/**
 * soul admin tools — model-facing control of soul operations.
 *
 * These close the gap recorded in PLAN-TOOLS.md: `/soul-config` and
 * `/soul-engine` (among others) were reachable only by the human, so a routine
 * task — flip the cognitive engine and confirm it is not degrading — could not
 * be done by the agent. They are `direct` exposure so the human can simply ask
 * for the operation instead of typing a slash command.
 *
 * Why a tool and not a file edit: `SoulManager` caches its config in memory, so
 * writing `config.json` from the filesystem cannot rebuild the running engine.
 * Only the bridge can run configure() -> rebuildEngine() together. That
 * asymmetry is the bug this file removes (PLAN-TOOLS.md §4).
 *
 * All three tools are model-only control surfaces; they return human-readable
 * text plus `details`. They deliberately do not declare `outputSchema` — their
 * payloads describe live mutable state (breakers, budget counters, config) whose
 * shape is owned elsewhere; a duplicated schema here would drift and start
 * failing validation at the least convenient moment.
 */
import { Type, type TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cpSync, existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { SoulBridge } from "./bridge.ts";
import { SOUL_NAMESPACE, textResult } from "./tool-support.ts";
import type { SoulManagerConfig } from "./soul-manager.ts";
import { soulSlug } from "./soul-manager.ts";
import { buildConfigPatch } from "./soul-config.ts";
import { Soul } from "../runtime/soul.ts";
import { dreamSummary } from "../runtime/dream.ts";

// ── parameter schemas ───────────────────────────────────────────────────────

const EngineParams = Type.Object({});

const OceanParams = Type.Object({
	openness: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	conscientiousness: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	extraversion: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	agreeableness: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	neuroticism: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

/**
 * The schema *is* the whitelist: only these keys exist, so an unknown key cannot
 * reach `configure()`. `additionalProperties: false` makes that explicit rather
 * than relying on the validator's default.
 */
const ConfigParams = Type.Object(
	{
		engine: Type.Optional(
			Type.Union([Type.Literal("heuristic"), Type.Literal("model")], {
				description: "heuristic = fully offline; model = tiered CognitiveRouter",
			}),
		),
		sessionModel: Type.Optional(Type.String({ description: "provider/id, or empty to follow the session model" })),
		classifierModel: Type.Optional(Type.String({ description: "provider/id of a classifier-type model" })),
		analysisModel: Type.Optional(Type.String({ description: "provider/id for facts/entities/significance" })),
		reflectModel: Type.Optional(Type.String({ description: "provider/id for reflect/learn/dream" })),
		factsMode: Type.Optional(Type.Union([Type.Literal("heuristic"), Type.Literal("model")])),
		rubricScoring: Type.Optional(
			Type.Union([Type.Literal("hybrid"), Type.Literal("classifier"), Type.Literal("heuristic")]),
		),
		confidenceFloor: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		cache: Type.Optional(Type.Boolean()),
		recallLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
		promptBudget: Type.Optional(Type.Number({ minimum: 50, maximum: 4000 })),
		reflectEvery: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
		notifications: Type.Optional(Type.Boolean()),
		budget: Type.Optional(
			Type.Object({
				perMinute: Type.Optional(Type.Number({ minimum: 1 })),
				perSession: Type.Optional(Type.Number({ minimum: 1 })),
			}),
		),
	},
	{ additionalProperties: false },
);

const AdminParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("dream"),
			Type.Literal("learning"),
			Type.Literal("evaluation"),
			Type.Literal("list"),
			Type.Literal("switch"),
			Type.Literal("birth"),
			Type.Literal("export"),
			Type.Literal("import"),
			Type.Literal("engine_reset"),
			Type.Literal("prune_entities"),
		],
		{ description: "Which soul operation to perform" },
	),
	dry_run: Type.Optional(Type.Boolean({ description: "dream: report without persisting" })),
	domain: Type.Optional(Type.String({ description: "learning: filter by domain" })),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
	name: Type.Optional(Type.String({ description: "switch | birth: soul name" })),
	archetype: Type.Optional(Type.String({ description: "birth: optional archetype" })),
	values: Type.Optional(Type.Array(Type.String(), { description: "birth: core values (immutable to evolution)" })),
	ocean: Type.Optional(OceanParams),
	path: Type.Optional(Type.String({ description: "export | import: .soul archive path (relative paths resolve against cwd)" })),
	password: Type.Optional(Type.String({ description: "export | import: AES-256-GCM password" })),
	keep: Type.Optional(
		Type.Array(Type.String(), {
			description: "prune_entities: entity/skill names to preserve (self-model domains are kept regardless)",
		}),
	),
});

