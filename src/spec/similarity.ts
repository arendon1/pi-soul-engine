/**
 * Similarity functions with dimension guards (spec/): mismatched vector
 * lengths raise instead of silently truncating.
 */
export type SimilarityMetric = "cosine" | "euclidean" | "dot";

function guard(a: readonly number[], b: readonly number[]): void {
	if (a.length !== b.length) {
		throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
	}
	if (a.length === 0) throw new Error("Cannot compare empty vectors");
}

export function dot(a: readonly number[], b: readonly number[]): number {
	guard(a, b);
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
	return sum;
}

export function magnitude(a: readonly number[]): number {
	let sum = 0;
	for (const x of a) sum += x * x;
	return Math.sqrt(sum);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
	guard(a, b);
	const denom = magnitude(a) * magnitude(b);
	if (denom === 0) return 0;
	return dot(a, b) / denom;
}

export function euclidean(a: readonly number[], b: readonly number[]): number {
	guard(a, b);
	let sum = 0;
	for (let i = 0; i < a.length; i++) {
		const d = a[i]! - b[i]!;
		sum += d * d;
	}
	return Math.sqrt(sum);
}

export function similarity(a: readonly number[], b: readonly number[], metric: SimilarityMetric = "cosine"): number {
	switch (metric) {
		case "cosine":
			return cosine(a, b);
		case "euclidean":
			return euclidean(a, b);
		case "dot":
			return dot(a, b);
		default:
			throw new Error(`Unknown metric: ${metric as string}`);
	}
}
