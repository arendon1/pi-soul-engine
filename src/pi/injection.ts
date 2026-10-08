/**
 * Context injection — the soul's voice in the system prompt.
 *
 * Named sections (`soul_identity`, `soul_state`, `soul_memory`) let Pi append
 * transcript deltas instead of rewriting the prompt, so prompt caching keeps
 * working. All sections are token-budget capped.
 */
import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { Soul } from "../runtime/soul.ts";
import { estimateTokens } from "../util/text.ts";

export interface InjectionOptions {
	promptBudget?: number;
	recallLimit?: number;
}

export interface InjectionResult {
	sections: Record<string, string>;
	recalled: Array<{ id: string; type: string; text: string; activation: number }>;
}

export function buildSoulSections(
	soul: Soul,
	userPrompt: string,
	options: InjectionOptions = {},
): InjectionResult {
	const budget = options.promptBudget ?? 400;
	const recallLimit = options.recallLimit ?? 5;

	const sections: Record<string, string> = {};
	sections.soul_identity = soul.toSystemPrompt({ maxTokens: budget });

	const bond = soul.bondSnapshot();
	sections.soul_state =
		`mood: ${soul.config.state.mood}; energy: ${Math.round(soul.config.state.energy)}/100; ` +
		`focus: ${soul.config.state.focus}; bond with ${bond.bondedTo ?? "the human"}: ${bond.label} (${Math.round(bond.strength)}/100, ${bond.interactions} interactions); ` +
		`memories: ${soul.memoryCount()}`;

	const recalled = userPrompt.trim()
		? soul
				.recall(userPrompt, { limit: recallLimit * 2 })
				.filter((hit) => hit.parts.spreading > 0) // relevance floor for prompt injection
				.slice(0, recallLimit)
				.map((hit) => ({
					id: hit.entry.id,
					type: hit.entry.type,
					text: hit.entry.content,
					activation: Number(hit.activation.toFixed(3)),
				}))
		: [];
	if (recalled.length > 0) {
		const lines = [
			"Relevant long-term memories for this request (recall from my soul; treat as my own experience):",
		];
		let spent = estimateTokens(lines[0]!);
		for (const memory of recalled) {
			const line = `- [${memory.type}] ${memory.text}`;
			spent += estimateTokens(line);
			if (spent > budget) break;
			lines.push(line);
		}
		sections.soul_memory = lines.join("\n");
	} else {
		sections.soul_memory = "";
	}

	return { sections, recalled };
}

/** Apply soul sections to a before_agent_start options object. */
export function applySoulSections(
	options: NormalizedBuildSystemPromptOptions,
	soul: Soul,
	userPrompt: string,
	injection: InjectionOptions = {},
): InjectionResult {
	const result = buildSoulSections(soul, userPrompt, injection);
	for (const [key, value] of Object.entries(result.sections)) {
		if (value) options.sections[key] = value;
		else delete options.sections[key];
	}
	return result;
}

/** Plain-text context block for custom messages / non-prompt surfaces. */
export function memoryMessage(soul: Soul, query: string, limit = 5): string {
	const recalled = soul
		.recall(query, { limit: limit * 2 })
		.filter((hit) => hit.parts.spreading > 0)
		.slice(0, limit)
		.map((hit) => ({ id: hit.entry.id, type: hit.entry.type, text: hit.entry.content, activation: 0 }));
	if (recalled.length === 0) return "No relevant memories surfaced.";
	const lines = [`(memories of ${soul.config.identity.name} — recalled for: "${query.slice(0, 120)}")`];
	for (const memory of recalled) lines.push(`- [${memory.type}] ${memory.text}`);
	return lines.join("\n");
}
