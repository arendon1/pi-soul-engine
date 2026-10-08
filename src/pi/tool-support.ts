/**
 * Shared tool infrastructure.
 *
 * The namespace descriptor and the standard result builder live here rather than
 * in `tools.ts` so that `tools-admin.ts` can use them without importing
 * `tools.ts` (which would be a cycle, since `tools.ts` registers the admin
 * tools). Keeping one definition also means the namespace a tool is grouped
 * under cannot drift between the two files.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export const SOUL_NAMESPACE = {
	name: "soul",
	description:
		"Long-term identity, memory, and emotion of the agent (Soul Protocol). " +
		"Memories persist across sessions and projects; recall is automatic at prompt time.",
	instructions:
		"Use soul_remember for durable facts the human explicitly asks you to keep or that are clearly " +
		"worth carrying across sessions. Use soul_recall for anything about the human's history, " +
		"preferences, or past work that is not in the current context. Memories are fallible: when a " +
		"recall result conflicts with current context, trust the present and supersede the old memory. " +
		"Use soul_engine to inspect the cognitive engine's health and soul_config to change it; these " +
		"replace the /soul-engine and /soul-config commands, which the human should not have to run by hand.",
};

/** Standard result shape: model-facing text, plus structured details for rendering. */
export function textResult(
	text: string,
	details?: unknown,
	structuredContent?: unknown,
	isError = false,
): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text }],
		details,
		...(structuredContent !== undefined ? { structuredContent: structuredContent as never } : {}),
		...(isError ? { isError: true } : {}),
	};
}
