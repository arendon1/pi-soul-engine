# Changelog

All notable changes to `pi-soul-engine`. This project targets `.soul` format
version **1.0.0** (upstream Soul Protocol).

## [Unreleased]

### Added — model-facing control surface (PLAN-TOOLS.md)
- `soul_engine` (direct, read-only): cognitive-engine telemetry — active tiers,
  degradation, circuit breakers, budget, cache, token usage/cost, audit status.
- `soul_config` (direct): read or change runtime configuration. Writes go through
  `SoulManager.configure()` → `CognitiveRouter` rebuild atomically and report the
  resulting tier ladder, so a config change can no longer be written to disk
  without taking effect in the running engine. Unknown keys are rejected (the
  `/soul-config` command still merges blindly); changes are journaled as
  `soul:config` transcript entries; a requested-but-unresolved model tier is
  reported as a warning instead of a silent success.
- `soul_admin` (direct): `dream`, `learning`, `evaluation`, `list`, `switch`,
  `birth`, `export`, `import`, `engine_reset`, `prune_entities` (with `keep` and
  `dry_run`). Import backs up the soul it replaces; birth refuses an existing name.
- Command↔tool parity is enforced by `tests/admin-tools.test.ts`: every `/soul-*`
  command except the `/soul` overlay must map to a registered tool.

### Changed
- Config whitelist extracted to `src/pi/soul-config.ts` (dependency-free, unit
  tested) and the namespace/result helpers to `src/pi/tool-support.ts`, so
  `tools.ts` and `tools-admin.ts` share one definition instead of drifting.
- `soulSlug` is exported from `soul-manager.ts` for name normalisation by tools.

### Fixed — entity corruption in early souls
- Heuristic entity extraction no longer treats sentence-initial or common English
  words as entities, skips spans under three characters, and no longer matches
  across newlines (which had produced a graph node literally named
  `Projects\nDone`). The capitalized-word heuristic is a fallback; the model tiers
  do this properly.
- Entity-derived skill XP is awarded only for non-person entities, so `What` and
  `Here` no longer become "competencies".
- `Soul.pruneEntities({ keep, dryRun })` and `SkillRegistry.remove()` remediate
  souls already corrupted by the two bugs above. Exposed as
  `soul_admin { action: "prune_entities" }`; self-model domains always survive, so
  `research_aide` is kept while `Knob` is removed.

## [0.2.0] — 2026-10-08

First packaged release: the full Soul Protocol implementation plus a tiered,
resilient cognitive engine, published as an installable Pi package.

### Added — protocol and runtime
- `.soul` archive and directory codec (format 1.0.0): `manifest.json`,
  `soul.json`, `state.json`, `dna.md`, `memory/*`, with tolerant reading of the
  minimal `identity.json` variant.
- AES-256-GCM encryption with scrypt (n=2^17, r=8, p=1), byte-compatible
  envelope (`salt || nonce || ciphertext+tag`) and `.enc` entries with
  `manifest.encrypted`, matching the upstream runtime.
- TypeBox schemas mirroring the upstream JSON Schemas; conformance verified
  against them.
- `observe()` psychology pipeline: somatic markers, LIDA significance gate
  (0.35), episodic storage, semantic fact extraction with `superseded_by`
  conflict chains, temporal knowledge graph, Klein self-model, bond, state.
- ACT-R activation recall (power-law base level, spreading activation, emotional
  boost) with personality modulation.
- Evaluator: 10 rubrics, heuristic scorers, domain statistics, streak detection.
- Learning events: lesson distillation for notable scores, lifecycle
  (`apply`/`reinforce`/`weaken`), persisted **inside** the `.soul` file.
- `dream()` consolidation: topic clusters, procedure detection, behavioural
  trends, archival, semantic dedup, graph consolidation, `[dream]` procedure
  synthesis, evolution insights, dry-run mode.
- Evolution with automatic triggers (high-performance streaks → proposed
  communication-style mutation) and both numeric and enum traits.
- Ed25519 trust chain journaling every write, forget, supersede, mutation and
  bond change; exports verify without the signing key.

### Added — cognitive engine
- `CognitiveRouter`: per-task tier ladder
  (classifier → analysis → reasoning → session → heuristic).
- `AnalysisService`: one batched classifier request per exchange (8–13 typed
  `choice`/`score` questions) plus one chat call for facts/entities, replacing
  2–5 per-task model calls.
- Hybrid rubric scoring: the classifier is asked only for the criteria
  heuristics are weak at (specificity, empathy, originality, clarity).
- Resilience: failure classification, per-tier deadlines, a single jittered
  retry for transient failures, model and provider circuit breakers, session
  degradation, per-minute/per-session budgets, content-hash cache, per-field
  heuristic fallback, usage/cost capture.
- Deferral instead of fabrication: an aborted observation keeps its journal
  entry for the next session and commits with heuristics after three attempts.
- Input bounding (`maxInputChars`) so a pasted megabyte cannot stall the queue.

### Added — Pi integration
- Lifecycle wiring: `session_start`, `before_agent_start` (recall injection),
  `agent_end` (observe), `agent_before_settle` (reflection),
  `session_before_compact` (distillation), `session_shutdown`.
- 11 model-facing tools, 18 `/soul*` commands, 2 skills, 3 prompt templates.
- Detached worker child process owning persistence and heavy crypto, so the
  agent loop is never blocked; pending-observation journal for crash safety.
- `scripts/deploy.sh`: one-way, idempotent sync from this source repository into
  a deployment directory (dry run by default, `--apply` to write).
- Non-intrusive notifications: transcript entries with renderers plus rare,
  configurable toasts.

### Verification
- 114 tests: spec and codec round-trips, upstream schema conformance and
  cross-runtime interop, psychology golden vectors, evaluator/learning/dream,
  resilience failure classes, performance guards, Pi-layer behaviour.
- Test suite requires **no dependencies**; `ajv` (optional) enables full schema
  conformance.
- Measured (phone): 1290 observe ops/s, 1218× cache-hit speedup, open-breaker
  path 13 ms per 1000 calls, observe kickoff 0.4 ms, 1 MB input bounded to
  ~1200 tokens.

### Notes
- Independent implementation, not a fork. Upstream:
  `github.com/qbtrix/soul-protocol` @ `b6ab6ee` (MIT, OCEAN Foundation).
- Deliberate divergences from the reference runtime are listed in `NOTICE`.
