/**
 * observe() — the EQ pipeline. Every interaction passes through it before
 * storage. It decides not just what to store, but whether to store, how to
 * feel about it, and what it means for the soul's sense of self.
 *
 *   💬 input
 *   → ♥ somatic markers (Damasio)
 *   → ⚙ significance gate (LIDA, threshold 0.35)
 *   → episodic (if significant)
 *   → semantic (fact extraction + superseded_by conflicts)
 *   → graph (entity extraction, temporal edges)
 *   → self-model (Klein: what does this say about who I am?)
 *   → bond + state + skills + evaluation
 *
 * Analysis is fetched in ONE batched pass (`AnalysisService`): classifier for
 * typed tasks, cheap chat for generative ones, heuristics per field. When no
 * service is wired (bare HeuristicEngine), it falls back to per-task calls.
 */
import type {
	GraphEntity,
	Interaction,
	MemoryEntry,
	SomaticMarker,
	SelfModelFile,
	GraphFile,
} from "../spec/types.ts";
import { makeEntry, MemoryStore } from "./store.ts";
import { contentRichness, passesGate, significanceTotal, SIGNIFICANCE_THRESHOLD } from "./psychology.ts";
import type { CognitiveEngine } from "./engines/engine.ts";
import { parseJsonLoose } from "./engines/engine.ts";
import {
	entitiesPrompt,
	factsPrompt,
	selfModelPrompt,
	sentimentPrompt,
	significancePrompt,
} from "./engines/prompts.ts";
import type { AnalysisService } from "./engines/analysis.ts";
import { HeuristicEngine } from "./engines/heuristic.ts";
import { addEvidence } from "./self-model.ts";
import { nowIso } from "../util/ids.ts";
import { clamp, tokenOverlap, tokenize } from "../util/text.ts";

export interface ObserveContext {
	store: MemoryStore;
	selfModel: SelfModelFile;
	graph: GraphFile;
	engine: CognitiveEngine;
	/** Preferred path: one batched classifier/model pass per exchange. */
	analysis?: AnalysisService | null;
	/** Rubric criteria to score in the same batched call (domain rubric). */
	rubricCriteria?: string[];
	personality?: import("../spec/types.ts").Personality;
	domain?: string | null;
	userId?: string | null;
	/** Async callers pass an abort signal (e.g. pi session shutdown). */
	signal?: AbortSignal;
	/** Known domains for the self-model prompt. */
	knownDomains?: string[];
}

export interface ObservationResult {
	somatic: SomaticMarker;
	significance: number;
	significance_scores: { novelty: number; emotional_intensity: number; goal_relevance: number; content_richness: number };
	episodic: MemoryEntry | null;
	facts: MemoryEntry[];
	entities: Array<{ name: string; entity_type: string }>;
	self_model_updates: string[];
	stored: boolean;
	engine_used: string;
	/** Rubric scores produced in the same batched pass (null when unavailable). */
	rubric?: { criteria: Record<string, number>; overall: number } | null;
	/** Mutations the soul proposed on its own (high-performance streak triggers). */
	evolution_proposals?: Array<{
		id: string;
		trait: string;
		old_value: string;
		new_value: string;
		reason: string;
	}>;
}

/** Normalised analysis consumed by the pipeline, whatever produced it. */
interface PipelineAnalysis {
	somatic: SomaticMarker;
	significance: { novelty: number; emotional_intensity: number; goal_relevance: number; content_richness: number };
	facts: Array<{ content: string; entities: string[]; importance: number }>;
	entities: Array<{ name: string; entity_type: string }>;
	domains: Array<{ domain: string; evidence_delta: number }>;
	rubric: { criteria: Record<string, number>; overall: number } | null;
}

const heuristic = new HeuristicEngine();

function heuristicJson<T>(prompt: string): T {
	return JSON.parse(heuristic.thinkSync(prompt)) as T;
}

/** Extract a stand-alone interaction text pair. */
function pairOf(interaction: Interaction): { user: string; agent: string; text: string } {
	const user = interaction.participants.find((p) => p.role === "user")?.content ?? "";
	const agent = interaction.participants.find((p) => p.role === "agent")?.content ?? "";
	return { user, agent, text: `${user}\n${agent}` };
}

/**
 * Batched path (preferred): one classifier call + one extraction call, with
 * per-field heuristic fallback inside the service.
 */
async function batchedAnalysis(
	service: AnalysisService,
	ctx: ObserveContext,
	user: string,
	agent: string,
): Promise<PipelineAnalysis> {
	const analysis = await service.analyze({
		user,
		agent,
		knownDomains: ctx.knownDomains,
		rubricCriteria: ctx.rubricCriteria,
		signal: ctx.signal,
	});
	return {
		somatic: analysis.somatic,
		significance: analysis.significance,
		facts: analysis.facts,
		entities: analysis.entities,
		domains: analysis.domain ? [{ domain: analysis.domain, evidence_delta: 1 }] : [],
		rubric: analysis.rubric,
	};
}

