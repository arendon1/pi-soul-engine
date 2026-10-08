/**
 * Rubric-based self-evaluation — port of the reference runtime's
 * `runtime/evaluation.py`.
 *
 * Heuristic only, by design: word counts, token overlap, and keyword detection.
 * No LLM required, deterministic, cheap enough to run on every interaction —
 * which is what feeds the evolution triggers.
 */
import type {
	CriterionResult,
	Interaction,
	LearningEvent,
	Rubric,
	RubricCriterion,
	RubricResult,
} from "../spec/types.ts";
import { newId, nowIso } from "../util/ids.ts";

export const HIGH_SCORE_THRESHOLD = 0.8;
export const LOW_SCORE_THRESHOLD = 0.3;
/** Streak/average thresholds calibrated for heuristic scores (~0.6-0.8 for solid work). */
export const STREAK_SCORE_THRESHOLD = 0.55;
export const TRIGGER_STREAK_LENGTH = 5;
export const MAX_HISTORY = 100;

const STOP_WORDS = new Set([
	"a", "an", "the", "is", "it", "in", "on", "at", "to", "for", "of", "and", "or", "but", "not",
	"with", "this", "that", "was", "are", "be", "has", "had", "do", "did", "will", "can", "i",
	"you", "he", "she", "we", "they", "my", "your", "me",
]);

export const DEFAULT_CRITERIA: RubricCriterion[] = [
	{ name: "completeness", description: "Agent provided a substantive response addressing the user's request", weight: 1.0 },
	{ name: "relevance", description: "Agent response is directly relevant to what the user asked", weight: 1.0 },
	{ name: "helpfulness", description: "Agent response would be useful to the user", weight: 0.8 },
];

function slug(name: string): string {
	return name.toLowerCase().replace(/ /g, "_");
}

function makeRubric(name: string, domain: string, extras: RubricCriterion[]): Rubric {
	return { id: slug(name), name, domain, criteria: [...DEFAULT_CRITERIA, ...extras] };
}

const crit = (name: string, description: string, weight = 1.0): RubricCriterion => ({ name, description, weight });

/**
 * Upstream's six domains, plus rubrics for the remaining self-model domains
 * this runtime can produce, so domain selection always resolves.
 */
export const DEFAULT_RUBRICS: Record<string, Rubric> = {
	technical_helper: makeRubric("technical_helper", "technical_helper", [
		crit("specificity", "Response includes specific technical details, code, or commands"),
	]),
	creative_writer: makeRubric("creative_writer", "creative_writer", [
		crit("originality", "Response shows creative or novel expression"),
	]),
	knowledge_guide: makeRubric("knowledge_guide", "knowledge_guide", [
		crit("clarity", "Response explains concepts clearly and accessibly"),
	]),
	problem_solver: makeRubric("problem_solver", "problem_solver", [
		crit("specificity", "Response includes specific steps, diagnoses, or actionable solutions"),
	]),
	creative_collaborator: makeRubric("creative_collaborator", "creative_collaborator", [
		crit("originality", "Response contributes novel ideas or unexpected angles"),
	]),
	emotional_companion: makeRubric("emotional_companion", "emotional_companion", [
		crit("empathy", "Response acknowledges and validates the user's feelings"),
	]),
	// pi-soul self-model domains (so every emergent domain has a rubric)
	emotional_support: makeRubric("emotional_support", "emotional_support", [
		crit("empathy", "Response acknowledges and validates the user's feelings"),
	]),
	learning_companion: makeRubric("learning_companion", "learning_companion", [
		crit("clarity", "Response explains concepts clearly and accessibly"),
	]),
	planning_partner: makeRubric("planning_partner", "planning_partner", [
		crit("specificity", "Response includes concrete steps, sequencing, or tradeoffs"),
	]),
	research_aide: makeRubric("research_aide", "research_aide", [
		crit("specificity", "Response cites specifics, sources, or comparisons"),
	]),
};

// ── extract the user/agent pair from an Interaction ─────────────────────────

export function interactionPair(interaction: Interaction): { user: string; agent: string } {
	const user = interaction.participants.find((p) => p.role === "user")?.content ?? "";
	const agent = interaction.participants.find((p) => p.role === "agent")?.content ?? "";
	return { user, agent };
}

// ── heuristic scoring functions ─────────────────────────────────────────────

/** Longer responses score higher, up to 20 words = 1.0. */
export function scoreCompleteness(agentOutput: string): number {
	return Math.min(1, agentOutput.split(/\s+/).filter(Boolean).length / 20);
}

/** Token overlap between input and output, excluding stop words; user tokens as denominator. */
export function scoreRelevance(userInput: string, agentOutput: string): number {
	const words = (t: string): Set<string> =>
		new Set(t.split(/\s+/).map((w) => w.toLowerCase()).filter((w) => w && !STOP_WORDS.has(w)));
	const userTokens = words(userInput);
	const agentTokens = words(agentOutput);
	if (userTokens.size === 0 || agentTokens.size === 0) return 0;
	let shared = 0;
	for (const t of userTokens) if (agentTokens.has(t)) shared++;
	return Math.min(1, shared / userTokens.size);
}

