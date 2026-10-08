/**
 * SoulManager — where souls live and which one is active.
 *
 *   ~/.pi/agent/souls/            global soul root
 *     ├── config.json             engine + default soul settings
 *     ├── bindings.json           project (cwd) → { soul, domain }
 *     └── <name>.soul/            soul directory (SOUL-FORMAT-SPEC §8)
 *
 * Domain isolation: every project gets its own memory domain on a shared
 * soul (a whitepaper gap upstream — wired here).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Soul, type BirthOptions } from "../runtime/soul.ts";
import type { SoulDocument } from "../spec/types.ts";
import { saveSoulDir } from "../spec/soul-file.ts";
import type { CognitiveEngine } from "../runtime/engines/engine.ts";
import { HeuristicEngine } from "../runtime/engines/heuristic.ts";

export interface SoulBinding {
	soul: string;
	domain: string | null;
}

export interface SoulManagerConfig {
	defaultSoul: string;
	engine: "heuristic" | "model";
	/** Session-model override (empty → the session's active model). */
	sessionModel?: string;
	/** Typed classifier tier, `provider/id` (empty → disabled). */
	classifierModel?: string;
	/** Cheap chat tier: facts/entities, analysis fallback. */
	analysisModel?: string;
	/** Reasoning tier: reflect, learn, dream synthesis. */
	reflectModel?: string;
	/** @deprecated legacy single-model override (superseded by sessionModel). */
	model?: string;
	/** Generative extraction via the model, or heuristics only. */
	factsMode: "heuristic" | "model";
	/**
	 * Rubric scoring mode: `hybrid` (classifier only for criteria heuristics are
	 * weak at), `classifier` (all criteria), `heuristic` (none).
	 */
	rubricScoring: "hybrid" | "classifier" | "heuristic";
	/** Classifier answers below this confidence fall back to heuristics. */
	confidenceFloor: number;
	/** Content-hash cache for engine results. */
	cache: boolean;
	/** Max memories recalled per prompt into the soul_memory section. */
	recallLimit: number;
	/** Token budget for injected soul sections. */
	promptBudget: number;
	/** Observations between automatic reflections (default 8). */
	reflectEvery: number;
	/** Non-intrusive toasts for background soul activity (default true). */
	notifications: boolean;
	resilience: {
		retries: number;
		timeoutMs: { analysis: number; reflect: number; dream: number };
		breakerFailures: number;
		breakerCooldownMs: number;
		degradeAfter: number;
	};
	budget: { perMinute: number; perSession: number };
}

const DEFAULT_CONFIG: SoulManagerConfig = {
	defaultSoul: "default",
	engine: "model",
	sessionModel: "",
	// Cheapest adequate tier per task (see ENGINE.md). Resolved at runtime; a
	// tier whose model is unavailable simply drops out of the ladder.
	classifierModel: "openrouter/~typesafe/jev-latest",
	analysisModel: "openrouter/~z-ai/glm-flash-latest",
	reflectModel: "openrouter/~deepseek/deepseek-flash-latest",
	factsMode: "model",
	rubricScoring: "hybrid",
	confidenceFloor: 0.4,
	cache: true,
	recallLimit: 5,
	promptBudget: 400,
	notifications: true,
	reflectEvery: 8,
	resilience: {
		retries: 1,
		timeoutMs: { analysis: 20_000, reflect: 60_000, dream: 120_000 },
		breakerFailures: 3,
		breakerCooldownMs: 300_000,
		degradeAfter: 5,
	},
	budget: { perMinute: 20, perSession: 500 },
};

export class SoulManager {
	readonly root: string;
	private config: SoulManagerConfig;
	private bindings: Record<string, SoulBinding> = {};
	private soul: Soul | null = null;
	private activeName: string | null = null;
	private dirty = false;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * Persistence sink. When set (the detached soul worker), saves go through it
	 * fire-and-forget and never touch pi's event loop with file I/O.
	 */
	persistSink: ((dir: string, doc: SoulDocument) => void) | null = null;

	constructor(root?: string) {
		this.root = root ?? join(homedir(), ".pi", "agent", "souls");
		mkdirSync(this.root, { recursive: true });
		this.config = { ...DEFAULT_CONFIG, ...(readJsonSafe<SoulManagerConfig>(join(this.root, "config.json")) ?? {}) };
		this.bindings = readJsonSafe<Record<string, SoulBinding>>(join(this.root, "bindings.json")) ?? {};
	}

	// ── config & bindings ──────────────────────────────────────────────────

