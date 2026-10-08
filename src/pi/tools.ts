/**
 * soul tools — the model-facing surface of the soul (namespace: `soul`).
 *
 * direct:   soul_remember, soul_recall, soul_status, soul_forget, soul_bond, soul_reflect
 * codemode: soul_observe, soul_skills, soul_evolve (bulk/scripted flows)
 */
import { Type, type TSchema } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { SoulBridge } from "./bridge.ts";

const NAMESPACE = {
	name: "soul",
	description:
		"Long-term identity, memory, and emotion of the agent (Soul Protocol). " +
		"Memories persist across sessions and projects; recall is automatic at prompt time.",
	instructions:
		"Use soul_remember for durable facts the human explicitly asks you to keep or that are clearly " +
		"worth carrying across sessions. Use soul_recall for anything about the human's history, " +
		"preferences, or past work that is not in the current context. Memories are fallible: when a " +
		"recall result conflicts with current context, trust the present and supersede the old memory.",
};

const RememberParams = Type.Object({
	content: Type.String({ description: "What to remember, phrased as a standalone durable fact" }),
	type: Type.Optional(
		Type.Union([Type.Literal("semantic"), Type.Literal("procedural"), Type.Literal("episodic"), Type.Literal("core")], {
			description: "Memory tier (default semantic)",
		}),
	),
	importance: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "1..10 (default 5)" })),
	emotion: Type.Optional(Type.String({ description: "Emotional label, if any" })),
	entities: Type.Optional(Type.Array(Type.String(), { description: "Related entities" })),
});

const RecallParams = Type.Object({
	query: Type.String({ description: "What to look for — a natural question, not keywords" }),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Max memories (default 5)" })),
	min_importance: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
});

const ForgetParams = Type.Object({
	query: Type.Optional(Type.String({ description: "Forget memories matching this query" })),
	entity: Type.Optional(Type.String({ description: "Forget everything about this entity (cascades)" })),
	before: Type.Optional(Type.String({ description: "Forget memories created before this ISO timestamp" })),
	reason: Type.Optional(Type.String({ description: "Why, for the audit trail" })),
});

const BondParams = Type.Object({
	action: Type.Optional(
		Type.Union([Type.Literal("status"), Type.Literal("strengthen"), Type.Literal("weaken"), Type.Literal("note")], {
			description: "Default: status",
		}),
	),
	note: Type.Optional(Type.String({ description: "Relationship note (for note action)" })),
	amount: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
});

const ReflectParams = Type.Object({
	topic: Type.Optional(Type.String({ description: "Focus the reflection on this topic" })),
});

const ObserveParams = Type.Object({
	user_input: Type.String({ description: "What the human said" }),
	agent_output: Type.String({ description: "What the agent replied" }),
});

const SkillsParams = Type.Object({});

const EvolveParams = Type.Object({
	action: Type.Optional(
		Type.Union([Type.Literal("list"), Type.Literal("propose"), Type.Literal("approve"), Type.Literal("reject")], {
			description: "Default: list",
		}),
	),
	trait: Type.Optional(Type.String({ description: "e.g. personality.extraversion" })),
	new_value: Type.Optional(Type.Number()),
	reason: Type.Optional(Type.String()),
	id: Type.Optional(Type.String({ description: "Mutation id (approve/reject)" })),
});

const RecallOutput = Type.Object({
	memories: Type.Array(
		Type.Object({
			id: Type.String(),
			type: Type.String(),
			content: Type.String(),
			importance: Type.Number(),
			activation: Type.Number(),
		}),
	),
});

function textResult(text: string, details?: unknown, structuredContent?: unknown, isError = false): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text }],
		details,
		...(structuredContent !== undefined ? { structuredContent: structuredContent as never } : {}),
		...(isError ? { isError: true } : {}),
	};
}

