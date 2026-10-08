/**
 * Resilience primitives for the cognitive engine layer.
 *
 * Everything here is time-injectable (`now = Date.now()`) so failure, breaker
 * and budget behaviour is deterministic under test.
 *
 * Failure taxonomy (each class has a distinct response):
 *   abort             — the session/turn was cancelled: never retry, never fall back
 *   auth              — missing/expired credentials: skip the tier entirely
 *   quota             — exhausted allowance/billing: open the breaker, next tier
 *   rate_limit        — 429 with a Retry-After: one jittered retry, then next tier
 *   transient         — 5xx / network / socket: one jittered retry, then next tier
 *   timeout           — our own deadline fired: no retry, next tier
 *   context_overflow  — request too large: retry once shrunk, then next tier
 *   malformed         — unparseable/wrong-shaped output: repair, one retry, then per-field fallback
 *   unknown           — treated as retryable once
 */

export type FailureClass =
	| "abort"
	| "auth"
	| "quota"
	| "rate_limit"
	| "transient"
	| "timeout"
	| "context_overflow"
	| "malformed"
	| "unknown";

/** Thrown when a call was cancelled by the caller's signal. Never converted to a fallback. */
export class EngineAbortError extends Error {
	constructor(message = "cognitive engine call aborted") {
		super(message);
		this.name = "EngineAbortError";
	}
}

/** Thrown when a call exceeded the router's per-tier deadline. */
export class EngineTimeoutError extends Error {
	constructor(message = "cognitive engine call timed out") {
		super(message);
		this.name = "EngineTimeoutError";
	}
}

function messageOf(err: unknown): string {
	if (err instanceof Error) return err.message.toLowerCase();
	if (typeof err === "string") return err.toLowerCase();
	return String(err ?? "").toLowerCase();
}

function statusOf(err: unknown): number {
	const status = (err as { status?: unknown; statusCode?: unknown })?.status ?? (err as { statusCode?: unknown })?.statusCode;
	const n = Number(status);
	return Number.isFinite(n) ? n : 0;
}

export function classifyFailure(err: unknown, sessionSignal?: AbortSignal): FailureClass {
	if (err instanceof EngineAbortError) return "abort";
	if (err instanceof EngineTimeoutError) return "timeout";
	if (sessionSignal?.aborted) return "abort";

	const status = statusOf(err);
	const message = messageOf(err);

	if (status === 401 || status === 403) return "auth";
	if (/unauthor|invalid api key|no credentials|missing credentials|authentication/.test(message)) return "auth";
	if (status === 402) return "quota";
	if (/quota|insufficient|billing|payment required|out of credit|exceeded your current/.test(message)) return "quota";
	if (status === 429 || /rate ?limit|too many requests/.test(message)) return "rate_limit";
	if (status === 408) return "timeout";
	if (/context length|too many tokens|maximum context|context_length|token limit|prompt is too long/.test(message)) {
		return "context_overflow";
	}
	if (/timeout|timed out|etimedout|esockettimedout/.test(message)) return "timeout";
	if (status >= 500 || /server error|overloaded|service unavailable|bad gateway|gateway time|internal error/.test(message)) {
		return "transient";
	}
	if (/econnreset|econnrefused|enotfound|socket hang up|fetch failed|network|epipe|terminated/.test(message)) {
		return "transient";
	}
	return "unknown";
}

/** Only transient classes are worth a second attempt; a timeout or overflow is not. */
export function isRetryable(failure: FailureClass): boolean {
	return failure === "rate_limit" || failure === "transient" || failure === "unknown";
}

export interface FailureCounters {
	abort: number;
	auth: number;
	quota: number;
	rate_limit: number;
	transient: number;
	timeout: number;
	context_overflow: number;
	malformed: number;
	unknown: number;
}

export function zeroFailures(): FailureCounters {
	return {
		abort: 0,
		auth: 0,
		quota: 0,
		rate_limit: 0,
		transient: 0,
		timeout: 0,
		context_overflow: 0,
		malformed: 0,
		unknown: 0,
	};
}

// ── circuit breaker ─────────────────────────────────────────────────────────

export class CircuitBreaker {
	readonly key: string;
	private failures = 0;
	private open = false;
	private openedAt = 0;
	private probing = false;
	private readonly threshold: number;
	private readonly cooldownMs: number;

	constructor(key: string, threshold: number, cooldownMs: number) {
		this.key = key;
		this.threshold = threshold;
		this.cooldownMs = cooldownMs;
	}

	/** Closed → allow. Open past cooldown → allow one half-open probe. */
	allow(now: number = Date.now()): boolean {
		if (!this.open) return true;
		if (now - this.openedAt >= this.cooldownMs) {
			this.probing = true;
			return true;
		}
		return false;
	}

	success(): void {
		this.failures = 0;
		this.open = false;
		this.openedAt = 0;
		this.probing = false;
	}

	failure(now: number = Date.now()): void {
		this.failures++;
		this.probing = false;
		if (this.failures >= this.threshold) {
			this.open = true;
			this.openedAt = now;
		}
	}

	get isOpen(): boolean {
		return this.open;
	}

	get isProbing(): boolean {
		return this.probing;
	}

	snapshot(now: number = Date.now()): { key: string; open: boolean; failures: number; retryInMs: number } {
		return {
			key: this.key,
			open: this.open && now - this.openedAt < this.cooldownMs,
			failures: this.failures,
			retryInMs: this.open ? Math.max(0, this.cooldownMs - (now - this.openedAt)) : 0,
		};
	}
}

