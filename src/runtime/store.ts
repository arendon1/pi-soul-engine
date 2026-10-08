/**
 * Layered memory store: JSONL-backed persistence lives elsewhere (soul.ts
 * owns the .soul document); this is the in-memory store with search,
 * access tracking (ACT-R history), conflict supersession, and forget cascades.
 */
import type { MemoryEntry, MemoryLayer, MemoryType } from "../spec/types.ts";
import { tokenOverlap, tokenize } from "../util/text.ts";
import { newId, nowIso } from "../util/ids.ts";

export interface SearchHit {
	entry: MemoryEntry;
	score: number;
}

export interface StoreQuery {
	query?: string;
	limit?: number;
	types?: MemoryType[];
	layer?: MemoryLayer;
	min_importance?: number;
	user_id?: string | null;
	domain?: string | null;
	include_superseded?: boolean;
}

/** BM25-ish lexical scoring (k1=1.5, b=0.75). */
function bm25(queryTokens: string[], entryTokens: string[], avgLen: number, docCount: number, df: Map<string, number>): number {
	const k1 = 1.5;
	const b = 0.75;
	const len = Math.max(entryTokens.length, 1);
	let score = 0;
	const tf = new Map<string, number>();
	for (const t of entryTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
	for (const q of queryTokens) {
		const f = tf.get(q) ?? 0;
		if (f === 0) continue;
		const n = df.get(q) ?? 1;
		const idf = Math.log(1 + (docCount - n + 0.5) / (n + 0.5));
		score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / Math.max(avgLen, 1))));
	}
	return score;
}

export class MemoryStore {
	private layers = new Map<MemoryLayer, MemoryEntry[]>();

	constructor(initial?: Partial<Record<MemoryLayer, MemoryEntry[]>>) {
		if (initial) {
			for (const [layer, entries] of Object.entries(initial)) {
				if (entries) this.layers.set(layer, [...entries]);
			}
		}
	}

	static fromEntries(entries: MemoryEntry[]): MemoryStore {
		const store = new MemoryStore();
		for (const entry of entries) store.store(entry.type, entry);
		return store;
	}

	layerNames(): MemoryLayer[] {
		return [...this.layers.keys()];
	}

	/** Snapshot of all layers (for .soul serialization). */
	entriesByLayer(): Partial<Record<MemoryLayer, MemoryEntry[]>> {
		const out: Partial<Record<MemoryLayer, MemoryEntry[]>> = {};
		for (const [layer, entries] of this.layers) out[layer] = [...entries];
		return out;
	}

	all(): MemoryEntry[] {
		return [...this.layers.values()].flat();
	}

	counts(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const [layer, entries] of this.layers) out[layer] = entries.length;
		return out;
	}

	store(layer: MemoryLayer, entry: MemoryEntry): MemoryEntry {
		const list = this.layers.get(layer) ?? [];
		list.push(entry);
		this.layers.set(layer, list);
		return entry;
	}

	get(id: string): MemoryEntry | undefined {
		return this.all().find((e) => e.id === id);
	}

	delete(id: string): boolean {
		for (const [layer, list] of this.layers) {
			const idx = list.findIndex((e) => e.id === id);
			if (idx !== -1) {
				list.splice(idx, 1);
				this.layers.set(layer, list);
				return true;
			}
		}
		return false;
	}

	/** Mark an entry superseded (fact conflict resolution via superseded_by chain). */
	supersede(oldId: string, replacement: MemoryEntry): boolean {
		const old = this.get(oldId);
		if (!old) return false;
		old.superseded_by = replacement.id;
		return true;
	}

	/** Record an ACT-R access on recall. */
	touch(entry: MemoryEntry): void {
		const now = nowIso();
		entry.access_count += 1;
		entry.last_accessed = now;
		entry.access_timestamps.push(now);
		// Keep the access history bounded (full history matters for the power law,
		// but a few hundred accesses already saturate the sum).
		if (entry.access_timestamps.length > 500) {
			entry.access_timestamps = entry.access_timestamps.slice(-500);
		}
	}

	/** Token-overlap search (spec/ DictMemoryStore semantics) + BM25 blend. */
	search(query: string, limit = 10, layer?: MemoryLayer): SearchHit[] {
		const pool = layer ? (this.layers.get(layer) ?? []) : this.all();
		if (pool.length === 0) return [];
		const queryTokens = tokenize(query);
		if (queryTokens.length === 0) return [];
		const docs = pool.map((e) => tokenize(`${e.content} ${e.entities.join(" ")}`));
		const df = new Map<string, number>();
		for (const doc of docs) {
			for (const token of new Set(doc)) df.set(token, (df.get(token) ?? 0) + 1);
		}
		const avgLen = docs.reduce((n, d) => n + d.length, 0) / docs.length;

		const hits: SearchHit[] = [];
		for (let i = 0; i < pool.length; i++) {
			const entry = pool[i]!;
			if (entry.superseded_by) continue;
			const overlap = tokenOverlap(query, entry.content + " " + entry.entities.join(" "));
			const lexical = bm25(queryTokens, docs[i]!, avgLen, pool.length, df);
			if (overlap === 0 && lexical === 0) continue; // no lexical signal → no match
			const normalizedBm25 = lexical / (lexical + 1); // squash to 0..1
			const score = 0.5 * overlap + 0.5 * normalizedBm25 + 0.02 * entry.importance;
			hits.push({ entry, score });
		}
		return hits.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	/** Entries matching a filter, newest first. */
	recent(limit = 10, layer?: MemoryLayer): MemoryEntry[] {
		const pool = layer ? (this.layers.get(layer) ?? []) : this.all();
		return [...pool].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
	}

	filter(q: StoreQuery): MemoryEntry[] {
		let pool = q.layer ? (this.layers.get(q.layer) ?? []) : this.all();
		if (q.types) pool = pool.filter((e) => q.types!.includes(e.type));
		if (q.min_importance !== undefined) pool = pool.filter((e) => e.importance >= q.min_importance!);
		if (q.user_id !== undefined && q.user_id !== null) {
			pool = pool.filter((e) => (e.user_id ?? null) === q.user_id || e.user_id == null);
		}
		if (q.domain !== undefined && q.domain !== null) {
			pool = pool.filter((e) => (e.domain ?? null) === q.domain || e.domain == null);
		}
		if (!q.include_superseded) pool = pool.filter((e) => !e.superseded_by);
		return pool;
	}
}

/** Convenience factory for a new entry with sensible defaults. */
export function makeEntry(partial: Partial<MemoryEntry> & { type: MemoryType; content: string }): MemoryEntry {
	const now = nowIso();
	return {
		id: partial.id ?? newId(partial.type.slice(0, 3)),
		type: partial.type,
		content: partial.content,
		importance: partial.importance ?? 5,
		emotion: partial.emotion ?? null,
		confidence: partial.confidence ?? 1,
		entities: partial.entities ?? [],
		created_at: partial.created_at ?? now,
		last_accessed: partial.last_accessed ?? null,
		access_count: partial.access_count ?? 0,
		somatic: partial.somatic ?? null,
		access_timestamps: partial.access_timestamps ?? [],
		significance: partial.significance ?? 0,
		general_event_id: partial.general_event_id ?? null,
		superseded_by: partial.superseded_by ?? null,
		domain: partial.domain ?? null,
		user_id: partial.user_id ?? null,
	};
}