/** Per-task path (no service wired): identical shapes, engine or heuristic each. */
async function perTaskAnalysis(ctx: ObserveContext, user: string, agent: string, text: string): Promise<PipelineAnalysis> {
	async function thinkJson<T>(prompt: string, fallback: () => T): Promise<T> {
		try {
			const output = await ctx.engine.think(prompt, { json: true, signal: ctx.signal });
			return parseJsonLoose<T>(output);
		} catch {
			return fallback();
		}
	}

	const somatic = await thinkJson<SomaticMarker>(sentimentPrompt(user, agent), () =>
		heuristicJson<SomaticMarker>(sentimentPrompt(user, agent)),
	);
	const sig = await thinkJson<{
		novelty?: number;
		emotional_intensity?: number;
		goal_relevance?: number;
		content_richness?: number;
	}>(significancePrompt(user, agent), () => heuristicJson<Record<string, number>>(significancePrompt(user, agent)));
	const factData = await thinkJson<{ facts?: Array<{ content: string; entities: string[]; importance: number }> }>(
		factsPrompt(user, agent),
		() => heuristicJson<{ facts: Array<{ content: string; entities: string[]; importance: number }> }>(factsPrompt(user, agent)),
	);
	const entityData = await thinkJson<{ entities?: Array<{ name: string; entity_type: string }> }>(
		entitiesPrompt(text),
		() => heuristicJson<{ entities: Array<{ name: string; entity_type: string }> }>(entitiesPrompt(text)),
	);
	const selfData = await thinkJson<{ domains?: Array<{ domain: string; evidence_delta: number }> }>(
		selfModelPrompt(ctx.knownDomains ?? Object.keys(ctx.selfModel.self_images), text),
		() => heuristicJson<{ domains: Array<{ domain: string; evidence_delta: number }> }>(selfModelPrompt([], text)),
	);

	return {
		somatic: {
			valence: clamp(Number(somatic.valence ?? 0), -1, 1),
			arousal: clamp(Number(somatic.arousal ?? 0), 0, 1),
			label: String(somatic.label ?? "neutral"),
		},
		significance: {
			novelty: clamp(Number(sig.novelty ?? 0), 0, 1),
			emotional_intensity: clamp(Number(sig.emotional_intensity ?? 0), 0, 1),
			goal_relevance: clamp(Number(sig.goal_relevance ?? 0), 0, 1),
			content_richness: clamp(Number(sig.content_richness ?? contentRichness(text)), 0, 1),
		},
		facts: (factData.facts ?? []).map((f) => ({
			content: String(f.content ?? ""),
			entities: (f.entities ?? []).map(String),
			importance: Number(f.importance ?? 5),
		})),
		entities: (entityData.entities ?? []).map((e) => ({
			name: String(e.name ?? ""),
			entity_type: String(e.entity_type ?? "topic"),
		})),
		domains: (selfData.domains ?? []).map((d) => ({
			domain: String(d.domain ?? ""),
			evidence_delta: Number(d.evidence_delta ?? 1),
		})),
		rubric: null,
	};
}

