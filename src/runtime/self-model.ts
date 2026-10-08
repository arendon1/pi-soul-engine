/**
 * Klein self-model (2004) — self-concept emerges from accumulated evidence.
 *
 *   confidence = min(0.95, 0.1 + 0.85 × (1 - 1/(1 + evidence × 0.1)))
 *
 * ~18% after 1 interaction, ~53% at 10, ~81% at 50 — never 1.0.
 * Uncertainty is permanent.
 */
import type { SelfImage, SelfModelFile } from "../spec/types.ts";
import { clamp } from "../util/text.ts";

export function kleinConfidence(evidence: number): number {
	return Math.min(0.95, 0.1 + 0.85 * (1 - 1 / (1 + evidence * 0.1)));
}

export function makeSelfModel(): SelfModelFile {
	return { self_images: {}, relationship_notes: {} };
}

export function addEvidence(selfModel: SelfModelFile, domain: string, delta = 1): SelfImage {
	const image = selfModel.self_images[domain] ?? { domain, confidence: 0.1, evidence_count: 0 };
	image.evidence_count += delta;
	image.confidence = kleinConfidence(image.evidence_count);
	selfModel.self_images[domain] = image;
	return image;
}

export function topDomains(selfModel: SelfModelFile, limit = 3): SelfImage[] {
	return Object.values(selfModel.self_images)
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, limit);
}

export function noteRelationship(selfModel: SelfModelFile, entity: string, note: string): void {
	const existing = selfModel.relationship_notes[entity];
	selfModel.relationship_notes[entity] = existing ? `${existing} ${note}` : note;
	if (selfModel.relationship_notes[entity]!.length > 2000) {
		selfModel.relationship_notes[entity] = selfModel.relationship_notes[entity]!.slice(-2000);
	}
}

export function selfModelSummary(selfModel: SelfModelFile): string {
	const tops = topDomains(selfModel, 3);
	if (tops.length === 0) return "Self-concept still forming — no strong domains yet.";
	return tops
		.map((d) => `${d.domain.replace(/_/g, " ")} (${Math.round(d.confidence * 100)}% confidence, ${d.evidence_count} observations)`)
		.join("; ");
}

export function clampConfidence(value: number): number {
	return clamp(value, 0, 0.95);
}
