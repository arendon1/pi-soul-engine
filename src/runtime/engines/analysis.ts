/**
 * AnalysisService — one batched call per exchange instead of 2–5.
 *
 * Typed tasks (sentiment, significance, self-model domain, rubric scores) go to a
 * classifier: `choice`/`score`/`bool` questions answered in a single request, with
 * per-answer confidence and free output tokens. Generative tasks (facts, entities)
 * go to the cheap chat tier. Every field has a deterministic heuristic baseline,
 * and a missing or low-confidence answer falls back **per field**, never wholesale.
 */
import type { SomaticMarker } from "../../spec/types.ts";
import type { CognitiveEngine } from "./engine.ts";
import { HeuristicEngine } from "./heuristic.ts";
import {
	answerConfidence,
	scoreToSigned,
	scoreToUnit,
	type ClassifierAnswer,
	type ClassifierClient,
	type ClassifierQuestion,
} from "./classifier.ts";
import { entitiesPrompt, extractionPrompt, sentimentPrompt, significancePrompt } from "./prompts.ts";
import {
	asNumber,
	clamp,
	clampSigned,
	clampUnit,
	sanitizeMemoryText,
	truncateToTokens,
	tryJson,
} from "./validate.ts";

export interface ExtractedFact {
	content: string;
	entities: string[];
	importance: number;
}

export interface ExtractedEntity {
	name: string;
	entity_type: string;
}

export type AnalysisSource = "classifier" | "model" | "heuristic";

export interface ExchangeAnalysis {
	somatic: SomaticMarker;
	significance: {
		novelty: number;
		emotional_intensity: number;
		goal_relevance: number;
		content_richness: number;
	};
	facts: ExtractedFact[];
	entities: ExtractedEntity[];
	domain: string | null;
	rubric: { criteria: Record<string, number>; overall: number } | null;
	sources: Record<string, AnalysisSource>;
	/** True when at least one field fell back from its preferred source. */
	degraded: boolean;
}

export interface AnalysisInput {
	user: string;
	agent: string;
	knownDomains?: string[];
	rubricCriteria?: string[];
	signal?: AbortSignal;
}

export interface AnalysisOptions {
	classifier?: ClassifierClient | null;
	/** Chat tier for generative tasks (usually the router). */
	engine?: CognitiveEngine | null;
	heuristic?: HeuristicEngine;
	/** Below this confidence a classifier answer is discarded for that field. */
	confidenceFloor?: number;
	/**
	 * Which criteria the classifier scores: `hybrid` (default) asks only for the
	 * criteria heuristics are weak at, `classifier` asks for all, `heuristic`
	 * asks for none.
	 */
	rubricScoring?: "hybrid" | "classifier" | "heuristic";
	factsMode?: "heuristic" | "model";
	/** Token budget for the state sent to a classifier. */
	maxStateTokens?: number;
	/** Character cap applied to raw exchange text before *any* analysis work. */
	maxInputChars?: number;
}

const VALENCE_LEVELS = ["very negative", "negative", "neutral", "positive", "very positive"];
const AROUSAL_LEVELS = ["calm", "mildly engaged", "animated", "intense"];
const INTENSITY_LEVELS = ["none", "low", "moderate", "high"];
const LABELS = ["neutral", "joy", "curiosity", "contentment", "concern", "frustration", "sadness", "surprise"];

/**
 * Criteria the heuristics already measure well (word count, token overlap).
 * Asking a classifier for these spends tokens to get a coarser answer, so in
 * `hybrid` mode they stay heuristic and only the criteria heuristics are weak
 * at (specificity, empathy, originality, clarity) go to the classifier.
 */
export const HEURISTIC_STRONG_CRITERIA = new Set(["completeness", "relevance", "helpfulness"]);

function labelCriteria(): Record<string, string> {
	return {
		neutral: "no strong feeling either way",
		joy: "happiness, delight, relief, celebration",
		curiosity: "interest, wanting to understand, exploration",
		contentment: "satisfied, calm, mildly positive",
		concern: "worry, unease, mild anxiety",
		frustration: "annoyance, irritation, blocked progress",
		sadness: "disappointment, loss, deflation",
		surprise: "unexpected, startling",
	};
}