/** Average of completeness and relevance, with a positive-sentiment boost. */
export function scoreHelpfulness(completeness: number, relevance: number, sentimentPositive: boolean): number {
	const boost = sentimentPositive ? 1.2 : 1.0;
	return Math.min(1, ((completeness + relevance) / 2) * boost);
}

/** Concrete/specific content markers: acronyms, digits, code-like tokens, long words. */
export function scoreSpecificity(agentOutput: string): number {
	const words = agentOutput.split(/\s+/).filter(Boolean);
	if (words.length === 0) return 0;
	let specific = 0;
	for (const word of words) {
		const hasInnerUpper = /[A-Z]/.test(word.slice(1));
		if (hasInnerUpper) specific++;
		else if (/\d/.test(word)) specific++;
		else if (/[.()_]/.test(word)) specific++;
		else if (word.length >= 6) specific++;
	}
	return Math.min(1, (specific / Math.max(words.length, 1)) * 2);
}

const EMPATHY_MARKERS = [
	"understand", "feel", "sorry", "glad", "appreciate", "hear", "difficult", "tough",
	"hard", "care", "support", "here", "listen", "valid", "okay",
];

/** Check for empathy marker words (3 markers saturate). */
export function scoreEmpathy(agentOutput: string): number {
	const lower = agentOutput.toLowerCase();
	let count = 0;
	for (const marker of EMPATHY_MARKERS) if (lower.includes(marker)) count++;
	return Math.min(1, count / 3);
}

const POSITIVE_WORDS = ["great", "good", "excellent", "helpful", "thanks", "love", "awesome", "perfect", "nice", "wonderful"];
const NEGATIVE_WORDS = ["bad", "wrong", "terrible", "awful", "hate", "useless", "broken", "fail", "error", "bug"];

export function detectPositiveSentiment(text: string): boolean {
	const lower = text.toLowerCase();
	const pos = POSITIVE_WORDS.filter((w) => lower.includes(w)).length;
	const neg = NEGATIVE_WORDS.filter((w) => lower.includes(w)).length;
	return pos > neg;
}

// ── heuristic evaluation ────────────────────────────────────────────────────

export function heuristicEvaluate(interaction: Interaction, rubric: Rubric): RubricResult {
	const { user, agent } = interactionPair(interaction);
	const completeness = scoreCompleteness(agent);
	const relevance = scoreRelevance(user, agent);
	const positive = detectPositiveSentiment(agent);
	const helpfulness = scoreHelpfulness(completeness, relevance, positive);

	const scoreMap: Record<string, number> = {
		completeness,
		relevance,
		helpfulness,
		specificity: scoreSpecificity(agent),
		originality: 0.5, // unknowable heuristically
		clarity: (completeness + relevance) / 2,
		empathy: scoreEmpathy(agent),
	};

	const criterionResults: CriterionResult[] = [];
	let totalWeight = 0;
	let weightedSum = 0;
	for (const criterion of rubric.criteria) {
		const score = scoreMap[criterion.name] ?? 0.5;
		criterionResults.push({
			criterion: criterion.name,
			passed: score >= 0.5,
			score,
			reasoning: `Heuristic score for ${criterion.name}`,
		});
		totalWeight += criterion.weight;
		weightedSum += score * criterion.weight;
	}
	const overall = totalWeight > 0 ? weightedSum / totalWeight : 0;

	let learning = `Scored ${Math.round(overall * 100)}% on ${rubric.name}.`;
	if (criterionResults.length > 0) {
		const best = criterionResults.reduce((a, b) => (b.score > a.score ? b : a));
		const worst = criterionResults.reduce((a, b) => (b.score < a.score ? b : a));
		learning = `Scored ${Math.round(overall * 100)}% on ${rubric.name}. Strongest: ${best.criterion}. Weakest: ${worst.criterion}.`;
	}

	return {
		rubric_id: rubric.id,
		overall_score: overall,
		criterion_results: criterionResults,
		learning,
		timestamp: nowIso(),
	};
}

/** Rubric for a domain (falls back to technical_helper). */
export function rubricFor(domain?: string | null): Rubric {
	const key = domain || "technical_helper";
	return DEFAULT_RUBRICS[key] ?? DEFAULT_RUBRICS.technical_helper ?? Object.values(DEFAULT_RUBRICS)[0]!;
}

/** Criterion names for a domain, used to request classifier scores. */
export function criteriaFor(domain?: string | null): string[] {
	return rubricFor(domain).criteria.map((c) => c.name);
}

/**
 * Merge externally-scored criteria (e.g. classifier) with heuristic scores,
 * so a partially-scored rubric still produces a complete result.
 */
