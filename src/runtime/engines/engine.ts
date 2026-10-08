/**
 * CognitiveEngine — the soul's single integration point for cognition.
 *
 * Mirrors the reference runtime: `think(prompt) → text`. One interface, any
 * brain: PiModelEngine (the session's own model), HeuristicEngine (deterministic
 * fallback), or any custom engine.
 */

export interface CognitiveEngine {
	readonly name: string;
	think(prompt: string, opts?: ThinkOptions): Promise<string>;
}

export interface ThinkOptions {
	signal?: AbortSignal;
	/** Hint for engines that support structured output. */
	json?: boolean;
	/** Prefer a cheap/fast model for this call (engine-specific). */
	fast?: boolean;
}

/** Extract the first balanced JSON object/array from model output. */
export function parseJsonLoose<T = unknown>(text: string): T {
	const start = text.search(/[[{]/);
	if (start === -1) throw new Error("No JSON found in engine response");
	const open = text[start]!;
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as T;
		}
	}
	throw new Error("Unbalanced JSON in engine response");
}