export class BreakerRegistry {
	private breakers = new Map<string, CircuitBreaker>();
	private readonly threshold: number;
	private readonly cooldownMs: number;

	constructor(threshold: number, cooldownMs: number) {
		this.threshold = threshold;
		this.cooldownMs = cooldownMs;
	}

	get(key: string): CircuitBreaker {
		let breaker = this.breakers.get(key);
		if (!breaker) {
			breaker = new CircuitBreaker(key, this.threshold, this.cooldownMs);
			this.breakers.set(key, breaker);
		}
		return breaker;
	}

	openCount(now: number = Date.now()): number {
		let open = 0;
		for (const breaker of this.breakers.values()) if (breaker.snapshot(now).open) open++;
		return open;
	}

	snapshot(now: number = Date.now()): Array<{ key: string; open: boolean; failures: number; retryInMs: number }> {
		return [...this.breakers.values()].map((b) => b.snapshot(now));
	}
}

// ── budget ──────────────────────────────────────────────────────────────────

export class Budget {
	private minuteWindow: number[] = [];
	private sessionCount = 0;
	private denied = 0;
	private readonly perMinute: number;
	private readonly perSession: number;

	constructor(perMinute: number, perSession: number) {
		this.perMinute = perMinute;
		this.perSession = perSession;
	}

	tryConsume(now: number = Date.now()): boolean {
		if (this.perSession > 0 && this.sessionCount >= this.perSession) {
			this.denied++;
			return false;
		}
		if (this.perMinute > 0) {
			this.minuteWindow = this.minuteWindow.filter((t) => now - t < 60_000);
			if (this.minuteWindow.length >= this.perMinute) {
				this.denied++;
				return false;
			}
			this.minuteWindow.push(now);
		}
		this.sessionCount++;
		return true;
	}

	get deniedCount(): number {
		return this.denied;
	}

	snapshot(now: number = Date.now()): { sessionCalls: number; perMinute: number; perSession: number; denied: number; lastMinute: number } {
		this.minuteWindow = this.minuteWindow.filter((t) => now - t < 60_000);
		return {
			sessionCalls: this.sessionCount,
			perMinute: this.perMinute,
			perSession: this.perSession,
			denied: this.denied,
			lastMinute: this.minuteWindow.length,
		};
	}
}

// ── cache ───────────────────────────────────────────────────────────────────

export class TtlCache<V> {
	private map = new Map<string, { value: V; expires: number }>();
	private readonly max: number;
	private readonly ttlMs: number;

	constructor(max: number, ttlMs: number) {
		this.max = max;
		this.ttlMs = ttlMs;
	}

	get(key: string, now: number = Date.now()): V | undefined {
		const hit = this.map.get(key);
		if (!hit) return undefined;
		if (hit.expires <= now) {
			this.map.delete(key);
			return undefined;
		}
		// refresh recency (Map preserves insertion order → oldest first)
		this.map.delete(key);
		this.map.set(key, hit);
		return hit.value;
	}

	set(key: string, value: V, now: number = Date.now()): void {
		this.map.delete(key);
		this.map.set(key, { value, expires: now + this.ttlMs });
		while (this.map.size > this.max) {
			const oldest = this.map.keys().next();
			if (oldest.done) break;
			this.map.delete(oldest.value);
		}
	}

	get size(): number {
		return this.map.size;
	}

	clear(): void {
		this.map.clear();
	}
}

// ── telemetry ───────────────────────────────────────────────────────────────

export interface Usage {
	input: number;
	output: number;
	cost: number;
}

export class Telemetry {
	attempts = 0;
	retries = 0;
	cacheHits = 0;
	cacheMisses = 0;
	tierSkipped = 0;
	budgetDenied = 0;
	deferrals = 0;
	degraded = false;
	failures: FailureCounters = zeroFailures();
	tierCalls: Record<string, number> = {};
	usage: Usage = { input: 0, output: 0, cost: 0 };

	recordFailure(failure: FailureClass): void {
		this.failures[failure]++;
	}

	recordTier(tier: string): void {
		this.tierCalls[tier] = (this.tierCalls[tier] ?? 0) + 1;
	}

	addUsage(usage: Partial<Usage> | undefined): void {
		if (!usage) return;
		this.usage.input += usage.input ?? 0;
		this.usage.output += usage.output ?? 0;
		this.usage.cost += usage.cost ?? 0;
	}

	snapshot(): {
		attempts: number;
		retries: number;
		cacheHits: number;
		cacheMisses: number;
		tierSkipped: number;
		budgetDenied: number;
		deferrals: number;
		degraded: boolean;
		failures: FailureCounters;
		tierCalls: Record<string, number>;
		usage: Usage;
	} {
		return {
			attempts: this.attempts,
			retries: this.retries,
			cacheHits: this.cacheHits,
			cacheMisses: this.cacheMisses,
			tierSkipped: this.tierSkipped,
			budgetDenied: this.budgetDenied,
			deferrals: this.deferrals,
			degraded: this.degraded,
			failures: { ...this.failures },
			tierCalls: { ...this.tierCalls },
			usage: { ...this.usage },
		};
	}

	reset(): void {
		this.attempts = 0;
		this.retries = 0;
		this.cacheHits = 0;
		this.cacheMisses = 0;
		this.tierSkipped = 0;
		this.budgetDenied = 0;
		this.deferrals = 0;
		this.degraded = false;
		this.failures = zeroFailures();
		this.tierCalls = {};
		this.usage = { input: 0, output: 0, cost: 0 };
	}
}