export class AnalysisService {
	private classifier: ClassifierClient | null;
	private engine: CognitiveEngine | null;
	private heuristic: HeuristicEngine;
	private confidenceFloor: number;
	private rubricScoring: "hybrid" | "classifier" | "heuristic";
	private factsMode: "heuristic" | "model";
	private maxStateTokens: number;
	private maxInputChars: number;
	/**
	 * Why the last classifier batch produced what it did. Classifier calls do not
	 * go through the router, so this is the only place their outcome is visible;
	 * it is recorded with each evaluation so silent fallbacks are diagnosable.
	 */
	private lastClassifierOutcome: {
		attempted: boolean;
		stopReason?: string;
		errorMessage?: string;
		answered?: number;
		dropped?: string[];
	} = { attempted: false };

	constructor(options: AnalysisOptions = {}) {
		this.classifier = options.classifier ?? null;
		this.engine = options.engine ?? null;
		this.heuristic = options.heuristic ?? new HeuristicEngine();
		this.confidenceFloor = options.confidenceFloor ?? 0.4;
		this.rubricScoring = options.rubricScoring ?? "hybrid";
		this.factsMode = options.factsMode ?? "model";
		this.maxStateTokens = options.maxStateTokens ?? 1200;
		// Bounds every downstream step (heuristic tokenisation included) so a
		// pasted megabyte cannot stall the observation queue.
		this.maxInputChars = options.maxInputChars ?? 6000;
	}

	private cap(text: string): string {
		return text.length > this.maxInputChars ? text.slice(0, this.maxInputChars) : text;
	}

	/** Criteria a classifier should actually be asked to score. */
	private classifierCriteria(criteria: string[] | undefined): string[] {
		if (!criteria || criteria.length === 0) return [];
		if (this.rubricScoring === "heuristic") return [];
		if (this.rubricScoring === "classifier") return criteria;
		const weak = criteria.filter((c) => !HEURISTIC_STRONG_CRITERIA.has(c));
		return weak.length > 0 ? weak : criteria;
	}

	/** Update the chat tier (e.g. when the router is rebuilt). */
	setEngine(engine: CognitiveEngine | null): void {
		this.engine = engine;
	}

	/** Outcome of the most recent classifier batch (for diagnostics/auditing). */
	get classifierOutcome(): {
		attempted: boolean;
		stopReason?: string;
		errorMessage?: string;
		answered?: number;
		dropped?: string[];
	} {
		return this.lastClassifierOutcome;
	}

	async analyze(input: AnalysisInput): Promise<ExchangeAnalysis> {
		const sources: Record<string, AnalysisSource> = {};
		// Bound the raw text once, so heuristics, extraction and the classifier
		// state all work on the same (bounded) view of the exchange.
		const bounded: AnalysisInput = { ...input, user: this.cap(input.user), agent: this.cap(input.agent) };
		const heuristic = this.heuristicBaselines(bounded);
		Object.assign(sources, heuristic.sources);

		// Classifier batch and generative extraction are independent → run together.
		const [classified, extracted] = await Promise.all([
			this.runClassifier(bounded),
			this.runExtraction(bounded),
		]);

		let degraded = false;

		const somatic: SomaticMarker = {
			valence: clampSigned(classified.valence ?? heuristic.somatic.valence),
			arousal: clampUnit(classified.arousal ?? heuristic.somatic.arousal),
			label: classified.label ?? heuristic.somatic.label,
		};
		const sentimentFromClassifier =
			classified.valence !== null && classified.arousal !== null && classified.label !== null;
		sources.sentiment = sentimentFromClassifier ? "classifier" : "heuristic";

		const significance = {
			novelty: clampUnit(classified.novelty ?? heuristic.significance.novelty),
			emotional_intensity: clampUnit(classified.emotional_intensity ?? heuristic.significance.emotional_intensity),
			goal_relevance: clampUnit(classified.goal_relevance ?? heuristic.significance.goal_relevance),
			content_richness: clampUnit(classified.content_richness ?? heuristic.significance.content_richness),
		};
		sources.significance = classified.significanceUsed === "heuristic" ? "heuristic" : "classifier";
		// A configured classifier that failed or answered unreliably means the
		// analysis is degraded, even though it still produced a usable result.
		if (classified.attempted && (!sentimentFromClassifier || classified.significanceUsed !== "classifier")) {
			degraded = true;
		}

		let domain: string | null = null;
		if (input.knownDomains && input.knownDomains.length > 0) {
			domain = classified.domain ?? null;
			sources.domain = classified.domain !== null ? "classifier" : "heuristic";
		}

		return {
			somatic,
			significance,
			facts: extracted.facts,
			entities: extracted.entities,
			domain,
			rubric: classified.rubric,
			sources,
			degraded: degraded || extracted.degraded,
		};
	}

