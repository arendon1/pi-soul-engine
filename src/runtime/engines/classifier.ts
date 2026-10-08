/**
 * Classifier client — typed questions over state via pi's classifier models
 * (`ctx.modelRegistry.classify`), which never appear in `/model` and cost input
 * tokens only (output is free on every classifier in the catalog).
 *
 * Important: `classify()` does NOT throw on provider errors. It returns
 * `stopReason: "stop" | "error" | "aborted"` plus `errorMessage`, so callers
 * must inspect the result — that responsibility lives here.
 */

export type ClassifierQuestion =
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] }
	| { type: "bool"; instructions: string; criteria: { true: string; false: string } };

export type ClassifierAnswer =
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "score"; score: number; confidence: number }
	| { type: "bool"; probability: number };

export interface ClassifierResponse {
	answers: Record<string, ClassifierAnswer>;
	usage: { input: number; output: number; cost: number };
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
}

export interface ClassifierClient {
	readonly label: string;
	/** Cheap pre-flight: are credentials configured for this classifier? */
	available(): boolean;
	classify(
		state: Record<string, unknown>,
		questions: Record<string, ClassifierQuestion>,
		opts?: { signal?: AbortSignal },
	): Promise<ClassifierResponse>;
}

/** The answer's own confidence, normalised per answer type. */
export function answerConfidence(answer: ClassifierAnswer | undefined): number {
	if (!answer) return 0;
	if (answer.type === "bool") return Math.max(answer.probability, 1 - answer.probability);
	return Number.isFinite(answer.confidence) ? answer.confidence : 0;
}

/** Map a `score` answer (ordered scale index) onto a 0..1 value. */
export function scoreToUnit(answer: ClassifierAnswer | undefined, levels: number): number | null {
	if (!answer || answer.type !== "score") return null;
	if (levels <= 1) return null;
	const clamped = Math.min(Math.max(answer.score, 0), levels - 1);
	return clamped / (levels - 1);
}

/** Map a `score` answer onto -1..1 (for valence). */
export function scoreToSigned(answer: ClassifierAnswer | undefined, levels: number): number | null {
	const unit = scoreToUnit(answer, levels);
	return unit === null ? null : unit * 2 - 1;
}

// ── pi-backed implementation ────────────────────────────────────────────────

/** The subset of pi's ModelRegistry that the classifier client needs. */
export interface ClassifierRegistryLike {
	classify(
		model: unknown,
		context: { state: Record<string, unknown>; questions: Record<string, ClassifierQuestion> },
		options?: unknown,
	): Promise<{
		answers?: Record<string, ClassifierAnswer>;
		usage?: { input?: number; output?: number; cost?: { total?: number } };
		stopReason?: string;
		errorMessage?: string;
	}>;
}

/**
 * Wraps `ctx.modelRegistry.classify()`.
 *
 * `classify()` reports provider problems through `stopReason`/`errorMessage`
 * instead of throwing, so both paths are normalised here — the router then
 * treats an error response exactly like a failed tier.
 */
export class PiClassifierClient implements ClassifierClient {
	private readonly registry: ClassifierRegistryLike;
	private readonly model: unknown;
	readonly label: string;
	private readonly authed: boolean;

	constructor(registry: ClassifierRegistryLike, model: unknown, label: string, authed = true) {
		this.registry = registry;
		this.model = model;
		this.label = label;
		this.authed = authed;
	}

	available(): boolean {
		return this.authed;
	}

	async classify(
		state: Record<string, unknown>,
		questions: Record<string, ClassifierQuestion>,
		opts?: { signal?: AbortSignal },
	): Promise<ClassifierResponse> {
		try {
			const response = await this.registry.classify(this.model, { state, questions }, { signal: opts?.signal });
			const stopReason =
				response.stopReason === "error" || response.stopReason === "aborted" ? response.stopReason : "stop";
			return {
				answers: response.answers ?? {},
				usage: {
					input: response.usage?.input ?? 0,
					output: response.usage?.output ?? 0,
					cost: response.usage?.cost?.total ?? 0,
				},
				stopReason,
				errorMessage: response.errorMessage,
			};
		} catch (err) {
			return {
				answers: {},
				usage: { input: 0, output: 0, cost: 0 },
				stopReason: opts?.signal?.aborted ? "aborted" : "error",
				errorMessage: (err as Error).message ?? String(err),
			};
		}
	}
}
