/**
 * Lifecycle wiring — where the soul meets the agent loop.
 *
 * Non-blocking contract: **no handler ever awaits soul work.** Anything that
 * takes time (the observe pipeline, reflection, persistence, crypto) runs as
 * detached background work or in the soul worker child process. Sending
 * messages, settling runs, compaction, and closing sessions never wait on the
 * soul.
 *
 *   session_start        awaken soul, bind project domain (fast local read)
 *   before_agent_start   inject soul_identity / soul_state / soul_memory (in-memory)
 *   agent_end            kick observe() in the background, return immediately
 *   agent_before_settle  kick reflection in the background, never continue
 *   session_before_compact  kick distillation in the background, return immediately
 *   session_shutdown     hand state to the worker, return immediately
 */
import type {
	AgentBeforeSettleEvent,
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { SoulBridge } from "./bridge.ts";
import { applySoulSections } from "./injection.ts";

// Reflection cadence is configurable (config.reflectEvery, default 8).

/** Pull the user prompt + final assistant text out of an agent run. */
export function exchangeOf(event: AgentEndEvent): { userText: string; agentText: string } | null {
	let userText = "";
	const assistantTexts: string[] = [];
	for (const message of event.messages) {
		if (message.role === "user") {
			const content = message.content;
			if (typeof content === "string") userText = content;
			else {
				userText = content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
			}
		} else if (message.role === "assistant") {
			const text = message.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			if (text.trim()) assistantTexts.push(text);
		}
	}
	const agentText = assistantTexts[assistantTexts.length - 1] ?? "";
	if (!userText.trim()) return null;
	return { userText, agentText };
}

export function registerSoulLifecycle(pi: ExtensionAPI, bridge: SoulBridge): void {
	pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
		// Awakening is a small local read (the soul's JSON) — it must be ready
		// before the first prompt injection, but it costs milliseconds. Anything
		// heavier lives in the worker.
		bridge.bind(ctx);
		bridge.rebuildEngine();
		try {
			bridge.soul();
			// Exchanges journaled by a session that exited mid-turn: replay in the
			// background — the soul loses nothing across restarts.
			if (bridge.replayPending() > 0) {
				bridge.notify("soul: processing memories carried over from the last session");
			}
		} catch (err) {
			bridge.notify(`soul: awaken failed (${(err as Error).message})`, "warning");
		}
		void event;
	});

	pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
		// Pure in-memory recall + section building — microseconds, no I/O.
		if (!bridge.hasSoul()) return;
		// Detect the agent type from the runtime system prompt and swap to its
		// bound soul, if any. Runs before injection so the soul sections are
		// built from the *subagent's* soul, not the parent's. The main agent's
		// prompt matches no fingerprint, so the active soul stays put.
		try {
			bridge.detectAndPushSoul(event.systemPrompt);
		} catch {
			/* never block the agent on soul errors */
		}
		try {
			const soul = bridge.soul();
			const config = bridge.manager.getConfig();
			applySoulSections(event.systemPromptOptions, soul, event.prompt, {
				promptBudget: config.promptBudget,
				recallLimit: config.recallLimit,
			});
		} catch {
			/* never block the agent on soul errors */
		}
	});

	pi.on("agent_end", (event: AgentEndEvent) => {
		// Fire-and-forget: the observe pipeline runs in the background; message
		// flow and run settlement continue without it.
		const exchange = exchangeOf(event);
		if (exchange) {
			void bridge.enqueueObserve(exchange.userText, exchange.agentText).catch(() => undefined);
		}
		// Queue a pop on the same serial queue as the observe, so the subagent's
		// observation lands in the *subagent's* soul before the parent is
		// restored. The main agent's own agent_end has an empty stack, so the
		// pop is a no-op there.
		void bridge.enqueuePopSoul().catch(() => undefined);
	});

	pi.on("agent_before_settle", (event: AgentBeforeSettleEvent, ctx: ExtensionContext) => {
		// Fire-and-forget reflection. Never returns continue: the soul reflects
		// quietly in the background and reports through a toast at most.
		void event;
		if (!bridge.hasSoul()) return;
		if (bridge.observationsSinceReflect < bridge.manager.getConfig().reflectEvery) return;
		const signal = ctx.signal ?? undefined;
		void (async () => {
			try {
				const soul = bridge.soul();
				const result = await soul.reflect({ apply: true, signal });
				bridge.observationsSinceReflect = 0;
				bridge.manager.markDirty();
				if (result.themes.length > 0 || result.summary) {
					bridge.append<{ themes: string[]; summary: string }>("soul:reflection", {
						themes: result.themes,
						summary: result.summary,
					});
					bridge.notify(
						`soul: reflected — ${result.themes.slice(0, 2).join(", ") || "patterns updated"}`,
					);
				}
			} catch {
				/* reflection is best-effort */
			}
		})();
	});

	pi.on("session_before_compact", (event: SessionBeforeCompactEvent) => {
		// Fire-and-forget distillation: compaction proceeds immediately. The
		// soul preserves what the context is about to forget, whenever it lands.
		if (!bridge.hasSoul()) return;
		void (async () => {
			try {
				const soul = bridge.soul();
				const before = soul.memoryCount();
				await soul.reflect({ apply: true, signal: event.signal });
				bridge.observationsSinceReflect = 0;
				bridge.manager.markDirty();
				bridge.manager.flush(); // hand state to the worker now
				const delta = soul.memoryCount() - before;
				bridge.append<{ memories: number }>("soul:compaction_distill", {
					memories: soul.memoryCount(),
				});
				if (delta > 0) bridge.notify(`soul: preserved ${delta} new memories across compaction`);
			} catch {
				/* compaction proceeds regardless */
			}
		})();
	});

	pi.on("session_shutdown", (_event: SessionShutdownEvent) => {
		// Hand the final state to the detached worker and return immediately.
		// The worker drains its queue and exits even after pi is gone.
		try {
			bridge.shutdown();
		} catch {
			/* shutdown must never throw */
		}
	});
}