	/** Classifier-scored rubric (null when no classifier or no criteria given). */
	async scoreRubric(input: AnalysisInput): Promise<{ criteria: Record<string, number>; overall: number } | null> {
		if (!input.rubricCriteria || input.rubricCriteria.length === 0) return null;
		const classified = await this.runClassifier(input, input.rubricCriteria);
		return classified.rubric;
	}

	// ── classifier batch ────────────────────────────────────────────────────

	private async runClassifier(
		input: AnalysisInput,
		rubricCriteria?: string[],
	): Promise<{
		used: boolean;
		valence: number | null;
		arousal: number | null;
		label: string | null;
		novelty: number | null;
		emotional_intensity: number | null;
		goal_relevance: number | null;
		content_richness: number | null;
		domain: string | null;
		rubric: { criteria: Record<string, number>; overall: number } | null;
		significanceUsed: "classifier" | "partial" | "heuristic";
		/** The classifier was configured and actually called (so failure = degraded). */
		attempted: boolean;
	}> {
		const empty = {
			used: false,
			attempted: false,
			valence: null,
			arousal: null,
			label: null,
			novelty: null,
			emotional_intensity: null,
			goal_relevance: null,
			content_richness: null,
			domain: null,
			rubric: null,
			significanceUsed: "heuristic" as const,
		};
		if (!this.classifier || !this.classifier.available()) {
			this.lastClassifierOutcome = { attempted: false, stopReason: "unavailable" };
			return empty;
		}

		const exchange = truncateToTokens(`HUMAN: ${input.user}\nAGENT: ${input.agent}`, this.maxStateTokens);
		const questions: Record<string, ClassifierQuestion> = {
			valence: {
				type: "score",
				instructions: "How positive or negative is the human's feeling in this exchange?",
				criteria: VALENCE_LEVELS,
			},
			arousal: {
				type: "score",
				instructions: "How emotionally intense or activated is this exchange?",
				criteria: AROUSAL_LEVELS,
			},
			label: {
				type: "choice",
				instructions: "Which single emotion label best fits the human here?",
				criteria: labelCriteria(),
			},
			novelty: { type: "score", instructions: "How new or unexpected is this exchange?", criteria: INTENSITY_LEVELS },
			emotional_intensity: {
				type: "score",
				instructions: "How strong is the emotional charge of this exchange?",
				criteria: INTENSITY_LEVELS,
			},
			goal_relevance: {
				type: "score",
				instructions: "How relevant is this to the human's stated goals or ongoing work?",
				criteria: INTENSITY_LEVELS,
			},
			content_richness: {
				type: "score",
				instructions: "How much substance and detail does this exchange contain?",
				criteria: INTENSITY_LEVELS,
			},
		};
		if (input.knownDomains && input.knownDomains.length > 0) {
			questions.domain = {
				type: "choice",
				instructions: "Which of the soul's self-concept domains does this exchange give evidence for?",
				criteria: Object.fromEntries([
					...input.knownDomains.map((d) => [d, `evidence for ${d.replace(/_/g, " ")}`]),
					["none", "no clear domain evidence"],
				]),
			};
		}
		const criteria = this.classifierCriteria(rubricCriteria ?? input.rubricCriteria);
		for (const criterion of criteria) {
			questions[`rubric_${criterion}`] = {
				type: "score",
				instructions: `Score the agent's ${criterion.replace(/_/g, " ")} on this exchange.`,
				criteria: ["poor", "fair", "good", "excellent"],
			};
		}

		let answers: Record<string, ClassifierAnswer>;
		try {
			const response = await this.classifier.classify({ exchange }, questions, { signal: input.signal });
			if (response.stopReason === "aborted" && input.signal?.aborted) {
				throw new Error("aborted");
			}
			if (response.stopReason !== "stop") {
				// Configured and called, but unusable → the analysis is degraded.
				this.lastClassifierOutcome = {
					attempted: true,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage,
				};
				return { ...empty, attempted: true };
			}
			answers = response.answers ?? {};
		} catch (err) {
			if (input.signal?.aborted) throw err;
			this.lastClassifierOutcome = { attempted: true, stopReason: "threw", errorMessage: (err as Error).message };
			return { ...empty, attempted: true };
		}

		const floor = this.confidenceFloor;
		const droppedAnswers: string[] = [];
		const take = <T>(id: string, mapper: (a: ClassifierAnswer) => T | null): T | null => {
			const answer = answers[id];
			if (!answer) {
				droppedAnswers.push(`${id}:no-answer`);
				return null;
			}
			const confidence = answerConfidence(answer);
			if (confidence < floor) {
				droppedAnswers.push(`${id}:confidence=${confidence.toFixed(2)}<${floor}`);
				return null;
			}
			return mapper(answer);
		};

		const rubric = criteria.length > 0 ? this.collectRubric(answers, criteria, floor) : null;
		const value = (id: string): number | null => take(id, (a) => scoreToUnit(a, INTENSITY_LEVELS.length));
		const novelty = value("novelty");
		const emotional_intensity = value("emotional_intensity");
		const goal_relevance = value("goal_relevance");
		const content_richness = value("content_richness");
		const scored = [novelty, emotional_intensity, goal_relevance, content_richness].filter((v) => v !== null).length;
		const significanceUsed = scored === 4 ? "classifier" : scored > 0 ? "partial" : "heuristic";

		const result = {
			used: true,
			attempted: true,
			valence: take("valence", (a) => scoreToSigned(a, VALENCE_LEVELS.length)),
			arousal: take("arousal", (a) => scoreToUnit(a, AROUSAL_LEVELS.length)),
			label: take("label", (a) => (a.type === "choice" ? a.choice : null)),
			novelty,
			emotional_intensity,
			goal_relevance,
			content_richness,
			domain:
				input.knownDomains && input.knownDomains.length > 0
					? take("domain", (a) => (a.type === "choice" ? (a.choice === "none" ? null : a.choice) : null))
					: null,
			rubric,
			significanceUsed,
		};
		// Recorded after the field reads above, so per-field drop reasons are included.
		this.lastClassifierOutcome = {
			attempted: true,
			stopReason: "stop",
			answered: Object.keys(answers).length,
			dropped: [...droppedAnswers, ...this.lastRubricDropped],
		};
		return result;
	}

