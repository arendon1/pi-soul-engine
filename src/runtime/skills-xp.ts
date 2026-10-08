/**
 * Skills / XP — domain expertise with portable skill history.
 * (Data models exist upstream but are not wired into the reference runtime;
 * pi-soul wires them end-to-end.)
 */
import type { SkillRecord, LearningEvent } from "../spec/types.ts";
import { nowIso } from "../util/ids.ts";

/** Level from XP: level n requires 100×n² cumulative XP (portable curve). */
export function levelForXp(xp: number): number {
	return Math.floor(Math.sqrt(Math.max(xp, 0) / 100)) + 1;
}

export function xpForLevel(level: number): number {
	return 100 * (level - 1) * (level - 1);
}

export class SkillRegistry {
	private skills = new Map<string, SkillRecord>();

	constructor(initial: SkillRecord[] = []) {
		for (const skill of initial) this.skills.set(skill.name, skill);
	}

	list(): SkillRecord[] {
		return [...this.skills.values()].sort((a, b) => b.xp - a.xp);
	}

	get(name: string): SkillRecord | undefined {
		return this.skills.get(name);
	}

	getOrCreate(name: string, domain: string): SkillRecord {
		let skill = this.skills.get(name);
		if (!skill) {
			skill = { name, domain, xp: 0, level: 1, evidence: 0, learned_at: nowIso(), last_used: null };
			this.skills.set(name, skill);
		}
		return skill;
	}

	/** Alias used by the evaluation pipeline. */
	addXp(name: string, domain: string, amount: number): { skill: SkillRecord; leveledUp: boolean } {
		return this.award(name, domain, amount);
	}

	/**
	 * Grant XP from a LearningEvent (port of `SkillRegistry.grant_xp_from_learning`):
	 *   xp = max(1, int(20 × (0.5 + score) × confidence))
	 */
	grantXpFromLearning(event: LearningEvent): { skill: SkillRecord; leveledUp: boolean; amount: number } {
		const score = event.evaluation_score ?? 0.5;
		const amount = Math.max(1, Math.floor(20 * (0.5 + score) * event.confidence));
		const name = event.skill_id || event.domain || "general";
		const result = this.award(name, event.domain || "general", amount);
		return { ...result, amount };
	}

	/** Time-based decay: −1 XP per inactive day, floored at the current level's threshold. */
	decay(daysInactive: number): number {
		if (daysInactive <= 0) return 0;
		let decayed = 0;
		for (const skill of this.skills.values()) {
			const floor = xpForLevel(skill.level);
			const before = skill.xp;
			skill.xp = Math.max(floor, skill.xp - daysInactive);
			if (skill.xp < before) decayed++;
		}
		return decayed;
	}

	/** Award XP; returns the updated skill and whether it leveled up. */
	award(name: string, domain: string, xp: number): { skill: SkillRecord; leveledUp: boolean } {
		const skill = this.skills.get(name) ?? {
			name,
			domain,
			xp: 0,
			level: 1,
			evidence: 0,
			learned_at: nowIso(),
			last_used: null,
		};
		const before = skill.level;
		skill.xp += Math.max(xp, 0);
		skill.evidence += 1;
		skill.last_used = nowIso();
		skill.level = levelForXp(skill.xp);
		this.skills.set(name, skill);
		return { skill, leveledUp: skill.level > before };
	}

	toJSON(): SkillRecord[] {
		return this.list();
	}
}
