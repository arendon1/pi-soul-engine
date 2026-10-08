# pi-soul-engine — Soul Protocol, natively integrated into Pi

> **Status: shipped (v0.2.0).** This document is the original build plan; its
> phases P0–P5 are complete, and the engine/resilience work (P6–P11 below) was
> added afterwards. The canonical, installable artefact lives at
> `Projects/pi-soul-engine` and the strategy for the model layer is documented
> in `ENGINE.md`.
>
> See README.md for usage, ENGINE.md for the cognitive-engine strategy, and
> COVERAGE.md for how much of the upstream protocol is implemented.

> **Status: implemented.** All phases P0–P5 are complete (43/43 tests green,
> live e2e verified in Pi). See README.md for usage; §7 below maps to what shipped.

**Goal:** A fully integrated implementation of the Soul Protocol (portable AI identity, memory,
cognition, emotion — https://soul.qbtrix.com/whitepaper.html, github.com/qbtrix/soul-protocol)
as a **Pi package**: a TypeScript port of the spec + runtime, wired into Pi's extension
lifecycle so the soul is a first-class citizen of the agent — not a bolt-on.

**Constraint honored:** no footer/status-line plugins. Status is shown via a `/soul` overlay
panel and transcript tool renderers; nothing occupies the footer.

---

## 1. Strategic decisions

| Decision | Choice | Why |
|---|---|---|
| Implementation language | **TypeScript**, a port of `spec/` + core `runtime/` | Pi extensions run in-process as TS (`jiti`). Deep integration (prompt sections, events, nested model calls, custom messages) is impossible from a subprocess. The Python reference is ~10k lines but the *spec* is 695 lines and the JSON schemas are language-agnostic — that is our contract. |
| Interop guarantee | `.soul` files written/read **per `docs/SPEC.md` + `schemas/*.schema.json`** | A soul exported from pi-soul opens in the Python runtime (`soul inspect`) and vice versa. Enforced by a conformance test suite (ajv vs the repo schemas + golden fixtures from `fixtures/`). |
| CognitiveEngine | **`PiModelEngine`** — nested model calls via `ctx.modelRegistry` (chat `complete()` + `classify()` classifier models), with **`HeuristicEngine`** fallback | The whitepaper says "consumers provide a brain". Pi *is* the brain. Sentiment, significance, fact extraction, entity extraction, self-reflection run on the session's own model credentials. Zero extra auth, works with any provider, degrades to heuristics when no model is available. |
| Where the soul lives | `~/.pi/agent/souls/<name>.soul/` (unpacked directory form, which the reference runtime also supports) + project binding `.pi/settings.json` → `soul: {name, domain}` | Global soul (identity persists across projects) with **domain isolation** per project (whitepaper §11 "not working yet" — we implement it: domain = project key or user-configured). |
| Distribution | Pi package (`package.json` with `pi` manifest: extensions + skills + prompts) | `pi install ./pi-soul` or `pi install git:…`. One unit ships code, skills, and prompt templates. |
| Session state | Memory store = external soul dir; session audit = `pi.appendEntry()` custom entries, reconstructed from `ctx.sessionManager.getBranch()` | Branch-correct replay, survives resume/fork, never pollutes model context. |

---

## 2. Architecture

```
pi-soul/
├── package.json                 # pi manifest; peerDeps: pi-ai, pi-coding-agent, pi-tui, typebox
├── PLAN.md
├── src/
│   ├── spec/                    # ── Soul Protocol spec port (no pi imports; pure, testable) ──
│   │   ├── identity.ts          # Identity, DNA, Personality(OCEAN), CommunicationStyle, Biorhythms, BondTarget
│   │   ├── memory.ts            # MemoryEntry, layers (core/episodic/semantic/procedural/social/graph),
│   │   │                        #   Interaction/Participant, MemoryStore iface, DictMemoryStore
│   │   ├── soul-file.ts         # .soul ZIP pack/unpack (manifest/soul/state/memory/*.jsonl), AES-256-GCM + scrypt
│   │   ├── schemas.ts           # TypeBox schemas mirroring schemas/*.schema.json (validation + tool params)
│   │   ├── embeddings.ts        # EmbeddingProvider iface + HashEmbedder, TFIDFEmbedder
│   │   └── similarity.ts        # cosine / euclidean / dot, dimension guards
│   ├── runtime/
│   │   ├── soul.ts              # Soul: birth/awaken/observe/remember/recall/forget/reflect/dream/export
│   │   ├── observe.ts           # pipeline: somatic markers → LIDA gate (0.35) → episodic →
│   │   │                        #   fact extraction (superseded_by) → graph entities → Klein self-model → bond
│   │   ├── activation.ts        # ACT-R scoring: base_level Σt^-0.5, spreading, emotional boost
│   │   ├── recall.ts            # retrieval ranking + personality modulation (OCEAN)
│   │   ├── bond.ts              # BondRegistry: log growth, linear decay, multi-user
│   │   ├── state.ts             # mood, energy, focus, social battery, feel()
│   │   ├── self-model.ts        # Klein confidence curve, emergent domains
│   │   ├── evolution.ts         # supervised trait mutation: propose → approve/reject
│   │   ├── skills-xp.ts         # skill/XP registry (wired end-to-end, unlike the reference)
│   │   ├── consolidate.ts       # reflect() + dream(): dedupe, prune, summarize → archival
│   │   ├── store.ts             # JSONL-backed layered store + BM25/token-overlap search
│   │   └── engines/
│   │       ├── engine.ts        # CognitiveEngine protocol: think(prompt, schema?) → structured
│   │       ├── heuristic.ts     # deterministic fallback (ported word-list/regex heuristics)
│   │       └── pi-model.ts      # PiModelEngine (ctx.modelRegistry.complete / classify)
│   ├── pi/                      # ── the Pi integration layer ──
│   │   ├── extension.ts         # default factory; wires everything below
│   │   ├── lifecycle.ts         # session_start/shutdown, before_agent_start, message_end, turn_end,
│   │   │                        #   agent_before_settle, session_before_compact
│   │   ├── tools.ts             # soul_* tools (TypeBox params, outputSchema, structuredContent)
│   │   ├── commands.ts          # /soul* commands
│   │   ├── injection.ts         # systemPromptOptions sections + soul:memory custom messages
│   │   ├── renderers.ts         # tool-call renderers (memory cards, bond arcs)
│   │   ├── panels.ts            # /soul overlay panel (TUI custom component — overlay, not footer)
│   │   └── resources.ts         # resources_discover: ship bundled skills + prompt templates
│   └── util/                    # ids, timestamps, tokenization, jsonl io
├── skills/
│   ├── soul-memory/SKILL.md     # when & how to remember/recall; tier semantics; privacy rules
│   └── soul-file/SKILL.md       # working with .soul archives and JSON payloads
├── prompts/
│   ├── remember.md              # /remember <note>
│   ├── recall.md                # /recall <query>
│   └── soul-report.md           # /soul-report → SHS-style health report
├── scripts/
│   └── shs.ts                   # Soul Health Score evaluator (7 dimensions, heuristic-only)
└── tests/                       # vitest: spec, runtime math, .soul roundtrip, conformance, e2e via pi SDK
```

### Soul Protocol concept → Pi feature map

| Protocol concept | Pi integration point |
|---|---|
| Identity block (core memory, always in context) | `before_agent_start` → `systemPromptOptions.sections.soul_identity` |
| Per-turn context (`context_for()`) | `before_agent_start` (`event.prompt` drives retrieval) + `context` event → `soul:memory` custom message |
| `observe()` pipeline | `message_end` (collect user/assistant pairs) → async queue → pipeline; results via `pi.appendEntry("soul:observation")` |
| CognitiveEngine | `ctx.modelRegistry.complete()` / `classify()` nested calls; `usage` reported in tool results |
| Significance gate / self-model reflection | `agent_before_settle` (end-of-run consolidation, no forced continuation) |
| Memory survives context loss | `session_before_compact` → distill the compacted window into episodic/semantic memory first |
| Remember/recall | model tools `soul_remember`, `soul_recall`, `soul_search_graph` (`direct`, namespace `soul`) |
| GDPR deletion | `soul_forget` tool + `/soul-forget` command with `ctx.ui.confirm` |
| Bond | `soul_bond` tool + auto-update in observe; rendered in `/soul` panel |
| Evolution (personality drift) | `soul_evolve` (propose) + `/soul-approve` (human-in-the-loop, default approval required) |
| `.soul` portability | `/soul-export`, `/soul-import` commands; AES-256-GCM; schema-validated |
| Batch/scripted memory work | tools with `exposure: "codemode"` — codemode scripts bulk-label sentiment via `models.classify()` |
| Skills/XP | `soul_skills` tool + surfaced in `/soul` panel and prompt section |

---

## 3. Model-facing tool surface (namespace `soul`, with `instructions`)

| Tool | Exposure | Notes |
|---|---|---|
| `soul_remember {content, tier?, importance?, emotion?, domain?}` | direct | Explicit memory write; returns entry id |
| `soul_recall {query, limit?, tier?, min_importance?}` | direct | ACT-R ranked; `outputSchema` → structuredContent |
| `soul_status {}` | direct | mood, energy, bond, memory counts, recent salient memories |
| `soul_forget {query? \| entity? \| before?}` | direct | destructive; `tool_call` gate asks `ctx.ui.confirm` |
| `soul_bond {strengthen?, note?}` | direct | relationship reflection |
| `soul_reflect {topic?}` | direct | LLM consolidation via PiModelEngine (nested usage reported) |
| `soul_observe {user_input, agent_output}` | codemode | Manual pipeline run (for scripted/bulk flows) |
| `soul_skills {}`, `soul_evolve {action,…}` | codemode | Lower-frequency management |

All tools: TypeBox params (shared with `spec/schemas.ts`), `annotations` (readOnly for recall/status),
`outputSchema` + `structuredContent`, truncation guidance for large recall payloads.

> **Planned extension (surface parity).** Nine command capabilities still have no
> model-facing entry point — notably `/soul-config` and `/soul-engine`, which
> blocked a routine engine switch because a config file edit cannot rebuild the
> in-process engine. `PLAN-TOOLS.md` specifies the three tools that close this
> (`soul_engine`, `soul_config`, `soul_admin`), the parity rule, and a regression
> test for that failure.

## 4. Commands & UI (no footer)

- `/soul` — overlay panel: OCEAN bars, mood/energy/social battery, bond gauge, tier counts,
  last N salient memories, trust/health line. (`ctx.ui.custom()` in an **overlay**; in RPC mode
  it prints structured text instead.)
- `/soul-birth` — interactive questionnaire (name, archetype, values, OCEAN, style) → `Soul.birth()`.
- `/soul-switch <name>`, `/soul-inspect [name]`, `/soul-recall <q>`, `/soul-dream`, `/soul-evolve`,
  `/soul-approve <id>` / `/soul-reject <id>`, `/soul-forget …`, `/soul-export [path] [--password]`,
  `/soul-import <path>`.
- Tool renderers: `soul_recall` renders memory cards (tier badge, activation score, somatic marker);
  `soul_remember` renders a compact confirmation. HTML exports look right for free.

## 5. Behavioral wiring (the "alive" parts)

**Non-blocking contract (added after initial delivery):** no lifecycle handler
awaits soul work. The observe pipeline, reflection, and compaction distillation
are fire-and-forget background tasks; persistence and heavy crypto run in a
detached child process (`src/pi/worker/`) that survives pi's exit to drain its
queue. Notifications use pi's own non-intrusive mechanisms (transcript entry
renderers + rare `ctx.ui.notify` toasts, configurable via `notifications`).

