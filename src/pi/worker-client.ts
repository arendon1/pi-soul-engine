/**
 * SoulWorkerClient — talks to the detached soul worker over Node IPC.
 *
 * Contract:
 *  - `save()` is fire-and-forget with latest-wins coalescing: pi never waits
 *    on persistence, and at most one save per target dir is in flight.
 *  - `request()` is for explicitly awaited operations (export/import). The CPU
 *    cost (scrypt, deflate) lives in the child, so even these never block pi's
 *    event loop.
 *  - `shutdownSoon()` hands the final state to the worker and returns
 *    immediately; the worker drains and exits even after pi is gone.
 *  - If the worker cannot spawn (restricted environments), the client degrades
 *    to an inline mode that does the same work in-process.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadSoulDir, packSoul, unpackSoul, saveSoulDir } from "../spec/soul-file.ts";
import type { SoulDocument } from "../spec/types.ts";

export interface WorkerRequestOptions {
	timeoutMs?: number;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Transport failures (child died, spawn failed, timeout) are safe to retry inline. */
class TransportError extends Error {}

function transportError(message: string): TransportError {
	return new TransportError(message);
}

interface QueuedSave {
	dir: string;
	doc: SoulDocument;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const HEAVY_TIMEOUT_MS = 180_000; // scrypt derivations are slow by design

export class SoulWorkerClient {
	/**
	 * "worker" while a detached child handles persistence; "inline" once
	 * spawning has failed and the client does the work in-process. Derived, not
	 * fixed, so it never contradicts what is actually happening.
	 */
	get mode(): "worker" | "inline" {
		return this.spawnFailed ? "inline" : "worker";
	}
	private child: ChildProcess | null = null;
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private spawnFailed = false;
	/** True once the worker has sent any message, i.e. it really started. */
	private healthy = false;
	private closing = false;

	// latest-wins save coalescing
	private queuedSave: QueuedSave | null = null;
	private saveInFlight = false;

	private workerPath: string;

	constructor(workerPath?: string) {
		this.workerPath =
			workerPath ?? join(dirname(fileURLToPath(import.meta.url)), "worker", "soul-worker.ts");
	}

	// ── lifecycle ──────────────────────────────────────────────────────────

	private ensureChild(): ChildProcess | null {
		if (this.closing || this.spawnFailed) return null;
		if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
		try {
			const child = spawn(process.execPath, [this.workerPath], {
				stdio: ["ignore", "ignore", "ignore", "ipc"],
				detached: true,
			});
			child.on("message", (message: { id?: number; ok?: boolean; result?: unknown; error?: string }) => {
				this.healthy = true;
				const pending = this.pending.get(message.id ?? -1);
				if (!pending) return;
				this.pending.delete(message.id ?? -1);
				clearTimeout(pending.timer);
				if (message.ok) pending.resolve(message.result);
				else pending.reject(new Error(message.error ?? "soul worker error"));
			});
			child.on("exit", () => {
				this.child = null;
				// A child that exits before ever answering never really started
				// (bad script, missing runtime): stop respawning and go inline.
				if (!this.healthy) this.spawnFailed = true;
				for (const [, pending] of this.pending) {
					clearTimeout(pending.timer);
					pending.reject(transportError("soul worker exited"));
				}
				this.pending.clear();
				this.saveInFlight = false;
			});
			child.on("error", () => {
				this.child = null;
				this.spawnFailed = true;
			});
			child.unref();
			// Let pi's event loop drain freely even with an open IPC channel.
			try {
				(child as unknown as { channel?: { unref?: () => void } }).channel?.unref?.();
			} catch {
				/* best effort */
			}
			this.healthy = false;
			this.child = child;
			return child;
		} catch {
			this.spawnFailed = true;
			return null;
		}
	}

	// ── request/response ───────────────────────────────────────────────────

