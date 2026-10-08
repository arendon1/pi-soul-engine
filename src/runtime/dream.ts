/**
 * dream() — offline consolidation engine ("sleep"), port of `runtime/dream.py`.
 *
 * observe() processes interactions online, one at a time. dream() reviews
 * accumulated episodes in batch:
 *   1. detect recurring patterns (topic clusters, procedures, trends)
 *   2. consolidate memory tiers (archive old, dedupe semantic, prune graph)
 *   3. synthesize cross-tier insights (episodes → procedures, behavior → evolution)
 *
 * Psychology reference: memory consolidation during sleep
 * (Stickgold & Walker, 2013) — episodic replay → semantic extraction →
 * procedural skill formation → pruning.
 */
import type {
	ArchivalRecord,
	DetectedProcedure,
	EvolutionInsight,
	GeneralEvent,
	GraphConsolidation,
	GraphFile,
	MemoryEntry,
	TopicCluster,
} from "../spec/types.ts";
import { makeEntry, type MemoryStore } from "./store.ts";
import { newId, nowIso } from "../util/ids.ts";
import { tokenOverlap, tokenize } from "../util/text.ts";

export const MIN_CLUSTER_SIZE = 3;
export const CLUSTER_THRESHOLD = 0.25;
export const PROCEDURE_MIN_FREQ = 3;
export const ENTITY_MERGE_THRESHOLD = 0.85;
export const DEDUP_THRESHOLD = 0.85;
export const PROCEDURE_DEDUP_THRESHOLD = 0.6;
const ARCHIVE_AGE_DAYS = 30;
const ARCHIVE_MAX_IMPORTANCE = 4;
const MAX_ARCHIVAL_RECORDS = 500;

const PLANNING_KEYWORDS = ["plan", "step", "first", "then", "next", "organize", "schedule", "review", "test"];
const TECHNICAL_KEYWORDS = ["code", "bug", "api", "function", "test", "build", "deploy", "error", "config", "database"];

export interface DreamOptions {
	since?: string;
	archive?: boolean;
	detectPatterns?: boolean;
	synthesize?: boolean;
	consolidateGraph?: boolean;
	dryRun?: boolean;
}

export interface DreamContext {
	store: MemoryStore;
	graph: GraphFile;
	archival: ArchivalRecord[];
	/** Optional: general events, used to seed themes when synthesizing. */
	generalEvents?: GeneralEvent[];
}

export interface DreamReport {
	dreamed_at: string;
	episodes_reviewed: number;
	// phase 2
	topic_clusters: TopicCluster[];
	detected_procedures: DetectedProcedure[];
	behavioral_trends: string[];
	// phase 3
	archived_count: number;
	deduplicated_count: number;
	graph_consolidation: GraphConsolidation;
	// phase 4
	procedures_created: number;
	evolution_insights: EvolutionInsight[];
	duration_ms: number;
	dry_run: boolean;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const t of a) if (b.has(t)) shared++;
	return shared / (a.size + b.size - shared);
}

function ageDays(iso: string, now: number): number {
	return (now - new Date(iso).getTime()) / 86_400_000;
}

// ── Phase 2: pattern detection ──────────────────────────────────────────────

/** Greedy Jaccard clustering of episodes by shared tokens. */
export function detectTopicClusters(episodes: MemoryEntry[]): TopicCluster[] {
	const clusters: Array<{ tokens: Set<string>; episodes: MemoryEntry[] }> = [];

	for (const episode of episodes) {
		const tokens = new Set(tokenize(episode.content));
		if (tokens.size === 0) continue;
		let bestIdx = -1;
		let bestOverlap = 0;
		for (let i = 0; i < clusters.length; i++) {
			const overlap = jaccard(tokens, clusters[i]!.tokens);
			if (overlap > bestOverlap) {
				bestOverlap = overlap;
				bestIdx = i;
			}
		}
		if (bestOverlap >= CLUSTER_THRESHOLD && bestIdx >= 0) {
			const cluster = clusters[bestIdx]!;
			cluster.episodes.push(episode);
			for (const t of tokens) cluster.tokens.add(t);
		} else {
			clusters.push({ tokens, episodes: [episode] });
		}
	}

	const result: TopicCluster[] = [];
	for (const cluster of clusters) {
		const eps = cluster.episodes;
		if (eps.length < MIN_CLUSTER_SIZE) continue;
		const counts = new Map<string, number>();
		for (const ep of eps) {
			for (const t of tokenize(ep.content)) counts.set(t, (counts.get(t) ?? 0) + 1);
		}
		const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
		const times = eps.map((e) => e.created_at).sort();
		result.push({
			topic: top.map(([t]) => t).join(" "),
			episode_ids: eps.map((e) => e.id),
			episode_count: eps.length,
			first_seen: times[0]!,
			last_seen: times[times.length - 1]!,
			representative_content: eps[0]!.content.slice(0, 200),
		});
	}
	return result.sort((a, b) => b.episode_count - a.episode_count);
}