1. **Awaken** on `session_start`: load bound soul (small local read), inject identity.
2. **Per user prompt** (`before_agent_start`): in-memory retrieval against
   `event.prompt` → `soul_identity` / `soul_state` / `soul_memory` sections.
3. **Per run** (`agent_end`): *kick* `observe()` into the background queue and
   return immediately — message flow never waits on the soul.
4. **End of run** (`agent_before_settle`): *kick* one-shot reflection into the
   background; appends `soul:reflection` + at most one toast. Never continues.
5. **Before compaction** (`session_before_compact`): *kick* distillation into
   the background; compaction proceeds immediately.
6. **Shutdown** (`session_shutdown`): hand state to the worker and return —
   the worker persists after pi is gone (verified by test).

## 6. Testing & conformance

- **Unit (vitest):** ACT-R formula, LIDA threshold, Klein curve, bond growth/decay, significance,
  heuristic engine determinism (golden vectors).
- **Format conformance:** ajv-validate every produced artifact against the repo's
  `schemas/*.schema.json`; roundtrip pack→unpack→pack byte-stable; AES wrong-password raises clean error.
- **Cross-runtime interop:** golden `.soul` fixtures from `soul-protocol/fixtures/` must `awaken()`
  in pi-soul; our export must `soul inspect` cleanly in the Python runtime (checked in CI where
  `uv`/`python` is available, skipped otherwise).
