/**
 * CognitiveRouter — the strategy layer for model-backed cognition.
 *
 * Per-task tier ladder, cheapest first:
 *   task → [tier…] → heuristic floor (always available)
 *
 * Wrapped in resilience: per-call deadlines, one jittered retry for transient
 * failures only, model/provider circuit breakers, session degradation, call
 * budgets, a content-hash cache, usage capture, and abort semantics that are
 * never converted into a fallback result.
 */
import { createHash } from "node:crypto";
import type { CognitiveEngine, ThinkOptions } from "./engine.ts";
import { HeuristicEngine } from "./heuristic.ts";
import type { ModelCaller } from "./pi-model.ts";
import {
	Budget,
	BreakerRegistry,
	classifyFailure,
	EngineAbortError,
	EngineTimeoutError,
	isRetryable,
	Telemetry,
	TtlCache,
	type FailureClass,
} from "./resilience.ts";

export type TierName = "analysis" | "reflect" | "session";

export interface ResilienceConfig {
	/** Extra attempts after the first, for transient failures only. */
	retries: number;
	timeoutMs: { analysis: number; reflect: number; dream: number };
	breakerFailures: number;
	breakerCooldownMs: number;
	/** Consecutive failures before the session drops to heuristics. */
	degradeAfter: number;
}

export interface BudgetConfig {
	perMinute: number;
	perSession: number;
}

export interface CacheConfig {
	enabled: boolean;
	max: number;
	ttlMs: number;
}

export interface RouterOptions {
	analysis?: ModelCaller | null;
	reflect?: ModelCaller | null;
	session?: ModelCaller | null;
	fallback?: CognitiveEngine;
	resilience?: Partial<ResilienceConfig>;
	budget?: Partial<BudgetConfig>;
	cache?: Partial<CacheConfig>;
	/** Called once when the session degrades to heuristics. */
	onDegrade?: (reason: string) => void;
}

const DEFAULT_RESILIENCE: ResilienceConfig = {
	retries: 1,
	timeoutMs: { analysis: 20_000, reflect: 60_000, dream: 120_000 },
	breakerFailures: 3,
	breakerCooldownMs: 300_000,
	degradeAfter: 5,
};

const DEFAULT_BUDGET: BudgetConfig = { perMinute: 20, perSession: 500 };
const DEFAULT_CACHE: CacheConfig = { enabled: true, max: 512, ttlMs: 900_000 };

/** Task → tier ladder (cheapest adequate first). */
const LADDERS: Record<string, TierName[]> = {
	sentiment: ["analysis"],
	significance: ["analysis"],
	self_model: ["analysis"],
	evaluate: ["analysis"],
	facts: ["analysis"],
	entities: ["analysis"],
	reflect: ["reflect", "analysis", "session"],
	learn: ["reflect", "analysis", "session"],
	dream: ["reflect", "analysis", "session"],
	unknown: ["analysis", "session"],
};

function taskOf(prompt: string): string {
	return prompt.match(/^TASK:\s*(\w+)/m)?.[1] ?? "unknown";
}

