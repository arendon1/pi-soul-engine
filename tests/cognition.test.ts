/**
 * Secondary-cognition tests: the evaluator (golden vectors), learning events,
 * skill-XP linkage, automatic evolution triggers, and dream consolidation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	Evaluator,
	heuristicEvaluate,
	scoreCompleteness,
	scoreRelevance,
	scoreHelpfulness,
	scoreSpecificity,
	scoreEmpathy,
	detectPositiveSentiment,
	interactionPair,
	DEFAULT_RUBRICS,
} from "../src/runtime/evaluation.ts";
import { applyLearning, reinforceLearning, weakenLearning, LearningRegistry } from "../src/runtime/learning.ts";
import { checkTriggers, pendingMutations, approveMutation } from "../src/runtime/evolution.ts";
import { runDream, detectTopicClusters, detectProcedures, dreamSummary } from "../src/runtime/dream.ts";
import { Soul } from "../src/runtime/soul.ts";
import { HeuristicEngine } from "../src/runtime/engines/heuristic.ts";
import { makeEntry, MemoryStore } from "../src/runtime/store.ts";
import type { Interaction, RubricResult } from "../src/spec/types.ts";

function pair(user: string, agent: string): Interaction {
	return {
		participants: [
			{ role: "user", id: "human", content: user },
			{ role: "agent", id: "soul", content: agent },
		],
		timestamp: new Date().toISOString(),
		metadata: {},
	};
}

function fakeResult(score: number, rubric = "technical_helper"): RubricResult {
	return { rubric_id: rubric, overall_score: score, criterion_results: [], learning: `Scored ${Math.round(score * 100)}%`, timestamp: new Date().toISOString() };
}

const STRONG_USER = "how do I fix the build config?";
const STRONG_AGENT =
	"To fix the build config: the TypeScript config has a mismatched target option. Fix the config in tsconfig.json, " +
	"re-run the build, then review each step and test the api again. Specifically check target and module, great.";

// ── evaluator golden vectors ────────────────────────────────────────────────

test("evaluator: completeness counts words up to 20", () => {
	assert.equal(scoreCompleteness("one two"), 2 / 20);
	assert.equal(scoreCompleteness(Array.from({ length: 20 }, () => "w").join(" ")), 1);
	assert.equal(scoreCompleteness(Array.from({ length: 40 }, () => "w").join(" ")), 1);
});

test("evaluator: relevance uses the user's tokens as denominator", () => {
	assert.equal(scoreRelevance("graphql rest", "graphql rest ipa"), 1);
	assert.equal(scoreRelevance("graphql rest", "nothing related here"), 0);
	// 2 of the 3 user tokens are echoed ("fix" vs "fixed" is not stemmed) → 2/3
	assert.ok(Math.abs(scoreRelevance("fix the build config", "the build config is fixed") - 2 / 3) < 1e-9);
});

test("evaluator: helpfulness has a positive-sentiment boost", () => {
	assert.equal(scoreHelpfulness(0.5, 0.5, false), 0.5);
	assert.equal(scoreHelpfulness(0.5, 0.5, true), 0.6);
	assert.equal(scoreHelpfulness(1, 1, true), 1, "capped at 1");
});

test("evaluator: specificity rewards concrete markers", () => {
	assert.equal(scoreSpecificity("the cat sat"), 0);
	assert.equal(scoreSpecificity("tsconfig.json"), 1);
	assert.ok(scoreSpecificity("tsconfig.json v2 API") > scoreSpecificity("please fix it"));
});

test("evaluator: empathy markers and sentiment detection", () => {
	assert.equal(scoreEmpathy("I understand and I am sorry to hear that was difficult"), 1);
	assert.equal(scoreEmpathy("here is the code"), 0.3333333333333333);
	assert.equal(scoreEmpathy("nothing emotional"), 0);
	assert.equal(detectPositiveSentiment("great excellent wonderful"), true);
	assert.equal(detectPositiveSentiment("broken and it failed"), false);
});

test("evaluator: weighted overall + learning string", () => {
	const result = heuristicEvaluate(pair(STRONG_USER, STRONG_AGENT), DEFAULT_RUBRICS.technical_helper!);
	assert.ok(result.overall_score > 0.7 && result.overall_score <= 1, `score ${result.overall_score}`);
	assert.match(result.learning, /Strongest: .* Weakest: ./);
	assert.equal(result.rubric_id, "technical_helper");
	assert.equal(result.criterion_results.length, 4, "3 defaults + specificity");
});

test("evaluator: domain stats, streaks, and triggers", () => {
	const ev = new Evaluator();
	for (let i = 0; i < 5; i++) ev.history.push(fakeResult(0.7));
	const stats = ev.getDomainStats("technical_helper");
	assert.equal(stats.count, 5);
	assert.equal(stats.streak, 5);
	const triggers = ev.checkEvolutionTriggers();
	assert.equal(triggers.length, 1);
	assert.equal(triggers[0]!.trigger, "high_performance_streak");
	assert.match(triggers[0]!.reason, /Consistently high performance/);

	// a break in the streak resets it
	const ev2 = new Evaluator();
	ev2.history.push(fakeResult(0.7), fakeResult(0.2), fakeResult(0.7));
	assert.equal(ev2.getDomainStats("technical_helper").streak, 1);
	assert.equal(ev2.checkEvolutionTriggers().length, 0);

	// below-threshold average does not trigger even with a streak
	const ev3 = new Evaluator();
	for (let i = 0; i < 6; i++) ev3.history.push(fakeResult(0.5));
	assert.equal(ev3.checkEvolutionTriggers().length, 0);
});

test("evaluator: learning events only for notable scores", () => {
	const ev = new Evaluator();
	const high = ev.createLearningEvent(fakeResult(0.9));
	assert.ok(high);
	assert.match(high!.lesson, /^Success pattern:/);
	assert.ok(Math.abs(high!.confidence - 0.75) < 1e-9);

	const low = ev.createLearningEvent(fakeResult(0.1));
	assert.ok(low);
	assert.match(low!.lesson, /^Failure pattern:/);
	assert.equal(low!.confidence, 1);

	assert.equal(ev.createLearningEvent(fakeResult(0.6)), null, "mid-range yields no lesson");
});

test("learning: confidence reinforcement and decay", () => {
	const ev = new Evaluator();
	const event = ev.createLearningEvent(fakeResult(0.9))!;
	assert.equal(event.applied_count, 0);
	applyLearning(event);
	assert.equal(event.applied_count, 1);
	reinforceLearning(event, 0.5);
	assert.equal(event.confidence, 1, "capped at 1");
	weakenLearning(event, 2);
	assert.equal(event.confidence, 0, "floored at 0");

	const registry = new LearningRegistry([event]);
	assert.equal(registry.top(1).length, 1);
	assert.ok(registry.reinforce(event.id));
	assert.equal(registry.weaken("missing"), false);
});

// ── soul wiring ─────────────────────────────────────────────────────────────

test("soul.evaluate: stores learning as procedural memory and grants weighted XP", () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	const before = soul.store.filter({ layer: "procedural" }).length;
	const result = soul.evaluate(pair(STRONG_USER, STRONG_AGENT), "technical_helper");
	assert.ok(result.overall_score > 0.7);
	assert.equal(soul.store.filter({ layer: "procedural" }).length, before + 1);
	const expectedXp = Math.floor(20 * (0.5 + result.overall_score));
	assert.equal(soul.skills.get("technical_helper")?.xp, expectedXp);
	assert.ok(soul.trust.audit("evaluation").length >= 1, "evaluation is journaled");
});

test("soul.learn: distils a lesson for notable scores, nothing mid-range", () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });

	const strong = soul.learn(pair(STRONG_USER, STRONG_AGENT), "technical_helper");
	if (strong.event) {
		assert.match(strong.event.lesson, /pattern/);
		assert.equal(soul.learningEvents.length, 1);
		assert.ok(soul.trust.audit("learning.event").length >= 1);
	}

	const weak = soul.learn(pair("plan the entire migration thoroughly", "ok"), "technical_helper");
	assert.equal(weak.event?.lesson.startsWith("Failure pattern"), true);
	assert.ok(soul.learningEvents.length >= 1);

	const mid = soul.learn(pair("what is the weather", "Sunny with a light breeze in the afternoon, about twenty degrees."), "technical_helper");
	if (mid.event === null) assert.ok(mid.result.overall_score > 0.3 && mid.result.overall_score < 0.8);
});

test("observe: automatic evolution proposes once, then stops", async () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	const agent =
		"The build fails because the TypeScript config has a mismatched target option in tsconfig.json. " +
		"Fix the config and re-run npm run build, then test the api again.";
	const last = [];
	for (let i = 0; i < 6; i++) last.push(await soul.observe(pair("why is the build failing in the api config?", agent)));
	assert.equal(soul.pendingEvolutions().length, 1, "exactly one proposal despite six observations");
	assert.equal(soul.pendingEvolutions()[0]!.trait, "communication.warmth");
	assert.ok(soul.trust.audit("evolution.propose").length >= 1);

	// further observations must not pile up duplicates
	await soul.observe(pair("why is the build failing in the api config?", agent));
	assert.equal(soul.pendingEvolutions().length, 1);

	const proposal = soul.pendingEvolutions()[0]!;
	assert.ok(approveMutation(soul.config, proposal.id));
	assert.equal(soul.config.dna.communication.warmth, "high");
});

test("observe: entities earn significance-weighted skill XP", async () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	await soul.observe(pair("Tell me about Kubernetes and Rust deploys", "Kubernetes orchestrates containers; Rust is a systems language."));
	assert.ok(soul.skills.list().length > 0, `skills: ${soul.skills.list().map((s) => s.name).join(",")}`);
});

test("evolution: string traits validate and mutate", () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	const { mutation } = soul.proposeEvolution("communication.verbosity", "verbose", "user prefers detail");
	assert.equal(mutation.new_value, "verbose");
	assert.ok(soul.approveEvolution(mutation.id));
	assert.equal(soul.config.dna.communication.verbosity, "verbose");
	assert.throws(() => soul.proposeEvolution("communication.verbosity", "shouty", "invalid"), /Invalid value/);
	assert.throws(() => soul.proposeEvolution("identity.did", 1, "immutable"), /Unknown/);
});

// ── dream ───────────────────────────────────────────────────────────────────

test("dream: topic clusters need 3+ similar episodes", () => {
	const store = new MemoryStore();
	for (let i = 0; i < 4; i++) {
		store.store("episodic", makeEntry({ type: "episodic", content: "Human: the deploy pipeline broke\nMe: check the build config and rerun the deploy" }));
	}
	store.store("episodic", makeEntry({ type: "episodic", content: "Human: unrelated chat about cats\nMe: cats are lovely" }));
	const clusters = detectTopicClusters(store.filter({ layer: "episodic" }));
	assert.equal(clusters.length, 1);
	assert.equal(clusters[0]!.episode_count, 4);
});

test("dream: detects recurring procedures and synthesizes them", () => {
	const store = new MemoryStore();
	for (let i = 0; i < 4; i++) {
		store.store("episodic", makeEntry({ type: "episodic", content: "Human: deploy failed\nMe: check the config then run the test suite and review the logs" }));
	}
	const detected = detectProcedures(store.filter({ layer: "episodic" }));
	assert.equal(detected.length, 1);
	assert.ok(detected[0]!.frequency >= 3);
	assert.ok(detected[0]!.confidence >= 0.3);

	const report = runDream({ store, graph: { entities: {} }, archival: [] }, {});
	assert.equal(report.procedures_created, 1);
	const procedures = store.filter({ layer: "procedural" });
	assert.equal(procedures.length, 1);
	assert.match(procedures[0]!.content, /^\[dream\] Recurring pattern/);

	// second run is idempotent (dedup by relevance)
	const second = runDream({ store, graph: { entities: {} }, archival: [] }, {});
	assert.equal(second.procedures_created, 0);
});

test("dream: archives stale episodes without losing them", () => {
	const store = new MemoryStore();
	const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
	for (let i = 0; i < 3; i++) {
		store.store("episodic", makeEntry({ type: "episodic", content: `old low-value detail ${i}`, importance: 2, created_at: old }));
	}
	store.store("episodic", makeEntry({ type: "episodic", content: "recent important thing", importance: 9 }));
	const archival: import("../src/spec/types.ts").ArchivalRecord[] = [];

	const preview = runDream({ store, graph: { entities: {} }, archival }, { dryRun: true });
	assert.equal(preview.archived_count, 3, "dry run counts without mutating");
	assert.equal(store.filter({ layer: "episodic" }).length, 4);
	assert.equal(archival.length, 0);

	const report = runDream({ store, graph: { entities: {} }, archival }, {});
	assert.equal(report.archived_count, 3);
	assert.equal(store.filter({ layer: "episodic" }).length, 1, "only the recent entry stays");
	assert.equal(archival.length, 1);
	assert.equal(archival[0]!.count, 3);
	assert.match(dreamSummary(report), /archived/);
});

test("dream: dedupes semantic facts via superseded_by and consolidates the graph", () => {
	const store = new MemoryStore();
	store.store("semantic", makeEntry({ type: "semantic", content: "Human prefers GraphQL over REST" }));
	store.store("semantic", makeEntry({ type: "semantic", content: "Human prefers GraphQL over REST" }));
	const graph = {
		entities: {
			Rust: {
				name: "Rust",
				entity_type: "topic",
				relationships: [
					{ target: "api", relation: "used_for" },
					{ target: "api", relation: "used_for" },
				],
			},
			rust: { name: "rust", entity_type: "topic", relationships: [{ target: "api", relation: "used_for" }] },
		},
	};
	const report = runDream({ store, graph, archival: [] }, {});
	assert.equal(report.deduplicated_count, 1);
	assert.equal(store.filter({ layer: "semantic" }).length, 1);
	assert.equal(store.filter({ layer: "semantic", include_superseded: true }).length, 2);
	// "Rust" and "rust" merge; the merge absorbs the incoming duplicate edge,
	// and the pre-existing duplicate edge on the survivor is pruned.
	assert.equal(report.graph_consolidation.merged_entities.length, 1);
	assert.equal(report.graph_consolidation.pruned_edges, 1);
	assert.equal(Object.keys(graph.entities).length, 1);
});

// ── persistence ─────────────────────────────────────────────────────────────

test("learning events and evaluation history travel in the .soul file", () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	soul.learn(pair(STRONG_USER, STRONG_AGENT), "technical_helper");
	soul.learn(pair("plan the migration carefully with steps", "ok"), "technical_helper");
	assert.ok(soul.learningEvents.length >= 1);

	const back = Soul.awaken({ data: soul.pack() });
	assert.equal(back.learningEvents.length, soul.learningEvents.length);
	assert.equal(back.evaluator.history.length, soul.evaluator.history.length);
	assert.equal(back.learningEvents[0]!.lesson, soul.learningEvents[0]!.lesson);

	// evaluation history is what makes triggers survive a restart
	back.evaluator.history.push(...Array.from({ length: 5 }, () => fakeResult(0.7)));
	assert.equal(back.evaluator.checkEvolutionTriggers().length, 1);
});

test("dream: evolution insights require enough episodes", () => {
	const ctx = { store: new MemoryStore(), graph: { entities: {} }, archival: [] };
	// fewer than 10 episodes → no insights (upstream guard)
	for (let i = 0; i < 5; i++) {
		ctx.store.store("episodic", makeEntry({ type: "episodic", content: `episode ${i} about planning steps` }));
	}
	const few = runDream(ctx, { detectPatterns: true });
	assert.equal(few.evolution_insights.length, 0);

	// many diverse, planning-heavy episodes → conscientiousness insight
	const big = { store: new MemoryStore(), graph: { entities: {} }, archival: [] };
	for (let i = 0; i < 14; i++) {
		big.store.store(
			"episodic",
			makeEntry({
				type: "episodic",
				content: `topic${i} plan: first review the step, then organize the schedule and test it`,
			}),
		);
	}
	const report = runDream(big, {});
	assert.ok(report.evolution_insights.some((i) => i.trait === "personality.conscientiousness"));
});
