/**
 * Soul Protocol — spec types.
 *
 * TypeScript port of the protocol primitives defined by
 * github.com/qbtrix/soul-protocol (`schemas/*.schema.json`, `spec/SOUL-FORMAT-SPEC.md`).
 *
 * JSON field names are snake_case exactly as in the schemas, so every structure
 * here round-trips byte-compatible with the Python reference implementation.
 */

// ── Emotional / cognitive primitives ─────────────────────────────────────────

/** Damasio somatic marker: emotional context tagged onto a memory. */
export interface SomaticMarker {
	valence: number; // -1.0 .. 1.0
	arousal: number; // 0.0 .. 1.0
	label: string;
}

/** LIDA significance score: decides whether an interaction becomes episodic. */
export interface SignificanceScore {
	novelty: number;
	emotional_intensity: number;
	goal_relevance: number;
	/** Derived: 0.3*novelty + 0.2*emotional_intensity + 0.2*goal_relevance + 0.3*content_richness */
	content_richness?: number;
	total?: number;
}

// ── Memory ───────────────────────────────────────────────────────────────────

export type MemoryType = "core" | "episodic" | "semantic" | "procedural";

export type MemoryLayer =
	| "core"
	| "episodic"
	| "semantic"
	| "procedural"
	| "social"
	| "graph"
	| "self_model"
	| "general_events"
	| (string & {});

export interface MemoryEntry {
	id: string;
	type: MemoryType;
	content: string;
	importance: number; // 1..10
	emotion: string | null;
	confidence: number; // 0..1
	entities: string[];
	created_at: string; // ISO 8601
	last_accessed: string | null;
	access_count: number;
	somatic: SomaticMarker | null;
	access_timestamps: string[];
	significance: number;
	general_event_id: string | null;
	superseded_by: string | null;
	// v0.4.0 optional extensions (ignored by older readers)
	domain?: string | null;
	user_id?: string | null;
	visibility?: string;
	scope?: string | null;
}

/** Participant of an interaction (user input + agent output pair). */
export interface Participant {
	role: "user" | "agent" | (string & {});
	id: string;
	content: string;
}

export interface Interaction {
	participants: Participant[];
	timestamp: string;
	metadata: Record<string, unknown>;
}

export interface CoreMemory {
	persona: string;
	human: string;
}

export interface MemorySettings {
	episodic_max_entries: number;
	semantic_max_facts: number;
	importance_threshold: number;
	confidence_threshold: number;
	persona_tokens: number;
	human_tokens: number;
}

// ── Knowledge graph & self-model ─────────────────────────────────────────────

export interface GraphRelationship {
	target: string;
	relation: string;
	valid_from?: string;
	valid_to?: string | null;
}

export interface GraphEntity {
	name: string;
	entity_type: string;
	relationships: GraphRelationship[];
}

export interface GraphFile {
	entities: Record<string, GraphEntity>;
}

export interface SelfImage {
	domain: string;
	confidence: number; // 0..1, never reaches 1.0 (Klein)
	evidence_count: number;
}

export interface SelfModelFile {
	self_images: Record<string, SelfImage>;
	relationship_notes: Record<string, string>;
}

export interface GeneralEvent {
	id: string;
	theme: string;
	episode_ids: string[];
	started_at: string;
	last_updated: string;
}

// ── Identity & personality ───────────────────────────────────────────────────

export interface Bond {
	bonded_to: string;
	bonded_at: string;
	bond_strength: number; // 0..100
	interaction_count: number;
}

export interface Identity {
	did: string;
	name: string;
	archetype: string;
	born: string;
	bonded_to: string | null;
	origin_story: string;
	prime_directive: string;
	core_values: string[];
	bond: Bond;
	incarnation: number;
	previous_lives: string[];
}

/** Big Five OCEAN, each trait 0..1. */
export interface Personality {
	openness: number;
	conscientiousness: number;
	extraversion: number;
	agreeableness: number;
	neuroticism: number;
}

export interface CommunicationStyle {
	warmth: string;
	verbosity: string;
	humor_style: string;
	emoji_usage: string;
}

export interface Biorhythms {
	chronotype: string;
	social_battery: number;
	energy_regen_rate: number;
}

export interface DNA {
	personality: Personality;
	communication: CommunicationStyle;
	biorhythms: Biorhythms;
}

export type Mood =
	| "neutral"
	| "curious"
	| "focused"
	| "tired"
	| "excited"
	| "contemplative"
	| "satisfied"
	| "concerned";

export interface SoulState {
	mood: Mood;
	energy: number;
	focus: string;
	social_battery: number;
	last_interaction: string | null;
}

