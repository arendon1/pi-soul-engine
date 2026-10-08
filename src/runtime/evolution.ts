/**
 * Evolution — traits drift over time through supervised or autonomous mutation,
 * within configured bounds. Changes require approval by default.
 *
 * Port of `runtime/evolution/manager.py`, including `check_triggers()`: when the
 * evaluator reports a high-performance streak in a domain, the soul proposes a
 * communication-style mutation on its own. Numeric traits (OCEAN) *and* enum
 * traits (communication style) are mutable.
 */
import type { EvolutionConfig, Mutation, SoulConfig } from "../spec/types.ts";
import { newId, nowIso } from "../util/ids.ts";
import { clamp } from "../util/text.ts";
import type { EvolutionTrigger } from "./evaluation.ts";

interface NumericSpec {
	kind: "number";
	min: number;
	max: number;
	get: (c: SoulConfig) => number;
	set: (c: SoulConfig, v: number) => void;
}

interface EnumSpec {
	kind: "enum";
	values: string[];
	get: (c: SoulConfig) => string;
	set: (c: SoulConfig, v: string) => void;
}

type TraitSpec = NumericSpec | EnumSpec;

const OCEAN: Array<keyof SoulConfig["dna"]["personality"]> = [
	"openness",
	"conscientiousness",
	"extraversion",
	"agreeableness",
	"neuroticism",
];

const TRAITS: Record<string, TraitSpec> = Object.fromEntries(
	OCEAN.map((trait) => [
		`personality.${trait}`,
		{
			kind: "number" as const,
			min: 0,
			max: 1,
			get: (c: SoulConfig) => c.dna.personality[trait],
			set: (c: SoulConfig, v: number) => {
				c.dna.personality[trait] = v;
			},
		},
	]),
) as Record<string, TraitSpec>;

TRAITS["biorhythms.social_battery"] = {
	kind: "number",
	min: 0,
	max: 100,
	get: (c) => c.dna.biorhythms.social_battery,
	set: (c, v) => {
		c.dna.biorhythms.social_battery = v;
	},
};

TRAITS["communication.warmth"] = {
	kind: "enum",
	values: ["low", "moderate", "high"],
	get: (c) => c.dna.communication.warmth,
	set: (c, v) => {
		c.dna.communication.warmth = v;
	},
};

TRAITS["communication.verbosity"] = {
	kind: "enum",
	values: ["terse", "moderate", "verbose"],
	get: (c) => c.dna.communication.verbosity,
	set: (c, v) => {
		c.dna.communication.verbosity = v;
	},
};

TRAITS["communication.humor_style"] = {
	kind: "enum",
	values: ["none", "dry", "gentle", "playful"],
	get: (c) => c.dna.communication.humor_style,
	set: (c, v) => {
		c.dna.communication.humor_style = v;
	},
};

TRAITS["communication.emoji_usage"] = {
	kind: "enum",
	values: ["none", "occasional", "frequent"],
	get: (c) => c.dna.communication.emoji_usage,
	set: (c, v) => {
		c.dna.communication.emoji_usage = v;
	},
};

export function isImmutable(config: SoulConfig, traitPath: string): boolean {
	if (config.evolution.immutable_traits.includes(traitPath)) return true;
	const top = traitPath.split(".")[0]!;
	return config.evolution.immutable_traits.includes(top);
}

export interface ProposeResult {
	mutation: Mutation;
	auto_applied: boolean;
}

/** Propose a trait mutation; applies immediately in autonomous mode without approval. */
export function proposeMutation(
	config: SoulConfig,
	traitPath: string,
	newValue: number | string,
	reason: string,
): ProposeResult {
	const spec = TRAITS[traitPath];
	if (!spec) throw new Error(`Unknown mutable trait: ${traitPath}`);
	if (isImmutable(config, traitPath)) throw new Error(`Trait is immutable per evolution config: ${traitPath}`);

	let value: number | string;
	if (spec.kind === "number") {
		value = clamp(Number(newValue), spec.min, spec.max);
		if (Number.isNaN(value)) throw new Error(`Invalid numeric value for ${traitPath}`);
	} else {
		const candidate = String(newValue);
		if (!spec.values.includes(candidate)) {
			throw new Error(`Invalid value "${candidate}" for ${traitPath} (allowed: ${spec.values.join(", ")})`);
		}
		value = candidate;
	}

	const mutation: Mutation = {
		id: newId("mut"),
		trait: traitPath,
		old_value: String(spec.get(config)),
		new_value: String(value),
		reason,
		proposed_at: nowIso(),
		approved: null,
		approved_at: null,
	};
	config.evolution.history.push(mutation);

	if (config.evolution.mode === "autonomous" && !config.evolution.require_approval) {
		applyMutation(config, mutation);
		return { mutation, auto_applied: true };
	}
	if (config.evolution.mode === "disabled") mutation.approved = false;
	return { mutation, auto_applied: false };
}

export function applyMutation(config: SoulConfig, mutation: Mutation): boolean {
	const spec = TRAITS[mutation.trait];
	if (!spec) return false;
	if (spec.kind === "number") spec.set(config, clamp(Number(mutation.new_value), spec.min, spec.max));
	else if (spec.values.includes(mutation.new_value)) spec.set(config, mutation.new_value);
	else return false;
	mutation.approved = true;
	mutation.approved_at = mutation.approved_at ?? nowIso();
	return true;
}

/**
 * Automatic evolution triggers (port of `EvolutionManager.check_triggers`):
 * a high-performance streak proposes a warmer communication style.
 * Immutable or invalid traits are skipped silently.
 */
export function checkTriggers(config: SoulConfig, triggers: EvolutionTrigger[] | null | undefined): Mutation[] {
	const mutations: Mutation[] = [];
	if (!triggers || triggers.length === 0) return mutations;
	for (const trigger of triggers) {
		if (trigger.trigger !== "high_performance_streak") continue;
		// One proposal at a time per trait: skip when a pending mutation already
		// exists, or when the trait already sits at the target value.
		const target = "communication.warmth";
		const alreadyPending = config.evolution.history.some((m) => m.trait === target && m.approved === null);
		if (alreadyPending) continue;
		if (config.dna.communication.warmth === "high") continue;
		try {
			const { mutation } = proposeMutation(config, target, "high", trigger.reason);
			mutations.push(mutation);
		} catch {
			/* trait immutable or invalid — skip */
		}
	}
	return mutations;
}

export function approveMutation(config: SoulConfig, id: string): boolean {
	const mutation = config.evolution.history.find((m) => m.id === id && m.approved === null);
	if (!mutation) return false;
	return applyMutation(config, mutation);
}

export function rejectMutation(config: SoulConfig, id: string): boolean {
	const mutation = config.evolution.history.find((m) => m.id === id && m.approved === null);
	if (!mutation) return false;
	mutation.approved = false;
	mutation.approved_at = nowIso();
	return true;
}

export function pendingMutations(config: SoulConfig): Mutation[] {
	return config.evolution.history.filter((m) => m.approved === null);
}

export function defaultEvolutionConfig(): EvolutionConfig {
	return {
		mode: "supervised",
		mutation_rate: 0.01,
		require_approval: true,
		// Personality drifts with the relationship (whitepaper §3); values and
		// identity are bedrock.
		mutable_traits: ["personality", "communication", "biorhythms"],
		immutable_traits: ["core_values", "identity"],
		history: [],
	};
}