	private lastRubricDropped: string[] = [];

	private collectRubric(
		answers: Record<string, ClassifierAnswer>,
		criteria: string[],
		floor: number,
	): { criteria: Record<string, number>; overall: number } | null {
		const scores: Record<string, number> = {};
		const dropped: string[] = [];
		for (const criterion of criteria) {
			const answer = answers[`rubric_${criterion}`];
			if (!answer) {
				dropped.push(`${criterion}:no-answer`);
				continue;
			}
			const confidence = answerConfidence(answer);
			if (confidence < floor) {
				dropped.push(`${criterion}:confidence=${confidence.toFixed(2)}<${floor}`);
				continue;
			}
			const unit = scoreToUnit(answer, 4);
			if (unit !== null) scores[criterion] = clampUnit(unit);
			else dropped.push(`${criterion}:unusable-answer`);
		}
		this.lastRubricDropped = dropped;
		if (Object.keys(scores).length === 0) return null;
		const values = Object.values(scores);
		return { criteria: scores, overall: values.reduce((a, b) => a + b, 0) / values.length };
	}

	// ── generative extraction (facts + entities in one call) ────────────────

	private async runExtraction(input: AnalysisInput): Promise<{
		facts: ExtractedFact[];
		entities: ExtractedEntity[];
		degraded: boolean;
	}> {
		const heuristic = this.heuristicExtraction(input);
		if (this.factsMode !== "model" || !this.engine) {
			return { ...heuristic, degraded: false };
		}
		try {
			const text = await this.engine.think(extractionPrompt(input.user, input.agent), {
				json: true,
				signal: input.signal,
			});
			const parsed = tryJson<{
				facts?: Array<{ content?: unknown; entities?: unknown; importance?: unknown }>;
				entities?: Array<{ name?: unknown; entity_type?: unknown }>;
			}>(text);
			if (!parsed) {
				return { ...heuristic, degraded: true };
			}
			const facts = this.validateFacts(parsed.facts);
			const entities = this.validateEntities(parsed.entities);
			return {
				facts: facts.length > 0 ? facts : heuristic.facts,
				entities: entities.length > 0 ? entities : heuristic.entities,
				degraded: facts.length === 0 || entities.length === 0,
			};
		} catch (err) {
			if (input.signal?.aborted) throw err;
			return { ...heuristic, degraded: true };
		}
	}

