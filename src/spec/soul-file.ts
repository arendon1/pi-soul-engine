/**
 * `.soul` file format codec — pack/unpack per `spec/SOUL-FORMAT-SPEC.md`
 * (format version 1.0.0) of github.com/qbtrix/soul-protocol.
 *
 * Archive layout:
 *   manifest.json                     (always readable)
 *   soul.json  state.json  dna.md
 *   memory/core.json                  CoreMemory {persona, human}
 *   memory/{episodic,semantic,procedural}.json   MemoryEntry[]
 *   memory/graph.json                 GraphFile
 *   memory/self_model.json            SelfModelFile
 *   memory/general_events.json        GeneralEvent[]
 *   memory/core_entries.json          MemoryEntry[] (pi-soul extension: core-tier entries)
 *   skills.json  trust_chain/chain.json (pi-soul extensions, ignored by other readers)
 *
 * Directory layout (`.soul/`): identical, minus manifest.json.
 * Encryption: every file except manifest.json gets `.enc` suffix and is wrapped
 * with AES-256-GCM (salt||nonce||ct||tag); `manifest.encrypted` is set.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decryptBlob, encryptBlob } from "./crypto.ts";
import type {
	ArchivalRecord,
	CoreMemory,
	GeneralEvent,
	GraphFile,
	LearningEvent,
	MemoryEntry,
	MemoryLayer,
	RubricResult,
	SkillRecord,
	SoulConfig,
	SoulDocument,
	SoulManifest,
	SelfModelFile,
	TrustChainFile,
} from "./types.ts";
import { zipRead, zipWrite } from "./zip.ts";

export const FORMAT_VERSION = "1.0.0";

export interface PackOptions {
	password?: string;
	/** Include the trust-chain private key in the archive (default false). */
	includeKeys?: boolean;
}

export interface UnpackOptions {
	password?: string;
}

// ── dna.md generation ───────────────────────────────────────────────────────

export function buildDnaMarkdown(config: SoulConfig): string {
	const { identity: id, dna } = config;
	const lines: string[] = [`# ${id.name}`, ""];
	if (id.archetype) lines.push(`**Archetype:** ${id.archetype}`, "");
	if (id.origin_story) lines.push(`**Origin:** ${id.origin_story}`, "");
	if (id.prime_directive) lines.push(`**Prime Directive:** ${id.prime_directive}`, "");
	if (id.core_values.length > 0) {
		lines.push("## Core Values", "");
		for (const v of id.core_values) lines.push(`- ${v}`);
		lines.push("");
	}
	lines.push("## Personality (OCEAN)", "");
	lines.push("| Trait | Score |", "|-------|-------|");
	const p = dna.personality;
	lines.push(`| Openness | ${p.openness.toFixed(2)} |`);
	lines.push(`| Conscientiousness | ${p.conscientiousness.toFixed(2)} |`);
	lines.push(`| Extraversion | ${p.extraversion.toFixed(2)} |`);
	lines.push(`| Agreeableness | ${p.agreeableness.toFixed(2)} |`);
	lines.push(`| Neuroticism | ${p.neuroticism.toFixed(2)} |`);
	lines.push("");
	lines.push("## Communication Style", "");
	const c = dna.communication;
	lines.push(`- **Warmth:** ${c.warmth}`);
	lines.push(`- **Verbosity:** ${c.verbosity}`);
	lines.push(`- **Humor:** ${c.humor_style}`);
	lines.push(`- **Emoji usage:** ${c.emoji_usage}`);
	lines.push("");
	lines.push("## Biorhythms", "");
	const b = dna.biorhythms;
	lines.push(`- **Chronotype:** ${b.chronotype}`);
	lines.push(`- **Social battery:** ${b.social_battery}%`);
	lines.push(`- **Energy regen rate:** ${b.energy_regen_rate}`);
	lines.push("");
	return lines.join("\n");
}

// ── helpers ─────────────────────────────────────────────────────────────────

