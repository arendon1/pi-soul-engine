/**
 * Admin/control tool surface (PLAN-TOOLS.md): the config whitelist, the
 * command↔tool parity rule, and the engine-flip regression that motivated it.
 *
 * The parity check reads source as text on purpose. `tools.ts`/`tools-admin.ts`
 * import `typebox`, a peer dependency this repo does not install, so importing
 * them here would throw ERR_MODULE_NOT_FOUND before any assertion ran.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoulBridge } from "../src/pi/bridge.ts";
import { buildConfigPatch } from "../src/pi/soul-config.ts";
import { Soul } from "../src/runtime/soul.ts";
import { HeuristicEngine } from "../src/runtime/engines/heuristic.ts";
import { entitiesPrompt } from "../src/runtime/engines/prompts.ts";

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), "pi-soul-admin-"));
}

function readSource(relative: string): string {
	return readFileSync(new URL(relative, import.meta.url), "utf8");
}

test("buildConfigPatch: only whitelisted keys reach configure()", () => {
	assert.deepEqual(buildConfigPatch({}), {});
	assert.deepEqual(buildConfigPatch({ engine: "model" }), { engine: "model" });
	// Unknown keys are dropped, not merged — the /soul-config command patches
	// blindly, so the tool path must be the stricter one.
	assert.deepEqual(buildConfigPatch({ engine: "model", bogus: 1, admin: true }), { engine: "model" });
	assert.deepEqual(buildConfigPatch({ recallLimit: 5, notAKey: true }), { recallLimit: 5 });
	// Nested budget passes through only when it carries a known field.
	assert.deepEqual(buildConfigPatch({ budget: { perMinute: 5 } }), { budget: { perMinute: 5 } });
	assert.deepEqual(buildConfigPatch({ budget: {} }), {});
	assert.deepEqual(buildConfigPatch({ budget: "nonsense" }), {});
});

test("parity: every non-visual /soul-* command maps to a registered tool", () => {
	const commands = [...readSource("../src/pi/commands.ts").matchAll(/registerCommand\("([a-z0-9-]+)"/g)].map(
		(m) => `/${m[1]}`,
	);
	const toolSource = readSource("../src/pi/tools.ts") + readSource("../src/pi/tools-admin.ts");
	const tools = new Set([...toolSource.matchAll(/name:\s*"(soul_[a-z_]+)"/g)].map((m) => m[1]!));

	assert.ok(commands.length >= 15, `command source scan found only ${commands.length} commands`);

	// `/soul` is the TUI overlay panel — the one command with no tool, by design.
	const UI_ONLY = new Set(["/soul"]);
	const MAPPING: Record<string, string | null> = {
		"/soul": null,
		"/soul-list": "soul_admin",
		"/soul-birth": "soul_admin",
		"/soul-switch": "soul_admin",
		"/soul-recall": "soul_recall",
		"/soul-remember": "soul_remember",
		"/soul-forget": "soul_forget",
		"/soul-reflect": "soul_reflect",
		"/soul-dream": "soul_admin",
		"/soul-engine": "soul_engine",
		"/soul-learning": "soul_admin",
		"/soul-evaluate": "soul_evaluate",
		"/soul-evolve": "soul_evolve",
		"/soul-approve": "soul_evolve",
		"/soul-reject": "soul_evolve",
		"/soul-export": "soul_admin",
		"/soul-import": "soul_admin",
		"/soul-config": "soul_config",
	};

	for (const command of commands) {
		assert.ok(command in MAPPING, `${command} has no parity entry — add its tool, or list it UI-only`);
		const tool = MAPPING[command];
		if (tool === null) {
			assert.ok(UI_ONLY.has(command), `${command} is exempted but is not UI-only`);
			continue;
		}
		assert.ok(tools.has(tool), `${command} maps to ${tool}, which is not registered`);
	}
	// Reverse direction: no stale mapping entries for commands that no longer exist.
	for (const command of Object.keys(MAPPING)) {
		assert.ok(commands.includes(command), `parity entry ${command} no longer matches any registered command`);
	}
});

test("admin tools: direct exposure, honest read-only annotation", () => {
	const source = readSource("../src/pi/tools-admin.ts");
	const engineBlock = source.slice(source.indexOf('name: "soul_engine"'), source.indexOf('name: "soul_config"'));
	const configBlock = source.slice(source.indexOf('name: "soul_config"'), source.indexOf('name: "soul_admin"'));

	assert.match(engineBlock, /exposure: "direct"/, "soul_engine must be direct");
	assert.match(engineBlock, /readOnlyHint: true/, "soul_engine is read-only");
	assert.match(configBlock, /readOnlyHint: false/, "soul_config mutates");
	assert.match(source, /name: "soul_admin"[\s\S]{0,600}exposure: "direct"/, "soul_admin must be direct");
});

test("engine flip rebuilds the live engine (regression for PLAN-TOOLS.md)", () => {
	const root = tmpRoot();
	try {
		const bridge = new SoulBridge(root);
		bridge.cwd = "/projects/alpha";

		const registry = {
			find: () => ({ provider: "openrouter", id: "stub" }),
			findOfType: () => ({ type: "classifier" }),
			hasConfiguredAuth: () => true,
			complete: async () => ({
				content: [{ type: "text", text: "{}" }],
				usage: { input: 0, output: 0, cost: { total: 0 } },
			}),
		};
		// Only cwd, model and modelRegistry are read while building the engine.
		bridge.bind({
			cwd: "/projects/alpha",
			model: { provider: "openrouter", id: "~deepseek/deepseek-flash-latest" },
			modelRegistry: registry,
		} as never);

		// This is exactly the sequence soul_config performs on a write.
		bridge.manager.configure({ engine: "model" });
		bridge.rebuildEngine();
		assert.equal(bridge.getEngine().name, "router", "engine=model must construct the router");
		const status = bridge.engineStatus();
		assert.ok(!("note" in status), "router status must expose a tier ladder");

		bridge.manager.configure({ engine: "heuristic" });
		bridge.rebuildEngine();
		assert.equal(bridge.getEngine().name, "heuristic", "engine=heuristic must drop to the offline engine");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pruneEntities: clears corrupted entities, keeps self-model domains", () => {
	const soul = Soul.birth({ name: "Prune", engine: new HeuristicEngine() });
	// A real domain skill must survive; the junk ones must not.
	soul.selfModel.self_images["research_aide"] = { domain: "research_aide", confidence: 0.3, evidence_count: 1 };
	soul.graph.entities = {
		What: { name: "What", entity_type: "person", relationships: [{ target: "Knob", relation: "co_occurs" }] },
		Knob: { name: "Knob", entity_type: "person", relationships: [] },
		OpenRouter: { name: "OpenRouter", entity_type: "topic", relationships: [] },
	};
	const entry = soul.remember("I read the OpenRouter docs", {
		type: "semantic",
		entities: ["What", "Knob", "OpenRouter"],
	});
	soul.skills.addXp("What", "What", 30);
	soul.skills.addXp("research_aide", "research_aide", 30);

	// Dry run must not mutate anything.
	const preview = soul.pruneEntities({ keep: ["openrouter"], dryRun: true });
	assert.ok(preview.graphRemoved.includes("What"));
	assert.ok(soul.graph.entities.What, "dry run must not delete graph nodes");
	assert.deepEqual(entry.entities, ["What", "Knob", "OpenRouter"], "dry run must not strip tags");

	const result = soul.pruneEntities({ keep: ["openrouter"] });
	assert.deepEqual(Object.keys(soul.graph.entities), ["OpenRouter"], "only the kept entity remains");
	assert.deepEqual(entry.entities, ["OpenRouter"], "memory tags edited in place");
	assert.equal(result.memoryTagsRemoved, 2);
	assert.equal(soul.skills.get("What"), undefined, "junk skill removed");
	assert.equal(soul.skills.get("research_aide")?.xp, 30, "self-model domain skill survives");
});

test("heuristic extractor: sentence-initial stopwords are not entities", () => {
	const out = JSON.parse(
		new HeuristicEngine().thinkSync(
			entitiesPrompt("Here is what I did. The engine is fast. Kubernetes and Rust are tools."),
		),
	) as { entities: Array<{ name: string; entity_type: string }> };
	const names = out.entities.map((e) => e.name);
	assert.ok(!names.includes("Here"), `stopword leaked: ${names.join(",")}`);
	assert.ok(!names.includes("The"), `stopword leaked: ${names.join(",")}`);
	assert.ok(
		names.some((n) => /Kubernetes|Rust|rust/.test(n)),
		`real entities missing: ${names.join(",")}`,
	);
});
