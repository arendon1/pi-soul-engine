/**
 * SoulBridge — the shared runtime state of the extension: soul manager,
 * engine construction, the observe queue, and audit entries.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CognitiveEngine } from "../runtime/engines/engine.ts";
import { HeuristicEngine } from "../runtime/engines/heuristic.ts";
import type { ModelCaller } from "../runtime/engines/pi-model.ts";
import { CognitiveRouter, type RouterStatus } from "../runtime/engines/router.ts";
import { AnalysisService } from "../runtime/engines/analysis.ts";
import { PiClassifierClient, type ClassifierClient } from "../runtime/engines/classifier.ts";
import { EngineAbortError } from "../runtime/engines/resilience.ts";
import { SoulManager } from "./soul-manager.ts";
import { SoulWorkerClient } from "./worker-client.ts";
import type { Soul } from "../runtime/soul.ts";
import type { ObservationResult } from "../runtime/observe.ts";
import type { Interaction } from "../spec/types.ts";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { newId } from "../util/ids.ts";
import { detectBinding, loadAgentBindings, SESSION_SENTINEL, type AgentBinding } from "./agent-bindings.ts";

export interface ObserveRecord {
	timestamp: string;
	domain: string | null;
	significance: number;
	stored: boolean;
	episodicId: string | null;
	factCount: number;
	mood: string;
	/** Mutations the soul proposed on its own this turn (high-performance streak). */
	proposals: number;
}

export class SoulBridge {
	readonly manager: SoulManager;
	readonly worker: SoulWorkerClient;
	userId = "human";
	cwd = process.cwd();
	domain: string | null = null;
	observationsSinceReflect = 0;
	/** Set on session_shutdown: background work continues, session writes stop. */
	closed = false;

	/**
	 * Per-soul queue of stashed parents. Each entry is a `{ name, soul }` that
	 * was active before a subagent swap. Subagents are dispatched LIFO, so this
	 * is naturally a stack — only push when we actually swap, only pop when the
	 * matching subagent ends.
	 */
	private soulStack: Array<{ name: string; soul: import("../runtime/soul.ts").Soul }> = [];
	/**
	 * Loaded once per session from the global agent .md files and the
	 * `agent-soul-bindings.json` table. Null until the first call to
	 * `loadAgentBindings()`. Resolved lazily so the bridge can be constructed
	 * before the souls directory is fully ready.
	 */
	private agentBindings: Map<string, AgentBinding> | null = null;

	private ctx: ExtensionContext | null = null;
	/** Transcript entries are written through the ExtensionAPI, not the context. */
	private api: ExtensionAPI | null = null;
	private auditFailures = 0;
	private lastAuditError: string | null = null;
	private engine: CognitiveEngine | null = null;
	private router: CognitiveRouter | null = null;
	private analysisService: AnalysisService | null = null;
	private readonly heuristicEngine = new HeuristicEngine();
	private queue: Promise<unknown> = Promise.resolve();

	constructor(root?: string, worker?: SoulWorkerClient) {
		this.manager = new SoulManager(root);
		this.worker = worker ?? new SoulWorkerClient();
		// All persistence goes to the detached worker — fire-and-forget.
		this.manager.persistSink = (dir, doc) => this.worker.save(dir, doc);
	}

	/** Bind to a pi session context (called on session_start and lazily elsewhere). */
	/** Hand the bridge the extension API handle (required for transcript entries). */
	attachApi(api: ExtensionAPI): void {
		this.api = api;
	}

	/** Health of the audit trail: entries that could not be written must be visible. */
	auditStatus(): { attached: boolean; failures: number; lastError: string | null } {
		return { attached: this.api !== null, failures: this.auditFailures, lastError: this.lastAuditError };
	}

	bind(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.cwd = ctx.cwd ?? this.cwd;
		this.domain = this.manager.domainFor(this.cwd);
		this.closed = false;
	}

	/**
	 * Non-intrusive notification over pi's own mechanism: a toast that never
	 * steals focus, suppressed after session close and when disabled in config.
	 */
	notify(message: string, level: "info" | "warning" | "error" = "info"): void {
		if (this.closed || !this.manager.getConfig().notifications) return;
		try {
			this.ctx?.ui.notify(message, level);
		} catch {
			/* headless modes have no UI — silence is correct */
		}
	}