- **Extension e2e:** programmatic sessions via the pi SDK (`examples/sdk`) asserting: identity
  section present, recall injection appears as custom message, observe entries appended, forget
  cascades, compaction distillation preserves facts.
- **SHS eval (`scripts/shs.ts`):** port the 7-dimension rubric from the repo's research tier-6;
  heuristic-only target ≥ 90/100 (reference: 90.2).

## 7. Phases

| Phase | Deliverable | Acceptance |
|---|---|---|
| **P0 — Scaffold + spec** | package skeleton, `spec/` port, TypeBox schemas, `.soul` ZIP codec, tests | ✅ done — roundtrip + upstream schema conformance (ajv) green |
| **P1 — Runtime** | observe pipeline, ACT-R recall, bond, state, self-model, store, HeuristicEngine, consolidation | ✅ done — whitepaper golden vectors pass |
| **P2 — Pi core integration** | extension factory, lifecycle wiring, core tools, prompt-section injection, commands | ✅ done — live e2e in pi (observe, recall injection, tools) |
| **P3 — PiModelEngine** | LLM-backed cognition via `modelRegistry` (HybridEngine default); compaction distillation; `agent_before_settle` reflection | ✅ done |
| **P4 — UX + skills + codemode** | overlay panel, renderers, 2 skills, 3 prompt templates, codemode tools, export/import | ✅ done — no footer usage anywhere |
| **P5 — Advanced + hardening** | skills/XP, Ed25519 trust chain, evolution approval, multi-soul switch, SHS evaluator, docs | ✅ done — SHS 80.6/100 on a one-exchange soul |

