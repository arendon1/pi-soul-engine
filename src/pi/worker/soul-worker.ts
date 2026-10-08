/**
 * Soul worker — a detached child process that owns soul persistence and
 * heavy local work (AES-256-GCM scrypt derivation, ZIP deflate) so none of it
 * ever runs on Pi's event loop.
 *
 * Protocol (Node IPC): parent sends {id, op, payload}; worker replies
 * {id, ok, result} or {id, ok: false, error}. Fire-and-forget sends are
 * allowed: the parent may ignore replies for `save`/`exit`.
 *
 * Lifecycle: spawned detached + unref'd by the client. When the parent
 * disconnects, the worker drains its remaining queue and exits. An idle
 * timeout backstops orphaned workers.
 */
import { loadSoulDir, packSoul, unpackSoul, saveSoulDir } from "../../spec/soul-file.ts";
import type { SoulDocument } from "../../spec/types.ts";

type Payload = Record<string, unknown>;
type Reply = (result: unknown) => void;
type Fail = (error: string) => void;

const IDLE_EXIT_MS = 60_000;

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let draining = false;

function bumpIdle(): void {
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		// Nothing heard for a while and the parent may be gone: wrap up.
		if (!draining) process.exit(0);
	}, IDLE_EXIT_MS);
	if (typeof idleTimer.unref === "function") idleTimer.unref();
}

async function handle(op: string, payload: Payload, reply: Reply, fail: Fail): Promise<void> {
	try {
		switch (op) {
			case "ping":
				reply({ ok: true, pid: process.pid });
				return;

			case "saveDir": {
				const doc = revive(payload.doc as SoulDocument);
				saveSoulDir(doc, payload.dir as string);
				reply({ saved: true });
				return;
			}

			case "loadDir": {
				const doc = loadSoulDir(payload.dir as string);
				reply({ doc });
				return;
			}

			case "pack": {
				const doc = revive(payload.doc as SoulDocument);
				const bytes = packSoul(doc, {
					password: payload.password as string | undefined,
					includeKeys: payload.includeKeys === true,
				});
				reply({ bytes: Buffer.from(bytes).toString("base64") });
				return;
			}

			case "packToFile": {
				const doc = revive(payload.doc as SoulDocument);
				const bytes = packSoul(doc, {
					password: payload.password as string | undefined,
					includeKeys: payload.includeKeys === true,
				});
				const { mkdirSync, writeFileSync } = await import("node:fs");
				const { dirname } = await import("node:path");
				const outPath = payload.outPath as string;
				mkdirSync(dirname(outPath), { recursive: true });
				writeFileSync(outPath, bytes);
				reply({ path: outPath, size: bytes.length });
				return;
			}

			case "unpack": {
				const { readFileSync } = await import("node:fs");
				const raw = payload.path
					? new Uint8Array(readFileSync(payload.path as string))
					: new Uint8Array(Buffer.from(payload.bytes as string, "base64"));
				const doc = unpackSoul(raw, { password: payload.password as string | undefined });
				reply({ doc });
				return;
			}

			case "journalAdd": {
				const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import("node:fs");
				const { dirname: dir } = await import("node:path");
				const path = payload.path as string;
				mkdirSync(dir(path), { recursive: true });
				const current: unknown[] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
				current.push(payload.entry);
				writeFileSync(path, JSON.stringify(current), "utf8");
				reply({ journaled: current.length });
				return;
			}

			case "journalRemove": {
				const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
				const path = payload.path as string;
				if (!existsSync(path)) {
					reply({ removed: 0 });
					return;
				}
				const ids = new Set(payload.ids as string[]);
				const current: Array<{ id: string }> = JSON.parse(readFileSync(path, "utf8"));
				const kept = current.filter((e) => !ids.has(e.id));
				writeFileSync(path, JSON.stringify(kept), "utf8");
				reply({ removed: current.length - kept.length });
				return;
			}

			case "exit":
				draining = true;
				reply({ exiting: true });
				// Let the reply flush before exiting.
				setTimeout(() => process.exit(0), 20);
				return;

			default:
				fail(`unknown op: ${op}`);
		}
	} catch (err) {
		fail((err as Error).message ?? String(err));
	}
}

/** Dates arrive as plain strings over IPC — nothing to revive today, but keep the seam. */
function revive(doc: SoulDocument): SoulDocument {
	return doc;
}

/**
 * Messages are handled strictly in arrival order: ops mutate shared journal and
 * soul files, so concurrent handling could reorder add/remove pairs.
 */
let chain: Promise<void> = Promise.resolve();

process.on("message", (message: { id?: string; op?: string; payload?: Payload }) => {
	bumpIdle();
	const id = message.id ?? "";
	const op = message.op ?? "";
	chain = chain.then(
		() =>
			new Promise<void>((resolve) => {
				const done = (packet: Record<string, unknown>) => {
					try {
						process.send?.(packet);
					} catch {
						/* parent gone */
					}
					resolve();
				};
				const reply: Reply = (result) => done({ id, ok: true, result });
				const fail: Fail = (error) => done({ id, ok: false, error });
				void handle(op, message.payload ?? {}, reply, fail);
			}),
	);
});

process.on("disconnect", () => {
	// Parent (pi) went away: finish whatever is in flight (handlers are already
	// running), then exit promptly so nothing lingers.
	draining = true;
	if (idleTimer) clearTimeout(idleTimer);
	setTimeout(() => process.exit(0), 250);
});

bumpIdle();
process.send?.({ id: "", ok: true, result: { ready: true, pid: process.pid } });
