/**
 * Runtime tests — golden vectors from the whitepaper's psychology stack:
 * ACT-R activation, LIDA significance gate, Klein confidence curve,
 * bond growth/decay, observe() pipeline, recall, forgetting, evolution.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseLevel, activationOf } from "../src/runtime/activation.ts";
import { significanceTotal, passesGate, heuristicSentiment, SIGNIFICANCE_THRESHOLD } from "../src/runtime/psychology.ts";
import { kleinConfidence, addEvidence, makeSelfModel } from "../src/runtime/self-model.ts";
import { bondStrengthen, bondWeaken, makeBond, bondLabel } from "../src/runtime/bond.ts";
import { makeEntry, MemoryStore } from "../src/runtime/store.ts";
import { HeuristicEngine } from "../src/runtime/engines/heuristic.ts";
import { parseJsonLoose } from "../src/runtime/engines/engine.ts";
import { Soul } from "../src/runtime/soul.ts";
import type { Interaction } from "../src/spec/types.ts";

function interaction(user: string, agent: string): Interaction {
	return {
		participants: [
			{ role: "user", id: "human", content: user },
			{ role: "agent", id: "soul", content: agent },
		],
		timestamp: new Date().toISOString(),
		metadata: {},
	};
}

// ── whitepaper formula golden vectors ───────────────────────────────────────

test("Klein confidence curve matches the whitepaper", () => {
	// 1 interaction → ~18%, 10 → ~53-56%, 50 → ~81-82%, never 1.0
	assert.ok(Math.abs(kleinConfidence(1) - 0.177) < 0.01);
	assert.ok(kleinConfidence(10) >= 0.52 && kleinConfidence(10) <= 0.57);
	assert.ok(kleinConfidence(50) >= 0.79 && kleinConfidence(50) <= 0.83);
	assert.ok(kleinConfidence(1_000_000) <= 0.95);
});

test("LIDA significance formula and 0.35 threshold", () => {
	const total = significanceTotal({
		novelty: 1,
		emotional_intensity: 1,
		goal_relevance: 1,
		content_richness: 1,
	});
	assert.equal(total, 1.0);
	assert.equal(SIGNIFICANCE_THRESHOLD, 0.35);
	// half-and-half sits at the formula's midpoint
	assert.ok(Math.abs(significanceTotal({ novelty: 0.5, emotional_intensity: 0.5, goal_relevance: 0.5, content_richness: 0.5 }) - 0.5) < 1e-9);
	// below-threshold example
	assert.equal(passesGate({ novelty: 0.1, emotional_intensity: 0.1, goal_relevance: 0.1, content_richness: 0.1 }), false);
	// "hello"-class input should fail the gate; "I just got promoted" should pass
	const engine = new HeuristicEngine();
	const hello = JSON.parse(engine.thinkSync(`TASK: significance\nUSER: hello\nAGENT: hi there`));
	assert.ok(significanceTotal(hello) < 0.5);
	const promoted = JSON.parse(
		engine.thinkSync(`TASK: significance\nUSER: I just got promoted to staff engineer!\nAGENT: That is fantastic news, congratulations!`),
	);
	assert.ok(significanceTotal(promoted) > significanceTotal(hello));
});

test("ACT-R: recently recalled memory outranks old important one", () => {
	const now = Date.now();
	const days = (n: number) => new Date(now - n * 86_400_000).toISOString();
	const oldImportant = makeEntry({
		type: "semantic",
		content: "An important fact about databases",
		importance: 10,
		created_at: days(30),
		access_timestamps: [days(28)],
	});
	const recalledToday = makeEntry({
		type: "semantic",
		content: "A fact about databases recalled today",
		importance: 3,
		created_at: days(14),
		access_timestamps: [days(0.1), days(0.2), days(1)],
	});
	const query = "databases fact";
	const a1 = activationOf(oldImportant, query, now);
	const a2 = activationOf(recalledToday, query, now);
	assert.ok(a2.activation > a1.activation, `recently accessed ${a2.activation} should beat old ${a1.activation}`);
	// power law: base level is a log over t^-0.5
	assert.ok(baseLevel(recalledToday, now) > baseLevel(oldImportant, now));
});

test("somatic markers: emotional boost formula", () => {
	const entry = makeEntry({
		type: "episodic",
		content: "x",
		somatic: { valence: 0.5, arousal: 0.4, label: "joy" },
	});
	const parts = activationOf(entry, "x", Date.now());
	assert.ok(Math.abs(parts.emotional - (0.4 + 0.5 * 0.3)) < 1e-9);
});

test("heuristic sentiment: word lists + arousal", () => {
	const joy = heuristicSentiment("I love this, it is amazing and wonderful!");
	assert.ok(joy.valence > 0.5);
	assert.ok(joy.arousal > 0.5);
	const anger = heuristicSentiment("This is terrible, I am so frustrated and angry.");
	assert.ok(anger.valence < -0.5);
	const neutral = heuristicSentiment("the meeting is at noon");
	assert.ok(Math.abs(neutral.valence) < 0.2);
	assert.ok(neutral.arousal < 0.2);
});

test("bond: logarithmic growth, linear decay semantics", () => {
	const bond = makeBond("Alex");
	const before = bond.bond_strength;
	bondStrengthen(bond);
	const firstGain = bond.bond_strength - before;
	for (let i = 0; i < 20; i++) bondStrengthen(bond);
	assert.ok(bond.bond_strength > before, "bond grows with interactions");
	assert.ok(bond.bond_strength <= 100);
	// diminishing returns: the 21st gain is smaller than the first
	const beforeLast = bond.bond_strength;
	bondStrengthen(bond);
	assert.ok(bond.bond_strength - beforeLast < firstGain, "growth decelerates (logarithmic)");
	// weakening is linear and sharp
	const wb = makeBond("x");
	bondWeaken(wb, 10);
	assert.equal(wb.bond_strength, 40);
	assert.equal(bondLabel(85), "close");
	assert.equal(bondLabel(5), "estranged");
});

// ── observe() pipeline ──────────────────────────────────────────────────────

test("observe: routine greeting is filtered, promotion is remembered", async () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	const routine = await soul.observe(interaction("hello", "hi there"));
	assert.equal(routine.episodic, null, "greeting should not become episodic");
	assert.equal(routine.stored, false, "nothing should be stored");

	const big = await soul.observe(
		interaction("I just got promoted to staff engineer after six months of hard work!", "That is fantastic news, congratulations!"),
	);
	assert.ok(big.significance > 0.35, `significance ${big.significance} should pass the gate`);
	assert.ok(big.episodic !== null, "promotion should become episodic");
	assert.ok(big.somatic.arousal > 0.3);
	assert.equal(big.engine_used, "heuristic");
});

test("observe: fact extraction creates semantic entries with entities", async () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	const result = await soul.observe(
		interaction("I prefer GraphQL over REST for our API. My name is Alex.", "Noted — GraphQL it is."),
	);
	assert.ok(result.facts.length > 0, "should extract at least one fact");
	const semantic = soul.store.filter({ layer: "semantic" });
	assert.ok(semantic.some((e) => /graphql/i.test(e.content)), `facts: ${semantic.map((e) => e.content).join(" | ")}`);
});

test("observe: fact conflicts use superseded_by chain", async () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	soul.remember("Human prefers GraphQL over REST", { type: "semantic", importance: 6 });
	const replacement = soul.remember("Human prefers gRPC over REST", { type: "semantic", importance: 6 });
	const old = soul.search("prefers")[0]!.entry;
	soul.supersede(old.id, "Human prefers gRPC over REST");
	assert.ok(soul.store.get(old.id)!.superseded_by !== null, "old fact must be superseded");
	assert.ok(soul.store.get(replacement.id) !== undefined);
	// superseded facts are excluded from default recall/search
	assert.ok(!soul.search("prefers").some((h) => h.entry.id === old.id));
});

test("observe: Klein self-model accumulates domain evidence", async () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	for (let i = 0; i < 5; i++) {
		await soul.observe(
			interaction(
				`Can you debug this function and review the code for the API bug? (round ${i})`,
				"Found the bug: the error handling breaks the build test.",
			),
		);
	}
	const image = soul.selfModel.self_images.technical_helper;
	assert.ok(image, "technical_helper domain should emerge");
	assert.ok(image.evidence_count >= 5, `evidence ${image.evidence_count}`);
	assert.ok(image.confidence > 0.3 && image.confidence <= 0.95);
});

test("observe: bond strengthens on positive interactions", async () => {
	const soul = Soul.birth({ name: "Aria", bondedTo: "Alex", engine: new HeuristicEngine() });
	const start = soul.config.identity.bond.bond_strength;
	await soul.observe(interaction("This is amazing, thank you so much!", "You are very welcome!"));
	assert.ok(soul.config.identity.bond.bond_strength > start);
	assert.ok(soul.config.identity.bond.interaction_count >= 1);
});

test("observe: state drifts with emotional weather", async () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	await soul.observe(interaction("This is a disaster, everything failed and I am devastated.", "I am here. Let's work through it."));
	assert.equal(soul.config.state.mood, "concerned");
	assert.ok(soul.config.state.energy < 100);
});

// ── recall ──────────────────────────────────────────────────────────────────

test("recall: buried fact resurfaces through 30 turns of noise (hard recall)", async () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	// turn 3: plant the fact
	soul.remember("Human prefers GraphQL over REST", { type: "semantic", importance: 7, entities: ["GraphQL", "REST"] });
	// 30 turns of unrelated noise
	for (let i = 0; i < 30; i++) {
		soul.remember(`Noise memory ${i}: weather talk and small talk filler`, { type: "episodic", importance: 2 });
	}
	const hits = soul.recall("what API architecture should I use for the client?", { limit: 5 });
	assert.ok(hits.length > 0);
	assert.ok(
		hits[0]!.entry.content.includes("GraphQL"),
		`top hit should be the planted fact, got: ${hits[0]!.entry.content}`,
	);
});

test("recallText + contextFor produce usable blocks", () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	soul.remember("Human prefers GraphQL over REST", { type: "semantic", importance: 7 });
	const ctx = soul.contextFor("How should I design my API?");
	assert.match(ctx, /soul memory/);
	assert.match(ctx, /GraphQL/);
	assert.match(ctx, /soul state/);
	const prompt = soul.toSystemPrompt();
	assert.match(prompt, /# Soul: Aria/);
	assert.match(prompt, /## Persona/);
	assert.match(prompt, /OCEAN/);
});

// ── forgetting ──────────────────────────────────────────────────────────────

test("forget: targeted, entity cascade, and time-based erasure", () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	soul.remember("Human's dog is called Rex", { type: "semantic", entities: ["Rex"] });
	soul.remember("Rex loves the park", { type: "semantic", entities: ["Rex"] });
	soul.remember("Unrelated fact about databases", { type: "semantic" });

	const byQuery = soul.forget("databases");
	assert.equal(byQuery.length, 1);

	const cascaded = soul.forgetEntity("Rex");
	assert.equal(cascaded.length, 2);
	assert.equal(soul.search("Rex").length, 0);
	assert.equal(soul.graph.entities.Rex, undefined);

	soul.remember("Old memory from long ago", { type: "episodic" });
	const before = soul.forgetBefore("2999-01-01T00:00:00.000Z");
	assert.ok(before.length >= 1);
	assert.equal(soul.memoryCount(), 0);
});

// ── dream / evolution / reincarnation ───────────────────────────────────────

test("dream: dedupes only near-identical facts, honors dry runs", () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	soul.remember("Duplicate fact about cats", { type: "semantic" });
	soul.remember("Duplicate fact about cats", { type: "semantic" });
	soul.remember("Unique fact about dogs", { type: "semantic" });

	// dry run reports without mutating
	const preview = soul.dream({ dryRun: true });
	assert.equal(preview.dry_run, true);
	assert.equal(preview.deduplicated_count, 1);
	assert.equal(soul.store.filter({ layer: "semantic" }).length, 3);

	// real run soft-deletes via superseded_by, keeping an audit trail
	const report = soul.dream({});
	assert.equal(report.deduplicated_count, 1);
	assert.equal(soul.store.filter({ layer: "semantic" }).length, 2);
	assert.equal(soul.store.filter({ layer: "semantic", include_superseded: true }).length, 3);
});

test("evolution: supervised mutation requires approval", () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	const { mutation, auto_applied } = soul.proposeEvolution("personality.extraversion", 0.9, "drift toward the human's energy");
	assert.equal(auto_applied, false);
	assert.equal(mutation.approved, null);
	assert.equal(soul.config.dna.personality.extraversion, 0.5);
	assert.ok(soul.approveEvolution(mutation.id));
	assert.equal(soul.config.dna.personality.extraversion, 0.9);
	// immutability: core_values-adjacent guard + unknown traits
	assert.throws(() => soul.proposeEvolution("identity.did", 1, "nope"), /Unknown|immutable/);
});

test("reincarnate: preserves memories, increments incarnation", async () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	soul.remember("Persistent fact", { type: "semantic" });
	const next = soul.reincarnate("Aria-2");
	assert.equal(next.config.identity.incarnation, 2);
	assert.equal(next.config.identity.previous_lives.length, 1);
	assert.equal(next.memoryCount(), 1);
});

test("pack/unpack preserves runtime state end-to-end", async () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	await soul.observe(interaction("I prefer TypeScript and my name is Alex.", "Good to know!"));
	const bytes = soul.pack();
	const awakened = Soul.awaken({ data: bytes });
	assert.equal(awakened.config.identity.did, soul.config.identity.did);
	assert.equal(awakened.memoryCount(), soul.memoryCount());
	assert.deepEqual(awakened.store.counts(), soul.store.counts());
});

test("engine: parseJsonLoose tolerates prose wrappers", () => {
	assert.deepEqual(parseJsonLoose('Sure! Here it is: {"a": 1} hope that helps'), { a: 1 });
	assert.deepEqual(parseJsonLoose('{"facts": [{"content": "x}y", "entities": [], "importance": 5}]}').facts?.length, 1);
	assert.throws(() => parseJsonLoose("no json here"));
});
