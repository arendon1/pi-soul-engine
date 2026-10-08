/**
 * LIDA significance gate (Franklin, 2003) + Damasio somatic markers.
 *
 *   significance = 0.3×novelty + 0.2×emotional_intensity
 *                + 0.2×goal_relevance + 0.3×content_richness
 *   threshold    = 0.35  (below → no episodic storage)
 */
import type { SomaticMarker, SignificanceScore } from "../spec/types.ts";
import { clamp, keywords, tokenize } from "../util/text.ts";

export const SIGNIFICANCE_THRESHOLD = 0.35;

export const WEIGHTS = {
	novelty: 0.3,
	emotional_intensity: 0.2,
	goal_relevance: 0.2,
	content_richness: 0.3,
} as const;

export function significanceTotal(score: SignificanceScore): number {
	return (
		WEIGHTS.novelty * score.novelty +
		WEIGHTS.emotional_intensity * score.emotional_intensity +
		WEIGHTS.goal_relevance * score.goal_relevance +
		WEIGHTS.content_richness * (score.content_richness ?? 0)
	);
}

export function passesGate(score: SignificanceScore, threshold = SIGNIFICANCE_THRESHOLD): boolean {
	return significanceTotal(score) >= threshold;
}

/** Deterministic content-richness estimate: length + vocabulary breadth. */
export function contentRichness(text: string): number {
	const tokens = tokenize(text);
	if (tokens.length === 0) return 0;
	const breadth = new Set(tokens).size / tokens.length;
	const length = clamp(tokens.length / 80, 0, 1);
	return clamp(0.5 * breadth + 0.5 * length, 0, 1);
}

// ── Somatic marker heuristics (HeuristicEngine support) ─────────────────────

const POSITIVE = new Set([
	"happy", "great", "love", "loved", "excited", "amazing", "wonderful", "fantastic", "good",
	"thanks", "thank", "awesome", "perfect", "excellent", "glad", "proud", "breakthrough",
	"success", "succeeded", "won", "celebrate", "beautiful", "fun", "enjoy", "joy", "promoted",
	"first steps", "milestone", "grateful", "calm", "peaceful", "relieved",
]);
const NEGATIVE = new Set([
	"sad", "angry", "hate", "hated", "terrible", "awful", "bad", "frustrated", "frustrating",
	"annoying", "annoyed", "disappointed", "failed", "failure", "broken", "bug", "crash",
	"stuck", "confused", "confusing", "worried", "anxious", "scared", "afraid", "devastated",
	"cancelled", "lost", "problem", "issue", "pain", "hurt", "wrong", "error", "unfortunately",
]);
const HIGH_AROUSAL = new Set([
	"!", "furious", "ecstatic", "thrilled", "devastated", "outraged", "panicking", "amazing",
	"incredible", "finally", "breakthrough", "promoted", "cancelled", "first steps",
]);

export function heuristicSentiment(text: string): SomaticMarker {
	const lower = text.toLowerCase();
	const tokens = new Set(lower.split(/[^a-z']+/).filter(Boolean));
	let pos = 0;
	let neg = 0;
	for (const token of tokens) {
		if (POSITIVE.has(token)) pos++;
		if (NEGATIVE.has(token)) neg++;
	}
	const valence = clamp((pos - neg) / Math.max(pos + neg, 1), -1, 1);
	let arousal = clamp((pos + neg) / 8, 0, 1);
	for (const marker of HIGH_AROUSAL) {
		if (lower.includes(marker)) {
			arousal = Math.max(arousal, 0.7);
			break;
		}
	}
	if (text.includes("!")) arousal = Math.max(arousal, 0.6);
	if (pos + neg === 0) arousal = Math.min(arousal, 0.1);

	let label = "neutral";
	if (valence >= 0.5) label = "joy";
	else if (valence <= -0.5) label = neg > 1 ? "frustration" : "sadness";
	else if (valence > 0.1) label = "contentment";
	else if (valence < -0.1) label = "concern";
	if (arousal > 0.7 && Math.abs(valence) < 0.3) label = "surprise";
	if (keywords(lower, 3).some((k) => ["learned", "interesting", "curious", "wonder", "how"].includes(k))) {
		label = valence < -0.1 ? label : "curiosity";
	}
	return { valence: clamp(valence, -1, 1), arousal: clamp(arousal, 0, 1), label };
}
