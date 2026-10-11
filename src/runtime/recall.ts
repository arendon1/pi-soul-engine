/**
 * Recall — ACT-R ranked retrieval with personality modulation (OCEAN traits
 * influence retrieval ranking) and importance prior.
 */
import type { MemoryEntry, Personality } from "../spec/types.ts";
import { activationOf } from "./activation.ts";
import { bm25, tokenize } from "../util/text.ts";
import type { MemoryStore, StoreQuery } from "./store.ts";

export interface RecallHit {
	entry: MemoryEntry;
	activation: number;
	score: number;
	parts: { base_level: number; spreading: number; emotional: number; activation: number };
}

export interface RecallOptions {
	limit?: number;
	min_activation?: number;
	personality?: Personality;
	user_id?: string | null;
	domain?: string | null;
}

/**
 * Personality modulation:
 *  - openness ↑ → boost novel/abstract (high significance, low access_count)
 *  - conscientiousness ↑ → boost procedural + high-importance
 *  - neuroticism ↑ → boost negative-valence memories (stickier, per Damasio)
 *  - agreeableness ↑ → boost social/bonded content
 */
function personalityWeight(entry: MemoryEntry, p: Personality | undefined): number {
	if (!p) return 1;
	let w = 1;
	if (p.openness > 0.6 && entry.significance > 0.6 && entry.access_count <= 1) w += 0.1 * (p.openness - 0.6) * 5;
	if (p.conscientiousness > 0.6 && (entry.type === "procedural" || entry.importance >= 7)) {
		w += 0.1 * (p.conscientiousness - 0.6) * 5;
	}
	if (p.neuroticism > 0.6 && (entry.somatic?.valence ?? 0) < -0.2) {
		w += 0.15 * (p.neuroticism - 0.6) * 5;
	}
	if (p.agreeableness > 0.6 && entry.entities.length > 0) {
		w += 0.08 * (p.agreeableness - 0.6) * 5;
	}
	return w;
}

export function recall(store: MemoryStore, query: string, options: RecallOptions = {}): RecallHit[] {
	const limit = options.limit ?? 5;
	const candidates = store.filter({
		user_id: options.user_id ?? null,
		domain: options.domain ?? null,
	});
	// BM25 over the whole pool gives IDF-weighted lexical relevance; the raw
	// tokenOverlap used by `spreading` saturates for short queries, so relevance
	// here gates activation instead of merely tying it.
	const queryTokens = tokenize(query);
	const docs = candidates.map((e) => tokenize(`${e.content} ${e.entities.join(" ")}`));
	const df = new Map<string, number>();
	for (const doc of docs) {
		for (const token of new Set(doc)) df.set(token, (df.get(token) ?? 0) + 1);
	}
	const avgLen = docs.length > 0 ? docs.reduce((n, d) => n + d.length, 0) / docs.length : 0;
	const lexScores = candidates.map((entry, i) => {
		const raw = bm25(queryTokens, docs[i]!, avgLen, candidates.length, df);
		return raw / (raw + 1); // squash to 0..1
	});
	const maxLex = Math.max(0.0001, ...lexScores);
	const hits: RecallHit[] = [];
	for (let i = 0; i < candidates.length; i++) {
		const entry = candidates[i]!;
		const parts = activationOf(entry, query);
		const lex = lexScores[i]! / maxLex; // 0..1, query-differentiating
		// Zero lexical signal → heavy penalty so pure-recency entries can only
		// surface when nothing in the pool matches the query.
		const relevanceGate = lex > 0 ? 0.3 + 0.7 * lex : 0.05;
		const importancePrior = entry.importance / 100; // small stable tiebreaker
		const score =
			parts.activation * personalityWeight(entry, options.personality) * relevanceGate +
			importancePrior * (0.1 + 0.4 * lex);
		hits.push({ entry, activation: parts.activation, score, parts });
	}
	hits.sort((a, b) => b.score - a.score);
	const minAct = options.min_activation ?? -Infinity;
	return hits.filter((h) => h.activation >= minAct).slice(0, limit);
}