	/** Append a quiet transcript entry (visible, never interrupting). */
	append<T>(customType: string, data: T): void {
		if (this.closed) return;
		if (!this.api) {
			// appendEntry lives on ExtensionAPI, not ExtensionContext; calling it on
			// the context throws, so a missing handle is a real failure, not a no-op.
			this.auditFailures++;
			this.lastAuditError = "no ExtensionAPI attached (call attachApi before appending)";
			return;
		}
		try {
			this.api.appendEntry<T>(customType, data);
		} catch (err) {
			// Never fatal to the agent loop, but never silent either.
			this.auditFailures++;
			this.lastAuditError = (err as Error).message ?? String(err);
		}
	}

	// ── engine ─────────────────────────────────────────────────────────────

	buildEngine(): CognitiveEngine {
		const config = this.manager.getConfig();
		if (config.engine === "heuristic" || !this.ctx) {
			this.router = null;
			this.analysisService = null;
			return this.heuristicEngine;
		}

		const session = this.resolveModel(config.sessionModel) ?? this.resolveModel(null);
		const analysis = this.resolveModel(config.analysisModel) ?? session;
		const reflect = this.resolveModel(config.reflectModel) ?? session;
		if (!analysis && !reflect && !session) {
			this.router = null;
			this.analysisService = null;
			return this.heuristicEngine;
		}

		const router = new CognitiveRouter({
			analysis: analysis ? this.makeCaller(analysis.model, analysis.label) : null,
			reflect: reflect ? this.makeCaller(reflect.model, reflect.label) : null,
			session: session ? this.makeCaller(session.model, session.label) : null,
			fallback: this.heuristicEngine,
			resilience: config.resilience,
			budget: config.budget,
			cache: { enabled: config.cache },
			onDegrade: (reason) =>
				this.notify(`soul: cognitive engine degraded to heuristics (${reason}) — /soul-engine for status`, "warning"),
		});
		this.router = router;
		this.analysisService = new AnalysisService({
			classifier: this.buildClassifier(config.classifierModel),
			engine: router,
			factsMode: config.factsMode,
			rubricScoring: config.rubricScoring,
			confidenceFloor: config.confidenceFloor,
		});
		return router;
	}

	/** Resolve a `provider/id` reference (or the session model) with auth check. */
	private resolveModel(ref?: string | null): { model: unknown; label: string } | null {
		const ctx = this.ctx;
		if (!ctx) return null;
		const registry = ctx.modelRegistry as unknown as {
			find(provider: never, id: never): unknown;
			hasConfiguredAuth?(model: unknown): boolean;
		};

		if (ref && ref.includes("/")) {
			const slash = ref.indexOf("/");
			const provider = ref.slice(0, slash);
			const id = ref.slice(slash + 1);
			try {
				const model = registry.find(provider as never, id as never);
				if (model) {
					if (registry.hasConfiguredAuth && !registry.hasConfiguredAuth(model)) return null;
					return { model, label: `${provider}/${id}` };
				}
			} catch {
				/* unknown provider/model → fall through to the session model */
			}
			return null;
		}

		const session = ctx.model as unknown;
		if (!session) return null;
		const meta = session as { provider?: string; id?: string };
		return { model: session, label: `${meta.provider ?? "session"}/${meta.id ?? "model"}` };
	}

	/** Chat-tier caller with usage reporting so soul spend counts in session cost. */
	private makeCaller(model: unknown, label: string): ModelCaller {
		const registry = this.ctx!.modelRegistry as unknown as {
			complete(model: never, context: never, options: never): Promise<{
				content: Array<{ type: string; text?: string }>;
				usage?: { input?: number; output?: number; cost?: { total?: number } };
			}>;
		};
		return {
			modelLabel: label,
			complete: async (prompt, opts) => {
				const response = await registry.complete(
					model as never,
					{
						messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
					} as never,
					{ maxTokens: 1024, signal: opts?.signal, cacheRetention: "none" } as never,
				);
				const usage = response.usage;
				opts?.onUsage?.({
					input: usage?.input ?? 0,
					output: usage?.output ?? 0,
					cost: usage?.cost?.total ?? 0,
				});
				return response.content
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("\n");
			},
		};
	}

	/** Classifier tier: typed, batched, output-free. */
	private buildClassifier(ref?: string | null): ClassifierClient | null {
		const ctx = this.ctx;
		if (!ctx || !ref || !ref.includes("/")) return null;
		const slash = ref.indexOf("/");
		const provider = ref.slice(0, slash);
		const id = ref.slice(slash + 1);
		try {
			const registry = ctx.modelRegistry as unknown as {
				findOfType(type: never, provider: never, id: never): unknown;
				hasConfiguredAuth?(model: unknown): boolean;
			};
			const model = registry.findOfType("classifier" as never, provider as never, id as never);
			if (!model) return null;
			const authed = registry.hasConfiguredAuth ? registry.hasConfiguredAuth(model) : true;
			return new PiClassifierClient(
				ctx.modelRegistry as never,
				model,
				`${provider}/${id}`,
				authed,
			);
		} catch {
			return null;
		}
	}

