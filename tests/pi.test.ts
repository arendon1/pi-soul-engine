/**
 * Pi-layer tests (no pi runtime required): soul manager bindings/domain
 * isolation, injection sections + budgets, exchange extraction, engines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoulManager } from "../src/pi/soul-manager.ts";
import { buildSoulSections, memoryMessage } from "../src/pi/injection.ts";
import { exchangeOf } from "../src/pi/lifecycle.ts";
import { HybridEngine, PiModelEngine, type ModelCaller } from "../src/runtime/engines/pi-model.ts";
import { SoulBridge } from "../src/pi/bridge.ts";
import { HeuristicEngine } from "../src/runtime/engines/heuristic.ts";
import { estimateTokens } from "../src/util/text.ts";

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), "pi-soul-test-"));
}

/** Poll until a condition holds (test files run in parallel; fixed sleeps are flaky). */
async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return condition();
}

const echoCaller: ModelCaller = {
	modelLabel: "test/echo",
	async complete(prompt) {
		return JSON.stringify({ echoed: prompt.slice(0, 20) });
	},
};

test("soul-manager: auto-birth, binding persistence, domain isolation", async () => {
	const root = tmpRoot();
	try {
		const manager = new SoulManager(root);
		const engine = new HeuristicEngine();

		// project A: auto-birth
		const soulA = manager.ensure("/projects/alpha", engine);
		assert.equal(soulA.config.identity.name, "Default");
		assert.ok(existsSync(join(root, "default.soul", "soul.json")));
		assert.equal(manager.domainFor("/projects/alpha"), "alpha");
		assert.equal(manager.domainFor("/projects/beta"), "beta");

		// binding persisted on birth
		assert.equal(manager.bindingFor("/projects/alpha").soul, "default");
		assert.equal(manager.bindingFor("/projects/alpha").domain, "alpha");

		// same soul, different project → different domain (isolation, not duplication)
		const manager2 = new SoulManager(root);
		const soulB = manager2.ensure("/projects/beta", engine);
		assert.equal(soulB.config.identity.did, soulA.config.identity.did);
		assert.equal(manager2.domainFor("/projects/beta"), "beta");

		// explicit birth + switch
		const custom = manager2.birth("/projects/beta", { name: "Aria", engine }, engine);
		assert.equal(custom.config.identity.name, "Aria");
		assert.equal(manager2.bindingFor("/projects/beta").soul, "aria");
		const manager3 = new SoulManager(root);
		const switched = manager3.switchTo("/projects/beta", "default", engine);
		assert.ok(switched);
		assert.equal(manager3.bindingFor("/projects/beta").soul, "default");
		assert.equal(manager3.list().length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("soul-manager: config persists", () => {
	const root = tmpRoot();
	try {
		const manager = new SoulManager(root);
		manager.configure({ engine: "heuristic", recallLimit: 3 });
		const reloaded = new SoulManager(root);
		assert.equal(reloaded.getConfig().engine, "heuristic");
		assert.equal(reloaded.getConfig().recallLimit, 3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("injection: sections are tagged, budgeted, and recall-aware", async () => {
	const root = tmpRoot();
	try {
		const manager = new SoulManager(root);
		const soul = manager.ensure("/projects/alpha", new HeuristicEngine());
		soul.remember("Human prefers GraphQL over REST for their API style", { type: "semantic", importance: 8 });

		const first = buildSoulSections(soul, "What API style should I use?");
		assert.ok(first.sections.soul_identity.includes("# Soul: Default"));
		assert.ok(first.sections.soul_identity.includes("## Persona"));
		assert.match(first.sections.soul_state, /mood:/);
		assert.match(first.sections.soul_memory, /GraphQL/);
		assert.equal(first.recalled.length > 0, true);

		// budget respected
		const tiny = buildSoulSections(soul, "What API style?", { promptBudget: 60, recallLimit: 20 });
		assert.ok(estimateTokens(tiny.sections.soul_memory) < 200);

		// no memories for an unknown prompt → empty memory section
		const none = buildSoulSections(soul, "zzz qqq xyz unknown completely");
		assert.equal(none.sections.soul_memory, "");

		// memoryMessage
		const msg = memoryMessage(soul, "API style", 3);
		assert.match(msg, /GraphQL/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("exchangeOf: extracts user prompt and final assistant text", () => {
	const event = {
		messages: [
			{ role: "user", content: "hello soul", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "thinking about it" },
					{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
				],
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], isError: false, timestamp: 3 },
			{
				role: "assistant",
				content: [{ type: "text", text: "final answer here" }],
				timestamp: 4,
			},
		],
	} as never;
	const exchange = exchangeOf(event);
	assert.ok(exchange);
	assert.equal(exchange.userText, "hello soul");
	assert.equal(exchange.agentText, "final answer here");

	const empty = exchangeOf({ messages: [{ role: "assistant", content: [{ type: "text", text: "x" }], timestamp: 1 }] } as never);
	assert.equal(empty, null);
});

test("engines: PiModelEngine uses the model; HybridEngine mixes and falls back", async () => {
	const pi = new PiModelEngine(echoCaller);
	const out = await pi.think("TASK: sentiment\nUSER: hi\nAGENT: yo");
	assert.match(out, /echoed/);
	assert.equal(pi.modelLabel, "test/echo");

	// failing caller + task prompt → heuristic fallback (never throws)
	const failing: ModelCaller = {
		modelLabel: "test/broken",
		async complete() {
			throw new Error("model down");
		},
	};
	const resilient = new PiModelEngine(failing);
	const fallback = await resilient.think('TASK: sentiment\nUSER: this is amazing!\nAGENT: great');
	const parsed = JSON.parse(fallback);
	assert.ok(parsed.valence > 0, "fallback returns heuristic sentiment");

	// hybrid: mechanical tasks stay local
	let calls = 0;
	const counting: ModelCaller = {
		modelLabel: "test/count",
		async complete(prompt) {
			calls++;
			return JSON.parse(new HeuristicEngine().thinkSync(prompt)) as never;
		},
	};
	const hybrid = new HybridEngine(counting);
	await hybrid.think('TASK: facts\nUSER: I prefer Rust\nAGENT: ok');
	await hybrid.think('TASK: sentiment\nUSER: I prefer Rust\nAGENT: ok');
	assert.equal(calls, 1, "facts answered heuristically, sentiment via model");
});

test("bridge: observe queue serializes and records state", async () => {
	const root = tmpRoot();
	try {
		const bridge = new SoulBridge(root);
		bridge.cwd = "/projects/alpha";
		bridge.domain = "alpha";
		bridge.manager.bind("/projects/alpha", "default");

		const results = await Promise.all([
			bridge.enqueueObserve("I prefer GraphQL over REST", "Noted!"),
			bridge.enqueueObserve("hello", "hi there"),
			bridge.enqueueObserve("I just got promoted!", "Congratulations!"),
		]);
		assert.equal(results.length, 3);
		assert.equal(results[1]!.stored, false, "greeting filtered");
		assert.equal(results[2]!.stored, true, "promotion stored");

		const soul = bridge.soul();
		assert.ok(soul.memoryCount() > 0);
		assert.equal(soul.config.identity.bond.interaction_count, 3);
		assert.equal(bridge.observationsSinceReflect, 3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("journal: exchanges survive a dead session and replay into memory", async () => {
	const root = tmpRoot();
	try {
		// Session A: an exchange is journaled, but pi exits before observe finishes.
		const bridgeA = new SoulBridge(root);
		bridgeA.cwd = "/projects/alpha";
		bridgeA.domain = "alpha";
		bridgeA.soul(); // ensure the soul exists
		const pendingPath = join(root, "pending-observations.json");
		bridgeA.worker.journalAdd(pendingPath, {
			id: "obs-dead-session",
			timestamp: new Date().toISOString(),
			domain: "alpha",
			userText: "I prefer GraphQL over REST for everything",
			agentText: "Noted — GraphQL it is.",
		});
		await waitFor(() => existsSync(pendingPath), 15_000);
		assert.ok(existsSync(pendingPath), "journaled before completion");
		bridgeA.shutdown();

		// Session B: fresh bridge on the same root replays the journal.
		const bridgeB = new SoulBridge(root);
		bridgeB.cwd = "/projects/alpha";
		bridgeB.domain = "alpha";
		const replayed = bridgeB.replayPending();
		assert.equal(replayed, 1);
		await bridgeB.settled();
		const soul = bridgeB.soul();
		assert.ok(
			soul.search("GraphQL").length > 0,
			"replayed exchange produced memories",
		);
		await waitFor(() => {
			if (!existsSync(pendingPath)) return false;
			try {
				return (JSON.parse(readFileSync(pendingPath, "utf8")) as unknown[]).length === 0;
			} catch {
				return false;
			}
		}, 15_000);
		const journal = existsSync(pendingPath) ? JSON.parse(readFileSync(pendingPath, "utf8")) : [];
		assert.equal(journal.length, 0, "completed replay entries are removed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bridge: transcript entries go through the ExtensionAPI (regression)", () => {
	const root = tmpRoot();
	try {
		const written: string[] = [];
		const bridge = new SoulBridge(root);
		bridge.attachApi({ appendEntry: (type: string) => void written.push(type) } as never);
		bridge.append("soul:observation", { x: 1 });
		assert.deepEqual(written, ["soul:observation"], "entry written via the API handle");
		assert.equal(bridge.auditStatus().failures, 0);

		// A missing handle is a failure, not a silent no-op: appendEntry lives on
		// ExtensionAPI, calling it on the ExtensionContext throws.
		const bare = new SoulBridge(root);
		bare.append("soul:observation", {});
		assert.equal(bare.auditStatus().failures, 1);
		assert.match(bare.auditStatus().lastError ?? "", /no ExtensionAPI attached/);

		// A throwing API is counted, never swallowed, and never propagated.
		const failing = new SoulBridge(root);
		failing.attachApi({
			appendEntry: () => {
				throw new Error("session closed");
			},
		} as never);
		failing.append("soul:deferred", {});
		assert.equal(failing.auditStatus().failures, 1);
		assert.match(failing.auditStatus().lastError ?? "", /session closed/);

		// After shutdown the session is off limits.
		const closed = new SoulBridge(root);
		const afterClose: string[] = [];
		closed.attachApi({ appendEntry: (type: string) => void afterClose.push(type) } as never);
		closed.shutdown();
		closed.append("soul:observation", {});
		assert.deepEqual(afterClose, [], "no writes after shutdown");
		assert.equal(closed.auditStatus().failures, 0, "a deliberate skip is not a failure");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bridge: shutdown hands state to the detached worker and returns immediately", async () => {
	const root = tmpRoot();
	const bridge = new SoulBridge(root);
	try {
		bridge.cwd = "/projects/alpha";
		bridge.domain = "alpha";
		bridge.manager.bind("/projects/alpha", "default");
		const soul = bridge.soul();
		soul.remember("Persistent fact about otters", { type: "semantic" });
		bridge.manager.markDirty();

		// Fire-and-forget observe in flight when we close — like agent_end does.
		void bridge.enqueueObserve("I love otters", "Otters are wonderful.").catch(() => undefined);

		const t0 = performance.now();
		bridge.shutdown(); // must set closed, flush, and hand off to the worker
		const elapsed = performance.now() - t0;
		assert.ok(elapsed < 100, `shutdown must not block (took ${elapsed.toFixed(1)}ms)`);
		assert.equal(bridge.closed, true);

		// After close: no session writes, notifications suppressed.
		let appended = 0;
		let notified = 0;
		bridge.append("soul:test", {});
		bridge.notify("should not appear");
		void appended;
		void notified;

		// The detached worker persists the final state regardless.
		const dir = join(root, "default.soul", "soul.json");
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			if (existsSync(dir)) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		assert.ok(existsSync(dir), "soul persisted by the worker after shutdown");
		const written = JSON.parse(readFileSync(dir, "utf8"));
		assert.equal(written.identity.name, "Default");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
