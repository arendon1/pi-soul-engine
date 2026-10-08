/**
 * Recall — ACT-R ranked retrieval with personality modulation (OCEAN traits
 * influence retrieval ranking) and importance prior.
 */
import type { MemoryEntry, Personality } from "../spec/types.ts";
import { activationOf } from "./activation.ts";
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
	const pool: StoreQuery = {
		query,
		limit: 200,
		user_id: options.user_id ?? null,
		domain: options.domain ?? null,
	};
	void pool;
	const candidates = store.filter({
		user_id: options.user_id ?? null,
		domain: options.domain ?? null,
	});
	const hits: RecallHit[] = [];
	for (const entry of candidates) {
		const parts = activationOf(entry, query);
		const importancePrior = entry.importance / 100; // small stable tiebreaker
		const score = parts.activation * personalityWeight(entry, options.personality) + importancePrior;
		hits.push({ entry, activation: parts.activation, score, parts });
	}
	hits.sort((a, b) => b.score - a.score);
	const minAct = options.min_activation ?? -Infinity;
	return hits.filter((h) => h.activation >= minAct).slice(0, limit);
}
