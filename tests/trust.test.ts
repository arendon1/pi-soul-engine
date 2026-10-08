/**
 * Trust chain tests: signing, verification, tamper detection, portability.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TrustChainManager } from "../src/runtime/trust.ts";
import { Soul } from "../src/runtime/soul.ts";
import { HeuristicEngine } from "../src/runtime/engines/heuristic.ts";

test("trust: signed entries verify as a chain", () => {
	const trust = new TrustChainManager();
	trust.append("memory.write", { id: "m1", content: "fact" });
	trust.append("memory.forget", { mode: "query", query: "fact", removed: ["m1"] });
	trust.append("bond.strengthen", { amount: 3 });

	const result = trust.verifyChain();
	assert.equal(result.ok, true);
	assert.equal(result.checked, 3);
	assert.equal(trust.audit("memory.").length, 2);
	assert.equal(trust.audit().length, 3);
});

test("trust: tampering breaks verification", () => {
	const trust = new TrustChainManager();
	trust.append("memory.write", { id: "m1" });
	trust.append("memory.write", { id: "m2" });
	const file = trust.toJSON();

	// forge the payload of entry 1 after the fact
	file.entries[1]!.payload = JSON.stringify({ id: "m2", content: "forged" });
	const forged = new TrustChainManager(file, file.private_key);
	const result = forged.verifyChain();
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /hash mismatch/);
});

test("trust: signature forgery is detected", () => {
	const trust = new TrustChainManager();
	trust.append("memory.write", { id: "m1" });
	const file = trust.toJSON();
	// replace signature bytes
	file.entries[0]!.signature = Buffer.alloc(64, 7).toString("base64");
	const forged = new TrustChainManager(file, file.private_key);
	assert.equal(forged.verifyChain().ok, false);
});

test("trust: chain travels with the soul and stays verifiable after export", () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	soul.remember("Human prefers GraphQL over REST", { type: "semantic" });
	soul.remember("Human prefers gRPC over REST", { type: "semantic" });
	soul.strengthenBond(2);
	assert.ok(soul.trust.verifyChain().ok);
	assert.ok(soul.trust.audit("memory.write").length >= 2);

	// export WITHOUT keys: chain verifies but cannot grow
	const bytes = soul.pack();
	const imported = Soul.awaken({ data: bytes });
	assert.ok(imported.trust.verifyChain().ok, "imported chain still verifies");
	assert.throws(() => imported.trust.append("memory.write", { id: "x" }), /read-only/);

	// export WITH keys: fully functional lineage
	const withKeys = Soul.awaken({ data: soul.pack(undefined, true) });
	assert.ok(withKeys.trust.verifyChain().ok);
	withKeys.remember("New fact", { type: "semantic" });
	assert.ok(withKeys.trust.verifyChain().ok, "chain grows and stays valid");
});

test("trust: forget and evolve actions are journaled", () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	soul.remember("secret fact about zebras", { type: "semantic" });
	soul.forget("zebras");
	const { mutation } = soul.proposeEvolution("personality.openness", 0.9, "growing");
	soul.approveEvolution(mutation.id);

	const actions = soul.trust.audit().map((e) => e.action);
	assert.ok(actions.includes("memory.write"));
	assert.ok(actions.includes("memory.forget"));
	assert.ok(actions.includes("evolution.propose"));
	assert.ok(actions.includes("evolution.apply"));
	assert.ok(soul.trust.verifyChain().ok);
});

test("trust: observe pipeline writes are journaled too", async () => {
	const soul = Soul.birth({ name: "Aria", engine: new HeuristicEngine() });
	await soul.observe({
		participants: [
			{ role: "user", id: "h", content: "I just got promoted and I prefer GraphQL over REST!" },
			{ role: "agent", id: "s", content: "Congratulations! Noted about GraphQL." },
		],
		timestamp: new Date().toISOString(),
		metadata: {},
	});
	const actions = soul.trust.audit().map((e) => e.action);
	assert.ok(actions.includes("memory.write"), `journaled: ${actions.join(",")}`);
	assert.ok(actions.includes("bond.strengthen"));
	assert.ok(soul.trust.verifyChain().ok);
});
