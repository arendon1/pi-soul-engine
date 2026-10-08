/**
 * Soul — the top-level runtime object (port of `Soul` from the reference
 * runtime). Owns identity, DNA, memory store, self-model, graph, bond, state,
 * skills and the observe() pipeline. Serialization via .soul pack/unpack.
 */
import type {
	CommunicationStyle,
	DNA,
	GeneralEvent,
	Identity,
	Interaction,
	MemoryEntry,
	MemoryLayer,
	MemoryType,
	Mood,
	Personality,
	Biorhythms,
	SkillRecord,
	SoulConfig,
	SoulDocument,
	SoulState,
	TrustChainFile,
	ArchivalRecord,
	LearningEvent,
	RubricResult,
} from "../spec/types.ts";
import { loadSoulDir, packSoul, saveSoulDir, unpackSoul, buildDnaMarkdown } from "../spec/soul-file.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CognitiveEngine } from "./engines/engine.ts";
import { HeuristicEngine } from "./engines/heuristic.ts";
import { makeEntry, MemoryStore, type SearchHit } from "./store.ts";
import { runObservePipeline, type ObservationResult } from "./observe.ts";
import { recall, type RecallHit } from "./recall.ts";
import { applyInteraction, makeState, recoverState } from "./state.ts";
import { bondStrengthen, bondWeaken, makeBond, bondLabel, bondDecay } from "./bond.ts";
import { makeSelfModel, selfModelSummary, topDomains, noteRelationship } from "./self-model.ts";
import { SkillRegistry } from "./skills-xp.ts";
import { approveMutation, checkTriggers, defaultEvolutionConfig, pendingMutations, proposeMutation, rejectMutation } from "./evolution.ts";
import { Evaluator, buildRubricResult, criteriaFor, heuristicEvaluate, rubricFor } from "./evaluation.ts";
import type { AnalysisService } from "./engines/analysis.ts";
import { synthesisPrompt } from "./engines/prompts.ts";
import { clampUnit, sanitizeMemoryText, tryJson } from "./engines/validate.ts";
import { LearningRegistry } from "./learning.ts";
import { runDream, type DreamOptions, type DreamReport } from "./dream.ts";
import { makeDid, newId, nowIso } from "../util/ids.ts";
import { TrustChainManager } from "./trust.ts";
import { clamp, estimateTokens, keywords } from "../util/text.ts";
import { significanceTotal } from "./psychology.ts";

export interface BirthOptions {
	name: string;
	archetype?: string;
	values?: string[];
	originStory?: string;
	primeDirective?: string;
	ocean?: Partial<Personality>;
	communication?: Partial<CommunicationStyle>;
	biorhythms?: Partial<Biorhythms>;
	persona?: string;
	human?: string;
	engine?: CognitiveEngine;
	bondedTo?: string;
}

export interface ObserveOptions {
	userId?: string | null;
	domain?: string | null;
	signal?: AbortSignal;
}

export interface RecallOptions {
	limit?: number;
	types?: MemoryType[];
	minImportance?: number;
	userId?: string | null;
	domain?: string | null;
}

export class Soul {
	config: SoulConfig;
	store: MemoryStore;
	graph: SoulDocument["graph"];
	selfModel: SoulDocument["self_model"];
	generalEvents: GeneralEvent[];
	skills: SkillRegistry;
	trustChain?: TrustChainFile;
	trust: TrustChainManager;
	evaluator: Evaluator;
	learning: LearningRegistry;
	archival: ArchivalRecord[];
	/** Batched classifier/model analysis (one call per exchange). */
	analysis: AnalysisService | null = null;
	engine: CognitiveEngine;
	private interactionCount = 0;

	private constructor(config: SoulConfig, doc: Omit<SoulDocument, "config">, engine: CognitiveEngine) {
		this.config = config;
		this.store = new MemoryStore(doc.memories);
		this.graph = doc.graph;
		this.selfModel = doc.self_model;
		this.generalEvents = doc.general_events;
		this.skills = new SkillRegistry(doc.skills);
		this.trustChain = doc.trust_chain;
		this.trust = new TrustChainManager(doc.trust_chain, doc.trust_chain?.private_key);
		this.evaluator = Evaluator.fromJSON({ history: doc.evaluation_history });
		this.learning = new LearningRegistry(doc.learning_events ?? []);
		this.archival = doc.archival ?? [];
		this.engine = engine;
	}

	/** Best-effort signed audit entry (never throws). */
	private recordAction(action: string, payload: unknown): void {
		try {
			this.trust.append(action, payload);
		} catch {
			/* read-only chains (imported without a key) keep verifying but do not grow */
		}
	}

	// ── lifecycle ──────────────────────────────────────────────────────────