// ── pure helpers ─────────────────────────────────────────────────────────────

function pickKeys(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) out[key] = source[key];
	return out;
}

type EngineStatus = ReturnType<SoulBridge["engineStatus"]>;
type AuditStatus = ReturnType<SoulBridge["auditStatus"]>;

/** Ported from the `/soul-engine` command so both surfaces read identically. */
function renderEngine(status: EngineStatus, audit?: AuditStatus): string {
	if ("note" in status) return `engine: ${status.engine}\n${status.note}`;
	const t = status.telemetry;
	const failures =
		Object.entries(t.failures)
			.filter(([, n]) => n > 0)
			.map(([k, n]) => `${k}=${n}`)
			.join(" ") || "none";
	const lines = [
		`engine: ${status.engine}${status.degraded ? " — DEGRADED (heuristics only)" : ""}`,
		`tiers: analysis=${status.tiers.analysis ?? "—"} · reflect=${status.tiers.reflect ?? "—"} · session=${status.tiers.session ?? "—"} · fallback=${status.tiers.fallback}`,
		`calls: ${t.attempts} attempts, ${t.retries} retries, cache ${t.cacheHits} hit / ${t.cacheMisses} miss (${status.cache.size}/${status.cache.max}), tier-skipped ${t.tierSkipped}`,
		`budget: ${status.budget.sessionCalls}/${status.budget.perSession} session · ${status.budget.lastMinute}/${status.budget.perMinute} last min · denied ${status.budget.denied}`,
		`failures: ${failures}`,
		`usage: ${t.usage.input} in / ${t.usage.output} out tokens · $${t.usage.cost.toFixed(4)}`,
		`deferrals: ${t.deferrals}`,
		`breakers: ${
			status.breakers
				.filter((b) => b.open)
				.map((b) => `${b.key} (retry in ${Math.round(b.retryInMs / 1000)}s)`)
				.join(", ") || "all closed"
		}`,
	];
	if (audit) {
		lines.push(
			audit.failures > 0 || !audit.attached
				? `audit: FAILING — ${audit.failures} transcript entries dropped (${audit.lastError ?? "unknown"})`
				: "audit: ok",
		);
	}
	return lines.join("\n");
}

/** The tier ladder, for re-reporting after a config change. */
function renderTiers(status: EngineStatus): string {
	if ("note" in status) return `engine: ${status.engine} (${status.note})`;
	return `engine: ${status.engine}${status.degraded ? " — DEGRADED" : ""} · analysis=${status.tiers.analysis ?? "—"} · reflect=${status.tiers.reflect ?? "—"} · session=${status.tiers.session ?? "—"}`;
}

// ── registration ────────────────────────────────────────────────────────────