	private validateFacts(raw: unknown): ExtractedFact[] {
		if (!Array.isArray(raw)) return [];
		const out: ExtractedFact[] = [];
		for (const item of raw.slice(0, 8)) {
			const record = item as { content?: unknown; entities?: unknown; importance?: unknown };
			const content = sanitizeMemoryText(String(record.content ?? ""), 400);
			if (content.length < 5) continue;
			out.push({
				content,
				entities: Array.isArray(record.entities)
					? record.entities.slice(0, 6).map((e) => String(e).slice(0, 60))
					: [],
				importance: clamp(Math.round(asNumber(record.importance, 5)), 1, 10),
			});
		}
		return out;
	}

	private validateEntities(raw: unknown): ExtractedEntity[] {
		if (!Array.isArray(raw)) return [];
		const out: ExtractedEntity[] = [];
		for (const item of raw.slice(0, 12)) {
			const record = item as { name?: unknown; entity_type?: unknown };
			const name = String(record.name ?? "").trim().slice(0, 60);
			if (name.length < 2) continue;
			out.push({ name, entity_type: String(record.entity_type ?? "topic").slice(0, 30) });
		}
		return out;
	}

	// ── heuristic baselines ─────────────────────────────────────────────────

	private heuristicBaselines(input: AnalysisInput): {
		somatic: SomaticMarker;
		significance: { novelty: number; emotional_intensity: number; goal_relevance: number; content_richness: number };
		sources: Record<string, AnalysisSource>;
	} {
		const somatic =
			tryJson<SomaticMarker>(this.heuristic.thinkSync(sentimentPrompt(input.user, input.agent))) ?? {
				valence: 0,
				arousal: 0,
				label: "neutral",
			};
		const sig =
			tryJson<{
				novelty?: number;
				emotional_intensity?: number;
				goal_relevance?: number;
				content_richness?: number;
			}>(this.heuristic.thinkSync(significancePrompt(input.user, input.agent))) ?? {};
		return {
			somatic: {
				valence: clampSigned(somatic.valence ?? 0),
				arousal: clampUnit(somatic.arousal ?? 0),
				label: String(somatic.label ?? "neutral"),
			},
			significance: {
				novelty: clampUnit(sig.novelty ?? 0),
				emotional_intensity: clampUnit(sig.emotional_intensity ?? 0),
				goal_relevance: clampUnit(sig.goal_relevance ?? 0),
				content_richness: clampUnit(sig.content_richness ?? 0),
			},
			sources: {},
		};
	}

	private heuristicExtraction(input: AnalysisInput): { facts: ExtractedFact[]; entities: ExtractedEntity[] } {
		const factsRaw =
			tryJson<{ facts?: Array<{ content?: unknown; entities?: unknown; importance?: unknown }> }>(
				this.heuristic.thinkSync(extractionPrompt(input.user, input.agent)),
			) ?? {};
		const entitiesRaw =
			tryJson<{ entities?: Array<{ name?: unknown; entity_type?: unknown }> }>(
				this.heuristic.thinkSync(entitiesPrompt(`${input.user}\n${input.agent}`)),
			) ?? {};
		return {
			facts: this.validateFacts(factsRaw.facts),
			entities: this.validateEntities(entitiesRaw.entities),
		};
	}
}
