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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ResourcesDiscoverEvent } from "@earendil-works/pi-coding-agent";
import { SoulBridge } from "./bridge.ts";
import { registerSoulTools } from "./tools.ts";
import { registerSoulCommands } from "./commands.ts";
import { registerSoulLifecycle } from "./lifecycle.ts";
import { registerSoulRenderers } from "./renderers.ts";

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

	// Ship skills + prompt templates even when loaded as a bare extension file.
	const packageRoot = dirname(dirname(fileURLToPath(import.meta.url))); // src/pi → package root
	pi.on("resources_discover", (_event: ResourcesDiscoverEvent) => ({
		skillPaths: [join(packageRoot, "skills")],
		promptPaths: [join(packageRoot, "prompts")],
	}));

	registerSoulLifecycle(pi, bridge);
	registerSoulTools(pi, bridge);
	registerSoulCommands(pi, bridge);
	registerSoulRenderers(pi);
}
