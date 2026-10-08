# pi-soul-engine

An independent TypeScript implementation of the [Soul Protocol](https://soul.qbtrix.com/whitepaper.html)
(upstream: [github.com/qbtrix/soul-protocol](https://github.com/qbtrix/soul-protocol)) packaged as a
Pi extension. A soul is a portable `.soul` file (ZIP + JSON, format 1.0.0, AES-256-GCM capable) holding
identity, five-tier memory, an `observe()` psychology pipeline, and a tiered cognitive engine that routes
each task to the cheapest adequate model. It interoperates with the upstream Python runtime.

**Why.** Most memory systems are command-driven: the user or agent must explicitly call "remember" and
"recall". This one is behaviour-driven. The extension hooks Pi's agent loop so memory forms as a
by-product of normal conversation — recall is injected before every prompt, exchanges are observed after
every reply, and consolidation happens around compaction. Nothing needs to be asked for.

## Requirements

- **Node ≥ 22.6** — the detached worker is spawned as a plain `node` process running TypeScript via
  type stripping (verified on Node 26.4.0).
- A **Pi** install with extension support (`pi --extension`, `pi install`).
- Optional **provider credentials** for the model tiers (see [Configuration](#configuration)). The
  default tiers use `openrouter` models and therefore `OPENROUTER_API_KEY` or `/login`. No credentials
  are required: `engine=heuristic` and the tier ladder's heuristic floor run fully offline.

## Install

```bash
# 1. Local directory (Pi follows its package discovery rules and reads the `pi` manifest)
pi install /path/to/pi-soul-engine

# 2. From git (replace <owner> and <ref> when published)
pi install git:github.com/<owner>/pi-soul-engine@<ref>

# 3. One-off trial, no settings change (verified working)
pi -e /path/to/pi-soul-engine
```

Installing the package adds, from the `pi` manifest: **1 extension**
(`src/pi/extension.ts`), **2 skills** (`skills/soul-memory`, `skills/soul-file`), and **3 prompt
templates** (`prompts/remember.md`, `prompts/recall.md`, `prompts/soul-report.md`).

## What it does

The soul is wired into Pi's lifecycle and is **fire-and-forget**: no handler ever awaits soul work, so
message flow, run settlement, and compaction never wait on it.

| Hook | Action |
|---|---|
| `session_start` | Awaken the soul, bind the project domain (fast local read); replay exchanges journaled by a session that exited mid-turn. |
| `before_agent_start` | Inject `soul_identity` / `soul_state` / `soul_memory` — in-memory ACT-R recall, no I/O. |
| `agent_end` | Kick the full `observe()` pipeline (somatic markers → significance gate → episodic/semantic/graph → self-model → bond). |
| `agent_before_settle` | Reflect in the background every 8 observations. |
| `session_before_compact` | Distil memories before the context is compacted. |
| `session_shutdown` | Hand final state to the detached worker, which drains and exits after Pi. |

Persistence and heavy crypto (AES-256-GCM scrypt derivation, ZIP deflate) run in a detached child
process, off Pi's event loop. If the worker cannot spawn, the client degrades to inline I/O. The tiered
engine is documented in `ENGINE.md`; coverage against the upstream spec is in `COVERAGE.md`.

## Quick start

1. Run any Pi session in a project directory — the first run **creates a soul automatically**
   (`default`), binds the project to it, and records the project's own memory domain.
2. `/soul` — open the status panel (identity, OCEAN, mood, bond, memory counts, self-concept, engine).
3. `/soul-birth <name>` — create a named soul with an archetype/values prompt.
4. `/soul-engine` — show live engine status: tiers, breakers, budget, cache, failures, cost.

## Configuration

Environment variables (read at extension load):

| Env | Effect |
|---|---|
| `PI_SOUL_DIR` | Soul root (default `~/.pi/agent/souls`) |
| `PI_SOUL_ENGINE` | `heuristic` forces the fully offline engine |
| `PI_SOUL_MODEL` | Session-model override (`provider/id`); empty → session's active model |
| `PI_SOUL_CLASSIFIER` | Typed classifier tier (sentiment, significance, self-model, rubric) |
| `PI_SOUL_ANALYSIS_MODEL` | Cheap chat tier (facts + entities) |
| `PI_SOUL_REFLECT_MODEL` | Reasoning tier (reflect, learn, dream synthesis) |
| `PI_SOUL_FACTS` | `heuristic` disables model-based fact extraction |
| `PI_SOUL_USER` | User id for memory scoping (default `human`) |

At runtime, `/soul-config key=value [...]` shows or patches config; `/soul-config` with no arguments
prints the JSON. Recognised keys include `engine=heuristic|model`, `model=provider/id`,
`rubricScoring=hybrid|classifier|heuristic`, `confidenceFloor=N`, `recallLimit=N`, `promptBudget=N`,
`notifications=on|off`, `cache=on|off`, and `factsMode=heuristic|model`.

`engine=heuristic` is a fully offline mode: **zero model calls and zero cost**, every task answered by
deterministic heuristics. See `ENGINE.md` for the full routing table, resilience defaults, and cost
figures rather than duplicating them here.

## Tools and commands

Model-facing tools (11):

| Tool | Purpose |
|---|---|
| `soul_remember` | Store a durable memory (significance + conflict checks). |
| `soul_recall` | ACT-R ranked search of long-term memory. |
| `soul_status` | Identity, mood, bond, memory counts, self-concept, pending changes. |
| `soul_forget` | GDPR deletion by query, entity cascade, or timestamp (irreversible). |
| `soul_bond` | Inspect/adjust the bond; log relationship notes. |
| `soul_reflect` | Consolidate experiences into themes, patterns, corrections. |
| `soul_evaluate` | Score an exchange against the domain rubric. |
| `soul_learn` | Distil a lesson when a score is notable (≥80% or ≤30%). |
| `soul_observe` (codemode) | Run an external exchange through the full pipeline. |
| `soul_skills` (codemode) | Portable skill history (domains, XP, level, evidence). |
| `soul_evolve` (codemode) | Propose/manage personality mutations (approval by default). |

User-facing commands (18): `/soul`, `/soul-list`, `/soul-birth`, `/soul-switch`, `/soul-recall`,
`/soul-remember`, `/soul-forget`, `/soul-reflect`, `/soul-dream`, `/soul-engine`, `/soul-learning`,
`/soul-evaluate`, `/soul-evolve`, `/soul-approve`, `/soul-reject`, `/soul-export`, `/soul-import`,
`/soul-config`.

## Where your data lives

```
~/.pi/agent/souls/
  config.json        # engine + resilience + budget settings
  bindings.json      # project (cwd) → { soul, domain }
  <name>.soul/       # soul directory (soul.json, state.json, dna.md, memory/*, …)
```

Each project gets its own **domain** (derived from the cwd basename) on the shared soul, so memory is
isolated per project without duplicating the soul.

**Privacy.** Soul data is personal. This repository gitignores `*.soul`, `*.soul/`, `**/souls/`,
`pending-observations.json`, `bindings.json`, `trust_chain/`, and `keys/`. `/soul-export --password`
writes an AES-256-GCM encrypted archive (manifest stays readable; every other entry gets an `.enc`
suffix). Do not share a `.soul` file without explicit permission.

## Verification / repeatability

```bash
npm test                 # 114 tests, zero dependencies installed
npm install              # enables the full upstream-schema conformance check
npm run verify           # runs the whole verification script
node scripts/shs.ts <soul-dir-or-.soul-file>   # Soul Health Score (7 dimensions)
```

The test suite runs with **no install at all**: the upstream JSON-schema conformance test cleanly skips
when `ajv` is absent (or when no schemas are found), and the cross-runtime interop check skips when
Python or the upstream `soul_protocol` package is absent. `npm install` adds `ajv` and full schema
conformance.

**On Termux / Android shared storage (`/storage/emulated/0`), `npm install` fails** because
`node_modules` cannot be created with the required symlinks/permissions. Run the install and the
verification script from a normal filesystem, e.g. copy the project into your home directory first.
The test suite itself needs no install.

## Interoperability

`.soul` archives target format **1.0.0** and interoperate with the upstream Python runtime. Both the
full runtime layout and the minimal `identity.json` variant are accepted on read; the full layout is
preferred on write. Conformance is checked against the upstream JSON Schemas at
`vendor/soul-protocol/schemas/` (set `SOUL_SCHEMAS_DIR` to override); when no schemas are present the
check skips and the rest of the suite still runs. `tests/interop.test.ts` also asserts the archive
layout against `SOUL-FORMAT-SPEC` and, when a Python runtime with `soul_protocol` is available, that
the upstream runtime reads a soul this implementation wrote. Have a look at
[CHANGELOG.md](CHANGELOG.md) for what changed in this release.

## Troubleshooting

- **`npm install` fails** on shared storage — no symlink/permission support in `node_modules`. Copy to a
  normal filesystem and install there. Tests need no install.
- **No classifier or analysis model available** — the tier drops out of the ladder and the per-field
  heuristic fallback takes over. The soul still works; only resolution/richness of sentiment, facts and
  rubric scores change.
- **Offline / zero cost** — set `engine=heuristic` (or `PI_SOUL_ENGINE=heuristic`). No model calls.
- **After a provider outage** — `/soul-engine reset` clears breakers, budget counters and the cache.
- **Why did the engine degrade?** `/soul-engine` shows tier assignments, degraded flag, breaker state,
  failure classes, budget denials, cache hits/misses and cost. `/soul` shows a one-line engine summary.

## Credits

Upstream **Soul Protocol** by the OCEAN Foundation, MIT licensed, at commit
`b6ab6ee3bb644a6e27f08af551a155b37c7925c2` (2026-05-25). This project is an **independent
implementation, not a fork** — a TypeScript port plus a Pi-native integration layer. Differences and
attribution are in `NOTICE`; implementation coverage (paper checklist ~83%, full reference-repo surface
~57% full-credit / ~64% with partial credit) is documented in `COVERAGE.md`. Vendored upstream JSON
Schemas, where present, remain under the upstream MIT license.
