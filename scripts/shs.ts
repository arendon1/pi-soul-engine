#!/usr/bin/env node
/**
 * Soul Health Score (SHS) — 7-dimension evaluation of a live soul instance.
 *
 * Port of the reference repo's Tier-6 rubric, heuristic-only (no LLM calls):
 *
 *   D1 memory recall (20) · D2 emotional intelligence (15) · D3 personality
 *   expression (15) · D4 bond (15) · D5 self-model (10) · D6 identity
 *   continuity (15) · D7 portability (10)
 *
 * Usage: node scripts/shs.ts [path-to-soul-dir-or-.soul-file]
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Soul } from "../src/runtime/soul.ts";
import { HeuristicEngine } from "../src/runtime/engines/heuristic.ts";
import { kleinConfidence } from "../src/runtime/self-model.ts";
import { unpackSoul } from "../src/spec/soul-file.ts";
import { estimateTokens } from "../src/util/text.ts";

interface Dimension {
	name: string;
	weight: number;
	score: number;
	notes: string;
}

function clamp01(n: number): number {
	return Math.min(1, Math.max(0, n));
}

function evaluate(soul: Soul): Dimension[] {
	const dims: Dimension[] = [];

	// D1: Memory Recall — probe each semantic fact with a shuffled-token query.
	const facts = soul.store.filter({ layer: "semantic" });
	let hits = 0;
	for (const fact of facts) {
		const words = fact.content.split(/\s+/).slice(0, 3).join(" ");
		const found = soul.search(words, 3).some((h) => h.entry.id === fact.id);
		if (found) hits++;
	}
	const recallRate = facts.length > 0 ? hits / facts.length : 1;
	dims.push({
		name: "D1 Memory Recall",
		weight: 20,
		score: Math.round(recallRate * 100),
		notes: `${hits}/${facts.length} facts resurface from partial queries`,
	});

	// D2: Emotional Intelligence — somatic coverage, label diversity, gating.
	const episodic = soul.store.filter({ layer: "episodic" });
	const withSomatic = episodic.filter((e) => e.somatic !== null);
	const labels = new Set(withSomatic.map((e) => e.somatic!.label));
	const somaticCoverage = episodic.length > 0 ? withSomatic.length / episodic.length : 0.5;
	const labelDiversity = clamp01(labels.size / 4);
	const gatingSanity = clamp01(1 - Math.abs(0.25 - episodic.length / Math.max(soul.memoryCount(), 1)));
	dims.push({
		name: "D2 Emotional Intelligence",
		weight: 15,
		score: Math.round((0.5 * somaticCoverage + 0.3 * labelDiversity + 0.2 * gatingSanity) * 100),
		notes: `${withSomatic.length}/${episodic.length} episodes carry somatic markers, ${labels.size} distinct labels`,
	});

	// D3: Personality Expression — DNA complete, traits in range, prompt faithful.
	const dna = soul.config.dna.personality;
	const traits = Object.values(dna);
	const inRange = traits.every((t) => t >= 0 && t <= 1);
	const prompt = soul.toSystemPrompt();
	const hasOcean = /OCEAN/.test(prompt) && /openness/.test(prompt);
	const hasStyle = /Style —/.test(prompt);
	const hasValues = soul.config.identity.core_values.length > 0;
	const variance = traits.reduce((s, t) => s + Math.abs(t - 0.5), 0) / traits.length;
	dims.push({
		name: "D3 Personality Expression",
		weight: 15,
		score: Math.round(
			(0.3 * (inRange ? 1 : 0) + 0.3 * (hasOcean ? 1 : 0) + 0.2 * (hasStyle ? 1 : 0) + 0.2 * (hasValues ? 1 : 0)) *
				(0.7 + 0.3 * clamp01(variance * 2)) *
				100,
		),
		notes: `traits ${inRange ? "in range" : "OUT OF RANGE"}, prompt ${hasOcean ? "renders OCEAN" : "MISSING OCEAN"}`,
	});

	// D4: Bond — growth evidence + sane curve.
	const bond = soul.config.identity.bond;
	const strengthSane = bond.bond_strength >= 0 && bond.bond_strength <= 100;
	const interactionEvidence = clamp01(bond.interaction_count / 10);
	const labelProgress = ["estranged", "distant", "acquainted", "warm", "close", "devoted"].indexOf(
		soul.bondSnapshot().label,
	);
	dims.push({
		name: "D4 Bond",
		weight: 15,
		score: Math.round((0.4 * (strengthSane ? 1 : 0) + 0.3 * interactionEvidence + 0.3 * clamp01((labelProgress + 1) / 6)) * 100),
		notes: `${soul.bondSnapshot().label} (${bond.bond_strength.toFixed(1)}/100, ${bond.interaction_count} interactions)`,
	});

	// D5: Self-model — Klein calibration: confidence must match the curve.
	const images = Object.values(soul.selfModel.self_images);
	let calibrated = 0;
	for (const image of images) {
		const expected = kleinConfidence(image.evidence_count);
		if (Math.abs(expected - image.confidence) < 0.01) calibrated++;
	}
	const calibration = images.length > 0 ? calibrated / images.length : 0.5;
	const neverCertain = images.every((i) => i.confidence < 1.0);
	dims.push({
		name: "D5 Self-model",
		weight: 10,
		score: Math.round((0.7 * calibration + 0.3 * (neverCertain ? 1 : 0)) * 100),
		notes: `${calibrated}/${images.length} domains on the Klein curve, uncertainty ${neverCertain ? "permanent" : "BROKEN"}`,
	});

	// D6: Identity Continuity — roundtrip fidelity.
	const before = soul.store.counts();
	const roundtrip = Soul.awaken({ data: soul.pack() }, new HeuristicEngine());
	const after = roundtrip.store.counts();
	const same =
		JSON.stringify(before) === JSON.stringify(after) &&
		roundtrip.config.identity.did === soul.config.identity.did;
	dims.push({
		name: "D6 Identity Continuity",
		weight: 15,
		score: same ? 100 : 0,
		notes: same ? `pack→unpack preserves ${soul.memoryCount()} memories and the DID` : "ROUNDTRIP LOSS DETECTED",
	});

	// D7: Portability — archive integrity + engine independence.
	let portable = 0;
	try {
		const bytes = soul.pack();
		const doc = unpackSoul(bytes);
		if (doc.config.identity.did === soul.config.identity.did) portable += 0.5;
		if (estimateTokens(JSON.stringify(doc)) > 0) portable += 0.25;
		const configText = JSON.stringify(doc.config);
		if (!/heuristic|pi-model|HybridEngine/.test(configText)) portable += 0.25;
	} catch {
		/* portable stays 0 */
	}
	dims.push({
		name: "D7 Portability",
		weight: 10,
		score: Math.round(portable * 100),
		notes: portable === 1 ? "archive valid, no engine leakage" : "archive issues",
	});

	return dims;
}

function main(): void {
	const arg = process.argv[2] ?? join(homedir(), ".pi", "agent", "souls", "default.soul");
	if (!existsSync(arg)) {
		console.error(`soul not found: ${arg}`);
		process.exit(1);
	}
	const isDir = statSync(arg).isDirectory();
	const soul = isDir
		? Soul.awaken({ dir: arg }, new HeuristicEngine())
		: Soul.awaken({ file: arg }, new HeuristicEngine());

	const dims = evaluate(soul);
	const composite = dims.reduce((sum, d) => sum + (d.score * d.weight) / 100, 0);

	console.log(`\nSoul Health Score — ${soul.config.identity.name} (${soul.config.identity.did})`);
	console.log("─".repeat(72));
	for (const dim of dims) {
		console.log(`${dim.name.padEnd(28)} ${String(dim.score).padStart(3)}/100  ×${dim.weight}%  ${dim.notes}`);
	}
	console.log("─".repeat(72));
	console.log(`${"Composite".padEnd(28)} ${composite.toFixed(1)}/100\n`);
}

main();
