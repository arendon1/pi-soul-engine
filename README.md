# pi-soul — Soul Protocol for Pi

A portable AI **identity, memory, cognition, and emotion** layer, natively
integrated into [Pi](https://github.com/earendil-works/pi). A TypeScript
implementation of the [Soul Protocol](https://soul.qbtrix.com/whitepaper.html)
spec, built on Pi's extension surface — prompt sections, lifecycle events,
model-callable tools, commands, skills, and codemode.

The soul remembers what matters, forgets what doesn't, and slowly becomes more
itself. Its full state serializes into a portable `.soul` file that interoperates
with the reference Python runtime.

## Install

```bash
pi install ~/pi-soul            # local package (extension + skills + prompts)
# or try it in one run:
pi --extension ~/pi-soul/src/pi/extension.ts
```

Zero runtime dependencies beyond Pi's host-provided packages. Optional env vars:

| Env | Effect |
|---|---|
| `PI_SOUL_DIR` | Override the soul root (default `~/.pi/agent/souls`) |
| `PI_SOUL_MODEL` | `provider/id` for the cognitive engine's model calls |
| `PI_SOUL_ENGINE=heuristic` | Deterministic offline engine (no model calls) |
| `PI_SOUL_USER` | User id for memory scoping (default `human`) |

## What it does

**Non-blocking by construction.** No pi lifecycle handler ever awaits soul
work. The observe pipeline, reflection, and persistence run as detached
background tasks; persistence and heavy crypto (scrypt, ZIP deflate) live in a
**detached child process** (`src/pi/worker/`, spawned `detached + unref`) that
drains its queue and exits even after pi is gone. Sending messages, settling
runs, compaction, and closing sessions never wait on the soul. If the worker
cannot spawn, everything degrades to inline execution transparently.

**Non-intrusive notifications.** Background soul activity reports through pi's
own mechanisms only: quiet transcript entries (custom-entry renderers) and, at
most, rare `ctx.ui.notify` toasts that never steal focus — reflection results,
compaction preservation, export/import completion, errors. Dialogs appear only
for user-invoked destructive consent (`/soul-forget`, `soul_forget`). Disable
toasts with `/soul-config notifications=off`.

**On every run** (`before_agent_start`): the soul's identity block, state, and
ACT-R-ranked recall of *the current prompt* are injected as named system-prompt
sections (`soul_identity`, `soul_state`, `soul_memory`) — delta-friendly, cache
preserving, token-budget capped.

**After every exchange** (`agent_end`): the pair runs through the `observe()`
pipeline **in the background** (fire-and-forget):

> somatic markers (Damasio) → significance gate (LIDA, 0.35) → episodic →
> fact extraction + `superseded_by` conflicts → temporal knowledge graph →
> self-model (Klein) → bond → state → skills/XP → **evaluation**

Trivial exchanges ("hello") are filtered. Promotions, breakups, and 2am
breakthroughs are remembered — with their emotional context attached.

**Secondary cognition** runs across exchanges, not inside them:

- **evaluate** — every interaction is scored by a rubric (completeness,
  relevance, helpfulness + a domain criterion) and the history feeds evolution.
- **learn** — notable scores (≥80% or ≤30%) distil a `LearningEvent`: a
  transferable lesson written to procedural memory and converted into skill XP.
- **evolve** — a sustained high-performance streak (5+ scores ≥0.55) makes the
  soul *propose a mutation on its own* (`communication.warmth → high`), pending
  your approval.
- **dream** — offline consolidation: topic clusters, recurring procedures →
  `[dream]` procedural memory, archival of stale episodes, semantic dedup via
  `superseded_by`, graph consolidation, and behavioral evolution insights.

**Before compaction** (`session_before_compact`): the dying context window is
distilled into durable memory — detached; compaction proceeds immediately.
The context forgets; the soul doesn't.

**Periodically** (`agent_before_settle`): reflection consolidates themes,
patterns, and corrections — journaled as `soul:reflection` entries, never
requesting a continuation.

## Surface

### Tools (namespace `soul`)

| Tool | Exposure | Purpose |
|---|---|---|
| `soul_remember` | direct | Store a durable fact (dedup + conflict chains) |
| `soul_recall` | direct | ACT-R ranked long-term recall |
| `soul_status` | direct | Identity, mood, bond, memories, self-concept |
| `soul_forget` | direct | GDPR deletion: query / entity cascade / before-date |
| `soul_bond` | direct | Relationship state and adjustments |
| `soul_reflect` | direct | LLM consolidation of recent experience |
| `soul_evaluate` | direct | Score an exchange against the domain rubric |
| `soul_learn` | direct | Distil a lesson from a notable score |
| `soul_observe` | codemode | Run external exchanges through the pipeline |
| `soul_skills` | codemode | Portable skill/XP history |
| `soul_evolve` | codemode | Personality mutations (human-approved) |

### Commands

`/soul` (overlay panel — OCEAN bars, mood, bond, memories, evaluations,
lessons; no footer widgets) ·
`/soul-birth` · `/soul-list` · `/soul-switch` · `/soul-recall` ·
`/soul-remember` · `/soul-forget` · `/soul-reflect` · `/soul-dream [--dry-run]` ·
`/soul-evaluate` · `/soul-learning [domain]` ·
`/soul-evolve` · `/soul-approve` · `/soul-reject` · `/soul-export` ·
`/soul-import` · `/soul-engine [reset]` · `/soul-config`

### Skills & prompts

`skills/soul-memory` (when/how to remember, tiers, privacy) ·
`skills/soul-file` (`.soul` archive work) ·
`/remember` · `/recall` · `/soul-report` (health report)

## Psychology stack (formulas are tested golden vectors)

- **Somatic markers** — `valence ∈ [-1,1]`, `arousal ∈ [0,1]`, label; emotional
  boost `arousal + |valence| × 0.3`
- **LIDA gate** — `0.3·novelty + 0.2·emotional_intensity + 0.2·goal_relevance +
  0.3·content_richness`, threshold `0.35`
- **ACT-R recall** — `1.0·base + 1.5·spread + 0.5·emotional` where
  `base = ln(Σ t_j^-0.5)` over the access history (recalled-today beats
  important-from-last-month)
- **Klein self-model** — `min(0.95, 0.1 + 0.85·(1 - 1/(1 + evidence·0.1)))`;
  uncertainty is permanent
- **Bond** — logarithmic growth, linear neglect decay
- **Personality modulation** — OCEAN traits bias retrieval ranking
- **Rubrics** — heuristic completeness/relevance/helpfulness/specificity/empathy
  per domain; streak detection drives automatic evolution
- **Dream** — Jaccard topic clustering (≥0.25, size ≥3), recurring-procedure
  detection (≥3×), archival, semantic dedup, graph consolidation

## The CognitiveEngine

One integration point — `think(prompt) → text` — behind a strategy layer:

- **`CognitiveRouter`** (default): routes each task to the cheapest adequate
  tier — a **classifier** for typed tasks (sentiment, significance, self-model
  domain, rubric scores: one batched call answering 8–13 typed questions with
  confidences), a **cheap chat model** for facts/entities, a **reasoning model**
  for reflect/learn/dream synthesis, the **session model** as continuity, and
  **heuristics** as the guaranteed floor. Per-field fallback means a failed or
  low-confidence answer degrades one field, never the exchange.
- **`HeuristicEngine`**: offline, deterministic, no hallucination. The floor
  that makes the pipeline total, and the whole engine when `engine=heuristic`.
- **`PiModelEngine` / `HybridEngine`**: single-model engines, still exported for
  direct use and tests.

Typed routing, cost, the failure taxonomy and the measured numbers are in
[ENGINE.md](ENGINE.md). Short version: ~2× cheaper than the previous
session-model-per-exchange behaviour, ~80× cheaper than using a frontier model,
and more accurate because classifier answers carry confidence.

## `.soul` portability

Standard ZIP (format 1.0.0) per the Soul Protocol spec: `manifest.json`,
`soul.json`, `state.json`, `dna.md`, `memory/*.json`. Encrypted exports keep the
manifest readable and wrap every other entry in AES-256-GCM (scrypt n=2^17,
r=8, p=1 — byte-compatible with the reference runtime). The directory form
(`~/.pi/agent/souls/<name>.soul/`) is identical minus the manifest.

A **trust chain** (Ed25519) journals every memory write, forget, supersede,
mutation, and bond change; exports verify without the signing key, which never
leaves the local soul dir unless explicitly included.

Interoperability is enforced: `tests/spec.test.ts` validates our artifacts
against the upstream `schemas/*.schema.json` (ajv) when the reference repo is
available.

## Souls live here

```
~/.pi/agent/souls/
├── config.json        engine, model, recall budget, notifications
├── bindings.json      project → { soul, domain }   ← domain isolation
└── <name>.soul/       soul.json, state.json, dna.md, memory/, trust_chain/
```

All writes go through the detached soul worker (fire-and-forget, latest state
wins), so the soul dir is always consistent even if pi exits mid-turn.

One soul can serve every project — each project gets its own **memory domain**
(a gap in the reference runtime), so billing work doesn't bleed into legal work.

## Development

```bash
npm test                    # 108 tests: spec conformance, psychology golden
                            # vectors, evaluator + learning events, dream
                            # synthesis, evolution triggers, engine routing and
                            # resilience (every failure class), performance
                            # guards, pi layer, detached worker, trust
node scripts/shs.ts ~/.pi/agent/souls/default.soul   # Soul Health Score
```

Layout: `src/spec/` (protocol port, no pi imports) · `src/runtime/`
(psychology pipeline) · `src/pi/` (extension integration) · `src/pi/worker/`
(detached persistence/crypto child) · `tests/` · `skills/` · `prompts/` ·
`scripts/shs.ts`.

## License

MIT — protocol specification © its upstream authors; this implementation is an
independent port.