	getEngine(): CognitiveEngine {
		if (!this.engine) this.engine = this.buildEngine();
		return this.engine;
	}

	rebuildEngine(): CognitiveEngine {
		this.engine = this.buildEngine();
		return this.engine;
	}

	/** Engine + resilience status for `/soul-engine` and tools. */
	engineStatus(): RouterStatus | { engine: string; degraded: false; note: string } {
		if (!this.router) {
			return { engine: this.getEngine().name, degraded: false, note: "no model tiers configured (heuristic only)" };
		}
		return this.router.status();
	}

	get routerRef(): CognitiveRouter | null {
		return this.router;
	}

	// ── soul access ────────────────────────────────────────────────────────

	soul(): Soul {
		const soul = this.manager.ensure(this.cwd, this.getEngine());
		soul.setAnalysisService(this.analysisService);
		return soul;
	}

	hasSoul(): boolean {
		return this.manager.current() !== null;
	}

	// ── per-agent soul binding (subagent lifecycle) ────────────────────────

	/**
	 * Load the per-agent soul binding table from the global agent .md files
	 * and `agent-soul-bindings.json`. Idempotent — safe to call repeatedly.
	 */
	ensureAgentBindingsLoaded(): void {
		if (this.agentBindings) return;
		this.agentBindings = loadAgentBindings(this.manager.root);
	}

	/**
	 * Detect the agent type from a runtime system prompt and, if it has a
	 * non-`$session` soul binding, swap to that soul for the dispatch. Returns
	 * the binding that was applied, or null if no swap happened.
	 *
	 * Safe to call on every `before_agent_start`: the main agent's prompt
	 * matches no fingerprint, so it returns null and the active soul stays put.
	 */
	detectAndPushSoul(systemPrompt: string): AgentBinding | null {
		this.ensureAgentBindingsLoaded();
		const binding = detectBinding(systemPrompt, this.agentBindings!);
		if (!binding) return null;
		if (binding.soul === SESSION_SENTINEL) return null;
		// No-op if already on the bound soul (avoids redundant flush+reload).
		if (this.manager.activeName === binding.soul) return binding;
		const newSoul = this.pushSoul(binding.soul);
		return newSoul ? binding : null;
	}

	/**
	 * Push the current soul onto the stack and swap to `name` in-memory.
	 * Flushes the current soul first so its in-flight writes do not land in the
	 * wrong directory after the swap.
	 */
	pushSoul(name: string): import("../runtime/soul.ts").Soul | null {
		const current = this.manager.current();
		const currentName = this.manager.activeName;
		if (current) {
			this.soulStack.push({ name: currentName ?? "default", soul: current });
		}
		const swapped = this.manager.swapTo(name, this.getEngine());
		if (swapped) {
			swapped.setAnalysisService(this.analysisService);
		}
		return swapped;
	}

	/**
	 * Pop the most recent soul off the stack and restore it as active. No-op
	 * when the stack is empty (e.g. the main agent's own `agent_end`).
	 */
	popSoul(): import("../runtime/soul.ts").Soul | null {
		const prev = this.soulStack.pop();
		if (!prev) return null;
		const restored = this.manager.swapTo(prev.name, this.getEngine());
		if (restored) {
			restored.setAnalysisService(this.analysisService);
		}
		return restored;
	}

	/**
	 * Queue a `popSoul()` to run after every pending observe completes. The
	 * swap and the observe share the same in-memory `activeName`, so popping
	 * the stack *before* the observe runs would land the subagent's observation
	 * in the parent soul. Queueing onto the same serial queue as `enqueueObserve`
	 * fixes the ordering.
	 */
	enqueuePopSoul(): Promise<void> {
		const next = this.queue.then(() => {
			this.popSoul();
		});
		this.queue = next.catch(() => undefined);
		return next;
	}

	domainOrNull(): string | null {
		return this.domain;
	}

	interaction(userText: string, agentText: string): Interaction {
		return {
			participants: [
				{ role: "user", id: this.userId, content: userText },
				{ role: "agent", id: "soul", content: agentText },
			],
			timestamp: new Date().toISOString(),
			metadata: { domain: this.domain ?? undefined, source: "pi-session" },
		};
	}