function providerOf(modelLabel: string): string {
	return modelLabel.split("/")[0] ?? modelLabel;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RouterStatus {
	engine: string;
	degraded: boolean;
	tiers: { analysis: string | null; reflect: string | null; session: string | null; fallback: string };
	breakers: Array<{ key: string; open: boolean; failures: number; retryInMs: number }>;
	budget: ReturnType<Budget["snapshot"]>;
	cache: { enabled: boolean; size: number; max: number };
	telemetry: ReturnType<Telemetry["snapshot"]>;
}

export class CognitiveRouter implements CognitiveEngine {
	readonly name = "router";
	private analysis: ModelCaller | null;
	private reflect: ModelCaller | null;
	private session: ModelCaller | null;
	private fallback: CognitiveEngine;
	private resilience: ResilienceConfig;
	private budget: Budget;
	private cache: TtlCache<string>;
	private cacheConfig: CacheConfig;
	private breakers: BreakerRegistry;
	readonly telemetry = new Telemetry();
	private consecutiveFailures = 0;
	private onDegrade?: (reason: string) => void;

	constructor(options: RouterOptions = {}) {
		this.analysis = options.analysis ?? null;
		this.reflect = options.reflect ?? null;
		this.session = options.session ?? null;
		this.fallback = options.fallback ?? new HeuristicEngine();
		this.resilience = { ...DEFAULT_RESILIENCE, ...(options.resilience ?? {}) };
		const budget = { ...DEFAULT_BUDGET, ...(options.budget ?? {}) };
		this.budget = new Budget(budget.perMinute, budget.perSession);
		this.cacheConfig = { ...DEFAULT_CACHE, ...(options.cache ?? {}) };
		this.cache = new TtlCache<string>(this.cacheConfig.max, this.cacheConfig.ttlMs);
		this.breakers = new BreakerRegistry(this.resilience.breakerFailures, this.resilience.breakerCooldownMs);
		this.onDegrade = options.onDegrade;
	}

	get isDegraded(): boolean {
		return this.telemetry.degraded;
	}

	/** True when at least one model tier is configured. */
	get hasModelTiers(): boolean {
		return Boolean(this.analysis || this.reflect || this.session);
	}

	private callerFor(tier: TierName): ModelCaller | null {
		if (tier === "analysis") return this.analysis;
		if (tier === "reflect") return this.reflect;
		return this.session;
	}

	private timeoutFor(tier: TierName, task: string): number {
		if (task === "dream") return this.resilience.timeoutMs.dream;
		if (tier === "analysis") return this.resilience.timeoutMs.analysis;
		return this.resilience.timeoutMs.reflect;
	}

	private cacheKey(task: string, prompt: string): string {
		return createHash("md5").update(`${task}\n${prompt}`).digest("hex");
	}

	private async fallbackFor(prompt: string, task: string): Promise<string> {
		try {
			return await this.fallback.think(prompt);
		} catch (err) {
			throw new Error(
				`cognitive engine tiers failed and the fallback engine failed for ${task}: ${(err as Error).message}`,
			);
		}
	}

	async think(prompt: string, opts?: ThinkOptions): Promise<string> {
		const task = taskOf(prompt);

		// Abort is never a fallback: it is a cancellation.
		if (opts?.signal?.aborted) throw new EngineAbortError();

		// Degraded session → deterministic heuristics only.
		if (this.telemetry.degraded) return await this.fallbackFor(prompt, task);

		const key = this.cacheKey(task, prompt);
		if (this.cacheConfig.enabled) {
			const cached = this.cache.get(key);
			if (cached !== undefined) {
				this.telemetry.cacheHits++;
				return cached;
			}
			this.telemetry.cacheMisses++;
		}

		const tiers = LADDERS[task] ?? LADDERS.unknown!;
		const hasAnyTier = tiers.some((tier) => this.callerFor(tier) !== null);
		if (!hasAnyTier) return await this.fallbackFor(prompt, task);

		if (!this.budget.tryConsume()) {
			this.telemetry.budgetDenied++;
			return await this.fallbackFor(prompt, task);
		}

		for (const tier of tiers) {
			const caller = this.callerFor(tier);
			if (!caller) continue;

			const modelBreaker = this.breakers.get(`model:${caller.modelLabel}`);
			const providerBreaker = this.breakers.get(`provider:${providerOf(caller.modelLabel)}`);
			if (!modelBreaker.allow() || !providerBreaker.allow()) {
				this.telemetry.tierSkipped++;
				continue;
			}

			const outcome = await this.attempt(caller, prompt, opts, tier, task);
			if (outcome.ok) {
				modelBreaker.success();
				providerBreaker.success();
				this.consecutiveFailures = 0;
				this.telemetry.recordTier(tier);
				if (this.cacheConfig.enabled) this.cache.set(key, outcome.text);
				return outcome.text;
			}

			if (outcome.failure === "abort") throw new EngineAbortError();

			this.telemetry.recordFailure(outcome.failure);
			this.telemetry.recordTier(`${tier}:failed`);
			modelBreaker.failure();
			providerBreaker.failure();
			this.consecutiveFailures++;
			if (this.consecutiveFailures >= this.resilience.degradeAfter) this.degrade(`repeated ${outcome.failure} failures`);
			if (this.telemetry.degraded) return await this.fallbackFor(prompt, task);
		}

		// Every tier failed → heuristic floor.
		return await this.fallbackFor(prompt, task);
	}

	private async attempt(
		caller: ModelCaller,
		prompt: string,
		opts: ThinkOptions | undefined,
		tier: TierName,
		task: string,
	): Promise<{ ok: true; text: string } | { ok: false; failure: FailureClass }> {
		const timeoutMs = this.timeoutFor(tier, task);
		let lastFailure: FailureClass = "unknown";

		for (let attempt = 0; attempt <= this.resilience.retries; attempt++) {
			const deadline = AbortSignal.timeout(timeoutMs);
			const signal = opts?.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
			try {
				this.telemetry.attempts++;
				const text = await caller.complete(prompt, {
					signal,
					json: opts?.json,
					onUsage: (usage) => this.telemetry.addUsage(usage),
				});
				if (opts?.signal?.aborted) return { ok: false, failure: "abort" };
				if (deadline.aborted) return { ok: false, failure: "timeout" };
				if (!text || !text.trim()) {
					lastFailure = "malformed";
				} else {
					return { ok: true, text };
				}
			} catch (err) {
				if (opts?.signal?.aborted) return { ok: false, failure: "abort" };
				if (deadline.aborted) return { ok: false, failure: "timeout" };
				lastFailure = classifyFailure(err, opts?.signal);
				if (lastFailure === "auth") return { ok: false, failure: lastFailure };
			}

			const canRetry = isRetryable(lastFailure) && attempt < this.resilience.retries;
			if (!canRetry) return { ok: false, failure: lastFailure };
			this.telemetry.retries++;
			await sleep(200 + Math.floor(Math.random() * 400) * (attempt + 1));
		}
		return { ok: false, failure: lastFailure };
	}

	private degrade(reason: string): void {
		if (this.telemetry.degraded) return;
		this.telemetry.degraded = true;
		try {
			this.onDegrade?.(reason);
		} catch {
			/* notification must never break the pipeline */
		}
	}

	/** Record a malformed-output failure (used by consumers that parse responses). */
	recordMalformed(): void {
		this.telemetry.recordFailure("malformed");
	}

	/** Record a deferral (all tiers unavailable; work kept for a later attempt). */
	recordDeferral(): void {
		this.telemetry.deferrals++;
	}

	status(): RouterStatus {
		return {
			engine: this.name,
			degraded: this.telemetry.degraded,
			tiers: {
				analysis: this.analysis?.modelLabel ?? null,
				reflect: this.reflect?.modelLabel ?? null,
				session: this.session?.modelLabel ?? null,
				fallback: this.fallback.name,
			},
			breakers: this.breakers.snapshot(),
			budget: this.budget.snapshot(),
			cache: { enabled: this.cacheConfig.enabled, size: this.cache.size, max: this.cacheConfig.max },
			telemetry: this.telemetry.snapshot(),
		};
	}

	/** Reset breakers/budget/cache (used by `/soul-engine reset`). */
	resetResilience(): void {
		this.consecutiveFailures = 0;
		this.telemetry.reset();
		this.cache.clear();
	}
}