	getConfig(): SoulManagerConfig {
		return { ...this.config };
	}

	configure(patch: Partial<SoulManagerConfig>): SoulManagerConfig {
		this.config = {
			...this.config,
			...patch,
			// nested config is merged, not replaced
			resilience: { ...this.config.resilience, ...(patch.resilience ?? {}) },
			budget: { ...this.config.budget, ...(patch.budget ?? {}) },
		};
		writeFileSync(join(this.root, "config.json"), JSON.stringify(this.config, null, 2), "utf8");
		return this.getConfig();
	}

	projectKey(cwd: string): string {
		return cwd;
	}

	domainFor(cwd: string): string {
		return basename(cwd).toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "global";
	}

	bindingFor(cwd: string): SoulBinding {
		return this.bindings[this.projectKey(cwd)] ?? { soul: this.config.defaultSoul, domain: this.domainFor(cwd) };
	}

	bind(cwd: string, soulName: string, domain?: string | null): SoulBinding {
		const binding: SoulBinding = {
			soul: soulName,
			domain: domain === undefined ? this.domainFor(cwd) : domain,
		};
		this.bindings[this.projectKey(cwd)] = binding;
		writeFileSync(join(this.root, "bindings.json"), JSON.stringify(this.bindings, null, 2), "utf8");
		return binding;
	}

	// ── soul lifecycle ─────────────────────────────────────────────────────

	soulDir(name: string): string {
		return join(this.root, `${name}.soul`);
	}

	list(): Array<{ name: string; path: string }> {
		if (!existsSync(this.root)) return [];
		return readdirSync(this.root)
			.filter((n) => n.endsWith(".soul"))
			.map((n) => ({ name: n.slice(0, -5), path: join(this.root, n) }))
			.filter((s) => {
				try {
					return statSync(s.path).isDirectory() && existsSync(join(s.path, "soul.json"));
				} catch {
					return false;
				}
			});
	}

	/** The active soul: awakened from the project binding, auto-birthed if new. */
	ensure(cwd: string, engine: CognitiveEngine): Soul {
		if (this.soul) return this.soul;
		const binding = this.bindingFor(cwd);
		const dir = this.soulDir(binding.soul);
		if (existsSync(join(dir, "soul.json"))) {
			this.soul = Soul.awaken({ dir }, engine);
		} else {
			this.soul = Soul.birth({
				name: binding.soul === "default" ? "Default" : binding.soul,
				archetype: "The Companion",
				values: ["helpfulness", "honesty", "curiosity"],
				bondedTo: "human",
				engine,
			} satisfies BirthOptions);
			this.activeName = binding.soul;
			this.bind(cwd, binding.soul); // persist the project binding
			this.saveNow();
		}
		this.activeName = binding.soul;
		this.soul.setEngine(engine);
		return this.soul;
	}

	current(): Soul | null {
		return this.soul;
	}

	birth(cwd: string, options: BirthOptions, engine: CognitiveEngine): Soul {
		this.soul = Soul.birth({ ...options, engine });
		this.activeName = soulSlug(options.name);
		this.bind(cwd, this.activeName);
		this.saveNow();
		return this.soul;
	}

	switchTo(cwd: string, name: string, engine: CognitiveEngine): Soul | null {
		const dir = this.soulDir(name);
		if (!existsSync(join(dir, "soul.json"))) return null;
		this.flush();
		this.soul = Soul.awaken({ dir }, engine);
		this.activeName = name;
		this.bind(cwd, name);
		return this.soul;
	}

	/** Adopt an imported soul as the active one for this project. */
	bindImported(cwd: string, name: string, soul: Soul): void {
		this.flush();
		this.soul = soul;
		this.activeName = soulSlug(name);
		this.bind(cwd, this.activeName);
		this.saveNow();
	}

	// ── persistence ────────────────────────────────────────────────────────

	markDirty(): void {
		this.dirty = true;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.saveNow();
		}, 2000);
	}

	saveNow(): void {
		if (!this.soul) return;
		const dir = this.soulDir(this.activeName ?? soulSlug(this.soul.config.identity.name));
		const doc = this.soul.toDocument();
		if (this.persistSink) {
			this.persistSink(dir, doc);
		} else {
			saveSoulDir(doc, dir);
		}
		this.dirty = false;
	}

	flush(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (this.dirty) this.saveNow();
	}
}

export function soulSlug(name: string): string {
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return slug || "soul";
}

function readJsonSafe<T>(path: string): T | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

export function defaultEngine(): CognitiveEngine {
	return new HeuristicEngine();
}
