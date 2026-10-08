/**
 * Soul configuration patching — pure, dependency-free.
 *
 * Kept out of `tools-admin.ts` (which imports `typebox`, a peer dependency the
 * repo deliberately does not install) so the whitelist logic is unit-testable
 * without a pi runtime. `tools-admin.ts` owns the TypeBox schema; this module
 * owns the rule that only whitelisted keys ever reach `SoulManager.configure()`.
 */

/** Top-level config keys the tool is allowed to write. */
export const CONFIG_KEYS = [
	"engine",
	"sessionModel",
	"classifierModel",
	"analysisModel",
	"reflectModel",
	"factsMode",
	"rubricScoring",
	"confidenceFloor",
	"cache",
	"recallLimit",
	"promptBudget",
	"reflectEvery",
	"notifications",
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

/**
 * Build the patch from whitelisted keys only. Unknown keys are dropped by
 * construction rather than by validator behaviour, so this is safe even if a
 * caller bypasses pi's argument validation (the `/soul-config` command merges
 * blindly; this must be stricter).
 */
export function buildConfigPatch(params: Record<string, unknown>): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const key of CONFIG_KEYS) {
		if (params[key] !== undefined) patch[key] = params[key];
	}
	const budget = params.budget;
	if (budget && typeof budget === "object") {
		const b = budget as { perMinute?: number; perSession?: number };
		if (b.perMinute !== undefined || b.perSession !== undefined) patch.budget = budget;
	}
	return patch;
}