### Post-plan phases (secondary cognition, then the model layer)

| Phase | Deliverable | Status |
|---|---|---|
| **P6** | Evaluator (10 rubrics, heuristic scorers, domain stats, streaks) + LearningEvent model and lifecycle | ✅ done |
| **P7** | Full `dream()`: topic clusters, procedure detection, behavioural trends, archival, dedup, graph consolidation, synthesis, insights, dry-run | ✅ done |
| **P8** | Automatic evolution triggers (`checkTriggers` on high-performance streaks) + enum trait support + Soul wiring (`evaluate` per interaction, `learn`, auto-consolidation) | ✅ done |
| **P9** | Pi surfaces for the above (`soul_evaluate`, `soul_learn`, `/soul-evaluate`, `/soul-learning`, richer `/soul-dream`) + coverage/README updates | ✅ done |
| **P10** | Cognitive-engine strategy: `ENGINE.md`, tiered `CognitiveRouter`, batched `AnalysisService` + classifier client, hybrid rubric scoring | ✅ done |
| **P11** | Resilience: failure taxonomy, deadlines, single transient retry, model/provider breakers, budgets, cache, degradation, deferral, usage capture; resilience + performance test suites | ✅ done |

## 8. Non-goals (v1)

- No footer/statusline/header widgets (explicit requirement).
- No Python bridge / MCP shim to the reference runtime (the port speaks `.soul`; a
  `pi.registerMcpServer("soul-mcp", …)` bridge is a possible later add-on).
- No real IPFS/Arweave (the reference's eternal storage is mock-tier too; keep the
  `EternalStorageProvider` interface only).
- No themes.

## 9. Risks & mitigations

- **Pipeline latency:** observe() is async/debounced off the critical path; nested model calls use a
  cheap/fast model override setting (`soul.engineModel` in package settings) and report `usage`.
- **Context bloat:** prompt sections are budget-capped (identity ≤ ~400 tokens, recall top-k ≤ 5,
  activation-thresholded); sections are named so Pi appends transcript deltas instead of full rewrites.
- **Branch correctness:** all session-visible soul writes go through entries/messages; state is
  rebuilt from `getBranch()` on `session_start`, never incrementally mutated across branches.
- **Schema drift vs upstream:** conformance tests pin to the repo's `schemas/`; version field in
  `manifest.json` validated on import.