/** Recurring action patterns in agent responses, ready to become procedures. */
export function detectProcedures(episodes: MemoryEntry[]): DetectedProcedure[] {
	const counts = new Map<string, number>();
	const bySignature = new Map<string, string[]>();

	for (const episode of episodes) {
		const parts = episode.content.split(/\n(?:Me|Agent): /);
		if (parts.length < 2) continue;
		const agentOutput = parts.slice(1).join("\n");
		const tokens = tokenize(agentOutput);
		if (tokens.length < 3) continue;
		const signature = [...tokens].sort().slice(0, 6).join(" ");
		if (!signature) continue;
		counts.set(signature, (counts.get(signature) ?? 0) + 1);
		const list = bySignature.get(signature) ?? [];
		list.push(episode.id);
		bySignature.set(signature, list);
	}

	const result: DetectedProcedure[] = [];
	for (const [signature, count] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
		if (count < PROCEDURE_MIN_FREQ) break;
		result.push({
			description: `Recurring pattern (${count}x): ${signature}`,
			source_episode_ids: (bySignature.get(signature) ?? []).slice(0, 10),
			confidence: Math.min(1, count / 10),
			frequency: count,
		});
	}
	return result;
}

/** Compare earlier vs later episodes for notable behavioral shifts. */
export function detectBehavioralTrends(episodes: MemoryEntry[]): string[] {
	if (episodes.length < 6) return [];
	const sorted = [...episodes].sort((a, b) => a.created_at.localeCompare(b.created_at));
	const mid = Math.floor(sorted.length / 2);
	const before = sorted.slice(0, mid);
	const after = sorted.slice(mid);
	const trends: string[] = [];

	const mean = (list: MemoryEntry[], pick: (e: MemoryEntry) => number): number =>
		list.reduce((sum, e) => sum + pick(e), 0) / Math.max(list.length, 1);
	const share = (list: MemoryEntry[], words: string[]): number =>
		list.reduce((sum, e) => {
			const tokens = new Set(tokenize(e.content));
			return sum + (words.some((w) => tokens.has(w)) ? 1 : 0);
		}, 0) / Math.max(list.length, 1);

	const arousalBefore = mean(before, (e) => e.somatic?.arousal ?? 0);
	const arousalAfter = mean(after, (e) => e.somatic?.arousal ?? 0);
	if (Math.abs(arousalAfter - arousalBefore) > 0.15) {
		trends.push(
			arousalAfter > arousalBefore
				? "Increasing emotional intensity"
				: "Calmer, less emotionally charged exchanges",
		);
	}

	const technicalBefore = share(before, TECHNICAL_KEYWORDS);
	const technicalAfter = share(after, TECHNICAL_KEYWORDS);
	if (Math.abs(technicalAfter - technicalBefore) > 0.2) {
		trends.push(technicalAfter > technicalBefore ? "Growing technical focus" : "Declining technical focus");
	}

	const lenBefore = mean(before, (e) => e.content.length);
	const lenAfter = mean(after, (e) => e.content.length);
	if (lenBefore > 0 && Math.abs(lenAfter - lenBefore) / lenBefore > 0.3) {
		trends.push(lenAfter > lenBefore ? "Responses getting longer" : "Responses getting shorter");
	}
	return trends;
}

// ── Phase 3: consolidation ──────────────────────────────────────────────────

/** Move stale, low-value, never-recalled episodes into a compact archival record. */
function archiveOld(ctx: DreamContext, episodes: MemoryEntry[], now: number): number {
	const victims = episodes.filter(
		(e) => ageDays(e.created_at, now) > ARCHIVE_AGE_DAYS && e.importance <= ARCHIVE_MAX_IMPORTANCE && e.access_count === 0,
	);
	if (victims.length === 0) return 0;
	const times = victims.map((v) => v.created_at).sort();
	const summary = victims
		.slice(0, 5)
		.map((v) => v.content.replace(/\s+/g, " ").slice(0, 120))
		.join(" | ");
	ctx.archival.push({
		id: newId("arch"),
		archived_at: nowIso(),
		summary: victims.length > 5 ? `${summary} … (${victims.length} episodes)` : summary,
		episode_ids: victims.map((v) => v.id),
		count: victims.length,
		first: times[0]!,
		last: times[times.length - 1]!,
	});
	if (ctx.archival.length > MAX_ARCHIVAL_RECORDS) {
		ctx.archival.splice(0, ctx.archival.length - MAX_ARCHIVAL_RECORDS);
	}
	for (const victim of victims) ctx.store.delete(victim.id);
	return victims.length;
}