export type LifecycleState = "born" | "active" | "dormant" | "retired";
export type EvolutionMode = "disabled" | "supervised" | "autonomous";

export interface Mutation {
	id: string;
	trait: string;
	old_value: string;
	new_value: string;
	reason: string;
	proposed_at: string;
	approved: boolean | null;
	approved_at: string | null;
}

export interface EvolutionConfig {
	mode: EvolutionMode;
	mutation_rate: number;
	require_approval: boolean;
	mutable_traits: string[];
	immutable_traits: string[];
	history: Mutation[];
}

export interface SoulConfig {
	version: string;
	identity: Identity;
	dna: DNA;
	memory: MemorySettings;
	core_memory: CoreMemory;
	state: SoulState;
	evolution: EvolutionConfig;
	lifecycle: LifecycleState;
}

export interface EternalLinks {
	ipfs?: Record<string, unknown>;
	arweave?: Record<string, unknown>;
	blockchain?: Record<string, unknown>;
}

export interface SoulManifest {
	format_version: string;
	created: string;
	exported: string;
	soul_id: string;
	soul_name: string;
	checksum: string;
	stats: Record<string, unknown>;
	eternal?: EternalLinks;
}

// ── Evaluation & learning (paper §13 v0.6.0: learning events) ───────────────

export interface LearningEvent {
	id: string;
	/** Interaction that triggered the lesson, if known. */
	trigger_interaction_id: string | null;
	/** The transferable insight itself. */
	lesson: string;
	domain: string;
	confidence: number; // 0..1
	/** Skill this lesson feeds XP into. */
	skill_id: string | null;
	evaluation_score: number | null;
	created_at: string;
	applied_count: number;
}

export interface RubricCriterion {
	name: string;
	description: string;
	weight: number;
}

export interface Rubric {
	id: string;
	name: string;
	domain: string;
	criteria: RubricCriterion[];
}

export interface CriterionResult {
	criterion: string;
	passed: boolean;
	score: number; // 0..1
	reasoning: string;
}

export interface RubricResult {
	rubric_id: string;
	overall_score: number; // weighted average, 0..1
	criterion_results: CriterionResult[];
	learning: string;
	timestamp: string;
}

/** A personality drift suggestion derived from behavioral patterns (dream). */
export interface EvolutionInsight {
	trait: string;
	direction: "increase" | "decrease";
	evidence: string;
	magnitude: number; // 0..1 suggested change
}

/** A compressed record of episodes moved out of the hot episodic store. */
export interface ArchivalRecord {
	id: string;
	archived_at: string;
	summary: string;
	episode_ids: string[];
	count: number;
	first: string;
	last: string;
}

/** A group of episodes sharing a topic (dream phase 2). */
export interface TopicCluster {
	topic: string;
	episode_ids: string[];
	episode_count: number;
	first_seen: string;
	last_seen: string;
	representative_content: string;
}

/** A recurring action pattern ready to become procedural memory (dream phase 2). */
export interface DetectedProcedure {
	description: string;
	source_episode_ids: string[];
	confidence: number;
	frequency: number;
}

export interface GraphConsolidation {
	merged_entities: Array<[string, string]>;
	pruned_edges: number;
	strengthened_edges: Array<[string, string, string]>;
}

// ── Skill / XP (protocol data models, fully wired by pi-soul) ────────────────

export interface SkillRecord {
	name: string;
	domain: string;
	xp: number;
	level: number;
	evidence: number;
	learned_at: string;
	last_used: string | null;
}

// ── Trust chain ─────────────────────────────────────────────────────────────

export interface TrustEntry {
	seq: number;
	timestamp: string;
	action: string;
	payload: string; // canonical JSON of action data
	prev_hash: string;
	hash: string;
	signature: string; // base64 Ed25519 over hash
}

export interface TrustChainFile {
	algorithm: "ed25519";
	public_key: string; // base64
	entries: TrustEntry[];
	/** Local-only signing key (stripped on export unless explicitly included). */
	private_key?: string;
}

// ── The complete in-memory soul document ────────────────────────────────────

export interface SoulDocument {
	config: SoulConfig;
	memories: Record<MemoryLayer, MemoryEntry[]>;
	graph: GraphFile;
	self_model: SelfModelFile;
	general_events: GeneralEvent[];
	skills: SkillRecord[];
	trust_chain?: TrustChainFile;
	/** Lessons extracted from scored experience (travels in the .soul file). */
	learning_events: LearningEvent[];
	/** Rolling rubric-evaluation history (feeds evolution triggers). */
	evaluation_history: RubricResult[];
	/** Compressed episodes moved out of the hot store by dream(). */
	archival?: ArchivalRecord[];
}
