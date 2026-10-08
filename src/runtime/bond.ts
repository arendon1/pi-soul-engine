/**
 * Bond model — emotional attachment to a bonded entity.
 * Strength 0..100: logarithmic growth (deep trust is hard-earned),
 * linear decay through neglect (sharp).
 */
import type { Bond } from "../spec/types.ts";
import { clamp } from "../util/text.ts";
import { nowIso } from "../util/ids.ts";

export const BOND_DEFAULT = 50;
export const BOND_MAX = 100;
const GROWTH_RATE = 12; // per log-unit of interactions
const DECAY_PER_DAY = 0.5; // linear neglect decay

export function bondStrengthen(bond: Bond, amount?: number, positive = true): Bond {
	if (!positive) return bondWeaken(bond, amount ?? 5);
	// Logarithmic growth: total strength grows like log(interactions);
	// each additional interaction counts for less.
	const scaled = amount ?? clamp(GROWTH_RATE / (1 + bond.interaction_count), 0.2, 3);
	bond.bond_strength = clamp(bond.bond_strength + scaled, 0, BOND_MAX);
	bond.interaction_count += 1;
	return bond;
}

export function bondWeaken(bond: Bond, amount = 5): Bond {
	bond.bond_strength = clamp(bond.bond_strength - amount, 0, BOND_MAX);
	return bond;
}

/** Apply neglect decay based on elapsed time since lastContact. */
export function bondDecay(bond: Bond, lastContactIso: string, now: number = Date.now()): Bond {
	const days = (now - new Date(lastContactIso).getTime()) / 86_400_000;
	if (days > 0) {
		bond.bond_strength = clamp(bond.bond_strength - DECAY_PER_DAY * days, 0, BOND_MAX);
	}
	return bond;
}

export function makeBond(bondedTo: string): Bond {
	return {
		bonded_to: bondedTo,
		bonded_at: nowIso(),
		bond_strength: BOND_DEFAULT,
		interaction_count: 0,
	};
}

export interface BondSnapshot {
	label: string;
	strength: number;
	interactions: number;
}

export function bondLabel(strength: number): string {
	if (strength >= 90) return "devoted";
	if (strength >= 75) return "close";
	if (strength >= 60) return "warm";
	if (strength >= 40) return "acquainted";
	if (strength >= 20) return "distant";
	return "estranged";
}
