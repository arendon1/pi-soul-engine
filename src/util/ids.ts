/**
 * Small shared helpers: id generation, timestamps, JSONL.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function newId(prefix: string): string {
	return `${prefix}-${randomBytes(4).toString("hex")}`;
}

export function nowIso(): string {
	return new Date().toISOString();
}

/** DID per the spec: `did:soul:<name-slug>-<6 hex>`. */
export function makeDid(name: string): string {
	const slug =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32) || "soul";
	return `did:soul:${slug}-${randomBytes(3).toString("hex")}`;
}

export function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

export function readJson<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function appendJsonl(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

export function readJsonl<T>(path: string): T[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as T);
}
