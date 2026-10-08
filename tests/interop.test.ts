/**
 * Interop / offline conformance tests.
 *
 * These tests require no installed dependencies. They verify that:
 *   - the upstream Soul Protocol JSON Schemas are vendored verbatim and intact;
 *   - a soul built by this implementation round-trips through pack/unpack;
 *   - the .soul archive layout matches SOUL-FORMAT-SPEC;
 *   - (optional) the payload conforms to the vendored schemas when `ajv` is
 *     installed — skipped cleanly otherwise;
 *   - (optional) the upstream Python runtime can read a soul we wrote — skipped
 *     cleanly when python3 or `soul_protocol` is unavailable.
 *
 * Schema resolution mirrors tests/spec.test.ts so both files agree:
 *   1. SOUL_SCHEMAS_DIR (explicit override)
 *   2. vendor/soul-protocol/schemas (vendored default; always present in-repo)
 *   3. a sibling upstream checkout under $HOME/soul-work/soul-protocol
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Soul } from "../src/runtime/soul.ts";
import { packSoul, unpackSoul } from "../src/spec/soul-file.ts";
import { zipRead } from "../src/spec/zip.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDORED_SCHEMAS = join(HERE, "..", "vendor", "soul-protocol", "schemas");

/** Same resolution order as tests/spec.test.ts (kept in sync deliberately). */
function findSchemasDir(): string | null {
	const candidates = [
		process.env.SOUL_SCHEMAS_DIR,
		VENDORED_SCHEMAS,
		join(process.env.HOME ?? "", "soul-work", "soul-protocol", "schemas"),
	].filter((candidate): candidate is string => Boolean(candidate));
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const SCHEMAS_DIR = findSchemasDir();

const EXPECTED_SCHEMAS = [
	"SoulConfig.schema.json",
	"MemoryEntry.schema.json",
	"SoulManifest.schema.json",
	"SoulState.schema.json",
];

/** Deterministic soul used across the round-trip and layout checks. */
function buildSoul(): Soul {
	const soul = Soul.birth({
		name: "Interop",
		archetype: "The Tester",
		values: ["clarity", "portability"],
		bondedTo: "Tester",
	});
	soul.remember("Offline interop must be deterministic.", {
		type: "episodic",
		importance: 7,
		emotion: "focused",
		entities: ["interop"],
	});
	soul.remember("Soul Protocol schemas are vendored verbatim.", {
		type: "semantic",
		importance: 6,
	});
	return soul;
}

function countMemories(doc: ReturnType<typeof unpackSoul>): number {
	return Object.values(doc.memories).reduce((total, list) => total + list.length, 0);
}

test("interop: vendored schema directory exists", () => {
	// Deliberately NOT a skip: vendor/ is part of this package (committed and
	// listed in package.json "files"), so its absence means a broken checkout or
	// archive. The failure message says how to restore it.
	assert.ok(
		existsSync(VENDORED_SCHEMAS),
		`missing vendored schemas at ${VENDORED_SCHEMAS} — re-sync them (see the re-syncing section in vendor/soul-protocol/ATTRIBUTION.md) or set SOUL_SCHEMAS_DIR`,
	);
});

test("interop: expected schema files are present and valid JSON", () => {
	if (!SCHEMAS_DIR) {
		console.log("skipped: no schema directory found (set SOUL_SCHEMAS_DIR or vendor the schemas)");
		return;
	}
	for (const name of EXPECTED_SCHEMAS) {
		const path = join(SCHEMAS_DIR, name);
		assert.ok(existsSync(path), `missing schema ${name}`);
		const schema = JSON.parse(readFileSync(path, "utf8")) as { type?: unknown; properties?: unknown };
		assert.equal(typeof schema.type, "string", `${name} must declare a type`);
		if (schema.type === "object") {
			assert.equal(typeof schema.properties, "object", `${name} must declare a properties block`);
			assert.ok(schema.properties !== null, `${name} properties must not be null`);
		}
	}
});

test("interop: a soul we produce round-trips through pack/unpack", () => {
	const soul = buildSoul();
	const bytes = soul.pack();
	const doc = unpackSoul(bytes);

	assert.equal(doc.config.identity.did, soul.config.identity.did);
	assert.equal(doc.config.identity.name, "Interop");
	assert.equal(countMemories(doc), soul.memoryCount());
	assert.equal(doc.memories.episodic.length, 1);
	assert.equal(doc.memories.semantic.length, 1);

	const manifest = JSON.parse(zipRead(bytes).get("manifest.json")!.toString("utf8")) as {
		format_version?: string;
		soul_id?: string;
		stats?: { total_memories?: number };
	};
	assert.equal(manifest.format_version, "1.0.0");
	assert.equal(manifest.soul_id, soul.config.identity.did);
	assert.equal(manifest.stats?.total_memories, soul.memoryCount());
});

test("interop: archive layout matches SOUL-FORMAT-SPEC", () => {
	const soul = buildSoul();
	const zip = zipRead(packSoul(soul.toDocument()));
	for (const name of ["manifest.json", "soul.json", "state.json", "dna.md", "memory/core.json"]) {
		assert.ok(zip.has(name), `archive is missing ${name}`);
	}
});

test("interop: vendored schema conformance (ajv, optional)", async () => {
	if (!SCHEMAS_DIR) {
		console.log("skipped: no schema directory found (set SOUL_SCHEMAS_DIR or vendor the schemas)");
		return;
	}
	// ajv is a devDependency: the rest of the suite is dependency-free, so a
	// missing install downgrades this check instead of failing the run.
	let Ajv: new (options: Record<string, unknown>) => {
		compile(schema: unknown): ((data: unknown) => boolean) & { errors?: unknown };
	};
	try {
		({ default: Ajv } = (await import("ajv")) as never);
	} catch {
		console.log("skipped: ajv not installed (run `npm install` for schema conformance)");
		return;
	}
	const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
	const load = (name: string) => JSON.parse(readFileSync(join(SCHEMAS_DIR, name), "utf8"));

	const soul = buildSoul();
	const zip = zipRead(soul.pack());

	// soul.json ↔ SoulConfig.schema.json
	const validateConfig = ajv.compile(load("SoulConfig.schema.json"));
	assert.ok(validateConfig(JSON.parse(zip.get("soul.json")!.toString("utf8"))), JSON.stringify(validateConfig.errors));

	// each episodic entry ↔ MemoryEntry.schema.json
	const validateEntry = ajv.compile(load("MemoryEntry.schema.json"));
	for (const entry of soul.toDocument().memories.episodic) {
		assert.ok(validateEntry(entry), JSON.stringify(validateEntry.errors));
	}
});

test("interop: upstream Python runtime reads a soul we wrote (optional)", () => {
	const probe = spawnSync("python3", ["-c", "import soul_protocol"], { encoding: "utf8", timeout: 15000 });
	if (probe.error || probe.status !== 0) {
		console.log("skipped: python3 or soul_protocol not available (cross-runtime check)");
		return;
	}
	const dir = mkdtempSync(join(tmpdir(), "soul-interop-"));
	try {
		const file = join(dir, "interop.soul");
		writeFileSync(file, buildSoul().pack());
		const run = spawnSync("python3", ["-m", "soul_protocol.cli.main", "inspect", file], {
			encoding: "utf8",
			timeout: 15000,
		});
		assert.equal(
			run.status,
			0,
			`soul inspect failed (exit ${run.status ?? "null"}): ${run.stderr || run.error?.message || ""}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