/** Soft-delete near-duplicate semantic facts via superseded_by (audit-friendly). */
function dedupSemantic(ctx: DreamContext): number {
	const facts = ctx.store.filter({ layer: "semantic" });
	let superseded = 0;
	for (let i = 0; i < facts.length; i++) {
		for (let j = i + 1; j < facts.length; j++) {
			const a = facts[i]!;
			const b = facts[j]!;
			if (a.superseded_by || b.superseded_by) continue;
			if (a.content === b.content) {
				// exact duplicate: supersede the older, keep the newer
				const [older, newer] = a.created_at <= b.created_at ? [a, b] : [b, a];
				ctx.store.supersede(older.id, newer);
				superseded++;
				continue;
			}
			if (tokenOverlap(a.content, b.content) >= DEDUP_THRESHOLD) {
				const [older, newer] = a.created_at <= b.created_at ? [a, b] : [b, a];
				ctx.store.supersede(older.id, newer);
				superseded++;
			}
		}
	}
	return superseded;
}

/** Merge duplicate entities, prune duplicate edges, strengthen co-occurrence. */
function consolidateGraph(ctx: DreamContext, episodes: MemoryEntry[]): GraphConsolidation {
	const result: GraphConsolidation = { merged_entities: [], pruned_edges: 0, strengthened_edges: [] };
	const names = Object.keys(ctx.graph.entities);

	// merge near-identical names ("Rust" / "rust", "Acme Corp" / "Acme Corp.")
	for (let i = 0; i < names.length; i++) {
		for (let j = i + 1; j < names.length; j++) {
			const keep = names[i]!;
			const merge = names[j]!;
			const keptNode = ctx.graph.entities[keep];
			const mergedNode = ctx.graph.entities[merge];
			if (!keptNode || !mergedNode) continue;
			const similarity = jaccard(new Set(tokenize(keep.toLowerCase())), new Set(tokenize(merge.toLowerCase())));
			const same = similarity >= ENTITY_MERGE_THRESHOLD || keep.toLowerCase() === merge.toLowerCase();
			if (!same) continue;
			for (const rel of mergedNode.relationships) {
				if (!keptNode.relationships.some((r) => r.target === rel.target && r.relation === rel.relation)) {
					keptNode.relationships.push(rel);
				}
			}
			// repoint references
			for (const node of Object.values(ctx.graph.entities)) {
				for (const rel of node.relationships) {
					if (rel.target === merge) rel.target = keep;
				}
			}
			delete ctx.graph.entities[merge];
			result.merged_entities.push([keep, merge]);
		}
	}

	// prune exact duplicate edges
	for (const node of Object.values(ctx.graph.entities)) {
		const seen = new Set<string>();
		const unique: typeof node.relationships = [];
		for (const rel of node.relationships) {
			const key = `${rel.target}|${rel.relation}|${rel.valid_to ?? ""}`;
			if (seen.has(key)) {
				result.pruned_edges++;
				continue;
			}
			seen.add(key);
			unique.push(rel);
		}
		node.relationships = unique;
	}

	// strengthen frequently co-occurring entity pairs
	const cooccurrence = new Map<string, number>();
	for (const episode of episodes) {
		const present = episode.entities.filter((e) => e in ctx.graph.entities);
		const unique = [...new Set(present)];
		for (let i = 0; i < unique.length; i++) {
			for (let j = i + 1; j < unique.length; j++) {
				const key = `${unique[i]}|${unique[j]}`;
				cooccurrence.set(key, (cooccurrence.get(key) ?? 0) + 1);
			}
		}
	}
	for (const [key, count] of [...cooccurrence.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
		if (count < 3) continue;
		const [a, b] = key.split("|");
		const node = ctx.graph.entities[a!];
		if (!node) continue;
		const relation = `co_occurs (${count}x)`;
		const existing = node.relationships.find((r) => r.target === b && !r.valid_to);
		if (existing) {
			existing.relation = relation;
		} else {
			node.relationships.push({ target: b!, relation, valid_from: episodes[0]?.created_at ?? nowIso() });
		}
		result.strengthened_edges.push([a!, b!, relation]);
	}

	return result;
}

// ── Phase 4: synthesis ──────────────────────────────────────────────────────

/** Convert detected patterns into `[dream]` procedural memories (dedup-aware). */
function synthesizeProcedures(ctx: DreamContext, detected: DetectedProcedure[], dryRun: boolean): number {
	const existing = ctx.store.filter({ layer: "procedural" });
	let created = 0;
	for (const procedure of detected) {
		if (procedure.confidence < 0.3) continue;
		const duplicate = existing.some((e) => tokenOverlap(procedure.description, e.content) >= PROCEDURE_DEDUP_THRESHOLD);
		if (duplicate) continue;
		created++;
		if (dryRun) continue;
		const entry = makeEntry({
			type: "procedural",
			content: `[dream] ${procedure.description}`,
			importance: Math.min(8, Math.max(4, Math.round(procedure.confidence * 8))),
			entities: [],
		});
		ctx.store.store("procedural", entry);
	}
	return created;
}

/** Behavioral patterns → personality drift suggestions. */
export function analyzeEvolution(episodes: MemoryEntry[], clusters: TopicCluster[]): EvolutionInsight[] {
	if (episodes.length < 10) return [];
	const insights: EvolutionInsight[] = [];

	// Openness: topic diversity
	const topicRatio = clusters.length / Math.max(episodes.length, 1);
	if (topicRatio > 0.3) {
		insights.push({
			trait: "personality.openness",
			direction: "increase",
			evidence: `High topic diversity: ${clusters.length} distinct clusters across ${episodes.length} episodes`,
			magnitude: Math.min(0.05, topicRatio * 0.1),
		});
	} else if (topicRatio < 0.05 && episodes.length > 20) {
		insights.push({
			trait: "personality.openness",
			direction: "decrease",
			evidence: `Low topic diversity: only ${clusters.length} clusters across ${episodes.length} episodes`,
			magnitude: 0.02,
		});
	}

	// Conscientiousness: structured/planning behavior
	const planningEpisodes = episodes.filter((e) => {
		const tokens = new Set(tokenize(e.content));
		return PLANNING_KEYWORDS.some((k) => tokens.has(k));
	}).length;
	const planningRatio = planningEpisodes / Math.max(episodes.length, 1);
	if (planningRatio > 0.4) {
		insights.push({
			trait: "personality.conscientiousness",
			direction: "increase",
			evidence: `Frequent structured/planning behavior: ${planningEpisodes}/${episodes.length} episodes`,
			magnitude: Math.min(0.05, planningRatio * 0.08),
		});
	}

	// Extraversion: interaction density
	const sorted = [...episodes].sort((a, b) => a.created_at.localeCompare(b.created_at));
	const spanSeconds = (new Date(sorted[sorted.length - 1]!.created_at).getTime() - new Date(sorted[0]!.created_at).getTime()) / 1000;
	if (spanSeconds > 0) {
		const perHour = episodes.length / (spanSeconds / 3600);
		if (perHour > 10) {
			insights.push({
				trait: "personality.extraversion",
				direction: "increase",
				evidence: `High interaction density: ${perHour.toFixed(1)} episodes/hour`,
				magnitude: 0.03,
			});
		}
	}

	// Neuroticism: share of negatively-valenced episodes
	const withSomatic = episodes.filter((e) => e.somatic);
	if (withSomatic.length >= 5) {
		const negative = withSomatic.filter((e) => (e.somatic!.valence ?? 0) < -0.3).length;
		const negativeRatio = negative / withSomatic.length;
		if (negativeRatio > 0.4) {
			insights.push({
				trait: "personality.neuroticism",
				direction: "increase",
				evidence: `${negative}/${withSomatic.length} episodes carried negative valence`,
				magnitude: Math.min(0.05, negativeRatio * 0.1),
			});
		} else if (negativeRatio < 0.1 && withSomatic.length > 10) {
			insights.push({
				trait: "personality.neuroticism",
				direction: "decrease",
				evidence: `Only ${negative}/${withSomatic.length} episodes carried negative valence`,
				magnitude: 0.02,
			});
		}
	}

	return insights;
}

// ── orchestrator ────────────────────────────────────────────────────────────

export function runDream(ctx: DreamContext, options: DreamOptions = {}): DreamReport {
	const start = Date.now();
	const dryRun = options.dryRun === true;
	const detectPatterns = options.detectPatterns !== false;
	const archive = options.archive !== false;
	const synthesize = options.synthesize !== false;
	const consolidate = options.consolidateGraph !== false;

	const report: DreamReport = {
		dreamed_at: nowIso(),
		episodes_reviewed: 0,
		topic_clusters: [],
		detected_procedures: [],
		behavioral_trends: [],
		archived_count: 0,
		deduplicated_count: 0,
		graph_consolidation: { merged_entities: [], pruned_edges: 0, strengthened_edges: [] },
		procedures_created: 0,
		evolution_insights: [],
		duration_ms: 0,
		dry_run: dryRun,
	};

	// Phase 1: gather (read-only)
	let episodes = ctx.store.filter({ layer: "episodic", include_superseded: true });
	if (options.since) episodes = episodes.filter((e) => e.created_at >= options.since!);
	report.episodes_reviewed = episodes.length;

	// Phase 2: pattern detection (read-only) — needs episodes to exist.
	// Consolidation below runs regardless: semantic facts and the graph are
	// independent of the episodic tier.
	if (detectPatterns && episodes.length > 0) {
		report.topic_clusters = detectTopicClusters(episodes);
		report.detected_procedures = detectProcedures(episodes);
		report.behavioral_trends = detectBehavioralTrends(episodes);
	}

	// Phase 3: consolidate (destructive — counted only on dry runs)
	const now = Date.now();
	if (archive) {
		report.deduplicated_count = dryRun ? countSemanticDuplicates(ctx) : dedupSemantic(ctx);
		report.archived_count = dryRun ? countArchivable(episodes, now) : archiveOld(ctx, episodes, now);
	}
	if (consolidate) {
		report.graph_consolidation = dryRun
			? { merged_entities: [], pruned_edges: countDuplicateEdges(ctx), strengthened_edges: [] }
			: consolidateGraph(ctx, episodes);
	}

	// Phase 4: synthesize (destructive — counted-only on dry runs)
	if (synthesize) {
		report.procedures_created = synthesizeProcedures(ctx, report.detected_procedures, dryRun);
	}
	// evolution analysis is read-only either way
	report.evolution_insights = analyzeEvolution(episodes, report.topic_clusters);

	report.duration_ms = Date.now() - start;
	return report;
}

function countArchivable(episodes: MemoryEntry[], now: number): number {
	return episodes.filter(
		(e) => ageDays(e.created_at, now) > ARCHIVE_AGE_DAYS && e.importance <= ARCHIVE_MAX_IMPORTANCE && e.access_count === 0,
	).length;
}

function countSemanticDuplicates(ctx: DreamContext): number {
	const facts = ctx.store.filter({ layer: "semantic" });
	let count = 0;
	for (let i = 0; i < facts.length; i++) {
		for (let j = i + 1; j < facts.length; j++) {
			const a = facts[i]!;
			const b = facts[j]!;
			if (a.content === b.content || tokenOverlap(a.content, b.content) >= DEDUP_THRESHOLD) count++;
		}
	}
	return count;
}

function countDuplicateEdges(ctx: DreamContext): number {
	let count = 0;
	for (const node of Object.values(ctx.graph.entities)) {
		const seen = new Set<string>();
		for (const rel of node.relationships) {
			const key = `${rel.target}|${rel.relation}|${rel.valid_to ?? ""}`;
			if (seen.has(key)) count++;
			seen.add(key);
		}
	}
	return count;
}

export function dreamSummary(report: DreamReport): string {
	const lines = [`Dream cycle${report.dry_run ? " (dry run)" : ""} — ${report.episodes_reviewed} episodes reviewed`];
	if (report.topic_clusters.length) lines.push(`  topic clusters: ${report.topic_clusters.length}`);
	if (report.detected_procedures.length) lines.push(`  procedures detected: ${report.detected_procedures.length}`);
	if (report.behavioral_trends.length) lines.push(`  trends: ${report.behavioral_trends.join(", ")}`);
	lines.push(
		`  consolidated: ${report.archived_count} archived, ${report.deduplicated_count} deduped, ` +
			`${report.graph_consolidation.merged_entities.length} merged, ${report.graph_consolidation.pruned_edges} edges pruned`,
	);
	lines.push(`  synthesized: ${report.procedures_created} procedures, ${report.evolution_insights.length} evolution insights`);
	return lines.join("\n");
}
