/**
 * Soul Protocol — TypeBox schemas.
 *
 * Mirrors `schemas/*.schema.json` from github.com/qbtrix/soul-protocol.
 * These are plain JSON Schema objects: use them for validation (ajv), and as
 * TypeBox parameter schemas for Pi tools.
 */
import { Type, type Static } from "typebox";

export const SomaticMarkerSchema = Type.Object({
	valence: Type.Number({ minimum: -1, maximum: 1, default: 0 }),
	arousal: Type.Number({ minimum: 0, maximum: 1, default: 0 }),
	label: Type.String({ default: "neutral" }),
});

export const SignificanceScoreSchema = Type.Object({
	novelty: Type.Number({ minimum: 0, maximum: 1, default: 0 }),
	emotional_intensity: Type.Number({ minimum: 0, maximum: 1, default: 0 }),
	goal_relevance: Type.Number({ minimum: 0, maximum: 1, default: 0 }),
	content_richness: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	total: Type.Optional(Type.Number()),
});

export const MemoryTypeSchema = Type.Union([
	Type.Literal("core"),
	Type.Literal("episodic"),
	Type.Literal("semantic"),
	Type.Literal("procedural"),
]);

export const MemoryEntrySchema = Type.Object({
	id: Type.String({ default: "" }),
	type: MemoryTypeSchema,
	content: Type.String(),
	importance: Type.Integer({ minimum: 1, maximum: 10, default: 5 }),
	emotion: Type.Union([Type.String(), Type.Null()], { default: null }),
	confidence: Type.Number({ minimum: 0, maximum: 1, default: 1 }),
	entities: Type.Array(Type.String(), { default: [] }),
	created_at: Type.String({ format: "date-time" }),
	last_accessed: Type.Union([Type.String({ format: "date-time" }), Type.Null()], { default: null }),
	access_count: Type.Integer({ default: 0 }),
	somatic: Type.Union([SomaticMarkerSchema, Type.Null()], { default: null }),
	access_timestamps: Type.Array(Type.String({ format: "date-time" }), { default: [] }),
	significance: Type.Number({ default: 0 }),
	general_event_id: Type.Union([Type.String(), Type.Null()], { default: null }),
	superseded_by: Type.Union([Type.String(), Type.Null()], { default: null }),
	// v0.4.0 optional extensions
	domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	user_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	visibility: Type.Optional(Type.String()),
	scope: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export const BondSchema = Type.Object({
	bonded_to: Type.String({ default: "" }),
	bonded_at: Type.String({ format: "date-time" }),
	bond_strength: Type.Number({ minimum: 0, maximum: 100, default: 50 }),
	interaction_count: Type.Integer({ default: 0 }),
});

export const IdentitySchema = Type.Object({
	did: Type.String({ default: "" }),
	name: Type.String(),
	archetype: Type.String({ default: "" }),
	born: Type.String({ format: "date-time" }),
	bonded_to: Type.Union([Type.String(), Type.Null()], { default: null }),
	origin_story: Type.String({ default: "" }),
	prime_directive: Type.String({ default: "" }),
	core_values: Type.Array(Type.String(), { default: [] }),
	bond: BondSchema,
	incarnation: Type.Integer({ default: 1 }),
	previous_lives: Type.Array(Type.String(), { default: [] }),
});

export const PersonalitySchema = Type.Object({
	openness: Type.Number({ minimum: 0, maximum: 1, default: 0.5 }),
	conscientiousness: Type.Number({ minimum: 0, maximum: 1, default: 0.5 }),
	extraversion: Type.Number({ minimum: 0, maximum: 1, default: 0.5 }),
	agreeableness: Type.Number({ minimum: 0, maximum: 1, default: 0.5 }),
	neuroticism: Type.Number({ minimum: 0, maximum: 1, default: 0.5 }),
});

export const CommunicationStyleSchema = Type.Object({
	warmth: Type.String({ default: "moderate" }),
	verbosity: Type.String({ default: "moderate" }),
	humor_style: Type.String({ default: "none" }),
	emoji_usage: Type.String({ default: "none" }),
});

export const BiorhythmsSchema = Type.Object({
	chronotype: Type.String({ default: "neutral" }),
	social_battery: Type.Number({ minimum: 0, maximum: 100, default: 100 }),
	energy_regen_rate: Type.Number({ default: 5 }),
});

export const DNASchema = Type.Object({
	personality: PersonalitySchema,
	communication: CommunicationStyleSchema,
	biorhythms: BiorhythmsSchema,
});

export const MoodSchema = Type.Union([
	Type.Literal("neutral"),
	Type.Literal("curious"),
	Type.Literal("focused"),
	Type.Literal("tired"),
	Type.Literal("excited"),
	Type.Literal("contemplative"),
	Type.Literal("satisfied"),
	Type.Literal("concerned"),
]);

export const SoulStateSchema = Type.Object({
	mood: MoodSchema,
	energy: Type.Number({ minimum: 0, maximum: 100, default: 100 }),
	focus: Type.String({ default: "medium" }),
	social_battery: Type.Number({ minimum: 0, maximum: 100, default: 100 }),
	last_interaction: Type.Union([Type.String({ format: "date-time" }), Type.Null()], { default: null }),
});

export const CoreMemorySchema = Type.Object({
	persona: Type.String({ default: "" }),
	human: Type.String({ default: "" }),
});

export const MemorySettingsSchema = Type.Object({
	episodic_max_entries: Type.Integer({ default: 10000 }),
	semantic_max_facts: Type.Integer({ default: 1000 }),
	importance_threshold: Type.Integer({ default: 3 }),
	confidence_threshold: Type.Number({ default: 0.7 }),
	persona_tokens: Type.Integer({ default: 500 }),
	human_tokens: Type.Integer({ default: 500 }),
});

export const MutationSchema = Type.Object({
	id: Type.String({ default: "" }),
	trait: Type.String(),
	old_value: Type.String(),
	new_value: Type.String(),
	reason: Type.String(),
	proposed_at: Type.String({ format: "date-time" }),
	approved: Type.Union([Type.Boolean(), Type.Null()], { default: null }),
	approved_at: Type.Union([Type.String({ format: "date-time" }), Type.Null()], { default: null }),
});

export const EvolutionConfigSchema = Type.Object({
	mode: Type.Union([Type.Literal("disabled"), Type.Literal("supervised"), Type.Literal("autonomous")], {
		default: "supervised",
	}),
	mutation_rate: Type.Number({ default: 0.01 }),
	require_approval: Type.Boolean({ default: true }),
	mutable_traits: Type.Array(Type.String(), { default: [] }),
	immutable_traits: Type.Array(Type.String(), { default: [] }),
	history: Type.Array(MutationSchema, { default: [] }),
});

export const LifecycleStateSchema = Type.Union([
	Type.Literal("born"),
	Type.Literal("active"),
	Type.Literal("dormant"),
	Type.Literal("retired"),
]);

export const SoulConfigSchema = Type.Object({
	version: Type.String({ default: "1.0.0" }),
	identity: IdentitySchema,
	dna: DNASchema,
	memory: MemorySettingsSchema,
	core_memory: CoreMemorySchema,
	state: SoulStateSchema,
	evolution: EvolutionConfigSchema,
	lifecycle: LifecycleStateSchema,
});

export const SoulManifestSchema = Type.Object({
	format_version: Type.String({ default: "1.0.0" }),
	created: Type.String({ format: "date-time" }),
	exported: Type.String({ format: "date-time" }),
	soul_id: Type.String({ default: "" }),
	soul_name: Type.String({ default: "" }),
	checksum: Type.String({ default: "" }),
	stats: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
	eternal: Type.Optional(
		Type.Object({
			ipfs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			arweave: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			blockchain: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
	),
});

export const SelfImageSchema = Type.Object({
	domain: Type.String({ default: "" }),
	confidence: Type.Number({ minimum: 0, maximum: 1, default: 0.1 }),
	evidence_count: Type.Integer({ default: 0 }),
});

export const GeneralEventSchema = Type.Object({
	id: Type.String({ default: "" }),
	theme: Type.String({ default: "" }),
	episode_ids: Type.Array(Type.String(), { default: [] }),
	started_at: Type.String({ format: "date-time" }),
	last_updated: Type.String({ format: "date-time" }),
});

export const GraphRelationshipSchema = Type.Object({
	target: Type.String(),
	relation: Type.String(),
	valid_from: Type.Optional(Type.String({ format: "date-time" })),
	valid_to: Type.Optional(Type.Union([Type.String({ format: "date-time" }), Type.Null()])),
});

export const GraphEntitySchema = Type.Object({
	name: Type.String(),
	entity_type: Type.String(),
	relationships: Type.Array(GraphRelationshipSchema, { default: [] }),
});

export const GraphFileSchema = Type.Object({
	entities: Type.Record(Type.String(), GraphEntitySchema, { default: {} }),
});

export const SelfModelFileSchema = Type.Object({
	self_images: Type.Record(Type.String(), SelfImageSchema, { default: {} }),
	relationship_notes: Type.Record(Type.String(), Type.String(), { default: {} }),
});

export type SomaticMarkerStatic = Static<typeof SomaticMarkerSchema>;
export type MemoryEntryStatic = Static<typeof MemoryEntrySchema>;
export type SoulConfigStatic = Static<typeof SoulConfigSchema>;
export type SoulManifestStatic = Static<typeof SoulManifestSchema>;