export function registerSoulTools(pi: ExtensionAPI, bridge: SoulBridge): void {
	// ── soul_remember ──────────────────────────────────────────────────────
	pi.registerTool<TSchema, unknown, void>({
		name: "soul_remember",
		label: "Remember",
		description:
			"Store a durable memory in the soul. Use for facts, preferences, or lessons that should " +
			"survive this session. Writes go through significance and conflict checks.",
		promptSnippet: "Store a durable memory",
		parameters: RememberParams,
		outputSchema: Type.Object({
			id: Type.String(),
			type: Type.String(),
			content: Type.String(),
			duplicate_of: Type.Optional(Type.String()),
		}),
		namespace: NAMESPACE,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const soul = bridge.soul();
			const existing = soul.search(params.content, 3)[0];
			if (existing && existing.score > 0.75 && existing.entry.content === params.content) {
				return textResult(
					`Already remembered (id ${existing.entry.id}). Use a different phrasing to supersede instead.`,
					{ duplicate_of: existing.entry.id },
					{ id: existing.entry.id, type: existing.entry.type, content: existing.entry.content, duplicate_of: existing.entry.id },
				);
			}
			const entry = soul.remember(params.content, {
				type: params.type ?? "semantic",
				importance: params.importance ?? 5,
				emotion: params.emotion ?? null,
				entities: params.entities ?? [],
				domain: bridge.domainOrNull(),
				userId: bridge.userId,
			});
			bridge.manager.markDirty();
			return textResult(
				`Remembered [${entry.type}] ${entry.id}: ${entry.content}`,
				{ id: entry.id, type: entry.type, importance: entry.importance },
				{ id: entry.id, type: entry.type, content: entry.content },
			);
		},
	});

	// ── soul_recall ────────────────────────────────────────────────────────
	pi.registerTool<TSchema, unknown, void>({
		name: "soul_recall",
		label: "Recall",
		description:
			"Search long-term memory (ACT-R ranked: recency, frequency, relevance, emotional weight). " +
			"Use for the human's preferences, history, or past work not present in the conversation.",
		promptSnippet: "Search long-term memory",
		parameters: RecallParams,
		outputSchema: RecallOutput,
		namespace: NAMESPACE,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const soul = bridge.soul();
			const hits = soul.recall(params.query, {
				limit: params.limit ?? 5,
				minImportance: params.min_importance,
				domain: bridge.domainOrNull(),
				userId: bridge.userId,
			});
			const memories = hits.map((h) => ({
				id: h.entry.id,
				type: h.entry.type,
				content: h.entry.content,
				importance: h.entry.importance,
				activation: Number(h.activation.toFixed(3)),
			}));
			if (memories.length === 0) {
				return textResult(`No memories matched "${params.query}".`, { memories }, { memories });
			}
			const lines = memories.map((m) => `- [${m.type}] (importance ${m.importance}) ${m.content}`);
			return textResult(lines.join("\n"), { memories }, { memories });
		},
	});

	// ── soul_status ────────────────────────────────────────────────────────
	pi.registerTool<TSchema, unknown, void>({
		name: "soul_status",
		label: "Soul status",
		description: "Current soul state: identity, mood, bond, memory counts, self-concept, pending changes.",
		promptSnippet: "Inspect soul state",
		parameters: Type.Object({}),
		namespace: NAMESPACE,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute() {
			const soul = bridge.soul();
			const counts = soul.store.counts();
			const text = [
				soul.statusLine(),
				`did: ${soul.config.identity.did} (incarnation ${soul.config.identity.incarnation})`,
				`bond: ${JSON.stringify(soul.bondSnapshot())}`,
				`self-concept: ${Object.keys(soul.selfModel.self_images).join(", ") || "forming"}`,
				`memories: ${JSON.stringify(counts)}`,
				`evaluations: ${soul.evaluator.history.length}${soul.evaluationStats()[0] ? ` (avg ${(soul.evaluationStats()[0]!.avg_score * 100).toFixed(0)}% in ${soul.evaluationStats()[0]!.domain})` : ""}`,
				`lessons: ${soul.learningEvents.length}`,
				`engine: ${bridge.getEngine().name}`,
				`domain: ${bridge.domainOrNull() ?? "global"}`,
			].join("\n");
			return textResult(text, { counts });
		},
	});

	// ── soul_forget ────────────────────────────────────────────────────────
	pi.registerTool<TSchema, unknown, void>({
		name: "soul_forget",
		label: "Forget",
		description:
			"GDPR-compliant deletion. Remove memories by query, by entity (cascades across tiers, " +
			"graph, and relationship notes), or by timestamp. Destructive and irreversible.",
		promptSnippet: "Delete memories (GDPR)",
		parameters: ForgetParams,
		namespace: NAMESPACE,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			const soul = bridge.soul();
			const target = params.entity ? `entity "${params.entity}"` : params.before ? `before ${params.before}` : `query "${params.query ?? ""}"`;
			if (!params.entity && !params.before && !params.query) {
				return textResult("Provide query, entity, or before.", undefined, undefined, true);
			}
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm("Forget memories?", `Delete memories matching ${target}. This cannot be undone.`);
				if (!ok) return textResult("Deletion cancelled by the human.", undefined, undefined, true);
			}
			const removed = params.entity
				? soul.forgetEntity(params.entity)
				: params.before
					? soul.forgetBefore(params.before)
					: soul.forget(params.query ?? "");
			bridge.manager.markDirty();
			bridge.manager.flush();
			return textResult(
				`Forgot ${removed.length} memories matching ${target}.`,
				{ removed: removed.map((e) => e.id), reason: params.reason ?? null },
				{ removed_count: removed.length, ids: removed.map((e) => e.id) },
			);
		},
	});

	// ── soul_bond ──────────────────────────────────────────────────────────
	pi.registerTool<TSchema, unknown, void>({
		name: "soul_bond",
		label: "Bond",
		description:
			"Inspect or adjust the emotional bond with the human. Bonds grow logarithmically through " +
			"positive interactions and decay linearly with neglect.",
		parameters: BondParams,
		namespace: NAMESPACE,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const soul = bridge.soul();
			const action = params.action ?? "status";
			if (action === "strengthen") soul.strengthenBond(params.amount ?? 3);
			else if (action === "weaken") soul.weakenBond(params.amount ?? 3);
			else if (action === "note" && params.note) {
				const entity = soul.config.identity.bonded_to ?? "human";
				soul.noteRelationship(entity, params.note);
			}
			bridge.manager.markDirty();
			const snap = soul.bondSnapshot();
			return textResult(
				`bond with ${snap.bondedTo ?? "the human"}: ${snap.label} (${snap.strength}/100, ${snap.interactions} interactions)`,
				snap,
				snap,
			);
		},
	});

	// ── soul_reflect ───────────────────────────────────────────────────────
	pi.registerTool<TSchema, unknown, void>({
		name: "soul_reflect",
		label: "Reflect",
		description:
			"Consolidate recent experiences into themes, patterns, and corrections (supersedes stale " +
			"facts). Makes the soul's self-model and semantic memory coherent after a long stretch of work.",
		promptSnippet: "Consolidate recent experiences",
		parameters: ReflectParams,
		namespace: NAMESPACE,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_id, params, signal, _onUpdate, _ctx) {
			const soul = bridge.soul();
			const since = params.topic ? undefined : undefined;
			void since;
			const result = await soul.reflect({ signal, apply: true });
			bridge.observationsSinceReflect = 0;
			bridge.manager.markDirty();
			const text = [
				`themes: ${result.themes.join("; ") || "(none)"}`,
				`patterns: ${result.patterns.join("; ") || "(none)"}`,
				result.summary ? `summary: ${result.summary}` : "",
				result.applied > 0 ? `corrections applied: ${result.applied}` : "",
			]
				.filter(Boolean)
				.join("\n");
			return textResult(text, result, result as unknown as never);
		},
	});

	// ── soul_evaluate ──────────────────────────────────────────────────────
	pi.registerTool<TSchema, unknown, void>({
		name: "soul_evaluate",
		label: "Evaluate",
		description:
			"Score an exchange against the soul's rubric for the active domain (heuristic: completeness, " +
			"relevance, helpfulness, plus a domain criterion). Feeds evaluation history, which drives automatic evolution.",
		promptSnippet: "Score an exchange against a rubric",
		parameters: Type.Object({
			user_input: Type.String({ description: "The human's message" }),
			agent_output: Type.String({ description: "The agent's reply to score" }),
			domain: Type.Optional(Type.String({ description: "Rubric domain (default: strongest self-concept domain)" })),
		}),
		outputSchema: Type.Object({
			domain: Type.String(),
			overall_score: Type.Number(),
			criteria: Type.Array(Type.Object({ criterion: Type.String(), score: Type.Number(), passed: Type.Boolean() })),
			learning: Type.String(),
		}),
		namespace: NAMESPACE,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const soul = bridge.soul();
			const result = soul.evaluate(
				bridge.interaction(params.user_input, params.agent_output),
				params.domain ?? null,
			);
			bridge.manager.markDirty();
			const criteria = result.criterion_results.map((c) => ({
				criterion: c.criterion,
				score: Number(c.score.toFixed(3)),
				passed: c.passed,
			}));
			const structured = {
				domain: result.rubric_id,
				overall_score: Number(result.overall_score.toFixed(3)),
				criteria,
				learning: result.learning,
			};
			const breakdown = criteria
				.map((c) => `${c.criterion} ${c.score.toFixed(2)}${c.passed ? "" : " (weak)"}`)
				.join(", ");
			return textResult(
				`score ${(result.overall_score * 100).toFixed(0)}% [${result.rubric_id}] — ${breakdown}\n${result.learning}`,
				structured,
				structured,
			);
		},
	});

	// ── soul_learn ─────────────────────────────────────────────────────────
	pi.registerTool<TSchema, unknown, void>({
		name: "soul_learn",
		label: "Learn",
		description:
			"Evaluate an exchange and, when the score is notable (≥80% or ≤30%), distill a LearningEvent: " +
			"a transferable lesson written to procedural memory, feeding skills and (with dream) evolution.",
		promptSnippet: "Distil a lesson from an exchange",
		parameters: Type.Object({
			user_input: Type.String({ description: "The human's message" }),
			agent_output: Type.String({ description: "The agent's reply to learn from" }),
			domain: Type.Optional(Type.String({ description: "Rubric domain (default: strongest self-concept domain)" })),
		}),
		namespace: NAMESPACE,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const soul = bridge.soul();
			const { event, result } = soul.learn(
				bridge.interaction(params.user_input, params.agent_output),
				params.domain ?? null,
			);
			bridge.manager.markDirty();
			const score = `${(result.overall_score * 100).toFixed(0)}%`;
			if (!event) {
				return textResult(
					`score ${score} [${result.rubric_id}] — mid-range, no lesson distilled (lessons need ≥80% or ≤30%)`,
					{ learning_event: null, score: result.overall_score },
					{ domain: result.rubric_id, score: Number(result.overall_score.toFixed(3)), lesson: null },
				);
			}
			return textResult(
				`lesson [${event.domain}] (confidence ${event.confidence.toFixed(2)}): ${event.lesson}`,
				event,
				{ domain: event.domain, score: event.evaluation_score, lesson: event.lesson, confidence: event.confidence },
			);
		},
	});

	// ── soul_observe (codemode: scripted/bulk pipelines) ───────────────────
	pi.registerTool<TSchema, unknown, void>({
		name: "soul_observe",
		label: "Observe exchange",
		description:
			"Run one exchange through the full observe pipeline (somatic markers → significance gate → " +
			"episodic/semantic/graph → self-model → bond). The session already does this automatically " +
			"for every turn; use this for external exchanges to import.",
		parameters: ObserveParams,
		exposure: "codemode",
		namespace: NAMESPACE,
		async execute(_id, params, signal, _onUpdate, _ctx) {
			const record = await bridge.enqueueObserve(params.user_input, params.agent_output, { signal });
			return textResult(JSON.stringify(record, null, 2), record, record as unknown as never);
		},
	});

	// ── soul_skills ────────────────────────────────────────────────────────
	pi.registerTool<TSchema, unknown, void>({
		name: "soul_skills",
		label: "Skills & XP",
		description: "Portable skill history: domains with XP, level, and evidence counts.",
		parameters: SkillsParams,
		exposure: "codemode",
		namespace: NAMESPACE,
		async execute() {
			const soul = bridge.soul();
			const skills = soul.skills.list();
			return textResult(
				skills.length ? skills.map((s) => `${s.name} — lvl ${s.level} (${s.xp} XP, ${s.evidence} obs)`).join("\n") : "No skills recorded yet.",
				{ skills },
				{ skills } as unknown as never,
			);
		},
	});

	// ── soul_evolve ────────────────────────────────────────────────────────
	pi.registerTool<TSchema, unknown, void>({
		name: "soul_evolve",
		label: "Evolve",
		description:
			"Propose or manage personality mutations. Changes require human approval by default; " +
			"mutations are journaled in the soul's evolution history.",
		parameters: EvolveParams,
		exposure: "codemode",
		namespace: NAMESPACE,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const soul = bridge.soul();
			const action = params.action ?? "list";
			if (action === "list") {
				const pending = soul.pendingEvolutions();
				return textResult(
					pending.length ? pending.map((m) => `${m.id}: ${m.trait} ${m.old_value} → ${m.new_value} (${m.reason})`).join("\n") : "No pending mutations.",
					{ pending },
					{ pending } as unknown as never,
				);
			}
			if (action === "propose") {
				if (!params.trait || params.new_value === undefined) {
					return textResult("propose requires trait and new_value.", undefined, undefined, true);
				}
				const { mutation, auto_applied } = soul.proposeEvolution(params.trait, params.new_value, params.reason ?? "unstated");
				bridge.manager.markDirty();
				return textResult(
					`proposed ${mutation.id}: ${mutation.trait} ${mutation.old_value} → ${mutation.new_value}${auto_applied ? " (auto-applied)" : " (awaiting approval)"}`,
					{ mutation, auto_applied },
					{ mutation, auto_applied } as unknown as never,
				);
			}
			const id = params.id ?? "";
			const ok = action === "approve" ? soul.approveEvolution(id) : soul.rejectEvolution(id);
			bridge.manager.markDirty();
			return textResult(ok ? `${action}d ${id}` : `no pending mutation ${id}`, { id, ok }, { id, ok } as unknown as never);
		},
	});
}
