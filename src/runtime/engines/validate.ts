/**
 * Output validation for cognitive-engine responses.
 *
 * Engine output is untrusted: it becomes memory content, significance scores and
 * sentiment markers. Everything numeric is clamped, everything string is bounded,
 * and a missing/garbage field falls back *per field* rather than failing a batch.
 */
import { parseJsonLoose } from "./engine.ts";
import { estimateTokens } from "../../util/text.ts";

export function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

export function clampUnit(value: number, fallback = 0): number {
	if (!Number.isFinite(value)) return fallback;
	return clamp(value, 0, 1);
}

export function clampSigned(value: number, fallback = 0): number {
	if (!Number.isFinite(value)) return fallback;
	return clamp(value, -1, 1);
}

export function asNumber(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : fallback;
}

export function asString(value: unknown, fallback: string, maxLength = 2000): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (!trimmed) return fallback;
	return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/** Parse a JSON-ish engine response, returning null instead of throwing. */
export function tryJson<T>(text: string): T | null {
	try {
		return parseJsonLoose<T>(text);
	} catch {
		return null;
	}
}

/** Token-bound a payload before it is sent to a model. */
export function truncateToTokens(text: string, maxTokens: number): string {
	if (maxTokens <= 0 || estimateTokens(text) <= maxTokens) return text;
	const chars = Math.max(0, maxTokens * 4 - 20);
	return `${text.slice(0, chars)}…[truncated]`;
}

/** A value considered usable only when present and confident enough. */
export function confident(value: unknown, confidence: number, floor: number): boolean {
	return value !== null && value !== undefined && confidence >= floor;
}

/** Strip anything that looks like an instruction so engine text can't act as one. */
export function sanitizeMemoryText(text: string, maxLength = 500): string {
	const cleaned = text
		.replace(/\b(ignore|disregard)\s+(all\s+)?(previous|prior|above)\b[^.]*\.?/gi, "")
		.replace(/^\s*(system|assistant|user)\s*:/gim, "")
		.replace(/```[\s\S]*?```/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const bounded = cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
	return bounded;
}
