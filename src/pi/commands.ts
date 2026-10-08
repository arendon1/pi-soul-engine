/**
 * /soul commands — user-facing surface.
 *
 * `/soul` opens an overlay panel (TUI custom component — overlays only, no
 * footer/status plugins). Every command degrades to notifications in RPC /
 * JSON / print modes.
 */
import type { Component, Theme, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SoulBridge } from "./bridge.ts";
import { memoryMessage } from "./injection.ts";
import { dreamSummary } from "../runtime/dream.ts";

// ── the /soul panel ─────────────────────────────────────────────────────────

class SoulPanel implements Component {
	private lines: string[] | null = null;

	constructor(
		private readonly text: string,
		private readonly onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.lines) return this.lines;
		const out: string[] = [""];
		for (const line of this.text.split("\n")) {
			out.push(truncateToWidth(line, width));
		}
		out.push("", truncateToWidth("(esc to close)", width));
		this.lines = out;
		return out;
	}

	invalidate(): void {
		this.lines = null;
	}

	focus(): void {}
	blur(): void {}
	dispose(): void {}
}

function soulStatusText(bridge: SoulBridge): string {
	const soul = bridge.soul();
	const id = soul.config.identity;
	const dna = soul.config.dna.personality;
	const counts = soul.store.counts();
	const bond = soul.bondSnapshot();
	const p = (n: number): string => {
		const filled = Math.round(n * 10);
		return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${(n * 100).toFixed(0)}%`;
	};
	const lines: string[] = [];
	lines.push(`◆ ${id.name}${id.archetype ? ` — ${id.archetype}` : ""}  [${soul.config.lifecycle}, incarnation ${id.incarnation}]`);
	lines.push(`  ${id.did}`);
	lines.push("");
	lines.push("OCEAN");
	lines.push(`  openness          ${p(dna.openness)}`);
	lines.push(`  conscientiousness ${p(dna.conscientiousness)}`);
	lines.push(`  extraversion      ${p(dna.extraversion)}`);
	lines.push(`  agreeableness     ${p(dna.agreeableness)}`);
	lines.push(`  neuroticism       ${p(dna.neuroticism)}`);
	lines.push("");
	lines.push("State");
	lines.push(`  mood ${soul.config.state.mood} · energy ${Math.round(soul.config.state.energy)}/100 · focus ${soul.config.state.focus} · social ${Math.round(soul.config.state.social_battery)}/100`);
	lines.push("");
	lines.push("Bond");
	lines.push(`  with ${bond.bondedTo ?? "the human"} — ${bond.label} (${bond.strength}/100, ${bond.interactions} interactions)`);
	lines.push("");
	lines.push("Memory");
	for (const [layer, n] of Object.entries(counts)) {
		lines.push(`  ${layer.padEnd(12)} ${n}`);
	}
	const tops = Object.values(soul.selfModel.self_images)
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, 3);
	if (tops.length > 0) {
		lines.push("");
		lines.push("Self-concept");
		for (const image of tops) {
			lines.push(`  ${image.domain} — ${(image.confidence * 100).toFixed(0)}% (${image.evidence_count} obs)`);
		}
	}
	const stats = soul.evaluationStats();
	if (stats.length > 0) {
		lines.push("");
		lines.push("Evaluation");
		for (const s of stats.slice(0, 3)) {
			lines.push(`  ${s.domain} — ${s.count} × avg ${(s.avg_score * 100).toFixed(0)}% (streak ${s.streak})`);
		}
	}
	const lessons = soul.learning.list({ limit: 3 });
	if (lessons.length > 0) {
		lines.push("");
		lines.push("Lessons");
		for (const lesson of lessons) {
			lines.push(`  [${lesson.domain}] ${lesson.lesson.slice(0, 90)}`);
		}
	}
	const pending = soul.pendingEvolutions();
	if (pending.length > 0) {
		lines.push("");
		lines.push(`Pending evolution: ${pending.length} (see /soul-approve)`);
	}
	lines.push("");
	lines.push("");
	const status = bridge.engineStatus();
	const engineLine =
		"note" in status
			? `engine ${status.engine} (heuristic only)`
			: `engine ${status.engine}${status.degraded ? " DEGRADED" : ""} · analysis ${status.tiers.analysis ?? "—"} · cache ${status.telemetry.cacheHits}/${status.telemetry.cacheHits + status.telemetry.cacheMisses}`;
	lines.push(`${engineLine} · domain ${bridge.domainOrNull() ?? "global"} · dir ~/.pi/agent/souls`);
	return lines.join("\n");
}

// ── helpers ─────────────────────────────────────────────────────────────────

function report(ctx: ExtensionCommandContext, text: string): void {
	if (ctx.hasUI && ctx.mode === "tui") {
		void ctx.ui.custom<void>(
			(_tui: TUI, _theme: Theme, _kb, done) => new SoulPanel(text, () => done(undefined)),
			{ overlay: true },
		);
	} else {
		ctx.ui.notify(text.split("\n").slice(0, 12).join(" | "), "info");
	}
}

// ── registration ────────────────────────────────────────────────────────────

export function registerSoulCommands(pi: ExtensionAPI, bridge: SoulBridge): void {
	pi.registerCommand("soul", {
		description: "Soul status panel (identity, mood, bond, memory)",
		handler: async (_args, ctx) => report(ctx, soulStatusText(bridge)),
	});

	pi.registerCommand("soul-list", {
		description: "List souls in ~/.pi/agent/souls",
		handler: async (_args, ctx) => {
			const souls = bridge.manager.list();
			report(
				ctx,
				souls.length
					? souls.map((s) => `◆ ${s.name}  ${s.path}`).join("\n")
					: "No souls yet. Use /soul-birth to create one.",
			);
		},
	});

	pi.registerCommand("soul-birth", {
		description: "Birth a new soul (name, archetype, values, OCEAN)",
		handler: async (args, ctx) => {
			let name = args.trim();
			if (!name && ctx.hasUI) name = (await ctx.ui.input("Soul name", "e.g. Aria")) ?? "";
			if (!name) {
				ctx.ui.notify("soul-birth: name required", "warning");
				return;
			}
			const archetype = ctx.hasUI ? ((await ctx.ui.input("Archetype (optional)", "e.g. The Companion")) ?? "") : "";
			const valuesRaw = ctx.hasUI ? ((await ctx.ui.input("Core values, comma separated", "curiosity, empathy, honesty")) ?? "") : "";
			const soul = bridge.manager.birth(
				ctx.cwd,
				{
					name,
					archetype,
					values: valuesRaw.split(",").map((v) => v.trim()).filter(Boolean),
					bondedTo: "human",
				},
				bridge.getEngine(),
			);
			bridge.domain = bridge.manager.domainFor(ctx.cwd);
			report(ctx, `◆ ${soul.config.identity.name} is born.\n${soul.statusLine()}`);
		},
	});

	pi.registerCommand("soul-switch", {
		description: "Switch the active soul for this project",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				report(ctx, bridge.manager.list().map((s) => s.name).join("\n") || "No souls.");
				return;
			}
			const soul = bridge.manager.switchTo(ctx.cwd, name, bridge.getEngine());
			if (!soul) {
				ctx.ui.notify(`No soul named "${name}"`, "warning");
				return;
			}
			report(ctx, `Switched to ${soul.config.identity.name}.\n${soul.statusLine()}`);
		},
	});

	pi.registerCommand("soul-recall", {
		description: "Recall memories for a query (without sending anything to the model)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("soul-recall: query required", "warning");
				return;
			}
			report(ctx, memoryMessage(bridge.soul(), args.trim(), 8));
		},
	});

	pi.registerCommand("soul-remember", {
		description: "Explicitly remember a fact",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("soul-remember: text required", "warning");
				return;
			}
			const entry = bridge.soul().remember(args.trim(), {
				domain: bridge.domainOrNull(),
				userId: bridge.userId,
			});
			bridge.manager.markDirty();
			ctx.ui.notify(`Remembered ${entry.id}`, "info");
		},
	});

	pi.registerCommand("soul-forget", {
		description: "Forget memories: <query> | entity:<name> | before:<ISO date>",
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify("soul-forget: query, entity:<name>, or before:<date> required", "warning");
				return;
			}
			const soul = bridge.soul();
			const ok = ctx.hasUI ? await ctx.ui.confirm("Forget memories?", raw) : true;
			if (!ok) return;
			let removed;
			if (raw.startsWith("entity:")) removed = soul.forgetEntity(raw.slice(7).trim());
			else if (raw.startsWith("before:")) removed = soul.forgetBefore(raw.slice(7).trim());
			else removed = soul.forget(raw);
			bridge.manager.markDirty();
			bridge.manager.flush();
			ctx.ui.notify(`Forgot ${removed.length} memories`, "info");
		},
	});

	pi.registerCommand("soul-reflect", {
		description: "Consolidate recent experiences (themes, patterns, corrections)",
		handler: async (_args, ctx) => {
			const result = await bridge.soul().reflect({ apply: true });
			bridge.observationsSinceReflect = 0;
			bridge.manager.markDirty();
			report(
				ctx,
				[
					`themes: ${result.themes.join("; ") || "(none)"}`,
					`patterns: ${result.patterns.join("; ") || "(none)"}`,
					result.summary ? `summary: ${result.summary}` : "",
					result.applied ? `corrections applied: ${result.applied}` : "",
				]
					.filter(Boolean)
					.join("\n"),
			);
		},
	});

	pi.registerCommand("soul-dream", {
		description: "Offline consolidation: patterns, archival, dedup, synthesis, insights",
		handler: async (args, ctx) => {
			const dryRun = args.includes("--dry-run") || args.includes("--preview");
			// Full path: heuristic cycle + LLM synthesis pass (best-effort).
			const report = await bridge.soul().dreamWithSynthesis({ dryRun });
			if (!dryRun) bridge.manager.markDirty();
			report(ctx, dreamSummary(report));
		},
	});

	pi.registerCommand("soul-engine", {
		description: "Cognitive engine status: tiers, breakers, budget, cache, failures, cost (/soul-engine reset to clear)",
		handler: async (args, ctx) => {
			if (args.trim() === "reset") {
				bridge.routerRef?.resetResilience();
				ctx.ui.notify("soul: engine resilience state reset", "info");
				return;
			}
			const status = bridge.engineStatus();
			if ("note" in status) {
				report(ctx, `engine: ${status.engine}\n${status.note}`);
				return;
			}
			const t = status.telemetry;
			const failures = Object.entries(t.failures)
				.filter(([, n]) => n > 0)
				.map(([k, n]) => `${k}=${n}`)
				.join(" ");
			report(
				ctx,
				[
					`engine: ${status.engine}${status.degraded ? " — DEGRADED (heuristics only)" : ""}`,
					`tiers: analysis=${status.tiers.analysis ?? "—"} · reflect=${status.tiers.reflect ?? "—"} · session=${status.tiers.session ?? "—"} · fallback=${status.tiers.fallback}`,
					`calls: ${t.attempts} attempts, ${t.retries} retries, cache ${t.cacheHits} hit / ${t.cacheMisses} miss (${status.cache.size}/${status.cache.max}), tier-skipped ${t.tierSkipped}`,
					`budget: ${status.budget.sessionCalls}/${status.budget.perSession} session · ${status.budget.lastMinute}/${status.budget.perMinute} last min · denied ${status.budget.denied}`,
					`failures: ${failures || "none"}`,
					`usage: ${t.usage.input} in / ${t.usage.output} out tokens · $${t.usage.cost.toFixed(4)}`,
					`deferrals: ${t.deferrals}`,
					`breakers: ${status.breakers.filter((b) => b.open).map((b) => `${b.key} (retry in ${Math.round(b.retryInMs / 1000)}s)`).join(", ") || "all closed"}`,
				].join("\n"),
			);
		},
	});

	pi.registerCommand("soul-learning", {
		description: "List distilled lessons (LearningEvents), optionally filtered by domain",
		handler: async (args, ctx) => {
			const soul = bridge.soul();
			const domain = args.trim() || undefined;
			const events = soul.learning.list({ domain, limit: 15 });
			if (events.length === 0) {
				report(ctx, "No learning events yet — lessons are distilled from notable scores (≥80% or ≤30%).");
				return;
			}
			report(
				ctx,
				events
					.map(
						(e) =>
							`◆ [${e.domain}] ${e.lesson}\n  confidence ${e.confidence.toFixed(2)} · applied ${e.applied_count}` +
							(e.evaluation_score !== null ? ` · score ${(e.evaluation_score * 100).toFixed(0)}%` : ""),
					)
					.join("\n"),
			);
		},
	});

	pi.registerCommand("soul-evaluate", {
		description: "Show evaluation stats per domain (these drive automatic evolution)",
		handler: async (_args, ctx) => {
			const stats = bridge.soul().evaluationStats();
			report(
				ctx,
				stats.length
					? stats
							.map((s) => `${s.domain}: ${s.count} evals, avg ${(s.avg_score * 100).toFixed(0)}%, streak ${s.streak}`)
							.join("\n")
					: "No evaluations yet.",
			);
		},
	});

	pi.registerCommand("soul-evolve", {
		description: "Propose a personality mutation: <trait> <value> [reason]",
		handler: async (args, ctx) => {
			const [trait, valueRaw, ...reason] = args.trim().split(/\s+/);
			const value = Number(valueRaw);
			if (!trait || Number.isNaN(value)) {
				const pending = bridge.soul().pendingEvolutions();
				report(
					ctx,
					pending.length
						? pending.map((m) => `${m.id}: ${m.trait} ${m.old_value} → ${m.new_value} (${m.reason})`).join("\n")
						: "No pending mutations. Usage: /soul-evolve <trait> <value> [reason]",
				);
				return;
			}
			const { mutation, auto_applied } = bridge.soul().proposeEvolution(trait, value, reason.join(" ") || "unstated");
			bridge.manager.markDirty();
			ctx.ui.notify(
				`${mutation.id}: ${mutation.trait} ${mutation.old_value} → ${mutation.new_value}${auto_applied ? " (auto-applied)" : " (pending approval)"}`,
				"info",
			);
		},
	});

	pi.registerCommand("soul-approve", {
		description: "Approve a pending mutation",
		handler: async (args, ctx) => {
			const ok = bridge.soul().approveEvolution(args.trim());
			bridge.manager.markDirty();
			ctx.ui.notify(ok ? `approved ${args.trim()}` : `no pending mutation ${args.trim()}`, ok ? "info" : "warning");
		},
	});

	pi.registerCommand("soul-reject", {
		description: "Reject a pending mutation",
		handler: async (args, ctx) => {
			const ok = bridge.soul().rejectEvolution(args.trim());
			bridge.manager.markDirty();
			ctx.ui.notify(ok ? `rejected ${args.trim()}` : `no pending mutation ${args.trim()}`, ok ? "info" : "warning");
		},
	});

	pi.registerCommand("soul-export", {
		description: "Export the soul as a portable .soul archive",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const wantsPassword = parts.includes("--password");
			const path = parts.filter((p) => !p.startsWith("--"))[0] ?? `${bridge.soul().config.identity.name}.soul`;
			let password: string | undefined;
			if (wantsPassword && ctx.hasUI) {
				password = (await ctx.ui.input("Password for AES-256-GCM encryption", "")) || undefined;
			}
			const soul = bridge.soul();
			// scrypt + deflate run in the detached worker; the UI stays responsive.
			bridge.notify("soul: export started (worker)…");
			try {
				await bridge.worker.packToFile(soul.toDocument(), path, { password });
				ctx.ui.notify(`Exported ${soul.memoryCount()} memories to ${path}${password ? " (encrypted)" : ""}`, "info");
			} catch (err) {
				ctx.ui.notify(`export failed: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("soul-import", {
		description: "Import a .soul archive (replaces the active soul)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const path = parts.filter((p) => !p.startsWith("--"))[0];
			if (!path) {
				ctx.ui.notify("soul-import: path required", "warning");
				return;
			}
			let password: string | undefined;
			if (parts.includes("--password") && ctx.hasUI) {
				password = (await ctx.ui.input("Password", "")) || undefined;
			}
			try {
				// Decryption (scrypt) happens in the detached worker.
				const doc = await bridge.worker.unpack({ path }, password);
				const { Soul } = await import("../runtime/soul.ts");
				const soul = Soul.fromDocument(doc, bridge.getEngine());
				const name = path.split("/").pop()?.replace(/\.soul$/, "") ?? "imported";
				bridge.manager.bindImported(ctx.cwd, name, soul);
				report(ctx, `Imported ${soul.config.identity.name} — ${soul.memoryCount()} memories.\n${soul.statusLine()}`);
			} catch (err) {
				ctx.ui.notify(`import failed: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("soul-config", {
		description: "Show or set config: engine=heuristic|model, model=provider/id, recallLimit=N, notifications=on|off",
		handler: async (args, ctx) => {
			const assignments = args.trim().split(/\s+/).filter((s) => s.includes("="));
			if (assignments.length === 0) {
				report(ctx, JSON.stringify(bridge.manager.getConfig(), null, 2));
				return;
			}
			const patch: Record<string, unknown> = {};
			for (const assignment of assignments) {
				const [key, value] = assignment.split("=", 2);
				if (key === "recallLimit" || key === "promptBudget" || key === "confidenceFloor") patch[key] = Number(value);
				else if (key === "notifications" || key === "cache") patch[key] = value === "on" || value === "true";
				else if (key === "engine" || key === "factsMode" || key === "rubricScoring") patch[key!] = value;
				else patch[key!] = value;
			}
			bridge.manager.configure(patch as never);
			bridge.rebuildEngine();
			report(ctx, JSON.stringify(bridge.manager.getConfig(), null, 2));
		},
	});
}
