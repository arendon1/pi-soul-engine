/**
 * ACT-R activation decay (Anderson, 1993) — the recall-scoring core.
 *
 *   base_level = ln( Σ t_j^(-0.5) )        power-law decay over access history
 *   spreading  = token_overlap(query, content)
 *   emotional  = arousal + |valence| × 0.3
 *   activation = 1.0 × base + 1.5 × spread + 0.5 × emotional
 *
 * Times t_j are in days since each access and must be > 0; recent accesses are
 * clamped to a small epsilon so a just-formed memory has a finite base level.
 */
import type { MemoryEntry } from "../spec/types.ts";
import { tokenOverlap } from "../util/text.ts";

export const ACT_WEIGHT_BASE = 1.0;
export const ACT_WEIGHT_SPREAD = 1.5;
export const ACT_WEIGHT_EMOTIONAL = 0.5;

const MIN_T_DAYS = 5 / (24 * 60); // 5 minutes in days

export function baseLevel(entry: MemoryEntry, now: number = Date.now()): number {
	const timestamps = entry.access_timestamps.length > 0 ? entry.access_timestamps : [entry.created_at];
	let sum = 0;
	for (const ts of timestamps) {
		const tDays = (now - new Date(ts).getTime()) / 86_400_000;
		const t = Math.max(tDays, MIN_T_DAYS);
		sum += Math.pow(t, -0.5);
	}
	return Math.log(sum);
}

export function spreading(query: string, entry: MemoryEntry): number {
	return tokenOverlap(query, entry.content + " " + entry.entities.join(" "));
}

export function emotionalBoost(entry: MemoryEntry): number {
	if (!entry.somatic) return 0;
	return entry.somatic.arousal + Math.abs(entry.somatic.valence) * 0.3;
}

export interface ActivationParts {
	base_level: number;
	spreading: number;
	emotional: number;
	activation: number;
}

export function activationOf(entry: MemoryEntry, query: string, now: number = Date.now()): ActivationParts {
	const base_level = baseLevel(entry, now);
	const spread = spreading(query, entry);
	const emotional = emotionalBoost(entry);
	return {
		base_level,
		spreading: spread,
		emotional,
		activation:
			ACT_WEIGHT_BASE * base_level + ACT_WEIGHT_SPREAD * spread + ACT_WEIGHT_EMOTIONAL * emotional,
	};
}
