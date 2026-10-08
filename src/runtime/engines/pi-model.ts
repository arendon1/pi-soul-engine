/**
 * PiModelEngine — CognitiveEngine backed by Pi's own model runtime.
 *
 * The whitepaper's integration contract is one method: `think(prompt) → text`.
 * Pi already runs a brain in-process (ctx.modelRegistry), so the soul uses the
 * session's own model — any provider, zero extra credentials — and falls back
 * to HeuristicEngine when no model is available.
 */
import type { CognitiveEngine, ThinkOptions } from "./engine.ts";
import { HeuristicEngine } from "./heuristic.ts";

/** Minimal model adapter so the engine is testable without a pi runtime. */
export interface ModelCaller {
	/** Run one completion and return the concatenated text. */
	complete(
		prompt: string,
		opts?: {
			signal?: AbortSignal;
			json?: boolean;
			/** Reports provider token usage so the router can account for cost. */
			onUsage?: (usage: { input: number; output: number; cost: number }) => void;
		},
	): Promise<string>;
	readonly modelLabel: string;
}

export class PiModelEngine implements CognitiveEngine {
	readonly name = "pi-model";
	private fallback = new HeuristicEngine();
	private caller: ModelCaller;

	constructor(caller: ModelCaller) {
		this.caller = caller;
	}

	async think(prompt: string, opts?: ThinkOptions): Promise<string> {
		try {
			return await this.caller.complete(prompt, { signal: opts?.signal, json: opts?.json });
		} catch (err) {
			if (opts?.signal?.aborted) throw err;
			// Model unavailable or failed → deterministic heuristics. Never crash the pipeline.
			const task = prompt.match(/^TASK:\s*(\w+)/m)?.[1];
			if (task) return this.fallback.thinkSync(prompt);
			throw err;
		}
	}

	get modelLabel(): string {
		return this.caller.modelLabel;
	}
}

/**
 * Hybrid engine: LLM for the tasks where heuristics are weakest (sentiment,
 * significance, reflection), heuristics for the mechanical ones. Cheapest
 * possible token spend per observation.
 */
export class HybridEngine implements CognitiveEngine {
	readonly name = "hybrid";
	private fallback = new HeuristicEngine();
	private caller: ModelCaller;
	private modelTasks: Set<string>;

	constructor(caller: ModelCaller, modelTasks: Set<string> = new Set(["sentiment", "significance", "reflect", "learn"])) {
		this.caller = caller;
		this.modelTasks = modelTasks;
	}

	async think(prompt: string, opts?: ThinkOptions): Promise<string> {
		const task = prompt.match(/^TASK:\s*(\w+)/m)?.[1] ?? "";
		if (!this.modelTasks.has(task)) return this.fallback.thinkSync(prompt);
		try {
			return await this.caller.complete(prompt, { signal: opts?.signal, json: opts?.json });
		} catch (err) {
			if (opts?.signal?.aborted) throw err;
			return this.fallback.thinkSync(prompt);
		}
	}

	get modelLabel(): string {
		return this.caller.modelLabel;
	}
}
