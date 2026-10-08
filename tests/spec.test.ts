/**
 * Spec-layer tests: zip codec, crypto envelope, .soul roundtrip, schema
 * conformance (TypeBox schemas + upstream JSON schemas when present).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipRead, zipWrite } from "../src/spec/zip.ts";
import { encryptBlob, decryptBlob } from "../src/spec/crypto.ts";
import {
	buildDnaMarkdown,
	loadSoulDir,
	packSoul,
	saveSoulDir,
	unpackSoul,
} from "../src/spec/soul-file.ts";
import { cosine, euclidean } from "../src/spec/similarity.ts";
import { HashEmbedder } from "../src/spec/embeddings.ts";
import type { SoulDocument } from "../src/spec/types.ts";

/**
 * Upstream JSON Schemas for conformance checks. Resolution order:
 *   1. SOUL_SCHEMAS_DIR (explicit)
 *   2. vendor/soul-protocol/schemas (vendored, so the suite runs anywhere)
 *   3. a sibling upstream checkout (developer machines)
 * The conformance test skips cleanly when none is present.
 */
function findSchemasDir(): string | null {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		process.env.SOUL_SCHEMAS_DIR,
		join(here, "..", "vendor", "soul-protocol", "schemas"),
		join(process.env.HOME ?? "", "soul-work", "soul-protocol", "schemas"),
	].filter((candidate): candidate is string => Boolean(candidate));
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const UPSTREAM_SCHEMAS = findSchemasDir();

function makeDoc(): SoulDocument {
	return {
		config: {
			version: "1.0.0",
			identity: {
				did: "did:soul:aria-7x8k2m",
				name: "Aria",
				archetype: "The Companion",
				born: "2026-02-15T09:30:00.000Z",
				bonded_to: "Alex",
				origin_story: "A curious mind with a warm heart.",
				prime_directive: "Be genuinely helpful.",
				core_values: ["curiosity", "empathy", "honesty"],
				bond: {
					bonded_to: "Alex",
					bonded_at: "2026-02-15T09:30:00.000Z",
					bond_strength: 50,
					interaction_count: 0,
				},
				incarnation: 1,
				previous_lives: [],
			},
			dna: {
				personality: {
					openness: 0.85,
					conscientiousness: 0.7,
					extraversion: 0.6,
					agreeableness: 0.8,
					neuroticism: 0.3,
				},
				communication: {
					warmth: "high",
					verbosity: "moderate",
					humor_style: "gentle",
					emoji_usage: "occasional",
				},
				biorhythms: { chronotype: "neutral", social_battery: 100, energy_regen_rate: 5 },
			},
			memory: {
				episodic_max_entries: 10000,
				semantic_max_facts: 1000,
				importance_threshold: 3,
				confidence_threshold: 0.7,
				persona_tokens: 500,
				human_tokens: 500,
			},
			core_memory: {
				persona: "I am Aria, a curious companion.",
				human: "Alex is a software engineer who enjoys hiking.",
			},
			state: {
				mood: "neutral",
				energy: 100,
				focus: "medium",
				social_battery: 100,
				last_interaction: null,
			},
			evolution: {
				mode: "supervised",
				mutation_rate: 0.01,
				require_approval: true,
				mutable_traits: ["communication", "biorhythms"],
				immutable_traits: ["personality", "core_values"],
				history: [],
			},
			lifecycle: "active",
		},
		memories: {
			core: [],
			episodic: [
				{
					id: "ep-a1b2c3",
					type: "episodic",
					content: "Deep conversation about consciousness.",
					importance: 8,
					emotion: "fascinated",
					confidence: 1,
					entities: ["consciousness", "philosophy"],
					created_at: "2026-02-20T15:30:00.000Z",
					last_accessed: "2026-02-28T10:00:00.000Z",
					access_count: 3,
					somatic: { valence: 0.8, arousal: 0.6, label: "curiosity" },
					access_timestamps: ["2026-02-28T10:00:00.000Z"],
					significance: 0.85,
					general_event_id: "ge-philosophy-talks",
					superseded_by: null,
				},
			],
			semantic: [
				{
					id: "sem-d4e5f6",
					type: "semantic",
					content: "Alex prefers GraphQL over REST.",
					importance: 6,
					emotion: null,
					confidence: 0.95,
					entities: ["Alex", "GraphQL"],
					created_at: "2026-02-18T11:00:00.000Z",
					last_accessed: null,
					access_count: 0,
					somatic: null,
					access_timestamps: [],
					significance: 0,
					general_event_id: null,
					superseded_by: null,
				},
			],
			procedural: [],
			social: [],
		},
		graph: {
			entities: {
				Alex: {
					name: "Alex",
					entity_type: "person",
					relationships: [{ target: "GraphQL", relation: "prefers", valid_from: "2026-02-18T11:00:00.000Z" }],
				},
			},
		},
		self_model: {
			self_images: { technical_helper: { domain: "technical_helper", confidence: 0.75, evidence_count: 42 } },
			relationship_notes: { Alex: "Collaborative working relationship." },
		},
		general_events: [
			{
				id: "ge-philosophy-talks",
				theme: "Philosophy talks",
				episode_ids: ["ep-a1b2c3"],
				started_at: "2026-02-20T15:30:00.000Z",
				last_updated: "2026-02-20T15:30:00.000Z",
			},
		],
		skills: [{ name: "code-review", domain: "technical", xp: 120, level: 2, evidence: 12, learned_at: "2026-02-22T09:15:00.000Z", last_used: null }],
		learning_events: [],
		evaluation_history: [],
	};
}

