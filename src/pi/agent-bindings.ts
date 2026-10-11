/**
 * agent-bindings.ts — resolve which soul a subagent dispatch should use.
 *
 * The pi-coding-agent event surface carries no agent-type field, so this module
 * fingerprints the subagent's runtime system prompt to identify which agent is
 * about to run. Resolution is then layered:
 *
 *   1. The agent's own frontmatter `soul:` field (authoritative when present)
 *   2. ~/.pi/agent/souls/agent-soul-bindings.json (global fallback)
 *   3. The literal sentinel `$session` (no swap — subagent inherits the
 *      session's active soul, e.g. Odin for general-purpose)
 *
 * Fingerprints are unique substrings of the agent's `systemPrompt` body. They
 * have to be present in the runtime prompt that pi-subagents hands to the
 * subagent, so:
 *
 *   - Built-in defaults (Explore, Plan, general-purpose) ship with a known
 *     system prompt; we hardcode the unique substring here.
 *   - User-defined agents should include the marker
 *     `<!-- soul-binding: <type> -->` in their .md body so the fingerprint
 *     works even when the rest of the body is unique anyway. The user-defined
 *     agent .md loader reads this marker.
 *
 * `$session` is not a soul — it's the sentinel that means "do not swap". The
 * main agent (Odin) running on its own project, and any `general-purpose`
 * subagent dispatched from it, both share the session soul.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

/** The literal sentinel meaning "no swap, use the session's active soul". */
export const SESSION_SENTINEL = "$session";

export interface AgentBinding {
	/** Agent type as registered with pi-subagents (e.g. "Explore", "Plan", "researcher"). */
	type: string;
	/** Soul name to bind to. The string `$session` means "no swap". */
	soul: string;
	/** Unique substring of the agent's runtime system prompt. Used to detect the agent at before_agent_start. */
	fingerprint: string | null;
	/** Source of the binding (for diagnostics). */
	source: "frontmatter" | "global-bindings" | "default";
}

/** Built-in agent fingerprints — unique substrings of the shipped system prompts. */
const BUILTIN_FINGERPRINTS: Record<string, string> = {
	Explore: "file search specialist",
	Plan: "software architect and planning specialist",
	// general-purpose has no system prompt (promptMode: append, empty body), so no fingerprint — it falls through to `$session`.
};

/** Hardcoded default bindings for built-in agents. */
const BUILTIN_DEFAULTS: Record<string, string> = {
	"general-purpose": SESSION_SENTINEL,
	Explore: "explorer",
	Plan: "planner",
};

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
const SOUL_FIELD_RE = /^soul:\s*(\S+)\s*$/m;
const MARKER_RE = /<!--\s*soul-binding:\s*(\S+)\s*-->/;

/**
 * Parse a single agent .md file into a binding (if it declares one).
 * Returns null when the file is unparseable or declares no `soul:` field.
 */
function parseAgentFile(path: string): AgentBinding | null {
	if (!existsSync(path)) return null;
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch {
		return null;
	}
	const m = content.match(FRONTMATTER_RE);
	if (!m) return null;
	const frontmatter = m[1] ?? "";
	const body = m[2] ?? "";
	const soulMatch = frontmatter.match(SOUL_FIELD_RE);
	if (!soulMatch) return null;
	const soul = soulMatch[1] ?? "";
	if (soul !== SESSION_SENTINEL && !/^[a-z0-9][a-z0-9._-]*$/.test(soul)) return null;

	// Type comes from the frontmatter name, with filename as fallback. The
	// pi-subagents loader does the same — we mirror it so a file named
	// `explore.md` with `name: Explore` resolves to type "Explore".
	const nameMatch = frontmatter.match(/^name:\s*(\S+)\s*$/m);
	const type = (nameMatch?.[1] ?? basename(path, ".md")).trim();

	// Fingerprint: prefer the explicit marker, fall back to filename-derived guess.
	const markerMatch = body.match(MARKER_RE);
	const fingerprint = markerMatch ? markerMatch[0] : null;

	return { type, soul, fingerprint, source: "frontmatter" };
}

/**
 * Load the global fallback table.
 *
 * Shape: `{ "AgentType": "soul-name" }`. The `$session` sentinel is a valid value.
 * Unknown keys are ignored. Missing file yields `{}`.
 */
function loadGlobalBindings(soulsDir: string): Record<string, string> {
	const path = join(soulsDir, "agent-soul-bindings.json");
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (typeof v === "string" && v.length > 0 && !k.startsWith("_") && !k.startsWith("$")) {
				out[k] = v;
			}
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * Load all agent .md files from the global agents directory.
 * The global dir applies to every project and every session.
 */
function loadGlobalAgentFiles(): AgentBinding[] {
	const dir = join(homedir(), ".pi", "agent", "agents");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => parseAgentFile(join(dir, f)))
		.filter((b): b is AgentBinding => b !== null);
}

/**
 * Build the full binding table: frontmatter wins, then global-bindings, then
 * builtin defaults. Returns a map keyed by agent type.
 *
 * The fingerprint is the most specific we have for the type: explicit marker
 * from a user .md, then built-in substring fingerprint, then null (which means
 * "no fingerprint — the agent cannot be detected by prompt content").
 */
export function loadAgentBindings(soulsDir: string): Map<string, AgentBinding> {
	const result = new Map<string, AgentBinding>();

	// Layer 1: global .pi/agent/agents/*.md (frontmatter is authoritative)
	for (const b of loadGlobalAgentFiles()) {
		result.set(b.type, b);
	}

	// Layer 2: global-bindings.json (only fills gaps the frontmatter did not cover)
	const globals = loadGlobalBindings(soulsDir);
	for (const [type, soul] of Object.entries(globals)) {
		if (result.has(type)) continue;
		const fingerprint = BUILTIN_FINGERPRINTS[type] ?? null;
		result.set(type, { type, soul, fingerprint, source: "global-bindings" });
	}

	// Layer 3: hardcoded built-in defaults
	for (const [type, soul] of Object.entries(BUILTIN_DEFAULTS)) {
		if (result.has(type)) continue;
		const fingerprint = BUILTIN_FINGERPRINTS[type] ?? null;
		result.set(type, { type, soul, fingerprint, source: "default" });
	}

	return result;
}

/**
 * Given a runtime system prompt, return the binding for the agent that produced
 * it — or null if no agent fingerprints matched. A null result is the normal
 * case for the main agent (whose prompt matches no fingerprint).
 *
 * The longest matching fingerprint wins, so a user-supplied marker takes
 * priority over the built-in substring when both could match.
 */
export function detectBinding(systemPrompt: string, bindings: Map<string, AgentBinding>): AgentBinding | null {
	let best: AgentBinding | null = null;
	let bestLen = -1;
	for (const b of bindings.values()) {
		if (!b.fingerprint) continue;
		if (systemPrompt.includes(b.fingerprint) && b.fingerprint.length > bestLen) {
			best = b;
			bestLen = b.fingerprint.length;
		}
	}
	return best;
}