function pretty(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function nowIso(): string {
	return new Date().toISOString();
}

function countMemories(doc: SoulDocument): number {
	return Object.values(doc.memories).reduce((n, list) => n + list.length, 0);
}

function buildManifest(doc: SoulDocument, encrypted: boolean): SoulManifest {
	return {
		format_version: FORMAT_VERSION,
		created: doc.config.identity.born,
		exported: nowIso(),
		soul_id: doc.config.identity.did,
		soul_name: doc.config.identity.name,
		checksum: "",
		stats: {
			version: doc.config.version,
			lifecycle: doc.config.lifecycle,
			total_memories: countMemories(doc),
			layers: Object.keys(doc.memories),
			...(encrypted ? { encrypted: true } : {}),
		},
		// NOTE: the reference reads `manifest.encrypted`; the JSON schema keeps it in stats,
		// the runtime writes it top-level. We write both for maximum compat.
		...(encrypted ? { encrypted: true } : {}),
	} as SoulManifest & { encrypted?: boolean };
}

/** Assemble every (path, content) pair that goes into an archive. */
export function documentFiles(doc: SoulDocument): Array<{ name: string; content: string }> {
	const files: Array<{ name: string; content: string }> = [];
	files.push({ name: "soul.json", content: pretty(doc.config) });
	files.push({ name: "state.json", content: pretty(doc.config.state) });
	files.push({ name: "dna.md", content: buildDnaMarkdown(doc.config) });

	const mem = (layer: MemoryLayer): string => pretty(doc.memories[layer] ?? []);
	files.push({ name: "memory/core.json", content: pretty(doc.config.core_memory) });
	if ((doc.memories.core ?? []).length > 0) {
		files.push({ name: "memory/core_entries.json", content: mem("core") });
	}
	files.push({ name: "memory/episodic.json", content: mem("episodic") });
	files.push({ name: "memory/semantic.json", content: mem("semantic") });
	files.push({ name: "memory/procedural.json", content: mem("procedural") });
	if ((doc.memories.social ?? []).length > 0) {
		files.push({ name: "memory/social.json", content: mem("social") });
	}
	files.push({ name: "memory/graph.json", content: pretty(doc.graph) });
	files.push({ name: "memory/self_model.json", content: pretty(doc.self_model) });
	files.push({ name: "memory/general_events.json", content: pretty(doc.general_events) });
	if (doc.skills.length > 0) files.push({ name: "skills.json", content: pretty(doc.skills) });
	if ((doc.learning_events ?? []).length > 0) {
		files.push({ name: "memory/learning_events.json", content: pretty(doc.learning_events) });
	}
	if ((doc.evaluation_history ?? []).length > 0) {
		files.push({ name: "evaluation.json", content: pretty(doc.evaluation_history) });
	}
	if ((doc.archival ?? []).length > 0) {
		files.push({ name: "memory/archival.json", content: pretty(doc.archival) });
	}
	if (doc.trust_chain) {
		// The signing key never leaves the local soul dir unless explicitly included.
		const chain: TrustChainFile = { ...doc.trust_chain };
		delete chain.private_key;
		files.push({ name: "trust_chain/chain.json", content: pretty(chain) });
	}
	return files;
}

// ── pack / unpack ───────────────────────────────────────────────────────────

export function packSoul(doc: SoulDocument, options: PackOptions = {}): Uint8Array {
	const encrypted = options.password !== undefined;
	const entries: Array<{ name: string; data: Uint8Array | string }> = [];

	for (const file of documentFiles(doc)) {
		const raw = Buffer.from(file.content, "utf8");
		if (encrypted) {
			entries.push({ name: `${file.name}.enc`, data: encryptBlob(raw, options.password as string) });
		} else {
			entries.push({ name: file.name, data: raw });
		}
	}
	if (options.includeKeys && doc.trust_chain?.private_key) {
		const raw = Buffer.from(doc.trust_chain.private_key, "utf8");
		if (encrypted) {
			entries.push({ name: "trust_chain/private.key.enc", data: encryptBlob(raw, options.password as string) });
		} else {
			entries.push({ name: "trust_chain/private.key", data: raw });
		}
	}
	// manifest last, always readable
	entries.push({ name: "manifest.json", data: pretty(buildManifest(doc, encrypted)) });
	return zipWrite(entries);
}

interface ReadResult {
	files: Map<string, string>;
	manifest: (SoulManifest & { encrypted?: boolean }) | null;
	encrypted: boolean;
	soulName: string;
}

function readArchive(data: Uint8Array, password?: string): ReadResult {
	const zip = zipRead(data);
	let manifest: (SoulManifest & { encrypted?: boolean }) | null = null;
	let encrypted = false;
	let soulName = "";

	const manifestRaw = zip.get("manifest.json");
	if (manifestRaw) {
		manifest = JSON.parse(manifestRaw.toString("utf8"));
		encrypted = Boolean((manifest as { encrypted?: boolean }).encrypted ?? manifest?.stats?.encrypted);
		soulName = manifest?.soul_name ?? "";
	}

	if (encrypted && password === undefined) {
		throw new Error("SOUL_ENCRYPTED: this .soul archive is password-encrypted; a password is required");
	}

	const files = new Map<string, string>();
	for (const [name, raw] of zip) {
		if (name === "manifest.json") continue;
		let content: Buffer;
		if (encrypted) {
			if (!name.endsWith(".enc")) continue;
			content = decryptBlob(raw, password as string);
		} else {
			if (name.endsWith(".enc")) continue;
			content = raw;
		}
		files.set(encrypted ? name.slice(0, -4) : name, content.toString("utf8"));
	}
	return { files, manifest, encrypted, soulName };
}

function parseMemEntries(text: string | undefined): MemoryEntry[] {
	if (text === undefined) return [];
	const value = JSON.parse(text);
	if (Array.isArray(value)) return value as MemoryEntry[];
	// Tolerate dict-style layer dumps ({entries: [...]}) from other runtimes.
	if (value && Array.isArray(value.entries)) return value.entries as MemoryEntry[];
	return [];
}

export function unpackSoul(data: Uint8Array, options: UnpackOptions = {}): SoulDocument {
	let read: ReadResult;
	try {
		read = readArchive(data, options.password);
	} catch (err) {
		if (err instanceof Error && err.message.includes("wrong password")) {
			throw new Error(`SOUL_DECRYPT_FAILED: ${err.message}`);
		}
		throw err;
	}
	const { files } = read;

	// Preferred: soul.json (format 1.0.0). Fallback: identity.json (minimal core codec).
	let config: SoulConfig;
	const soulJson = files.get("soul.json");
	if (soulJson) {
		config = normalizeConfig(JSON.parse(soulJson));
	} else if (files.get("identity.json")) {
		config = configFromIdentity(JSON.parse(files.get("identity.json") as string), files);
	} else {
		throw new Error("Invalid .soul file: missing soul.json");
	}

	// state.json is a denormalized convenience copy; soul.json wins per spec.
	const coreJson = files.get("memory/core.json");
	let coreMemory: CoreMemory = config.core_memory;
	const coreEntries: MemoryEntry[] = [];
	if (coreJson) {
		const parsed = JSON.parse(coreJson);
		if (Array.isArray(parsed)) {
			coreEntries.push(...(parsed as MemoryEntry[]));
		} else if (parsed && typeof parsed === "object") {
			coreMemory = {
				persona: String(parsed.persona ?? config.core_memory.persona),
				human: String(parsed.human ?? config.core_memory.human),
			};
		}
	}
	config.core_memory = coreMemory;

	const memories: Record<string, MemoryEntry[]> = {
		core: [...coreEntries, ...parseMemEntries(files.get("memory/core_entries.json"))],
		episodic: parseMemEntries(files.get("memory/episodic.json")),
		semantic: parseMemEntries(files.get("memory/semantic.json")),
		procedural: parseMemEntries(files.get("memory/procedural.json")),
		social: parseMemEntries(files.get("memory/social.json")),
	};

	let graph: GraphFile = { entities: {} };
	const graphRaw = files.get("memory/graph.json");
	if (graphRaw) {
		const parsed = JSON.parse(graphRaw);
		graph = { entities: parsed.entities ?? parsed ?? {} };
	}

	let selfModel: SelfModelFile = { self_images: {}, relationship_notes: {} };
	const selfRaw = files.get("memory/self_model.json");
	if (selfRaw) {
		const parsed = JSON.parse(selfRaw);
		selfModel = {
			self_images: parsed.self_images ?? {},
			relationship_notes: parsed.relationship_notes ?? {},
		};
	}

	let generalEvents: GeneralEvent[] = [];
	const geRaw = files.get("memory/general_events.json");
	if (geRaw) generalEvents = JSON.parse(geRaw);

	let skills: SkillRecord[] = [];
	const skillsRaw = files.get("skills.json");
	if (skillsRaw) skills = JSON.parse(skillsRaw);

	let learning_events: LearningEvent[] = [];
	const learningRaw = files.get("memory/learning_events.json");
	if (learningRaw) learning_events = JSON.parse(learningRaw);

	let evaluation_history: RubricResult[] = [];
	const evaluationRaw = files.get("evaluation.json");
	if (evaluationRaw) evaluation_history = JSON.parse(evaluationRaw);

	let archival: ArchivalRecord[] = [];
	const archivalRaw = files.get("memory/archival.json");
	if (archivalRaw) archival = JSON.parse(archivalRaw);

	let trust_chain: TrustChainFile | undefined;
	const trustRaw = files.get("trust_chain/chain.json");
	if (trustRaw) trust_chain = JSON.parse(trustRaw);
	const privateRaw = files.get("trust_chain/private.key");
	if (trust_chain && privateRaw) trust_chain.private_key = privateRaw;

	return {
		config,
		memories: memories as SoulDocument["memories"],
		graph,
		self_model: selfModel,
		general_events: generalEvents,
		skills,
		trust_chain,
		learning_events,
		evaluation_history,
		archival,
	};
}

// ── normalization (tolerant reader) ─────────────────────────────────────────

function normalizeConfig(raw: Record<string, unknown>): SoulConfig {
	const identity = (raw.identity ?? {}) as Record<string, unknown>;
	const dna = (raw.dna ?? {}) as Record<string, unknown>;
	const personality = (dna.personality ?? {}) as Record<string, unknown>;
	const communication = (dna.communication ?? {}) as Record<string, unknown>;
	const biorhythms = (dna.biorhythms ?? {}) as Record<string, unknown>;
	const state = (raw.state ?? {}) as Record<string, unknown>;
	const evolution = (raw.evolution ?? {}) as Record<string, unknown>;
	const memory = (raw.memory ?? {}) as Record<string, unknown>;
	const coreMemory = (raw.core_memory ?? {}) as Record<string, unknown>;
	const bond = (identity.bond ?? {}) as Record<string, unknown>;

	return {
		version: String(raw.version ?? "1.0.0"),
		identity: {
			did: String(identity.did ?? ""),
			name: String(identity.name ?? ""),
			archetype: String(identity.archetype ?? ""),
			born: String(identity.born ?? nowIso()),
			bonded_to: (identity.bonded_to as string | null) ?? null,
			origin_story: String(identity.origin_story ?? ""),
			prime_directive: String(identity.prime_directive ?? ""),
			core_values: Array.isArray(identity.core_values) ? (identity.core_values as string[]) : [],
			bond: {
				bonded_to: String(bond.bonded_to ?? ""),
				bonded_at: String(bond.bonded_at ?? nowIso()),
				bond_strength: Number(bond.bond_strength ?? 50),
				interaction_count: Number(bond.interaction_count ?? 0),
			},
			incarnation: Number(identity.incarnation ?? 1),
			previous_lives: Array.isArray(identity.previous_lives) ? (identity.previous_lives as string[]) : [],
		},
		dna: {
			personality: {
				openness: Number(personality.openness ?? 0.5),
				conscientiousness: Number(personality.conscientiousness ?? 0.5),
				extraversion: Number(personality.extraversion ?? 0.5),
				agreeableness: Number(personality.agreeableness ?? 0.5),
				neuroticism: Number(personality.neuroticism ?? 0.5),
			},
			communication: {
				warmth: String(communication.warmth ?? "moderate"),
				verbosity: String(communication.verbosity ?? "moderate"),
				humor_style: String(communication.humor_style ?? "none"),
				emoji_usage: String(communication.emoji_usage ?? "none"),
			},
			biorhythms: {
				chronotype: String(biorhythms.chronotype ?? "neutral"),
				social_battery: Number(biorhythms.social_battery ?? 100),
				energy_regen_rate: Number(biorhythms.energy_regen_rate ?? 5),
			},
		},
		memory: {
			episodic_max_entries: Number(memory.episodic_max_entries ?? 10000),
			semantic_max_facts: Number(memory.semantic_max_facts ?? 1000),
			importance_threshold: Number(memory.importance_threshold ?? 3),
			confidence_threshold: Number(memory.confidence_threshold ?? 0.7),
			persona_tokens: Number(memory.persona_tokens ?? 500),
			human_tokens: Number(memory.human_tokens ?? 500),
		},
		core_memory: {
			persona: String(coreMemory.persona ?? ""),
			human: String(coreMemory.human ?? ""),
		},
		state: {
			mood: (state.mood as SoulConfig["state"]["mood"]) ?? "neutral",
			energy: Number(state.energy ?? 100),
			focus: String(state.focus ?? "medium"),
			social_battery: Number(state.social_battery ?? 100),
			last_interaction: (state.last_interaction as string | null) ?? null,
		},
		evolution: {
			mode: (evolution.mode as SoulConfig["evolution"]["mode"]) ?? "supervised",
			mutation_rate: Number(evolution.mutation_rate ?? 0.01),
			require_approval: evolution.require_approval !== false,
			mutable_traits: Array.isArray(evolution.mutable_traits) ? (evolution.mutable_traits as string[]) : [],
			immutable_traits: Array.isArray(evolution.immutable_traits)
				? (evolution.immutable_traits as string[])
				: [],
			history: Array.isArray(evolution.history) ? (evolution.history as SoulConfig["evolution"]["history"]) : [],
		},
		lifecycle: (raw.lifecycle as SoulConfig["lifecycle"]) ?? "born",
	};
}

/** Build a SoulConfig from a minimal `identity.json`-style archive. */
function configFromIdentity(
	identityRaw: Record<string, unknown>,
	files: Map<string, string>,
): SoulConfig {
	const traits = (identityRaw.traits ?? {}) as Record<string, unknown>;
	const cfg = normalizeConfig({
		identity: identityRaw,
		dna: traits.dna ?? traits,
	});
	const coreRaw = files.get("memory/core.json");
	if (coreRaw) {
		try {
			const parsed = JSON.parse(coreRaw);
			if (!Array.isArray(parsed)) {
				cfg.core_memory = {
					persona: String(parsed.persona ?? ""),
					human: String(parsed.human ?? ""),
				};
			}
		} catch {
			/* keep defaults */
		}
	}
	return cfg;
}

// ── directory format ────────────────────────────────────────────────────────

const DIR_FILES = [
	"soul.json",
	"state.json",
	"dna.md",
	"memory/core.json",
	"memory/core_entries.json",
	"memory/episodic.json",
	"memory/semantic.json",
	"memory/procedural.json",
	"memory/social.json",
	"memory/learning_events.json",
	"memory/archival.json",
	"evaluation.json",
	"memory/graph.json",
	"memory/self_model.json",
	"memory/general_events.json",
	"skills.json",
	"trust_chain/chain.json",
];

export function saveSoulDir(doc: SoulDocument, dir: string): void {
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(dir, "memory"), { recursive: true });
	const files = documentFiles(doc);
	const byName = new Map(files.map((f) => [f.name, f.content]));
	for (const name of DIR_FILES) {
		const target = join(dir, name);
		const content = byName.get(name);
		if (content !== undefined) {
			mkdirSync(join(target, ".."), { recursive: true });
			writeFileSync(target, content, "utf8");
		} else if (existsSync(target)) {
			rmSync(target);
		}
	}
	// The signing key lives next to the chain locally (never in exports by default).
	const keyPath = join(dir, "trust_chain", "private.key");
	if (doc.trust_chain?.private_key) {
		mkdirSync(join(dir, "trust_chain"), { recursive: true });
		writeFileSync(keyPath, doc.trust_chain.private_key, "utf8");
	} else if (existsSync(keyPath)) {
		rmSync(keyPath);
	}
}

export function loadSoulDir(dir: string, options: UnpackOptions = {}): SoulDocument {
	if (!existsSync(join(dir, "soul.json")) && !existsSync(join(dir, "identity.json"))) {
		throw new Error(`Not a soul directory: ${dir}`);
	}
	void options; // directory form is not encrypted per spec
	const files = new Map<string, string>();
	const read = (name: string): void => {
		const p = join(dir, name);
		if (existsSync(p) && statSync(p).isFile()) files.set(name, readFileSync(p, "utf8"));
	};
	for (const name of DIR_FILES) read(name);
	read("identity.json");
	read("trust_chain/private.key");
	// Reuse archive parsing on the collected files by synthesizing a doc:
	const zip = zipWrite([...files].map(([name, content]) => ({ name, data: content })));
	return unpackSoul(zip, options);
}

/** List soul directories + .soul archives under a root directory. */
export function listSoulFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	for (const name of readdirSync(root)) {
		const p = join(root, name);
		if (name.endsWith(".soul")) out.push(p);
		else if (statSync(p).isDirectory() && existsSync(join(p, "soul.json"))) out.push(p);
	}
	return out.sort();
}
