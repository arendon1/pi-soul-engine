/**
 * Minimal ZIP reader/writer (DEFLATE), dependency-free.
 *
 * Enough of the ZIP spec for `.soul` archives: central-directory parsing with
 * zip-slip protection on read, DEFLATED/STORED entries, CRC-32 checksums.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// ── CRC-32 ──────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

export function crc32(buf: Uint8Array): number {
	let crc = -1;
	for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]!;
	return (crc ^ -1) >>> 0;
}

// ── Writer ──────────────────────────────────────────────────────────────────

export interface ZipEntryInput {
	name: string;
	data: Uint8Array | string;
}

export function zipWrite(entries: ZipEntryInput[]): Uint8Array {
	const chunks: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, "utf8");
		const dataBuf = Buffer.isBuffer(entry.data)
			? entry.data
			: typeof entry.data === "string"
				? Buffer.from(entry.data, "utf8")
				: Buffer.from(entry.data);
		const crc = crc32(dataBuf);
		const deflated = deflateRawSync(dataBuf, { level: 9 });
		const useDeflate = deflated.length < dataBuf.length;
		const payload = useDeflate ? deflated : dataBuf;
		const method = useDeflate ? 8 : 0;

		const local = Buffer.alloc(30);
		local.writeUInt32LE(SIG_LOCAL, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(0, 10); // time
		local.writeUInt16LE(0x21, 12); // date (1980-01-01)
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(dataBuf.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		chunks.push(local, nameBuf, payload);

		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(SIG_CENTRAL, 0);
		cen.writeUInt16LE(20, 4); // version made by
		cen.writeUInt16LE(20, 6); // version needed
		cen.writeUInt16LE(0x0800, 8);
		cen.writeUInt16LE(method, 10);
		cen.writeUInt16LE(0, 12);
		cen.writeUInt16LE(0x21, 14);
		cen.writeUInt32LE(crc, 16);
		cen.writeUInt32LE(payload.length, 20);
		cen.writeUInt32LE(dataBuf.length, 24);
		cen.writeUInt16LE(nameBuf.length, 28);
		cen.writeUInt16LE(0, 30); // extra len
		cen.writeUInt16LE(0, 32); // comment len
		cen.writeUInt16LE(0, 34); // disk number
		cen.writeUInt16LE(0, 36); // internal attrs
		cen.writeUInt32LE(0, 38); // external attrs
		cen.writeUInt32LE(offset, 42);
		central.push(cen, nameBuf);

		offset += local.length + nameBuf.length + payload.length;
	}

	const centralBuf = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(SIG_EOCD, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralBuf.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);

	return new Uint8Array(Buffer.concat([...chunks, centralBuf, eocd]));
}

// ── Reader ──────────────────────────────────────────────────────────────────

function findEocd(buf: Buffer): number {
	for (let i = buf.length - 22; i >= 0; i--) {
		if (buf.readUInt32LE(i) === SIG_EOCD) return i;
	}
	throw new Error("Invalid .soul archive: no end-of-central-directory record");
}

function safeEntryName(name: string): string {
	if (name.includes("..") || name.startsWith("/") || name.includes("\\")) {
		throw new Error(`Unsafe path in archive: ${name}`);
	}
	return name;
}

export function zipRead(data: Uint8Array): Map<string, Buffer> {
	const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
	const eocd = findEocd(buf);
	const count = buf.readUInt16LE(eocd + 10);
	let ptr = buf.readUInt32LE(eocd + 16);
	const out = new Map<string, Buffer>();

	for (let i = 0; i < count; i++) {
		if (buf.readUInt32LE(ptr) !== SIG_CENTRAL) {
			throw new Error("Invalid .soul archive: corrupt central directory");
		}
		const method = buf.readUInt16LE(ptr + 10);
		const compressedSize = buf.readUInt32LE(ptr + 20);
		const nameLen = buf.readUInt16LE(ptr + 28);
		const extraLen = buf.readUInt16LE(ptr + 30);
		const commentLen = buf.readUInt16LE(ptr + 32);
		const localOffset = buf.readUInt32LE(ptr + 42);
		const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
		ptr += 46 + nameLen + extraLen + commentLen;

		if (name.endsWith("/")) continue; // directory entry

		if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
			throw new Error("Invalid .soul archive: corrupt local header");
		}
		const localNameLen = buf.readUInt16LE(localOffset + 26);
		const localExtraLen = buf.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLen + localExtraLen;
		const raw = buf.subarray(dataStart, dataStart + compressedSize);

		const payload = method === 8 ? inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
		if (payload === null) {
			throw new Error(`Unsupported compression method ${method} for ${name}`);
		}
		out.set(safeEntryName(name), payload);
	}
	return out;
}
