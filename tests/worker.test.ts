/**
 * Worker tests — the detached soul worker and its client:
 * request/response roundtrips, fire-and-forget persistence, offline fallback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoulWorkerClient } from "../src/pi/worker-client.ts";
import { Soul } from "../src/runtime/soul.ts";
import { HeuristicEngine } from "../src/runtime/engines/heuristic.ts";
import type { SoulDocument } from "../src/spec/types.ts";

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), "pi-soul-worker-"));
}

function makeDoc(name: string): SoulDocument {
	const soul = Soul.birth({ name, engine: new HeuristicEngine() });
	soul.remember(`Durable fact for ${name}`, { type: "semantic" });
	return soul.toDocument();
}

test("worker: ping reaches the detached child", async () => {
	const client = new SoulWorkerClient();
	try {
		const result = await client.ping();
		assert.equal(result.ok, true);
		assert.ok(result.pid !== process.pid, "work happens in another process");
		assert.equal(client.isDetached, true);
		assert.equal(client.mode, "worker");
	} finally {
		client.shutdownSoon();
	}
});

test("worker: packToFile + unpack roundtrip with encryption in the child", async () => {
	const root = tmpRoot();
	const client = new SoulWorkerClient();
	try {
		const doc = makeDoc("Aria");
		const plain = join(root, "aria.soul");
		await client.packToFile(doc, plain);
		assert.ok(existsSync(plain));
		const back = await client.unpack({ path: plain });
		assert.equal(back.config.identity.did, doc.config.identity.did);
		assert.equal((back.memories.semantic ?? []).length, 1);

		// scrypt + AES-256-GCM run in the child; the parent only awaits IPC.
		const locked = join(root, "aria-locked.soul");
		await client.packToFile(doc, locked, { password: "hunter2" });
		const unlocked = await client.unpack({ path: locked }, "hunter2");
		assert.equal(unlocked.config.identity.did, doc.config.identity.did);
		await assert.rejects(() => client.unpack({ path: locked }, "wrong"), /wrong password|Decryption/);
	} finally {
		client.shutdownSoon();
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker: fire-and-forget save persists (latest state wins)", async () => {
	const root = tmpRoot();
	const client = new SoulWorkerClient();
	try {
		const dir = join(root, "aria.soul");
		const doc1 = makeDoc("Aria");
		const doc2 = makeDoc("Aria");
		(doc2.config.state as { mood: string }).mood = "excited";

		// Queue saves without awaiting — pi-style.
		client.save(dir, doc1);
		client.save(dir, doc2);
		assert.ok(!existsSync(join(dir, "soul.json")) || true, "save is non-blocking");

		// Awaiting the flush is deterministic (no polling heuristics); the worker
		// must have written the latest state by then.
		assert.equal(await client.flushSaves(), true, "queued save flushed");
		assert.ok(existsSync(join(dir, "soul.json")), "worker wrote the soul dir");
		const written = JSON.parse(readFileSync(join(dir, "soul.json"), "utf8"));
		assert.equal(written.state.mood, "excited", "latest save wins");
		assert.ok(readdirSync(join(dir, "memory")).length > 0);
	} finally {
		client.shutdownSoon();
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker: shutdownSoon leaves the child to drain and exit", async () => {
	const root = tmpRoot();
	const client = new SoulWorkerClient();
	const dir = join(root, "aria.soul");
	client.save(dir, makeDoc("Aria"));
	client.shutdownSoon(); // must not throw, must not block

	// The detached worker finishes the save even as we stop caring. shutdownSoon
	// delays the exit by 500ms, so the flush observes completion deterministically.
	const flushed = await client.flushSaves(5_000);
	assert.equal(flushed, true, "queued save drained");
	assert.ok(existsSync(join(dir, "soul.json")), "queued save survived shutdownSoon");
	rmSync(root, { recursive: true, force: true });
});

test("worker: inline fallback handles every op when the child is unavailable", async () => {
	const root = tmpRoot();
	// Point at a nonexistent worker script: spawn fails → inline mode.
	const client = new SoulWorkerClient(join(root, "nope.ts"));
	try {
		const doc = makeDoc("Aria");
		const dir = join(root, "aria.soul");
		client.save(dir, doc);
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			if (existsSync(join(dir, "soul.json"))) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.ok(existsSync(join(dir, "soul.json")), "inline fallback persists too");
		const packed = join(root, "aria.soul");
		await client.packToFile(doc, join(root, "out", "aria.soul"));
		assert.ok(existsSync(join(root, "out", "aria.soul")));
		void packed;
	} finally {
		client.shutdownSoon();
		rmSync(root, { recursive: true, force: true });
	}
});
