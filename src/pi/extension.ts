/**
 * pi-soul — Soul Protocol for Pi.
 *
 * A portable AI identity, memory, cognition, and emotion layer, natively
 * integrated: prompt-section injection, observe() on every exchange, ACT-R
 * recall at prompt time, model-callable tools, /soul commands, and a portable
 * .soul file format (interoperable with the reference Python runtime).
 *
 * Load: `pi install ./pi-soul` (or `pi --extension src/pi/extension.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ResourcesDiscoverEvent } from "@earendil-works/pi-coding-agent";
import { SoulBridge } from "./bridge.ts";
import { registerSoulTools } from "./tools.ts";
import { registerSoulCommands } from "./commands.ts";
import { registerSoulLifecycle } from "./lifecycle.ts";
import { registerSoulRenderers } from "./renderers.ts";

/** Walk up from `start` until a directory containing `package.json` is found. */
function findPackageRoot(start: string): string | undefined {
	let dir = start;
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/** Resolve to the nearest package root containing `pi-soul-engine` in package.json. */
function resolveSoulPackageRoot(): string | undefined {
	const start = dirname(fileURLToPath(import.meta.url));
	const candidates = [findPackageRoot(start), findPackageRoot(process.cwd())];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf-8")) as { name?: string };
			if (pkg.name === "pi-soul-engine") return candidate;
		} catch {
			// ignore unreadable / unparseable package.json
		}
	}
	return undefined;
}

export default function soulExtension(pi: ExtensionAPI): void {
	const bridge = new SoulBridge(process.env.PI_SOUL_DIR || undefined);
	bridge.attachApi(pi);
	if (process.env.PI_SOUL_USER) bridge.userId = process.env.PI_SOUL_USER;
	if (process.env.PI_SOUL_MODEL) bridge.manager.configure({ engine: "model", sessionModel: process.env.PI_SOUL_MODEL });
	if (process.env.PI_SOUL_CLASSIFIER) bridge.manager.configure({ classifierModel: process.env.PI_SOUL_CLASSIFIER });
	if (process.env.PI_SOUL_ANALYSIS_MODEL) bridge.manager.configure({ analysisModel: process.env.PI_SOUL_ANALYSIS_MODEL });
	if (process.env.PI_SOUL_REFLECT_MODEL) bridge.manager.configure({ reflectModel: process.env.PI_SOUL_REFLECT_MODEL });
	if (process.env.PI_SOUL_ENGINE === "heuristic") bridge.manager.configure({ engine: "heuristic" });
	if (process.env.PI_SOUL_FACTS === "heuristic") bridge.manager.configure({ factsMode: "heuristic" });
	if (process.env.PI_SOUL_REFLECT_EVERY) bridge.manager.configure({ reflectEvery: Number(process.env.PI_SOUL_REFLECT_EVERY) });

	// Ship bundled skills dynamically so they resolve whether the package is loaded
	// as a Pi install (the typical path) or as a bare extension file for trial
	// (`pi --extension src/pi/extension.ts`). Resolve to the nearest pi-soul-engine
	// package root so this is robust to running from a source checkout, a deployed
	// install, or a parent cwd that happens to contain pi-soul.
	//
	// Prompt templates are intentionally NOT returned from this handler. They are
	// declared once in package.json#pi.prompts as the single source of truth. If
	// we also returned the prompts directory here, the static loader (which lists
	// the .md files) and the runtime scan (which walks the directory) would each
	// load the same files, and dedupePrompts would emit a "name X collision"
	// warning for every template. (A bare-extension load therefore does not have
	// prompt templates — the documented install path is `pi install`.)
	const packageRoot = resolveSoulPackageRoot();
	if (packageRoot) {
		pi.on("resources_discover", (_event: ResourcesDiscoverEvent) => ({
			skillPaths: [join(packageRoot, "skills")],
		}));
	}

	registerSoulLifecycle(pi, bridge);
	registerSoulTools(pi, bridge);
	registerSoulCommands(pi, bridge);
	registerSoulRenderers(pi);
}
