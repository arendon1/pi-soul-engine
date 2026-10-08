/**
 * Trust chain — cryptographic verification of a soul's history (roadmap v0.8.0
 * upstream, implemented here): every memory write, forget, supersede, mutation
 * and bond change is signed and appended to a hash chain (Ed25519, node:crypto).
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { TrustChainFile, TrustEntry } from "../spec/types.ts";
import { nowIso } from "../util/ids.ts";
import { createHash } from "node:crypto";

export class TrustChainManager {
	private chain: TrustChainFile;
	private privateKey: string;
	private readOnly: boolean;

	constructor(existing?: TrustChainFile, privateKeyPem?: string) {
		if (existing) {
			this.chain = existing;
			this.privateKey = privateKeyPem ?? existing.private_key ?? "";
			this.readOnly = this.privateKey === "";
		} else {
			const { publicKey, privateKey } = generateKeyPairSync("ed25519");
			this.privateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
			this.chain = {
				algorithm: "ed25519",
				public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
				entries: [],
			};
			this.chain.private_key = this.privateKey;
			this.readOnly = false;
		}
	}

	get publicKeyPem(): string {
		return this.chain.public_key;
	}

	get privateKeyPem(): string {
		return this.privateKey;
	}

	toJSON(): TrustChainFile {
		return this.chain;
	}

	private hashOf(seq: number, timestamp: string, action: string, payload: string, prevHash: string): string {
		return createHash("sha256")
			.update(`${seq}\n${timestamp}\n${action}\n${payload}\n${prevHash}`)
			.digest("hex");
	}

	/** Append one signed action to the chain. */
	append(action: string, payload: unknown): TrustEntry {
		if (this.readOnly) throw new Error("trust chain is read-only (no signing key present)");
		const seq = this.chain.entries.length;
		const timestamp = nowIso();
		const payloadText = JSON.stringify(payload ?? {});
		const prev_hash = seq === 0 ? "genesis" : this.chain.entries[seq - 1]!.hash;
		const hash = this.hashOf(seq, timestamp, action, payloadText, prev_hash);
		const signature = sign(null, Buffer.from(hash, "hex"), createPrivateKey(this.privateKey)).toString("base64");
		const entry: TrustEntry = { seq, timestamp, action, payload: payloadText, prev_hash, hash, signature };
		this.chain.entries.push(entry);
		return entry;
	}

	/** Full-chain verification: hash links + signatures. */
	verifyChain(): { ok: boolean; error: string | null; checked: number } {
		const publicKey = createPublicKey(this.chain.public_key);
		let prevHash = "genesis";
		for (const entry of this.chain.entries) {
			if (entry.seq !== this.chain.entries.indexOf(entry)) {
				return { ok: false, error: `sequence break at ${entry.seq}`, checked: entry.seq };
			}
			const expected = this.hashOf(entry.seq, entry.timestamp, entry.action, entry.payload, prevHash);
			if (expected !== entry.hash) {
				return { ok: false, error: `hash mismatch at seq ${entry.seq}`, checked: entry.seq };
			}
			const valid = verify(null, Buffer.from(entry.hash, "hex"), publicKey, Buffer.from(entry.signature, "base64"));
			if (!valid) {
				return { ok: false, error: `bad signature at seq ${entry.seq}`, checked: entry.seq };
			}
			prevHash = entry.hash;
		}
		return { ok: true, error: null, checked: this.chain.entries.length };
	}

	audit(actionPrefix?: string, limit = 50): TrustEntry[] {
		const entries = actionPrefix
			? this.chain.entries.filter((e) => e.action.startsWith(actionPrefix))
			: this.chain.entries;
		return entries.slice(-limit);
	}
}
