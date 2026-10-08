/**
 * LearningEvent lifecycle + registry — port of `spec/learning.py`.
 *
 * A lesson is not what happened (episodic) or what is known (semantic); it is
 * an insight extracted from *scoring* an interaction. Lessons live in
 * procedural memory, feed skill XP, and — unlike the reference — travel inside
 * the `.soul` file (paper §13 v0.6.0).
 */
import type { LearningEvent } from "../spec/types.ts";

export const CONFIDENCE_STEP = 0.1;

/** Record that a lesson was recalled and used. */
export function applyLearning(event: LearningEvent): void {
	event.applied_count += 1;
}

/** Increase confidence when the lesson proves useful (capped at 1.0). */
export function reinforceLearning(event: LearningEvent, amount = CONFIDENCE_STEP): void {
	event.confidence = Math.min(1, event.confidence + amount);
}

/** Decrease confidence when the lesson proves wrong (floored at 0.0). */
export function weakenLearning(event: LearningEvent, amount = CONFIDENCE_STEP): void {
	event.confidence = Math.max(0, event.confidence - amount);
}

export interface LearningQuery {
	domain?: string;
	minConfidence?: number;
	limit?: number;
}

export class LearningRegistry {
	private events: LearningEvent[];

	constructor(initial: LearningEvent[] = []) {
		this.events = [...initial];
	}

	add(event: LearningEvent): LearningEvent {
		this.events.push(event);
		return event;
	}

	get(id: string): LearningEvent | undefined {
		return this.events.find((e) => e.id === id);
	}

	list(query: LearningQuery = {}): LearningEvent[] {
		let out = [...this.events];
		if (query.domain) out = out.filter((e) => e.domain === query.domain);
		if (query.minConfidence !== undefined) out = out.filter((e) => e.confidence >= query.minConfidence!);
		out.sort((a, b) => b.confidence - a.confidence || b.created_at.localeCompare(a.created_at));
		return query.limit ? out.slice(0, query.limit) : out;
	}

	/** Highest-confidence lessons, for prompt context / status display. */
	top(limit = 3): LearningEvent[] {
		return this.list({ limit });
	}

	reinforce(id: string, amount?: number): boolean {
		const event = this.get(id);
		if (!event) return false;
		reinforceLearning(event, amount);
		return true;
	}

	weaken(id: string, amount?: number): boolean {
		const event = this.get(id);
		if (!event) return false;
		weakenLearning(event, amount);
		return true;
	}

	toJSON(): LearningEvent[] {
		return this.events;
	}
}