export function buildRubricResult(
	rubric: Rubric,
	scores: Record<string, number>,
	heuristicFallback: RubricResult,
): RubricResult {
	const criterionResults: CriterionResult[] = [];
	let totalWeight = 0;
	let weightedSum = 0;
	for (const criterion of rubric.criteria) {
		const external = scores[criterion.name];
		const fallback = heuristicFallback.criterion_results.find((c) => c.criterion === criterion.name)?.score ?? 0.5;
		const score = Math.min(1, Math.max(0, external ?? fallback));
		criterionResults.push({
			criterion: criterion.name,
			passed: score >= 0.5,
			score,
			reasoning: external !== undefined ? "Classifier score" : "Heuristic score",
		});
		totalWeight += criterion.weight;
		weightedSum += score * criterion.weight;
	}
	const overall = totalWeight > 0 ? weightedSum / totalWeight : 0;
	const best = criterionResults.reduce((a, b) => (b.score > a.score ? b : a));
	const worst = criterionResults.reduce((a, b) => (b.score < a.score ? b : a));
	return {
		rubric_id: rubric.id,
		overall_score: overall,
		criterion_results: criterionResults,
		learning: `Scored ${Math.round(overall * 100)}% on ${rubric.name}. Strongest: ${best.criterion}. Weakest: ${worst.criterion}.`,
		timestamp: nowIso(),
	};
}

// ── the Evaluator ───────────────────────────────────────────────────────────

export interface DomainStats {
	domain: string;
	count: number;
	avg_score: number;
	streak: number;
}

export interface EvolutionTrigger {
	domain: string;
	trigger: "high_performance_streak";
	streak: number;
	avg_score: number;
	reason: string;
}

export class Evaluator {
	private rubrics: Record<string, Rubric>;
	history: RubricResult[] = [];
	private maxHistory = MAX_HISTORY;

	constructor(rubrics?: Record<string, Rubric>, history?: RubricResult[]) {
		this.rubrics = rubrics ?? { ...DEFAULT_RUBRICS };
		if (history) this.history = history.slice(-this.maxHistory);
	}

	/** Score an interaction; auto-selects the rubric from the domain. */
	evaluate(interaction: Interaction, domain?: string | null): RubricResult {
		const rubric = rubricFor(domain);
		const result = heuristicEvaluate(interaction, rubric);
		return this.record(result);
	}

	/** Push an externally-computed result (e.g. classifier-scored) into history. */
	record(result: RubricResult): RubricResult {
		this.history.push(result);
		if (this.history.length > this.maxHistory) this.history = this.history.slice(-this.maxHistory);
		return result;
	}

	/** Average score, count, and consecutive high-score streak for a domain. */
	getDomainStats(domain: string): DomainStats {
		const results = this.history.filter((r) => r.rubric_id === domain);
		if (results.length === 0) return { domain, count: 0, avg_score: 0, streak: 0 };
		const scores = results.map((r) => r.overall_score);
		let streak = 0;
		for (let i = scores.length - 1; i >= 0; i--) {
			if (scores[i]! >= STREAK_SCORE_THRESHOLD) streak++;
			else break;
		}
		return {
			domain,
			count: scores.length,
			avg_score: scores.reduce((a, b) => a + b, 0) / scores.length,
			streak,
		};
	}

	/** Detect patterns in evaluation history that should trigger evolution. */
	checkEvolutionTriggers(): EvolutionTrigger[] {
		const triggers: EvolutionTrigger[] = [];
		for (const domain of new Set(this.history.map((r) => r.rubric_id))) {
			const stats = this.getDomainStats(domain);
			if (stats.streak >= TRIGGER_STREAK_LENGTH && stats.avg_score >= STREAK_SCORE_THRESHOLD) {
				triggers.push({
					domain,
					trigger: "high_performance_streak",
					streak: stats.streak,
					avg_score: stats.avg_score,
					reason:
						`Consistently high performance in ${domain} ` +
						`(${stats.streak} consecutive high scores, avg ${stats.avg_score.toFixed(2)})`,
				});
			}
		}
		return triggers;
	}

	/** Create a LearningEvent from a notably high or low result (else null). */
	createLearningEvent(
		result: RubricResult,
		options: { interactionId?: string | null; domain?: string | null; skillId?: string | null } = {},
	): LearningEvent | null {
		const score = result.overall_score;
		let confidence: number;
		let lesson: string;
		if (score >= HIGH_SCORE_THRESHOLD) {
			confidence = Math.min(1, 0.5 + (score - HIGH_SCORE_THRESHOLD) * 2.5);
			lesson = `Success pattern: ${result.learning}`;
		} else if (score <= LOW_SCORE_THRESHOLD) {
			confidence = Math.min(1, 0.5 + (LOW_SCORE_THRESHOLD - score) * 2.5);
			lesson = `Failure pattern: ${result.learning}`;
		} else {
			return null;
		}
		return {
			id: newId("learn"),
			trigger_interaction_id: options.interactionId ?? null,
			lesson,
			domain: options.domain || result.rubric_id,
			confidence,
			skill_id: options.skillId ?? null,
			evaluation_score: score,
			created_at: nowIso(),
			applied_count: 0,
		};
	}

	toJSON(): { history: RubricResult[] } {
		return { history: this.history };
	}

	static fromJSON(data: { history?: RubricResult[] } | null | undefined, rubrics?: Record<string, Rubric>): Evaluator {
		return new Evaluator(rubrics, data?.history ?? []);
	}
}
