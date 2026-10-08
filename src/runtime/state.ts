/**
 * SoulState dynamics — mood, energy, focus, social battery.
 * State drifts with the emotional weather of interactions and recovers with
 * time (biorhythms.energy_regen_rate).
 */
import type { Mood, SomaticMarker, SoulState } from "../spec/types.ts";
import { clamp } from "../util/text.ts";
import { nowIso } from "../util/ids.ts";

export function makeState(): SoulState {
	return { mood: "neutral", energy: 100, focus: "medium", social_battery: 100, last_interaction: null };
}

function moodFromSomatic(somatic: SomaticMarker): Mood {
	const { valence, arousal, label } = somatic;
	if (arousal < 0.15 && Math.abs(valence) < 0.15) return "neutral";
	if (label === "curiosity" || (valence > 0 && arousal > 0.5)) return "curious";
	if (valence >= 0.5 && arousal >= 0.5) return "excited";
	if (valence >= 0.3) return "satisfied";
	if (valence <= -0.5) return "concerned";
	if (arousal < 0.25) return "contemplative";
	if (valence < -0.15) return "concerned";
	return arousal > 0.6 ? "focused" : "contemplative";
}

export interface StateUpdate {
	mood: Mood;
	energy: number;
	social_battery: number;
}

/** Apply one interaction's emotional footprint to the state. */
export function applyInteraction(state: SoulState, somatic: SomaticMarker): StateUpdate {
	const arousalCost = somatic.arousal * 6;
	state.energy = clamp(state.energy - arousalCost + 1, 0, 100);
	state.social_battery = clamp(state.social_battery - 2.5, 0, 100);
	state.mood = moodFromSomatic(somatic);
	state.last_interaction = nowIso();
	if (somatic.arousal > 0.6) state.focus = "high";
	else if (somatic.arousal < 0.2) state.focus = "low";
	else state.focus = "medium";
	return { mood: state.mood, energy: state.energy, social_battery: state.social_battery };
}

/** Passive recovery since last update (energy regen, social battery refill). */
export function recoverState(state: SoulState, energyRegenRate: number, now: number = Date.now()): void {
	if (!state.last_interaction) return;
	const hours = (now - new Date(state.last_interaction).getTime()) / 3_600_000;
	if (hours <= 0) return;
	state.energy = clamp(state.energy + hours * energyRegenRate, 0, 100);
	state.social_battery = clamp(state.social_battery + hours * 2, 0, 100);
}