export async function runObservePipeline(
	interaction: Interaction,
	ctx: ObserveContext,
): Promise<ObservationResult> {
	const { user, agent, text } = pairOf(interaction);

	const analysis = ctx.analysis
		? await batchedAnalysis(ctx.analysis, ctx, user, agent)
		: await perTaskAnalysis(ctx, user, agent, text);

	// ── 1. Somatic marker (Damasio) ─────────────────────────────────────────
	const marker: SomaticMarker = {
		valence: clamp(Number(analysis.somatic.valence ?? 0), -1, 1),
		arousal: clamp(Number(analysis.somatic.arousal ?? 0), 0, 1),
		label: String(analysis.somatic.label ?? "neutral"),
	};

	// ── 2. Significance gate (LIDA) ─────────────────────────────────────────
	const scores = {
		novelty: clamp(Number(analysis.significance.novelty ?? 0), 0, 1),
		emotional_intensity: clamp(Number(analysis.significance.emotional_intensity ?? 0), 0, 1),
		goal_relevance: clamp(Number(analysis.significance.goal_relevance ?? 0), 0, 1),
		content_richness: clamp(Number(analysis.significance.content_richness ?? contentRichness(text)), 0, 1),
	};
	const significance = significanceTotal(scores);

	// ── 3. Episodic — only if significant ───────────────────────────────────
	let episodic: MemoryEntry | null = null;
	const significant = passesGate(scores, SIGNIFICANCE_THRESHOLD);
	if (significant) {
		episodic = makeEntry({
			type: "episodic",
			content: summarizeInteraction(user, agent),
			importance: clamp(Math.round(4 + significance * 6), 1, 10),
			emotion: marker.label,
			somatic: marker,
			significance,
			entities: [],
			domain: ctx.domain ?? null,
			user_id: ctx.userId ?? null,
		});
		ctx.store.store("episodic", episodic);
	}

	// ── 4. Semantic — fact extraction + conflict chain ──────────────────────
	const facts: MemoryEntry[] = [];
	for (const fact of analysis.facts.slice(0, 8)) {
		const content = String(fact.content ?? "").trim();
		if (content.length < 5) continue;
		const entry = makeEntry({
			type: "semantic",
			content,
			importance: clamp(Math.round(Number(fact.importance ?? 5)), 1, 10),
			confidence: 0.9,
			entities: (fact.entities ?? []).map(String),
			somatic: null,
			domain: ctx.domain ?? null,
			user_id: ctx.userId ?? null,
		});
		const outcome = resolveConflict(ctx.store, entry);
		if (outcome === "duplicate") continue; // folded into an existing fact
		ctx.store.store("semantic", entry);
		facts.push(entry);
	}

	// ── 5. Graph — entity extraction, temporal edges ────────────────────────
	const entities = (analysis.entities ?? [])
		.map((e) => ({ name: String(e.name ?? "").trim(), entity_type: String(e.entity_type ?? "topic") }))
		.filter((e) => e.name.length > 1)
		.slice(0, 12);
	updateGraph(ctx.graph, entities, episodic);
	if (episodic) episodic.entities = entities.map((e) => e.name);

	// ── 6. Self-model (Klein) ───────────────────────────────────────────────
	const self_model_updates: string[] = [];
	for (const d of (analysis.domains ?? []).slice(0, 4)) {
		const domain = String(d.domain ?? "").trim().toLowerCase().replace(/\s+/g, "_");
		if (!domain) continue;
		const image = addEvidence(ctx.selfModel, domain, clamp(Math.round(Number(d.evidence_delta ?? 1)), 1, 3));
		self_model_updates.push(`${domain} → confidence ${image.confidence.toFixed(2)} (${image.evidence_count} obs)`);
	}

	return {
		somatic: marker,
		significance,
		significance_scores: scores,
		episodic,
		facts,
		entities,
		self_model_updates,
		stored: significant || facts.length > 0,
		engine_used: ctx.engine.name,
		rubric: analysis.rubric,
	};
}

/** Compact episodic content: what happened, not a transcript dump. */
function summarizeInteraction(user: string, agent: string): string {
	const u = user.replace(/\s+/g, " ").trim().slice(0, 240);
	const a = agent.replace(/\s+/g, " ").trim().slice(0, 240);
	return `Human: ${u}\nMe: ${a}`;
}

/**
 * Fact conflict detection: a near-duplicate with different content supersedes
 * the old fact (superseded_by chain), keeping provenance. Exact duplicates
 * fold into the existing entry. Returns "duplicate" when the incoming entry
 * must not be stored.
 */
function resolveConflict(store: MemoryStore, incoming: MemoryEntry): "stored" | "superseded" | "duplicate" {
	for (const existing of store.filter({ layer: "semantic", include_superseded: true })) {
		if (existing.id === incoming.id) continue;
		const overlap = tokenOverlap(existing.content, incoming.content);
		if (overlap >= 0.7 && existing.content !== incoming.content) {
			store.supersede(existing.id, incoming);
			incoming.confidence = Math.min(1, existing.confidence + 0.05);
			return "superseded";
		}
		if (existing.content === incoming.content) {
			existing.access_count += 1;
			existing.importance = Math.max(existing.importance, incoming.importance);
			return "duplicate";
		}
	}
	return "stored";
}

function updateGraph(
	graph: GraphFile,
	entities: Array<{ name: string; entity_type: string }>,
	episodic: MemoryEntry | null,
): void {
	const seen = entities.map((e) => e.name);
	const ts = episodic?.created_at ?? nowIso();
	for (const entity of entities) {
		const node: GraphEntity = graph.entities[entity.name] ?? {
			name: entity.name,
			entity_type: entity.entity_type,
			relationships: [],
		};
		node.entity_type = entity.entity_type;
		graph.entities[entity.name] = node;
	}
	// Co-occurrence edges with temporal validity windows.
	for (let i = 0; i < seen.length; i++) {
		for (let j = 0; j < seen.length; j++) {
			if (i === j) continue;
			const source = graph.entities[seen[i]!]!;
			const target = seen[j]!;
			const existing = source.relationships.find((r) => r.target === target && !r.valid_to);
			if (existing) continue;
			for (const rel of source.relationships) {
				if (rel.target === target && !rel.valid_to) rel.valid_to = ts;
			}
			source.relationships.push({ target, relation: "co_occurs", valid_from: ts });
		}
	}
}

/** Recency-of-thought heuristic used by dream/consolidation. */
export function thematicOverlap(a: string, b: string): number {
	const ta = new Set(tokenize(a));
	const tb = tokenize(b);
	if (ta.size === 0 || tb.length === 0) return 0;
	let hits = 0;
	for (const t of tb) if (ta.has(t)) hits++;
	return hits / Math.min(ta.size, tb.length);
}
