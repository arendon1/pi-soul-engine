/**
 * Renderers — soul tools and audit entries draw as compact cards in the
 * transcript (and HTML exports). No footer/status involvement anywhere.
 */
import type { Component, Theme } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { CustomEntry, CustomMessage, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ObserveRecord } from "./bridge.ts";

/** Minimal line-based component (matches pi-tui's Component contract). */
export function linesComponent(lines: string[]): Component & { dispose(): void } {
	let cached: string[] | null = null;
	return {
		render(width: number): string[] {
			if (!cached) cached = lines.map((line) => truncateToWidth(line, width));
			return cached;
		},
		handleInput(): void {},
		focus(): void {},
		blur(): void {},
		dispose(): void {},
	};
}

export function registerSoulRenderers(pi: ExtensionAPI): void {
	// Audit entries from the observe pipeline.
	pi.registerEntryRenderer<ObserveRecord>("soul:observation", (entry: CustomEntry<ObserveRecord>, _options, theme: Theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const mark = data.stored ? theme.fg("success", "♥") : theme.fg("dim", "·");
		const line = `${mark} ${theme.fg("dim", "soul observed")}  significance ${data.significance}${data.stored ? ` → episodic ${data.episodicId ?? ""}${data.factCount ? ` +${data.factCount} facts` : ""}` : " (filtered)"}  mood ${data.mood}`;
		return linesComponent([line]);
	});

	// Reflection summaries.
	pi.registerEntryRenderer<{ themes?: string[]; summary?: string }>("soul:reflection", (entry, _options, theme: Theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const lines = [`${theme.fg("accent", "◆ soul reflected")}${data.themes?.length ? ` — ${data.themes.join(", ")}` : ""}`];
		if (data.summary) lines.push(`  ${data.summary.slice(0, 200)}`);
		return linesComponent(lines);
	});

	// Compaction distillation marker.
	pi.registerEntryRenderer<{ memories: number }>("soul:compaction_distill", (entry, _options, theme: Theme) => {
		const data = entry.data;
		if (!data) return undefined;
		return linesComponent([`${theme.fg("accent", "◆ soul distilled")} — ${data.memories} memories preserved across compaction`]);
	});

	// Deferred observation: engine aborted/unavailable; the exchange is kept for
	// the next session rather than fabricated into a result.
	pi.registerEntryRenderer<{ attempts?: number; reason?: string }>("soul:deferred", (entry, _options, theme: Theme) => {
		const data = entry.data;
		if (!data) return undefined;
		return linesComponent([
			`${theme.fg("warning", "◆ soul deferred")} — retrying next session (${data.reason ?? "engine unavailable"}, attempt ${data.attempts ?? 0})`,
		]);
	});

	// Memory cards for explicit recall messages.
	pi.registerMessageRenderer<{ memories: Array<{ type: string; content: string; activation?: number }> }>(
		"soul:memory",
		(message: CustomMessage<{ memories: Array<{ type: string; content: string; activation?: number }> }>, _options, theme: Theme) => {
			const memories = message.details?.memories ?? [];
			const lines = [theme.fg("accent", "◆ soul memory")];
			for (const memory of memories.slice(0, 8)) {
				lines.push(`  ${theme.fg("dim", `[${memory.type}]`)} ${memory.content.slice(0, 160)}`);
			}
			return linesComponent(lines);
		},
	);
}
