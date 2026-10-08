/**
 * Embedding providers (spec/): a stable interface plus two dependency-free
 * reference implementations (HashEmbedder, TFIDFEmbedder), mirroring the
 * Python runtime.
 */
import { createHash } from "node:crypto";
import { tokenize } from "../util/text.ts";

export interface EmbeddingProvider {
	readonly dimensions: number;
	embed(text: string): number[];
	embedBatch(texts: string[]): number[][];
}

/** Deterministic MD5-hash embedder. Zero dependencies, stable across runs. */
export class HashEmbedder implements EmbeddingProvider {
	readonly dimensions: number;

	constructor(dimensions = 256) {
		this.dimensions = dimensions;
	}

	embed(text: string): number[] {
		const vec = new Array<number>(this.dimensions).fill(0);
		const tokens = tokenize(text);
		if (tokens.length === 0) return vec;
		for (const token of tokens) {
			const digest = createHash("md5").update(token).digest();
			const idx = digest.readUInt32BE(0) % this.dimensions;
			const sign = digest[4]! % 2 === 0 ? 1 : -1;
			vec[idx] = vec[idx]! + sign;
		}
		const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
		return norm === 0 ? vec : vec.map((x) => x / norm);
	}

	embedBatch(texts: string[]): number[][] {
		return texts.map((t) => this.embed(t));
	}
}

/**
 * Corpus-fitted TF-IDF embedder. Good for domain-specific retrieval without
 * external APIs. Call `fit()` on the corpus before embedding queries.
 */
export class TFIDFEmbedder implements EmbeddingProvider {
	private idf = new Map<string, number>();
	private vocab = new Map<string, number>();
	private fitted = false;

	get dimensions(): number {
		return Math.max(this.vocab.size, 1);
	}

	fit(corpus: string[]): void {
		const df = new Map<string, number>();
		const docs = corpus.map((text) => new Set(tokenize(text)));
		for (const doc of docs) {
			for (const token of doc) df.set(token, (df.get(token) ?? 0) + 1);
		}
		this.vocab.clear();
		this.idf.clear();
		let idx = 0;
		const n = Math.max(docs.length, 1);
		for (const [token, count] of [...df.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			this.vocab.set(token, idx++);
			this.idf.set(token, Math.log((n + 1) / (count + 1)) + 1);
		}
		this.fitted = true;
	}

	private vectorize(tokens: string[]): number[] {
		const vec = new Array<number>(this.vocab.size).fill(0);
		const tf = new Map<string, number>();
		for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
		for (const [token, count] of tf) {
			const idx = this.vocab.get(token);
			if (idx === undefined) continue;
			vec[idx] = (count / tokens.length) * (this.idf.get(token) ?? 1);
		}
		return vec;
	}

	embed(text: string): number[] {
		if (!this.fitted) this.fit([text]);
		const tokens = tokenize(text);
		if (tokens.length === 0) return new Array<number>(this.vocab.size).fill(0);
		return this.vectorize(tokens);
	}

	embedBatch(texts: string[]): number[][] {
		return texts.map((t) => this.embed(t));
	}
}