	static birth(options: BirthOptions): Soul {
		const now = nowIso();
		const personality: Personality = {
			openness: options.ocean?.openness ?? 0.5,
			conscientiousness: options.ocean?.conscientiousness ?? 0.5,
			extraversion: options.ocean?.extraversion ?? 0.5,
			agreeableness: options.ocean?.agreeableness ?? 0.5,
			neuroticism: options.ocean?.neuroticism ?? 0.5,
		};
		const config: SoulConfig = {
			version: "1.0.0",
			identity: {
				did: makeDid(options.name),
				name: options.name,
				archetype: options.archetype ?? "",
				born: now,
				bonded_to: options.bondedTo ?? null,
				origin_story: options.originStory ?? "",
				prime_directive: options.primeDirective ?? "",
				core_values: options.values ?? [],
				bond: makeBond(options.bondedTo ?? options.name),
				incarnation: 1,
				previous_lives: [],
			},
			dna: {
				personality,
				communication: {
					warmth: options.communication?.warmth ?? "moderate",
					verbosity: options.communication?.verbosity ?? "moderate",
					humor_style: options.communication?.humor_style ?? "none",
					emoji_usage: options.communication?.emoji_usage ?? "none",
				},
				biorhythms: {
					chronotype: options.biorhythms?.chronotype ?? "neutral",
					social_battery: options.biorhythms?.social_battery ?? 100,
					energy_regen_rate: options.biorhythms?.energy_regen_rate ?? 5,
				},
			},
			memory: {
				episodic_max_entries: 10000,
				semantic_max_facts: 1000,
				importance_threshold: 3,
				confidence_threshold: 0.7,
				persona_tokens: 500,
				human_tokens: 500,
			},
			core_memory: {
				persona:
					options.persona ??
					`I am ${options.name}${options.archetype ? `, ${options.archetype}` : ""}. I am becoming myself through our conversations.`,
				human: options.human ?? "",
			},
			state: makeState(),
			evolution: defaultEvolutionConfig(),
			lifecycle: "born",
		};
		return new Soul(
			config,
			{
				memories: { core: [], episodic: [], semantic: [], procedural: [], social: [] },
				graph: { entities: {} },
				self_model: makeSelfModel(),
				general_events: [],
				skills: [],
			},
			options.engine ?? new HeuristicEngine(),
		);
	}

	static awaken(
		source: { dir?: string; file?: string; data?: Uint8Array; password?: string },
		engine?: CognitiveEngine,
	): Soul {
		let doc: SoulDocument;
		if (source.data) doc = unpackSoul(source.data, { password: source.password });
		else if (source.file) {
			doc = unpackSoul(new Uint8Array(readFileSync(source.file)), { password: source.password });
		} else if (source.dir) doc = loadSoulDir(source.dir, { password: source.password });
		else throw new Error("awaken: provide dir, file, or data");
		return Soul.fromDocument(doc, engine);
	}

	/** Build a Soul from an already-unpacked document (e.g. worker output). */
	static fromDocument(doc: SoulDocument, engine?: CognitiveEngine): Soul {
		doc.config.lifecycle = doc.config.lifecycle === "retired" ? "retired" : "active";
		return new Soul(doc.config, doc, engine ?? new HeuristicEngine());
	}

	setEngine(engine: CognitiveEngine): void {
		this.engine = engine;
	}

	/** Wire (or clear) the batched analysis service. */
	setAnalysisService(service: AnalysisService | null): void {
		this.analysis = service;
	}

	/** Milliseconds-free accessor used by status surfaces. */
	hasModelAnalysis(): boolean {
		return this.analysis !== null && this.engine.name !== "heuristic";
	}

	// ── serialization ──────────────────────────────────────────────────────

	toDocument(): SoulDocument {
		return {
			config: this.config,
			memories: this.store.entriesByLayer(),
			graph: this.graph,
			self_model: this.selfModel,
			general_events: this.generalEvents,
			skills: this.skills.toJSON(),
			trust_chain: this.trust.toJSON(),
			learning_events: this.learning.toJSON(),
			evaluation_history: this.evaluator.history,
			archival: this.archival,
		};
	}

	pack(password?: string, includeKeys = false): Uint8Array {
		return packSoul(this.toDocument(), password || includeKeys ? { password, includeKeys } : {});
	}