export function registerAdminTools(pi: ExtensionAPI, bridge: SoulBridge): void {
	// ── soul_engine ────────────────────────────────────────────────────────
	pi.registerTool<TSchema, unknown, void>({
		name: "soul_engine",
		label: "Engine status",
		description:
			"Cognitive-engine health: active tiers, degradation, circuit breakers, budget, cache, " +
			"token usage and cost, audit-trail status. Read-only. Use it to verify that a config " +
			"change took effect and that model calls are actually succeeding rather than silently " +
			"falling back to heuristics.",
		promptSnippet: "Inspect the soul cognitive engine",
		parameters: EngineParams,
		exposure: "direct",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		namespace: SOUL_NAMESPACE,
		async execute() {
			const status = bridge.engineStatus();
			const audit = bridge.auditStatus();
			return textResult(renderEngine(status, audit), { status, audit });
		},
	});

	// ── soul_config ────────────────────────────────────────────────────────
	pi.registerTool<TSchema, unknown, void>({
		name: "soul_config",
		label: "Soul config",
		description:
			"Read or change the soul's runtime configuration. With no arguments, returns the current " +
			"config. With arguments, applies them, rebuilds the cognitive engine, and reports the " +
			"resulting tier ladder — this is the in-process path that a config-file edit cannot take. " +
			"Unknown keys are rejected. Moving engine/factsMode to 'model' changes token spend.",
		promptSnippet: "Read or change soul engine configuration",
		parameters: ConfigParams,
		exposure: "direct",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		namespace: SOUL_NAMESPACE,
		async execute(_id, params) {
			const before = bridge.manager.getConfig();
			const patch = buildConfigPatch(params as Record<string, unknown>);
			const keys = Object.keys(patch);

			if (keys.length === 0) {
				return textResult(JSON.stringify(before, null, 2), { config: before, changed: false });
			}

			const config = bridge.manager.configure(patch as Partial<SoulManagerConfig>);
			bridge.rebuildEngine();
			const status = bridge.engineStatus();

			// Config changes are soul writes too: journal them like every other one.
			bridge.append("soul:config", {
				timestamp: new Date().toISOString(),
				requested: patch,
				before: pickKeys(before as unknown as Record<string, unknown>, keys),
				after: pickKeys(config as unknown as Record<string, unknown>, keys),
				engine: bridge.getEngine().name,
			});

			const changed = keys.map((k) => `${k}=${JSON.stringify((config as unknown as Record<string, unknown>)[k])}`).join(", ");
			const lines = [`config updated: ${changed}`, renderTiers(status)];

			// The exact failure this tool exists to prevent: reporting success while
			// the engine quietly stayed on heuristics.
			if (patch.engine === "model" && status.engine !== "router") {
				lines.push(
					"WARNING: model engine requested but no model tier resolved — check provider auth and " +
						"model ids. The soul is still running on heuristics.",
				);
			} else if ("degraded" in status && status.degraded) {
				lines.push("WARNING: engine is DEGRADED — it fell back to heuristics after repeated failures. Use soul_engine for detail.");
			}

			return textResult(lines.join("\n"), { config, status, patch });
		},
	});

	// ── soul_admin ─────────────────────────────────────────────────────────
	pi.registerTool<TSchema, unknown, void>({
		name: "soul_admin",
		label: "Soul admin",
		description:
			"Manage soul operations that have no other model-facing entry point: dream (offline " +
			"consolidation), learning (distilled lessons), evaluation (per-domain scores), list/switch/" +
			"birth (multi-soul management), export/import (.soul archives), engine_reset (clear " +
			"breakers and counters), prune_entities (remove junk entities/skills; dry_run previews). " +
			"Import backs up the soul it replaces.",
		promptSnippet: "Run soul management operations",
		parameters: AdminParams,
		exposure: "direct",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		namespace: SOUL_NAMESPACE,
		async execute(_id, params) {
			const soul = bridge.soul();

			switch (params.action) {
				case "dream": {
					const dryRun = params.dry_run ?? false;
					const report = await soul.dreamWithSynthesis({ dryRun });
					if (!dryRun) bridge.manager.markDirty();
					return textResult(dreamSummary(report), { report, dryRun });
				}

				case "learning": {
					const events = soul.learning.list({ domain: params.domain, limit: params.limit ?? 15 });
					const text = events.length
						? events
								.map(
									(e) =>
										`◆ [${e.domain}] ${e.lesson}\n  confidence ${e.confidence.toFixed(2)} · applied ${e.applied_count}` +
										(e.evaluation_score !== null ? ` · score ${(e.evaluation_score * 100).toFixed(0)}%` : ""),
								)
								.join("\n")
						: "No learning events yet — lessons are distilled from notable scores (≥80% or ≤30%).";
					return textResult(text, { events });
				}

				case "evaluation": {
					const stats = soul.evaluationStats();
					const text = stats.length
						? stats
								.map(
									(s) =>
										`${s.domain}: ${s.count} evaluations, avg ${(s.avg_score * 100).toFixed(1)}%` +
										(s.streak ? `, streak ${s.streak}` : ""),
								)
								.join("\n")
						: "No evaluations yet.";
					return textResult(text, { stats });
				}

				case "list": {
					const souls = bridge.manager.list();
					const active = soulSlug(soul.config.identity.name);
					const text = souls.length
						? souls.map((s) => `◆ ${s.name}${s.name === active ? " (active)" : ""}  ${s.path}`).join("\n")
						: "No souls yet. Use soul_admin {action:'birth'}.";
					return textResult(text, { souls, active });
				}

				case "switch": {
					const name = (params.name ?? "").trim();
					if (!name) return textResult("switch requires `name`.", { ok: false }, undefined, true);
					const switched = bridge.manager.switchTo(bridge.cwd, name, bridge.getEngine());
					if (!switched) return textResult(`No soul named "${name}".`, { name, ok: false }, undefined, true);
					bridge.domain = bridge.manager.domainFor(bridge.cwd);
					return textResult(`Switched to ${switched.config.identity.name}.\n${switched.statusLine()}`, {
						name,
						ok: true,
					});
				}

				case "birth": {
					const name = (params.name ?? "").trim();
					if (!name) return textResult("birth requires `name`.", { ok: false }, undefined, true);
					if (bridge.manager.list().some((s) => s.name === soulSlug(name))) {
						return textResult(
							`A soul named "${soulSlug(name)}" already exists. Choose another name (this tool will not overwrite one).`,
							{ name, ok: false },
							undefined,
							true,
						);
					}
					const born = bridge.manager.birth(
						bridge.cwd,
						{
							name,
							archetype: params.archetype ?? "",
							values: params.values ?? [],
							ocean: params.ocean,
							bondedTo: "human",
						},
						bridge.getEngine(),
					);
					bridge.domain = bridge.manager.domainFor(bridge.cwd);
					return textResult(`◆ ${born.config.identity.name} is born.\n${born.statusLine()}`, {
						name: soulSlug(name),
						ok: true,
					});
				}

				case "export": {
					const raw = params.path ?? `${soul.config.identity.name}.soul`;
					const abs = isAbsolute(raw) ? raw : resolve(bridge.cwd, raw);
					await bridge.worker.packToFile(soul.toDocument(), abs, { password: params.password });
					const bytes = existsSync(abs) ? statSync(abs).size : 0;
					return textResult(
						`Exported ${soul.memoryCount()} memories to ${abs}${params.password ? " (encrypted)" : ""} (${bytes} bytes).`,
						{ path: abs, bytes, memories: soul.memoryCount() },
					);
				}

				case "import": {
					const raw = params.path;
					if (!raw) return textResult("import requires `path`.", { ok: false }, undefined, true);
					const abs = isAbsolute(raw) ? raw : resolve(bridge.cwd, raw);
					const doc = await bridge.worker.unpack({ path: abs }, params.password);
					const name = soulSlug(basename(abs).replace(/\.soul$/, "") || "imported");

					// Import replaces the active soul: back the old one up first.
					const existing = bridge.manager.list().find((s) => s.name === name);
					let backup: string | null = null;
					if (existing) {
						backup = `${existing.path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
						cpSync(existing.path, backup, { recursive: true });
					}

					const imported = Soul.fromDocument(doc, bridge.getEngine());
					bridge.manager.bindImported(bridge.cwd, name, imported);
					bridge.domain = bridge.manager.domainFor(bridge.cwd);
					return textResult(
						`Imported ${imported.config.identity.name} — ${imported.memoryCount()} memories.` +
							(backup ? `\nPrevious soul backed up to ${backup}` : ""),
						{ name, memories: imported.memoryCount(), backup },
					);
				}

				case "engine_reset": {
					if (!bridge.routerRef) {
						return textResult("No model engine is active (heuristics only) — nothing to reset.", { ok: false });
					}
					bridge.routerRef.resetResilience();
					return textResult("Engine resilience state reset (breakers, counters, budget).", { ok: true });
				}

				case "prune_entities": {
					const dryRun = params.dry_run ?? false;
					const result = soul.pruneEntities({ keep: params.keep ?? [], dryRun });
					const sample = (xs: string[], n = 12): string =>
						xs.slice(0, n).join(", ") + (xs.length > n ? ` … (+${xs.length - n} more)` : "");
					const lines = [
						`${dryRun ? "would remove" : "removed"}: ${result.graphRemoved.length} graph entities · ` +
							`${result.memoryTagsRemoved} memory entity tags · ${result.skillsRemoved.length} skills`,
						result.graphRemoved.length ? `  graph: ${sample(result.graphRemoved)}` : "",
						result.skillsRemoved.length ? `  skills: ${sample(result.skillsRemoved)}` : "",
						dryRun
							? "dry run — nothing written; call again without dry_run to apply"
							: "applied (self-model domains are always kept)",
					].filter(Boolean);
					if (!dryRun) bridge.manager.markDirty();
					return textResult(lines.join("\n"), { ...result, dryRun });
				}
			}
		},
	});
}