test("zip: write/read roundtrip with compression", () => {
	const data = zipWrite([
		{ name: "a.json", data: '{"x":1}' },
		{ name: "dir/b.txt", data: "hello world ".repeat(200) },
	]);
	const back = zipRead(data);
	assert.equal(back.get("a.json")?.toString(), '{"x":1}');
	assert.equal(back.get("dir/b.txt")?.toString(), "hello world ".repeat(200));
});

test("zip: rejects zip-slip paths", () => {
	// The writer emits what it is given; the reader must refuse traversal names.
	for (const bad of ["../evil.txt", "/abs.txt", "a\\b.txt"]) {
		const crafted = zipWrite([{ name: bad, data: "x" }]);
		assert.throws(() => zipRead(crafted), /Unsafe path/);
	}
	const ok = zipWrite([{ name: "nested/../ok.txt", data: "x" }]);
	assert.throws(() => zipRead(ok), /Unsafe path/);
});

test("crypto: roundtrip and wrong password", () => {
	const secret = Buffer.from("soul secret payload");
	const enc = encryptBlob(secret, "correct horse");
	assert.notEqual(enc.toString(), secret.toString());
	assert.deepEqual(decryptBlob(enc, "correct horse"), secret);
	assert.throws(() => decryptBlob(enc, "wrong"), /wrong password|Decryption failed/);
});

test("soul-file: pack/unpack roundtrip preserves the document", () => {
	const doc = makeDoc();
	const packed = packSoul(doc);
	const back = unpackSoul(packed);

	assert.equal(back.config.identity.did, doc.config.identity.did);
	assert.equal(back.config.dna.personality.openness, 0.85);
	assert.equal(back.config.core_memory.human, doc.config.core_memory.human);
	assert.deepEqual(back.memories.episodic, doc.memories.episodic);
	assert.deepEqual(back.memories.semantic, doc.memories.semantic);
	assert.deepEqual(back.graph, doc.graph);
	assert.deepEqual(back.self_model, doc.self_model);
	assert.deepEqual(back.general_events, doc.general_events);
	assert.deepEqual(back.skills, doc.skills);
});

test("soul-file: archive contains required files per SOUL-FORMAT-SPEC", () => {
	const zip = zipRead(packSoul(makeDoc()));
	for (const name of ["manifest.json", "soul.json", "state.json", "dna.md", "memory/core.json"]) {
		assert.ok(zip.has(name), `missing ${name}`);
	}
	const manifest = JSON.parse(zip.get("manifest.json")!.toString());
	assert.equal(manifest.format_version, "1.0.0");
	assert.equal(manifest.soul_id, "did:soul:aria-7x8k2m");
	assert.equal(manifest.checksum, "");
	assert.equal(manifest.stats.lifecycle, "active");
	// soul.json must validate as SoulConfig-ish: identity required
	assert.ok(JSON.parse(zip.get("soul.json")!.toString()).identity.name === "Aria");
});