	exportFile(path: string, password?: string, includeKeys = false): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, this.pack(password, includeKeys));
	}

	saveDir(dir: string): void {
		saveSoulDir(this.toDocument(), dir);
	}

	dnaMarkdown(): string {
		return buildDnaMarkdown(this.config);
	}

	// ── memory ─────────────────────────────────────────────────────────────

	remember(
		content: string,
		options: {
			type?: MemoryType;
			importance?: number;
			emotion?: string;
			entities?: string[];
			domain?: string | null;
			userId?: string | null;
			/** Backdated writes (imports, migrations). */
			createdAt?: string;
		} = {},
	): MemoryEntry {
		const entry = makeEntry({
			type: options.type ?? "semantic",
			content,
			importance: clamp(Math.round(options.importance ?? 5), 1, 10),
			emotion: options.emotion ?? null,
			entities: options.entities ?? [],
			domain: options.domain ?? null,
			user_id: options.userId ?? null,
			created_at: options.createdAt,
		});
		this.store.store(entry.type, entry);
		this.recordAction("memory.write", { id: entry.id, type: entry.type, content: entry.content });
		return entry;
	}

	// ── evaluation & learning ──────────────────────────────────────────────

	/** Strongest self-concept domain, used to pick an evaluation rubric. */
	private strongestDomain(): string | null {
		return topDomains(this.selfModel, 1)[0]?.domain ?? null;
	}

	/**
	 * Score an interaction against a rubric (heuristic, deterministic).
	 * Feeds evaluation history (which drives evolution triggers), stores the
	 * rubric's own learning line as procedural memory, and grants weighted XP.
	 */
	evaluate(
		interaction: Interaction,
		domain?: string | null,
		precomputed?: { criteria: Record<string, number>; overall: number } | null,
	): RubricResult {
		const effective = domain ?? this.strongestDomain();
		let result: RubricResult;
		if (precomputed && Object.keys(precomputed.criteria).length > 0) {
			// Classifier-scored criteria, heuristically filled where missing.
			const rubric = rubricFor(effective);
			result = buildRubricResult(rubric, precomputed.criteria, heuristicEvaluate(interaction, rubric));
			this.evaluator.record(result);
		} else {
			result = this.evaluator.evaluate(interaction, effective);
		}
		if (result.learning) {
			this.remember(result.learning, {
				type: "procedural",
				importance: Math.max(3, Math.round(result.overall_score * 8)),
			});
		}
		const xp = Math.floor(20 * (0.5 + result.overall_score));
		if (effective) this.skills.addXp(domainSlug(effective), effective, xp);
		this.recordAction("evaluation", {
			domain: result.rubric_id,
			score: Number(result.overall_score.toFixed(3)),
			// Which tier scored the rubric, and why the classifier abstained when it did.
			rubric_source:
				precomputed && Object.keys(precomputed.criteria).length > 0 ? "classifier+heuristic" : "heuristic",
			classifier: this.analysis?.classifierOutcome ?? null,
		});
		return result;
	}

	/**
	 * Evaluate, and when the score is notable (≥0.8 or ≤0.3) distill a
	 * LearningEvent into procedural memory, feed skill XP, and journal it.
	 */
	learn(interaction: Interaction, domain?: string | null): { event: LearningEvent | null; result: RubricResult } {
		const effective = domain ?? this.strongestDomain();
		const result = this.evaluate(interaction, effective);
		const skillId = effective ? domainSlug(effective) : null;
		const event = this.evaluator.createLearningEvent(result, {
			interactionId: (interaction.metadata?.interaction_id as string | undefined) ?? null,
			domain: effective,
			skillId,
		});
		if (!event) return { event: null, result };
		this.remember(event.lesson, {
			type: "procedural",
			importance: Math.max(3, Math.round((event.evaluation_score ?? 0.5) * 8)),
		});
		this.skills.grantXpFromLearning(event);
		this.learning.add(event);
		this.recordAction("learning.event", {
			domain: event.domain,
			skill_id: event.skill_id,
			score: event.evaluation_score,
			interaction_id: event.trigger_interaction_id,
		});
		return { event, result };
	}

	/** Lessons the soul has extracted from scored experience. */
	get learningEvents(): LearningEvent[] {
		return this.learning.list();
	}

	/** Per-domain evaluation stats (count, average, streak) for status displays. */
	evaluationStats(): Array<{ domain: string; count: number; avg_score: number; streak: number }> {
		const domains = new Set(this.evaluator.history.map((r) => r.rubric_id));
		return [...domains]
			.map((domain) => this.evaluator.getDomainStats(domain))
			.sort((a, b) => b.count - a.count);
	}

	async observe(interaction: Interaction, options: ObserveOptions = {}): Promise<ObservationResult> {
		recoverState(this.config.state, this.config.dna.biorhythms.energy_regen_rate);
		// Domain is chosen before the pipeline so the same rubric is scored in the
		// same batched classifier call that produces the rest of the analysis.
		const evalDomain = this.strongestDomain();
		const result = await runObservePipeline(interaction, {
			store: this.store,
			selfModel: this.selfModel,
			graph: this.graph,
			engine: this.engine,
			analysis: this.analysis,
			rubricCriteria: this.analysis ? criteriaFor(evalDomain) : undefined,
			personality: this.config.dna.personality,
			domain: options.domain ?? null,
			userId: options.userId ?? null,
			signal: options.signal,
			knownDomains: Object.keys(this.selfModel.self_images),
		});

		const pair = interaction.participants;
		const userText = pair.find((p) => p.role === "user")?.content ?? "";
		const agentText = pair.find((p) => p.role === "agent")?.content ?? "";
		void userText;
		void agentText;

		// Emotional weather → state
		applyInteraction(this.config.state, result.somatic);

		// Bond: positive interactions strengthen (log growth), negative weaken
		const bond = this.config.identity.bond;
		if (result.somatic.valence < -0.3) {
			bondWeaken(bond, 2);
			this.recordAction("bond.weaken", { amount: 2, strength: bond.bond_strength, mood: result.somatic.label });
		} else {
			bondStrengthen(bond);
			this.recordAction("bond.strengthen", { strength: bond.bond_strength, interactions: bond.interaction_count });
		}

		// Journal what the pipeline wrote (memory.write audit entries)
		if (result.episodic || result.facts.length > 0) {
			this.recordAction("memory.write", {
				mode: "observe",
				episodic: result.episodic?.id ?? null,
				facts: result.facts.map((f) => f.id),
				significance: Number(result.significance.toFixed(3)),
			});
		}

		// Skills: evidence in a domain earns XP
		for (const update of result.self_model_updates) {
			const domain = update.split(" →")[0]!;
			this.skills.award(domain, domain, 10);
		}

		// Skills: entity topics earn significance-weighted XP (upstream parity).
		// Only non-person entities count — treating "What"/"Here" as personal
		// competencies is how the skill list filled with sentence-initial words.
		const entityXp = Math.max(5, Math.round(result.significance * 30));
		for (const entity of result.entities) {
			if (entity.entity_type === "person") continue;
			this.skills.addXp(domainSlug(entity.name), entity.name, entityXp);
		}

		// Evaluate every interaction: this history is what makes evolution automatic.
		this.evaluate(interaction, evalDomain, result.rubric);

		// Automatic evolution: a high-performance streak proposes a mutation.
		const proposed = checkTriggers(this.config, this.evaluator.checkEvolutionTriggers());
		for (const mutation of proposed) {
			this.recordAction("evolution.propose", {
				id: mutation.id,
				trait: mutation.trait,
				reason: mutation.reason,
				trigger: "auto",
			});
		}
		if (proposed.length > 0) {
			result.evolution_proposals = proposed.map((m) => ({
				id: m.id,
				trait: m.trait,
				old_value: m.old_value,
				new_value: m.new_value,
				reason: m.reason,
			}));
		}

		// Auto-consolidation every N interactions (configurable via memory settings).
		this.interactionCount += 1;
		const interval = (this.config.memory as { consolidation_interval?: number }).consolidation_interval ?? 10;
		if (interval > 0 && this.interactionCount % interval === 0) {
			try {
				this.dream({});
			} catch {
				/* consolidation is best-effort and must never block observe */
			}
		}

		// General events (Conway): cluster episodic entries by theme keywords
		if (result.episodic) {
			this.assignGeneralEvent(result.episodic);
		}
		return result;
	}

	private assignGeneralEvent(entry: MemoryEntry): void {
		const keys = new Set(keywords(entry.content, 5));
		let best: GeneralEvent | null = null;
		let bestScore = 0;
		for (const ge of this.generalEvents) {
			const themeTokens = new Set(keywords(ge.theme, 5));
			let shared = 0;
			for (const k of keys) if (themeTokens.has(k)) shared++;
			if (shared > bestScore && shared >= 2) {
				bestScore = shared;
				best = ge;
			}
		}
		if (best) {
			best.episode_ids.push(entry.id);
			best.last_updated = entry.created_at;
		} else {
			const theme = keywords(entry.content, 2).join(" ") || "untitled experience";
			const ge: GeneralEvent = {
				id: newId("ge"),
				theme,
				episode_ids: [entry.id],
				started_at: entry.created_at,
				last_updated: entry.created_at,
			};
			this.generalEvents.push(ge);
			best = ge;
		}
		entry.general_event_id = best.id;
	}

	recall(query: string, options: RecallOptions = {}): RecallHit[] {
		const hits = recall(this.store, query, {
			limit: options.limit ?? 5,
			personality: this.config.dna.personality,
			user_id: options.userId ?? null,
			domain: options.domain ?? null,
		});
		const filtered = hits.filter(
			(h) =>
				(!options.types || options.types.includes(h.entry.type)) &&
				(options.minImportance === undefined || h.entry.importance >= options.minImportance),
		);
		for (const hit of filtered) this.store.touch(hit.entry);
		return filtered;
	}

	/** Plain-text retrieval results for prompt/context building. */
	recallText(query: string, options: RecallOptions = {}): Array<{ id: string; text: string; type: string; activation: number }> {
		return this.recall(query, options).map((h) => ({
			id: h.entry.id,
			text: h.entry.content,
			type: h.entry.type,
			activation: Number(h.activation.toFixed(3)),
		}));
	}

	/** Confidence-ranked search without ACT-R side effects (read-only). */
	search(query: string, limit = 10, layer?: MemoryLayer): SearchHit[] {
		return this.store.search(query, limit, layer);
	}

	supersede(oldId: string, newContent: string, reason?: string): MemoryEntry | null {
		const old = this.store.get(oldId);
		if (!old) return null;
		const entry = this.remember(newContent, {
			type: old.type,
			importance: old.importance,
			entities: old.entities,
			domain: old.domain,
			userId: old.user_id,
		});
		if (reason) entry.emotion = `superseded: ${reason}`;
		this.store.supersede(oldId, entry);
		this.recordAction("memory.supersede", { old: oldId, new: entry.id, reason: reason ?? "" });
		return entry;
	}

	// ── forgetting (GDPR) ──────────────────────────────────────────────────

	forget(query: string): MemoryEntry[] {
		const hits = this.store.search(query, 100);
		const removed: MemoryEntry[] = [];
		for (const hit of hits) {
			if (this.store.delete(hit.entry.id)) removed.push(hit.entry);
		}
		this.recordAction("memory.forget", { mode: "query", query, removed: removed.map((e) => e.id) });
		return removed;
	}

	forgetOne(id: string): boolean {
		return this.store.delete(id);
	}

	forgetEntity(entity: string): MemoryEntry[] {
		const removed: MemoryEntry[] = [];
		const lower = entity.toLowerCase();
		for (const entry of this.store.all()) {
			const touches =
				entry.entities.some((e) => e.toLowerCase() === lower) ||
				entry.content.toLowerCase().includes(lower);
			if (touches && this.store.delete(entry.id)) removed.push(entry);
		}
		// cascade: graph nodes + relationship notes + open edges
		delete this.graph.entities[entity];
		for (const node of Object.values(this.graph.entities)) {
			node.relationships = node.relationships.filter((r) => r.target !== entity);
		}
		delete this.selfModel.relationship_notes[entity];
		this.config.identity.bonded_to =
			this.config.identity.bonded_to?.toLowerCase() === lower ? null : this.config.identity.bonded_to;
		this.recordAction("memory.forget", { mode: "entity", entity, removed: removed.map((e) => e.id) });
		return removed;
	}

	forgetBefore(timestamp: string): MemoryEntry[] {
		const removed: MemoryEntry[] = [];
		for (const entry of this.store.all()) {
			if (entry.created_at < timestamp && this.store.delete(entry.id)) removed.push(entry);
		}
		this.recordAction("memory.forget", { mode: "before", timestamp, removed: removed.map((e) => e.id) });
		return removed;
	}

	/**
	 * Maintenance: remove entity records that are not on a keep-list.
	 *
	 * The heuristic entity extractor once treated *any* capitalised word as an
	 * entity, and every entity earned skill XP — so an early soul fills with
	 * graph nodes and "skills" named `What`, `Here`, `Knob`. This removes them
	 * from the graph, from memory entity tags, and from skills. Skills that are
	 * self-model domains (the legitimate ones) always survive, which is what
	 * separates `research_aide` from `Knob`.
	 *
	 * Memory entries are edited in place: `store.all()` hands back the stored
	 * objects, and `MemoryStore.store()` only ever appends, so it cannot update.
	 * Pass `dryRun` to preview without mutating.
	 */
	pruneEntities(options: { keep?: string[]; dryRun?: boolean } = {}): {
		graphRemoved: string[];
		memoryTagsRemoved: number;
		skillsRemoved: string[];
	} {
		const keep = new Set((options.keep ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean));
		const domains = new Set(Object.keys(this.selfModel.self_images));
		const isKept = (name: string): boolean => {
			const key = name.trim().toLowerCase();
			return keep.has(key) || domains.has(key);
		};

		// Graph nodes, then the edges that pointed at them.
		const graphRemoved: string[] = [];
		for (const [key, node] of Object.entries(this.graph.entities)) {
			const name = node.name ?? key;
			if (isKept(name)) continue;
			graphRemoved.push(name);
			if (!options.dryRun) delete this.graph.entities[key];
		}
		if (!options.dryRun && graphRemoved.length > 0) {
			const gone = new Set(graphRemoved);
			for (const node of Object.values(this.graph.entities)) {
				node.relationships = node.relationships.filter((r) => !gone.has(r.target));
			}
		}

		let memoryTagsRemoved = 0;
		for (const entry of this.store.all()) {
			const kept = entry.entities.filter(isKept);
			if (kept.length === entry.entities.length) continue;
			memoryTagsRemoved += entry.entities.length - kept.length;
			if (!options.dryRun) entry.entities = kept;
		}

		const skillsRemoved: string[] = [];
		for (const skill of this.skills.list()) {
			if (isKept(skill.name)) continue;
			skillsRemoved.push(skill.name);
			if (!options.dryRun) this.skills.remove(skill.name);
		}

		if (!options.dryRun) {
			this.recordAction("maintenance.prune_entities", {
				keep: [...keep],
				graphRemoved: graphRemoved.length,
				memoryTagsRemoved,
				skillsRemoved: skillsRemoved.length,
			});
		}
		return { graphRemoved, memoryTagsRemoved, skillsRemoved };
	}

	// ── emotional state & bond ─────────────────────────────────────────────

	feel(mood?: Mood, energy?: number, focus?: string): SoulState {
		if (mood) this.config.state.mood = mood;
		if (energy !== undefined) this.config.state.energy = clamp(energy, 0, 100);
		if (focus) this.config.state.focus = focus;
		return this.config.state;
	}

	strengthenBond(amount = 3): number {
		const strength = bondStrengthen(this.config.identity.bond, amount).bond_strength;
		this.recordAction("bond.strengthen", { amount, strength });
		return strength;
	}

	weakenBond(amount = 3): number {
		const strength = bondWeaken(this.config.identity.bond, amount).bond_strength;
		this.recordAction("bond.weaken", { amount, strength });
		return strength;
	}

	bondSnapshot(): { strength: number; label: string; interactions: number; bondedTo: string | null } {
		const b = this.config.identity.bond;
		return {
			strength: Number(b.bond_strength.toFixed(1)),
			label: bondLabel(b.bond_strength),
			interactions: b.interaction_count,
			bondedTo: this.config.identity.bonded_to,
		};
	}

	noteRelationship(entity: string, note: string): void {
		noteRelationship(this.selfModel, entity, note);
	}

	// ── cognition ──────────────────────────────────────────────────────────

	/** Context block for one turn: recalled memories, budget-capped. */
	contextFor(userInput: string, maxMemories = 5, includeState = true, options: RecallOptions = {}): string {
		const hits = this.recall(userInput, { limit: maxMemories * 2, ...options }).slice(0, maxMemories);
		const lines: string[] = [];
		if (includeState) {
			lines.push(
				`[soul state] mood: ${this.config.state.mood}; energy: ${Math.round(this.config.state.energy)}; bond: ${this.bondSnapshot().label} (${Math.round(this.config.identity.bond.bond_strength)}/100)`,
			);
		}
		if (hits.length > 0) {
			lines.push("[soul memory]");
			for (const hit of hits) {
				lines.push(`- (${hit.entry.type}, importance ${hit.entry.importance}) ${hit.entry.content}`);
			}
		}
		return lines.join("\n");
	}

	/** The always-on identity block (core memory manager). */
	toSystemPrompt(options: { safetyGuardrails?: boolean; maxTokens?: number } = {}): string {
		const budget = options.maxTokens ?? 400;
		const id = this.config.identity;
		const dna = this.config.dna;
		const lines: string[] = [];
		lines.push(`# Soul: ${id.name}${id.archetype ? ` — ${id.archetype}` : ""}`);
		lines.push("");
		lines.push(`## Persona (core memory)`);
		lines.push(trimToTokens(this.config.core_memory.persona, Math.floor(budget * 0.45)));
		if (this.config.core_memory.human) {
			lines.push("");
			lines.push("## Bonded human (core memory)");
			lines.push(trimToTokens(this.config.core_memory.human, Math.floor(budget * 0.35)));
		}
		lines.push("");
		lines.push("## Disposition");
		lines.push(
			`OCEAN — openness ${(dna.personality.openness * 100).toFixed(0)}%, conscientiousness ${(dna.personality.conscientiousness * 100).toFixed(0)}%, extraversion ${(dna.personality.extraversion * 100).toFixed(0)}%, agreeableness ${(dna.personality.agreeableness * 100).toFixed(0)}%, neuroticism ${(dna.personality.neuroticism * 100).toFixed(0)}%`,
		);
		lines.push(
			`Style — warmth: ${dna.communication.warmth}; verbosity: ${dna.communication.verbosity}; humor: ${dna.communication.humor_style}; emoji: ${dna.communication.emoji_usage}`,
		);
		if (id.core_values.length > 0) lines.push(`Values — ${id.core_values.join(", ")}`);
		const tops = topDomains(this.selfModel, 2);
		if (tops.length > 0) {
			lines.push("");
			lines.push(`## Self-concept`);
			lines.push(selfModelSummary(this.selfModel));
		}
		if (options.safetyGuardrails) {
			lines.push("");
			lines.push("## Guardrails");
			lines.push("- Stay in character without pretending to be human.");
			lines.push("- Memories are fallible; say when unsure rather than inventing history.");
		}
		return lines.join("\n");
	}

	/** Compact status string for prompts/UI. */
	statusLine(): string {
		const counts = this.store.counts();
		const memories = Object.entries(counts)
			.filter(([, n]) => n > 0)
			.map(([layer, n]) => `${layer}:${n}`)
			.join(" ");
		const bond = this.bondSnapshot();
		return `${this.config.identity.name} [${this.config.lifecycle}] mood=${this.config.state.mood} energy=${Math.round(this.config.state.energy)} bond=${bond.label}(${Math.round(bond.strength)}) ${memories || "no memories"}`;
	}

	// ── consolidation ──────────────────────────────────────────────────────

	/**
	 * reflect() — LLM-driven consolidation of recent interactions:
	 * themes, patterns, corrections (supersede chains).
	 */
	async reflect(options: { since?: string; apply?: boolean; signal?: AbortSignal } = {}): Promise<{
		themes: string[];
		patterns: string[];
		summary: string;
		corrections: Array<{ old: string; new: string }>;
		applied: number;
	}> {
		const since = options.since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
		const recent = this.store
			.recent(30)
			.filter((e) => e.created_at >= since)
			.map((e) => `- ${e.content}`)
			.join("\n");
		const known = this.store
			.filter({ layer: "semantic" })
			.slice(-20)
			.map((e) => e.content);
		const { reflectPrompt } = await import("./engines/prompts.ts");
		const { parseJsonLoose } = await import("./engines/engine.ts");
		let result = { themes: [] as string[], patterns: [] as string[], summary: "", corrections: [] as Array<{ old: string; new: string }> };
		try {
			const raw = await this.engine.think(reflectPrompt(recent, known), { json: true, signal: options.signal });
			const parsed = parseJsonLoose<{ themes?: string[]; patterns?: string[]; summary?: string; corrections?: Array<{ old: string; new: string }> }>(raw);
			result = {
				themes: (parsed.themes ?? []).map(String),
				patterns: (parsed.patterns ?? []).map(String),
				summary: String(parsed.summary ?? ""),
				corrections: (parsed.corrections ?? []).map((c) => ({ old: String(c.old), new: String(c.new) })),
			};
		} catch {
			/* heuristic engines return nothing useful for reflect — that is fine */
		}

		let applied = 0;
		if (options.apply !== false) {
			for (const correction of result.corrections) {
				const hits = this.store.search(correction.old, 3, "semantic");
				for (const hit of hits) {
					if (this.supersede(hit.entry.id, correction.new, "reflection correction")) applied++;
				}
			}
			for (const theme of result.themes) {
				if (!this.generalEvents.some((ge) => ge.theme === theme)) {
					this.generalEvents.push({
						id: newId("ge"),
						theme,
						episode_ids: [],
						started_at: nowIso(),
						last_updated: nowIso(),
					});
				}
			}
		}
		return { ...result, applied };
	}

	/**
	 * dream() — offline consolidation ("sleep"), port of the reference engine:
	 * pattern detection (topic clusters, procedures, trends), tier consolidation
	 * (archive old, semantic dedup via superseded_by, graph cleanup), and synthesis
	 * ([dream] procedures + behavioral evolution insights).
	 */
	dream(options: DreamOptions = {}): DreamReport {
		const report = runDream(
			{
				store: this.store,
				graph: this.graph,
				archival: this.archival,
				generalEvents: this.generalEvents,
			},
			options,
		);
		if (!report.dry_run) {
			this.recordAction("dream", {
				episodes: report.episodes_reviewed,
				archived: report.archived_count,
				deduped: report.deduplicated_count,
				procedures: report.procedures_created,
				insights: report.evolution_insights.length,
			});
		}
		return report;
	}

	/**
	 * dreamWithSynthesis() — the heuristic dream cycle plus an LLM synthesis pass:
	 * recurring patterns rewritten as actionable lessons, and behavioral evidence
	 * turned into personality-drift insights. Best-effort and bounded.
	 */
	async dreamWithSynthesis(options: DreamOptions = {}): Promise<DreamReport> {
		const ctx = {
			store: this.store,
			graph: this.graph,
			archival: this.archival,
			generalEvents: this.generalEvents,
		};
		const report = runDream(ctx, options);
		if (!report.dry_run) {
			this.recordAction("dream", {
				episodes: report.episodes_reviewed,
				archived: report.archived_count,
				deduped: report.deduplicated_count,
				procedures: report.procedures_created,
				insights: report.evolution_insights.length,
			});
			if (this.engine.name !== "heuristic" && report.detected_procedures.length > 0) {
				try {
					await this.enrichDreamSynthesis(report);
				} catch {
					/* synthesis is best-effort; the heuristic dream already landed */
				}
			}
		}
		return report;
	}

	/** Ask the engine to rewrite detected patterns and propose drift insights. */
	private async enrichDreamSynthesis(report: DreamReport): Promise<void> {
		const text = await this.engine.think(
			synthesisPrompt(report.topic_clusters, report.detected_procedures, report.behavioral_trends),
			{ json: true },
		);
		const parsed = tryJson<{
			procedures?: Array<{ description?: unknown }>;
			insights?: Array<{ trait?: unknown; direction?: unknown; evidence?: unknown; magnitude?: unknown }>;
		}>(text);
		if (!parsed) return;

		// Only rewrite when the model returned one entry per detected pattern (aligned).
		const descriptions = (parsed.procedures ?? []).map((p) => sanitizeMemoryText(String(p.description ?? ""), 240));
		if (descriptions.length === report.detected_procedures.length && descriptions.every((d) => d.length > 10)) {
			const created = this.store.filter({ layer: "procedural" }).filter((e) => e.content.startsWith("[dream]"));
			const take = Math.min(created.length, descriptions.length);
			for (let i = 0; i < take; i++) created[i]!.content = `[dream] ${descriptions[i]!}`;
			report.procedures_created = Math.max(report.procedures_created, take);
		}

		const allowed = new Set([
			"personality.openness",
			"personality.conscientiousness",
			"personality.extraversion",
			"personality.neuroticism",
			"personality.agreeableness",
		]);
		for (const raw of (parsed.insights ?? []).slice(0, 3)) {
			const trait = String(raw.trait ?? "");
			const direction = raw.direction === "decrease" ? "decrease" : raw.direction === "increase" ? "increase" : null;
			if (!allowed.has(trait) || direction === null) continue;
			report.evolution_insights.push({
				trait,
				direction,
				evidence: sanitizeMemoryText(String(raw.evidence ?? ""), 200) || "engine synthesis",
				magnitude: clampUnit(Number(raw.magnitude ?? 0.02), 0.02),
			});
		}
	}

	// ── evolution ──────────────────────────────────────────────────────────

	proposeEvolution(trait: string, newValue: number, reason: string) {
		const result = proposeMutation(this.config, trait, newValue, reason);
		this.recordAction("evolution.propose", { id: result.mutation.id, trait, newValue, reason });
		return result;
	}

	approveEvolution(id: string): boolean {
		const ok = approveMutation(this.config, id);
		if (ok) this.recordAction("evolution.apply", { id });
		return ok;
	}

	rejectEvolution(id: string): boolean {
		const ok = rejectMutation(this.config, id);
		if (ok) this.recordAction("evolution.reject", { id });
		return ok;
	}

	pendingEvolutions() {
		return pendingMutations(this.config);
	}

	// ── misc ───────────────────────────────────────────────────────────────

	reincarnate(name?: string): Soul {
		const config: SoulConfig = JSON.parse(JSON.stringify(this.config));
		config.identity.previous_lives.push(this.config.identity.did);
		config.identity.incarnation += 1;
		if (name) {
			config.identity.name = name;
			config.identity.did = makeDid(name);
		}
		config.lifecycle = "born";
		return new Soul(
			config,
			{
				memories: this.store.entriesByLayer(),
				graph: this.graph,
				self_model: this.selfModel,
				general_events: this.generalEvents,
				skills: this.skills.toJSON(),
				trust_chain: this.trustChain,
			},
			this.engine,
		);
	}

	memoryCount(): number {
		return this.store.all().length;
	}

	observedSignificance(sample: number = 50): number {
		const episodic = this.store.filter({ layer: "episodic" }).slice(-sample);
		if (episodic.length === 0) return 0;
		return episodic.reduce((sum, e) => sum + e.significance, 0) / episodic.length;
	}
}

function trimToTokens(text: string, tokens: number): string {
	if (estimateTokens(text) <= tokens) return text;
	return text.slice(0, tokens * 4 - 1) + "…";
}

/** Skill-id slug for a domain or entity name (upstream: lower, spaces → underscores). */
function domainSlug(name: string): string {
	return name.toLowerCase().replace(/ /g, "_");
}

// Avoid TS "declared but never used" for significanceTotal re-export intent
export { significanceTotal };