	private requestWorker(op: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
		const child = this.ensureChild();
		if (!child) return Promise.reject(transportError("soul worker unavailable"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(transportError(`soul worker timeout on ${op}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			child.send({ id, op, payload }, (err) => {
				if (err) {
					const pending = this.pending.get(id);
					if (pending) {
						this.pending.delete(id);
						clearTimeout(pending.timer);
						pending.reject(transportError(err.message));
					}
				}
			});
		});
	}

	private async request(op: string, payload: Record<string, unknown>, options: WorkerRequestOptions = {}): Promise<unknown> {
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		try {
			return await this.requestWorker(op, payload, timeoutMs);
		} catch (err) {
			// Transport failure → retry inline. Worker-side failures (e.g. wrong
			// password) are real operation errors and surface as-is.
			if (err instanceof TransportError || this.spawnFailed) {
				return this.inline(op, payload);
			}
			throw err;
		}
	}

	private async inline(op: string, payload: Record<string, unknown>): Promise<unknown> {
		switch (op) {
			case "saveDir":
				saveSoulDir(payload.doc as SoulDocument, payload.dir as string);
				return { saved: true };
			case "loadDir":
				return { doc: loadSoulDir(payload.dir as string) };
			case "pack":
				return {
					bytes: Buffer.from(
						packSoul(payload.doc as SoulDocument, {
							password: payload.password as string | undefined,
							includeKeys: payload.includeKeys === true,
						}),
					).toString("base64"),
				};
			case "packToFile": {
				const { mkdirSync, writeFileSync } = await import("node:fs");
				const { dirname: dir } = await import("node:path");
				const bytes = packSoul(payload.doc as SoulDocument, {
					password: payload.password as string | undefined,
					includeKeys: payload.includeKeys === true,
				});
				mkdirSync(dir(payload.outPath as string), { recursive: true });
				writeFileSync(payload.outPath as string, bytes);
				return { path: payload.outPath, size: bytes.length };
			}
			case "unpack": {
				const { readFileSync } = await import("node:fs");
				const raw = payload.path
					? new Uint8Array(readFileSync(payload.path as string))
					: new Uint8Array(Buffer.from(payload.bytes as string, "base64"));
				return { doc: unpackSoul(raw, { password: payload.password as string | undefined }) };
			}
			case "ping":
				return { ok: true, pid: process.pid };
			case "journalAdd": {
				const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import("node:fs");
				const { dirname: dir } = await import("node:path");
				const path = payload.path as string;
				mkdirSync(dir(path), { recursive: true });
				const current: unknown[] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
				current.push(payload.entry);
				writeFileSync(path, JSON.stringify(current), "utf8");
				return { journaled: current.length };
			}
			case "journalRemove": {
				const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
				const path = payload.path as string;
				if (!existsSync(path)) return { removed: 0 };
				const ids = new Set(payload.ids as string[]);
				const current: Array<{ id: string }> = JSON.parse(readFileSync(path, "utf8"));
				const kept = current.filter((e) => !ids.has(e.id));
				writeFileSync(path, JSON.stringify(kept), "utf8");
				return { removed: current.length - kept.length };
			}
			case "exit":
				return { exiting: true };
			default:
				throw new Error(`unknown op: ${op}`);
		}
	}

	// ── fire-and-forget persistence ────────────────────────────────────────

	/** Queue a save; returns immediately. Latest state wins. */
	save(dir: string, doc: SoulDocument): void {
		this.queuedSave = { dir, doc };
		this.drainSaves();
	}

	private drainSaves(): void {
		if (this.saveInFlight || !this.queuedSave) return;
		const job = this.queuedSave;
		this.queuedSave = null;
		this.saveInFlight = true;
		void this.request("saveDir", { dir: job.dir, doc: job.doc as unknown as Record<string, unknown> })
			.catch(() => {
				/* persistence is best-effort; the next save supersedes anyway */
			})
			.finally(() => {
				this.saveInFlight = false;
				if (this.queuedSave) this.drainSaves();
			});
	}

	/**
	 * Await queued persistence. Production code never needs this — persistence is
	 * deliberately fire-and-forget — but tests and orderly shutdown use it to
	 * observe completion without polling heuristics.
	 *
	 * Returns false if the deadline passed (the worker is gone or wedged).
	 */
	async flushSaves(timeoutMs = 10_000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			this.drainSaves();
			if (!this.saveInFlight && !this.queuedSave) return true;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		return false;
	}

	// ── awaited operations (user-invoked export/import) ────────────────────

	async packToFile(
		doc: SoulDocument,
		outPath: string,
		options: { password?: string; includeKeys?: boolean } = {},
	): Promise<void> {
		await this.request(
			"packToFile",
			{
				doc: doc as unknown as Record<string, unknown>,
				outPath,
				password: options.password,
				includeKeys: options.includeKeys,
			},
			{ timeoutMs: HEAVY_TIMEOUT_MS },
		);
	}

	async unpack(pathOrBytes: { path?: string; bytes?: string }, password?: string): Promise<SoulDocument> {
		const result = (await this.request(
			"unpack",
			{ path: pathOrBytes.path, bytes: pathOrBytes.bytes, password },
			{ timeoutMs: HEAVY_TIMEOUT_MS },
		)) as { doc: SoulDocument };
		return result.doc;
	}

	async ping(): Promise<{ ok: boolean; pid: number }> {
		return (await this.request("ping", {}, { timeoutMs: 5_000 })) as { ok: boolean; pid: number };
	}

	/** True when a real worker child is handling requests. */
	get isDetached(): boolean {
		return this.child !== null && this.child.exitCode === null;
	}

	/**
	 * Hand the final queued state to the worker and let it finish after we are
	 * gone. Returns immediately — closing a session never waits on the soul.
	 */
	shutdownSoon(): void {
		this.drainSaves();
		const child = this.child;
		if (!child || child.exitCode !== null) return;
		try {
			// Give queued saves a beat, then ask the worker to exit on its own.
			setTimeout(() => {
				try {
					child.send({ id: -1, op: "exit", payload: {} });
				} catch {
					/* already gone */
				}
			}, 500).unref?.();
		} catch {
			/* best effort */
		}
	}

	// ── pending-observation journal (survives pi exiting mid-turn) ─────────

	/** Fire-and-forget: remember an exchange until its observe() completes. */
	journalAdd(path: string, entry: Record<string, unknown>): void {
		void this.request("journalAdd", { path, entry }).catch(() => undefined);
	}

	/** Fire-and-forget: drop a journaled exchange after observe() completes. */
	journalRemove(path: string, ids: string[]): void {
		void this.request("journalRemove", { path, ids }).catch(() => undefined);
	}
}
