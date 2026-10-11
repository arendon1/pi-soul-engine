/**
 * Text utilities shared by spec + runtime: tokenization, overlap, keywords.
 * Deterministic and dependency-free (heuristicEngine + recall gating rely on these).
 */

const STOPWORDS = new Set([
	"a", "an", "the", "and", "or", "but", "if", "then", "so", "of", "to", "in", "on", "at", "for",
	"with", "about", "as", "by", "from", "is", "are", "was", "were", "be", "been", "being", "am",
	"it", "its", "this", "that", "these", "those", "i", "me", "my", "we", "our", "you", "your",
	"he", "she", "they", "them", "his", "her", "their", "what", "which", "who", "whom", "how",
	"when", "where", "why", "can", "could", "will", "would", "shall", "should", "may", "might",
	"must", "do", "does", "did", "done", "have", "has", "had", "not", "no", "yes", "just",
	"very", "too", "also", "than", "more", "most", "some", "any", "all", "each", "every",
]);

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s_-]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function tokenSet(text: string): Set<string> {
	return new Set(tokenize(text));
}

/** Overlap coefficient between query and content: |∩| / min(|A|,|B|) — the ACT-R spreading term. */
export function tokenOverlap(query: string, content: string): number {
	const a = tokenSet(query);
	const b = tokenSet(content);
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	return shared / Math.min(a.size, b.size);
}

/**
 * BM25 (Okapi) lexical relevance between a tokenized query and a document.
 * k1=1.2, b=0.75 — standard parameters, deterministic, dependency-free.
 * `df` maps token → document frequency across the candidate pool.
 */
export function bm25(
	queryTokens: string[],
	docTokens: string[],
	avgDocLen: number,
	nDocs: number,
	df: Map<string, number>,
): number {
	const k1 = 1.2;
	const b = 0.75;
	if (queryTokens.length === 0 || docTokens.length === 0 || nDocs === 0) return 0;
	const counts = new Map<string, number>();
	for (const token of docTokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	let score = 0;
	for (const token of queryTokens) {
		const freq = counts.get(token);
		if (!freq) continue;
		const docFreq = df.get(token) ?? 0;
		const idf = Math.log(1 + (nDocs - docFreq + 0.5) / (docFreq + 0.5));
		const norm = (freq * (k1 + 1)) /
			(freq + k1 * (1 - b + (b * docTokens.length) / Math.max(avgDocLen, 1)));
		score += idf * norm;
	}
	return score;
}

/** Simple keyword extraction: most frequent non-stopword tokens. */
export function keywords(text: string, limit = 8): string[] {
	const counts = new Map<string, number>();
	for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([token]) => token);
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Rough token estimate (≈4 chars/token) — used for prompt budgets. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
