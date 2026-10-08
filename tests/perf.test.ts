/**
 * Performance tests.
 *
 * These guard the *properties* that matter operationally, not absolute speeds
 * (CI/Termux machines vary): throughput of the observation pipeline, O(1)
 * fast paths (cache hit, open breaker, denied budget), deadline enforcement,
 * non-blocking kickoff, bounded memory, and payload bounding.
 *
 * Bounds are deliberately loose; each test prints its measurement so a genuine
 * regression is visible even when the loose bound still passes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Soul } from "../src/runtime/soul.ts";
import { HeuristicEngine } from "../src/runtime/engines/heuristic.ts";
import { CognitiveRouter } from "../src/runtime/engines/router.ts";
import { AnalysisService } from "../src/runtime/engines/analysis.ts";
import { TtlCache } from "../src/runtime/engines/resilience.ts";
import { SoulBridge } from "../src/pi/bridge.ts";
import { estimateTokens } from "../src/util/text.ts";
import type { Interaction } from "../src/spec/types.ts";
import type { CognitiveEngine } from "../src/runtime/engines/engine.ts";

function pair(user: string, agent: string): Interaction {
	return {
		participants: [
			{ role: "user", id: "human", content: user },
			{ role: "agent", id: "soul", content: agent },
		],
		timestamp: new Date().toISOString(),
		metadata: {},
	};
}

const GOOD = '{"valence":0.8,"arousal":0.6,"label":"joy"}';

// ── throughput ──────────────────────────────────────────────────────────────

test("perf: observation pipeline throughput (heuristics)", async () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	// disable auto-consolidation so we measure observe itself
	(soul.config.memory as { consolidation_interval?: number }).consolidation_interval = 0;

	const rounds = 150;
	const started = performance.now();
	for (let i = 0; i < rounds; i++) {
		await soul.observe(
			pair(
				`Turn ${i}: I prefer GraphQL over REST for the billing migration and I am frustrated with the latency`,
				"Understood — let us look at the resolver layer and the build config, then test the api again.",
			),
		);
	}
	const elapsed = performance.now() - started;
	const perOp = elapsed / rounds;
	console.log(`    observe: ${rounds} ops in ${elapsed.toFixed(0)}ms → ${(1000 / perOp).toFixed(0)} ops/s (${perOp.toFixed(2)}ms/op)`);
	assert.ok(perOp < 30, `per-observation cost too high: ${perOp.toFixed(2)}ms`);
	assert.ok(soul.memoryCount() > 0);
});

test("perf: batched analysis costs 2 model calls instead of 5", async () => {
	let classifierCalls = 0;
	let chatCalls = 0;

	const classifier = {
		label: "t/c",
		available: () => true,
		async classify(_state: unknown, questions: Record<string, { type: string }>) {
			classifierCalls++;
			const answers: Record<string, unknown> = {};
			for (const id of Object.keys(questions)) answers[id] = { type: "score", score: 3, confidence: 0.9 };
			return { answers: answers as never, usage: { input: 200, output: 0, cost: 0 }, stopReason: "stop" as const };
		},
	};
	const chatEngine: CognitiveEngine = {
		name: "counting",
		async think() {
			chatCalls++;
			return JSON.stringify({ facts: [{ content: "Human prefers GraphQL", entities: [], importance: 6 }], entities: [] });
		},
	};

	const service = new AnalysisService({ classifier: classifier as never, engine: chatEngine });
	await service.analyze({
		user: "I prefer GraphQL and I am frustrated with the build",
		agent: "Let us fix the config and test the api again.",
		knownDomains: ["technical_helper"],
		rubricCriteria: ["completeness", "relevance", "helpfulness", "specificity"],
	});
	console.log(`    batched path: classifier=${classifierCalls}, chat=${chatCalls}`);
	assert.equal(classifierCalls, 1, "one classifier call answers every typed question");
	assert.equal(chatCalls, 1, "one chat call for facts+entities");

	// the legacy per-task path costs five calls
	const soul = Soul.birth({ name: "Legacy", engine: chatEngine });
	await soul.observe(pair("I prefer GraphQL", "Noted"));
	console.log(`    legacy path: chat=${chatCalls} total (was 1, so +5 per exchange)`);
	assert.equal(chatCalls, 6, "legacy path issues five per-task calls");
});

// ── fast paths ──────────────────────────────────────────────────────────────

test("perf: cache hit is much cheaper than a cold call", async () => {
	let calls = 0;
	const router = new CognitiveRouter({
		analysis: {
			modelLabel: "openrouter/a",
			async complete() {
				calls++;
				await new Promise((r) => setTimeout(r, 5));
				return GOOD;
			},
		},
	});
	const prompt = "TASK: sentiment\nUSER: cached path\nAGENT: reply";

	const coldStart = performance.now();
	await router.think(prompt);
	const coldMs = performance.now() - coldStart;

	const rounds = 2000;
	const started = performance.now();
	for (let i = 0; i < rounds; i++) await router.think(prompt);
	const warmMs = performance.now() - started;
	const perHit = warmMs / rounds;
	console.log(`    cold ${coldMs.toFixed(1)}ms vs cache hit ${perHit.toFixed(3)}ms (${(coldMs / perHit).toFixed(0)}x faster)`);
	assert.equal(calls, 1);
	assert.equal(router.telemetry.cacheHits, rounds);
	assert.ok(coldMs / perHit > 10, "cache hit should be an order of magnitude cheaper");
	assert.ok(warmMs < 3000, `cache hits too slow: ${warmMs.toFixed(0)}ms for ${rounds}`);
});

test("perf: an open breaker makes calls near-free", async () => {
	let calls = 0;
	const router = new CognitiveRouter({
		analysis: {
			modelLabel: "openrouter/down",
			async complete() {
				calls++;
				throw Object.assign(new Error("bad gateway"), { status: 502 });
			},
		},
		resilience: { retries: 0, breakerFailures: 1, degradeAfter: 9999 },
	});
	await router.think("TASK: sentiment\nUSER: open the breaker\nAGENT: reply");
	const callsWhileClosed = calls;

	const rounds = 1000;
	const started = performance.now();
	for (let i = 0; i < rounds; i++) await router.think(`TASK: sentiment\nUSER: skipped ${i}\nAGENT: reply ${i}`);
	const elapsed = performance.now() - started;
	console.log(`    ${rounds} calls with an open breaker in ${elapsed.toFixed(0)}ms (${calls - callsWhileClosed} provider calls)`);
	assert.equal(calls, callsWhileClosed, "no provider calls while open");
	assert.ok(elapsed < 2000, `open-breaker path too slow: ${elapsed.toFixed(0)}ms`);
});

test("perf: budget denial is a fast path", async () => {
	let calls = 0;
	const router = new CognitiveRouter({
		analysis: {
			modelLabel: "openrouter/a",
			async complete() {
				calls++;
				return GOOD;
			},
		},
		budget: { perMinute: 1, perSession: 1 },
	});
	await router.think("TASK: sentiment\nUSER: allowed\nAGENT: reply");
	const rounds = 1000;
	const started = performance.now();
	for (let i = 0; i < rounds; i++) await router.think(`TASK: sentiment\nUSER: denied ${i}\nAGENT: reply ${i}`);
	const elapsed = performance.now() - started;
	console.log(`    ${rounds} denied calls in ${elapsed.toFixed(0)}ms`);
	assert.equal(calls, 1);
	assert.equal(router.telemetry.budgetDenied, rounds);
	assert.ok(elapsed < 2000, `denied path too slow: ${elapsed.toFixed(0)}ms`);
});

// ── latency bounds & non-blocking ───────────────────────────────────────────

test("perf: a hanging tier is cut off by the deadline", async () => {
	const router = new CognitiveRouter({
		analysis: {
			modelLabel: "openrouter/hung",
			complete: (_prompt, opts) =>
				new Promise((_resolve, reject) => {
					opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		},
		// the fallback must always answer: heuristics are the guaranteed floor
		fallback: new HeuristicEngine(),
		resilience: { retries: 0, timeoutMs: { analysis: 80, reflect: 80, dream: 80 } },
	});
	const started = performance.now();
	const out = await router.think("TASK: sentiment\nUSER: hanging provider\nAGENT: reply");
	const elapsed = performance.now() - started;
	console.log(`    deadline enforced in ${elapsed.toFixed(0)}ms (deadline 80ms)`);
	assert.ok(out.length > 0);
	assert.ok(elapsed < 1200, `deadline not enforced: ${elapsed.toFixed(0)}ms`);
});

test("perf: observe kickoff is non-blocking (sync return while work continues)", async () => {
	const root = mkdtempSync(join(tmpdir(), "soul-perf-"));
	try {
		const bridge = new SoulBridge(root);
		bridge.cwd = "/projects/perf";
		bridge.domain = "perf";
		const soul = bridge.soul();
		const slowEngine: CognitiveEngine = {
			name: "slow",
			think: () => new Promise<string>((resolve) => setTimeout(() => resolve(GOOD), 300)),
		};
		soul.setEngine(slowEngine);

		const started = performance.now();
		const pending = bridge.enqueueObserve("I prefer GraphQL over REST", "Noted, GraphQL it is");
		const syncMs = performance.now() - started;
		// a second exchange can be queued immediately, without waiting
		const queued = performance.now();
		void bridge.enqueueObserve("Second exchange", "Second reply").catch(() => undefined);
		const queueMs = performance.now() - queued;
		await pending;
		const totalMs = performance.now() - started;
		console.log(`    kickoff ${syncMs.toFixed(1)}ms, queueing a second ${queueMs.toFixed(1)}ms, work finished at ${totalMs.toFixed(0)}ms`);
		assert.ok(syncMs < 100, `kickoff blocked for ${syncMs.toFixed(0)}ms`);
		assert.ok(queueMs < 100, `queueing blocked for ${queueMs.toFixed(0)}ms`);
		assert.ok(totalMs >= 250, "the slow engine really did run after the return");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── bounded memory & payloads ───────────────────────────────────────────────

test("perf: cache stays bounded under many distinct keys", () => {
	const cache = new TtlCache<string>(512, 60_000);
	const started = performance.now();
	for (let i = 0; i < 20_000; i++) cache.set(`key-${i}`, "v");
	const elapsed = performance.now() - started;
	console.log(`    20k cache sets in ${elapsed.toFixed(0)}ms, size ${cache.size}`);
	assert.ok(cache.size <= 512);
	assert.ok(elapsed < 2000, `cache set too slow: ${elapsed.toFixed(0)}ms`);
});

test("perf: router bookkeeping stays bounded over many calls", async () => {
	const router = new CognitiveRouter({
		analysis: {
			modelLabel: "openrouter/a",
			async complete() {
				return GOOD;
			},
		},
		cache: { enabled: true, max: 128, ttlMs: 60_000 },
		budget: { perMinute: 0, perSession: 0 },
	});
	const rounds = 5000;
	const started = performance.now();
	for (let i = 0; i < rounds; i++) await router.think(`TASK: sentiment\nUSER: unique payload ${i}\nAGENT: reply ${i}`);
	const elapsed = performance.now() - started;
	const status = router.status();
	console.log(`    ${rounds} calls in ${elapsed.toFixed(0)}ms; cache ${status.cache.size}/${status.cache.max}; tier keys ${Object.keys(status.telemetry.tierCalls).length}`);
	assert.ok(status.cache.size <= 128, "cache bounded");
	assert.ok(Object.keys(status.telemetry.tierCalls).length <= 8, "tier counters bounded");
	assert.ok(Object.keys(status.breakers).length <= 8, "one breaker per model/provider, not per call");
});

test("perf: a huge exchange is token-bounded before it reaches a model", async () => {
	let receivedTokens = 0;
	const classifier = {
		label: "t/c",
		available: () => true,
		async classify(state: { exchange?: string }) {
			receivedTokens = estimateTokens(String(state.exchange ?? ""));
			return { answers: {}, usage: { input: 0, output: 0, cost: 0 }, stopReason: "stop" as const };
		},
	};
	const service = new AnalysisService({
		classifier: classifier as never,
		engine: null,
		maxStateTokens: 1200,
		maxInputChars: 6000,
	});
	// 1 MB of pasted conversation: every analysis step must stay bounded.
	const huge = "x".repeat(1_000_000);
	const started = performance.now();
	await service.analyze({ user: huge, agent: huge });
	const elapsed = performance.now() - started;
	console.log(`    1MB input bounded to ~${receivedTokens} tokens in ${elapsed.toFixed(0)}ms`);
	assert.ok(receivedTokens <= 1400, `payload not bounded: ${receivedTokens} tokens`);
	assert.ok(elapsed < 3000, `bounding path too slow: ${elapsed.toFixed(0)}ms`);
});

test("perf: session bookkeeping (SHS) completes quickly on a populated soul", () => {
	// a cheap proxy for "status surfaces stay responsive as the soul grows"
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	for (let i = 0; i < 400; i++) {
		soul.remember(`Fact ${i}: human prefers option ${i} for the billing migration`, { type: "semantic", importance: 5 });
	}
	for (let i = 0; i < 100; i++) {
		soul.remember(`Episode ${i}: we debugged the api and fixed the build config`, { type: "episodic", importance: 4 });
	}
	const started = performance.now();
	const prompt = soul.toSystemPrompt();
	const hit = soul.recall("billing migration options", { limit: 5 });
	const stats = soul.evaluationStats();
	const elapsed = performance.now() - started;
	console.log(`    500 memories: prompt+recall+stats in ${elapsed.toFixed(1)}ms (${hit.length} hits, ${stats.length} domains)`);
	assert.ok(prompt.length > 0);
	assert.ok(elapsed < 1500, `status surfaces too slow: ${elapsed.toFixed(0)}ms`);
});