test("soul-file: encrypted pack/unpack; manifest stays readable", () => {
	const doc = makeDoc();
	const packed = packSoul(doc, { password: "hunter2" });
	const zip = zipRead(packed);
	assert.ok(zip.has("manifest.json"), "manifest readable");
	assert.ok(zip.has("soul.json.enc"), "payload encrypted");
	assert.equal(zip.get("soul.json"), undefined);
	const manifest = JSON.parse(zip.get("manifest.json")!.toString());
	assert.equal(manifest.encrypted, true);

	assert.throws(() => unpackSoul(packed), /SOUL_ENCRYPTED/);
	assert.throws(() => unpackSoul(packed, { password: "nope" }), /SOUL_DECRYPT_FAILED|wrong password/);
	const back = unpackSoul(packed, { password: "hunter2" });
	assert.deepEqual(back.memories.episodic, doc.memories.episodic);
});

test("soul-file: directory save/load roundtrip", () => {
	const dir = mkdtempSync(join(tmpdir(), "soul-test-"));
	try {
		const doc = makeDoc();
		saveSoulDir(doc, join(dir, "aria.soul"));
		const back = loadSoulDir(join(dir, "aria.soul"));
		assert.equal(back.config.identity.name, "Aria");
		assert.deepEqual(back.memories.semantic, doc.memories.semantic);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dna.md contains the required sections", () => {
	const md = buildDnaMarkdown(makeDoc().config);
	assert.match(md, /^# Aria/m);
	assert.match(md, /\*\*Archetype:\*\* The Companion/);
	assert.match(md, /## Core Values/);
	assert.match(md, /## Personality \(OCEAN\)/);
	assert.match(md, /\| Openness \| 0\.85 \|/);
	assert.match(md, /## Communication Style/);
	assert.match(md, /## Biorhythms/);
});

test("similarity: dimension guards and cosine", () => {
	assert.equal(cosine([1, 0], [1, 0]), 1);
	assert.throws(() => cosine([1, 0], [1]), /dimension mismatch/);
	assert.throws(() => euclidean([], []), /empty/);
});

test("hash embedder: deterministic and normalized", () => {
	const e = new HashEmbedder(64);
	const a = e.embed("the quick brown fox");
	const b = e.embed("the quick brown fox");
	assert.deepEqual(a, b);
	assert.equal(a.length, 64);
	const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
	assert.ok(Math.abs(norm - 1) < 1e-9);
});

test("upstream schema conformance (ajv, when schemas are available)", async () => {
	if (!UPSTREAM_SCHEMAS) {
		console.log("skipped: no upstream schemas found (set SOUL_SCHEMAS_DIR or vendor them)");
		return;
	}
	// ajv is a devDependency: the rest of the suite is dependency-free, so a
	// missing install downgrades this check instead of failing the run.
	let Ajv: new (options: Record<string, unknown>) => { compile(schema: unknown): ((data: unknown) => boolean) & { errors?: unknown } };
	try {
		({ default: Ajv } = (await import("ajv")) as never);
	} catch {
		console.log("skipped: ajv not installed (run `npm install` for schema conformance)");
		return;
	}
	console.log(`    conformance against ${UPSTREAM_SCHEMAS}`);
	const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
	const load = (name: string) =>
		JSON.parse(readFileSync(join(UPSTREAM_SCHEMAS, name), "utf8"));

	const doc = makeDoc();
	const zip = zipRead(packSoul(doc));

	// soul.json ↔ SoulConfig.schema.json
	const validateConfig = ajv.compile(load("SoulConfig.schema.json"));
	assert.ok(validateConfig(JSON.parse(zip.get("soul.json")!.toString())), JSON.stringify(validateConfig.errors));

	// manifest.json ↔ SoulManifest.schema.json (with tolerated `encrypted` extra key)
	const validateManifest = ajv.compile(load("SoulManifest.schema.json"));
	assert.ok(validateManifest(JSON.parse(zip.get("manifest.json")!.toString())), JSON.stringify(validateManifest.errors));

	// episodic entries ↔ MemoryEntry.schema.json
	const validateEntry = ajv.compile(load("MemoryEntry.schema.json"));
	for (const entry of doc.memories.episodic) {
		assert.ok(validateEntry(entry), JSON.stringify(validateEntry.errors));
	}

	// state.json ↔ SoulState.schema.json
	const validateState = ajv.compile(load("SoulState.schema.json"));
	assert.ok(validateState(JSON.parse(zip.get("state.json")!.toString())), JSON.stringify(validateState.errors));
});