	/**
	 * Exchange journal: every observe job is recorded before it runs and removed
	 * when it completes. If pi exits mid-turn, the next session replays what the
	 * soul has not yet processed — nothing is lost, and nothing ever waits.
	 */
	private get pendingPath(): string {
		return join(this.manager.root, "pending-observations.json");
	}

	/** Serialize observe runs so concurrent turns cannot interleave writes. */
	enqueueObserve(
		userText: string,
		agentText: string,
		options: { signal?: AbortSignal; journaled?: boolean; attempts?: number } = {},
	): Promise<ObserveRecord> {
		const entryId = newId("obs");
		const attempts = options.attempts ?? 0;
		if (!options.journaled) {
			this.worker.journalAdd(this.pendingPath, {
				id: entryId,
				timestamp: new Date().toISOString(),
				domain: this.domain,
				userText,
				agentText,
				attempts,
			});
		}
		const run = async (): Promise<ObserveRecord> => {
			const soul = this.soul();
			// After repeated deferrals the observation must land: commit it with
			// heuristics rather than carrying it forever.
			const forceHeuristic = attempts >= 3;
			const prevEngine = soul.engine;
			const prevAnalysis = soul.analysis;
			if (forceHeuristic) {
				soul.setEngine(this.heuristicEngine);
				soul.setAnalysisService(null);
			}
			let result: ObservationResult;
			try {
				result = await soul.observe(this.interaction(userText, agentText), {
					domain: this.domain,
					userId: this.userId,
					signal: options.signal,
				});
			} catch (err) {
				// Cancellation (or a hard failure) leaves the journal entry in place so
				// the next session replays it. Never fabricated into a result.
				this.router?.recordDeferral();
				this.append("soul:deferred", {
					timestamp: new Date().toISOString(),
					domain: this.domain,
					attempts,
					reason: err instanceof EngineAbortError || (err as Error).name === "EngineAbortError" ? "aborted" : (err as Error).message,
				});
				throw err;
			} finally {
				if (forceHeuristic) {
					soul.setEngine(prevEngine);
					soul.setAnalysisService(prevAnalysis);
				}
			}
			this.observationsSinceReflect++;
			this.manager.markDirty();
			this.recordAudit(result);
			this.worker.journalRemove(this.pendingPath, [entryId]);
			const proposals = result.evolution_proposals ?? [];
			if (proposals.length > 0) {
				// Non-intrusive: the soul changed its mind about itself; ask, don't act.
				const first = proposals[0]!;
				this.notify(
					`soul: proposed ${first.trait} ${first.old_value} → ${first.new_value} — approve with /soul-approve`,
				);
			}
			return {
				timestamp: new Date().toISOString(),
				domain: this.domain,
				significance: Number(result.significance.toFixed(3)),
				stored: result.stored,
				episodicId: result.episodic?.id ?? null,
				factCount: result.facts.length,
				mood: soul.config.state.mood,
				proposals: proposals.length,
			};
		};
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		return next;
	}

	/** Replay exchanges journaled by a previous session that exited mid-turn. */
	replayPending(): number {
		let entries: Array<{ id: string; userText: string; agentText: string; domain?: string | null; attempts?: number }> = [];
		try {
			if (existsSync(this.pendingPath)) {
				entries = JSON.parse(readFileSync(this.pendingPath, "utf8"));
				rmSync(this.pendingPath); // re-journaled on enqueue unless completed
			}
		} catch {
			return 0;
		}
		for (const entry of entries.slice(-20)) {
			this.domain = entry.domain ?? this.domain;
			void this.enqueueObserve(entry.userText, entry.agentText, {
				journaled: false,
				attempts: (entry.attempts ?? 0) + 1,
			}).catch(() => undefined);
		}
		return entries.length;
	}

	private recordAudit(result: ObservationResult): void {
		this.append<ObserveRecord>("soul:observation", {
			timestamp: new Date().toISOString(),
			domain: this.domain,
			significance: Number(result.significance.toFixed(3)),
			stored: result.stored,
			episodicId: result.episodic?.id ?? null,
			factCount: result.facts.length,
			mood: result.somatic.label,
			proposals: result.evolution_proposals?.length ?? 0,
		});
	}

	/** Run fn after the observe queue drains. */
	settled(): Promise<unknown> {
		return this.queue;
	}

	/** Fire-and-forget flush: persistence happens in the detached worker. */
	flush(): void {
		this.manager.flush();
	}

	/** Hand remaining work to the worker and stop touching this session. */
	shutdown(): void {
		this.closed = true;
		this.manager.flush();
		this.worker.shutdownSoon();
	}
}
