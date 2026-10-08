# Tool-surface parity — soul operations the model can perform

> **Status: planned (not implemented).** This document is the plan for closing the
> gap between what a human can do with `/soul-*` commands and what the agent can
> do with `soul_*` tools. It is referenced from `PLAN.md` §3.
>
> **Origin:** during the first live engine switch (2026-10-08), `config.json` was
> edited on disk but the running engine did not change: `SoulManager` caches its
> config in memory and only `bridge.rebuildEngine()` re-reads it. The only path
> that did both was the `/soul-config` slash command — so the config could not be
> changed by the agent, only by the human. That is the concrete failure this plan
> removes, generalised to the whole command surface.

---

## 1. The rule

**Capability parity:** every `/soul-*` command that is not purely visual must have
an equivalent `soul_*` tool with the same or stricter safety.

Rationale:

- Direct file/config edits by the agent are unsafe because they bypass the
  in-process caches (`SoulManager.config`, the built `CognitiveEngine`, the
  observe queue). The tool must own the same atomic `configure() → rebuildEngine()`
  path the command uses.
- A human asking "flip the engine, check it isn't degraded, approve the mutation"
  should not have to translate intent into three slash commands.
- Parity is testable: walk the command registry, assert each id maps to a tool or
  is on an explicit UI-only allowlist.

**UI-only allowlist (no tool, by design):** the `/soul` overlay panel. Everything
else gets a tool.

---

## 2. Gap analysis (measured, not assumed)

| Command | Tool today | Gap |
|---|---|---|
| `/soul` (panel) | — | UI-only, exempt |
| `/soul-recall` | `soul_recall` | none |
| `/soul-remember` | `soul_remember` | none |
| `/soul-forget` | `soul_forget` | none |
| `/soul-reflect` | `soul_reflect` | none |
| `/soul-approve` / `/soul-reject` | `soul_evolve {action}` | none (covered) |
| `/soul-evolve` | `soul_evolve {action:"propose"}` | none |
| `/soul-evaluate` (stats view) | `soul_evaluate` scores one exchange; no stats view | **partial** |
| `/soul-list` | — | **missing** |
| `/soul-birth` | — | **missing** |
| `/soul-switch` | — | **missing** |
| `/soul-dream` | — | **missing** |
| `/soul-engine` (status, reset) | — | **missing — blocker** |
| `/soul-learning` | — | **missing** |
| `/soul-export` | — | **missing** |
| `/soul-import` | — | **missing** |
| `/soul-config` | — | **missing — blocker** |

Net: 9 command capabilities with no model-facing entry point, 2 of them (config,
engine status) being the ones that blocked a routine task.

---

## 3. Proposed tools

Three new tools, not nine. One direct tool per high-value verb, one multiplexed
admin tool for the rare ones — matching the existing `soul_evolve {action}` and
`soul_bond {action}` precedent. This keeps the always-in-context direct surface
small.

### 3.1 `soul_engine` — direct, read-only

```ts
SoulEngineParams = Type.Object({
  action: Type.Optional(Type.Union([Type.Literal("status")])),   // default: status
})
```

- Returns `bridge.engineStatus()` (tiers, degraded, breakers, budget, cache,
  telemetry: attempts/retries/cache hits/failures/usage/cost/deferrals) plus
  `bridge.auditStatus()`.
- This is the tool that lets the agent answer *"did the flip apply and is it
  silently degrading?"* without the human reading `/soul-engine`.
- **Reset stays out of this tool.** `annotations.readOnlyHint` is static per tool;
  a mutating `reset` action would make the annotation a lie. `reset` moves to
  `soul_admin`.

### 3.2 `soul_config` — direct, mutating, atomic rebuild

```ts
SoulConfigParams = Type.Object({
  engine:          Type.Optional(Type.Union([Type.Literal("heuristic"), Type.Literal("model")])),
  sessionModel:    Type.Optional(Type.String()),
  classifierModel: Type.Optional(Type.String()),
  analysisModel:   Type.Optional(Type.String()),
  reflectModel:    Type.Optional(Type.String()),
  factsMode:       Type.Optional(Type.Union([Type.Literal("heuristic"), Type.Literal("model")])),
  rubricScoring:   Type.Optional(Type.Union([Type.Literal("hybrid"), Type.Literal("classifier"), Type.Literal("heuristic")])),
  confidenceFloor: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  cache:           Type.Optional(Type.Boolean()),
  recallLimit:     Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
  promptBudget:    Type.Optional(Type.Number({ minimum: 50, maximum: 4000 })),
  reflectEvery:    Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  notifications:   Type.Optional(Type.Boolean()),
  budget:          Type.Optional(Type.Object({ perMinute: Type.Optional(Type.Number({ minimum: 1 })), perSession: Type.Optional(Type.Number({ minimum: 1 })) })),
})
```

Behaviour:

1. No arguments → return the effective config (read).
2. Any argument → `bridge.manager.configure(patch)` **then** `bridge.rebuildEngine()`
   **then** return `{ config, engine }` where `engine` is the freshly computed
   `bridge.engineStatus()`.
3. Whitelist + validate. Unknown keys are rejected with an error, never silently
   merged (the command currently patches blindly).
4. Emit a `soul:config` custom transcript entry with the before/after diff, so
   config changes are visible and auditable like every other soul write.
5. **Surface the exact failure we hit:** if the result is `engine === "router"`
   but with zero resolved tiers, or `engine === "heuristic"` after requesting
   `model`, say so explicitly in the result text ("model engine requested but no
   tier resolved — check provider auth") instead of reporting success.

### 3.3 `soul_admin` — direct, multiplexed management

```ts
SoulAdminParams = Type.Object({
  action: Type.Union([
    Type.Literal("dream"), Type.Literal("learning"), Type.Literal("evaluation"),
    Type.Literal("list"), Type.Literal("switch"), Type.Literal("birth"),
    Type.Literal("export"), Type.Literal("import"), Type.Literal("engine_reset"),
  ]),
  dry_run:  Type.Optional(Type.Boolean()),      // dream
  domain:   Type.Optional(Type.String()),       // learning
  limit:    Type.Optional(Type.Number()),       // learning
  name:     Type.Optional(Type.String()),       // switch | birth
  archetype:Type.Optional(Type.String()),       // birth
  values:   Type.Optional(Type.Array(Type.String())), // birth
  path:     Type.Optional(Type.String()),       // export | import
  password: Type.Optional(Type.String()),       // export | import
})
```

Wires to the same calls the commands use:

| action | call |
|---|---|
| `dream` | `bridge.soul().dreamWithSynthesis({ dryRun })` + `manager.markDirty()` |
| `learning` | `bridge.soul().learning.list({ domain, limit })` |
| `evaluation` | `bridge.soul().evaluationStats()` (the stats view `/soul-evaluate` shows) |
| `list` | `bridge.manager.list()` |
| `switch` | `bridge.manager.switchTo(bridge.cwd, name, bridge.getEngine())` |
| `birth` | `bridge.manager.birth(bridge.cwd, {...}, bridge.getEngine())` |
| `export` | `bridge.worker.packToFile(soul.toDocument(), path, { password })` |
| `import` | `bridge.worker.unpack` → `Soul.fromDocument` → `bridge.manager.bindImported` |
| `engine_reset` | `bridge.routerRef?.resetResilience()` |

---

## 4. Why a tool, not just a better command

The config path is the proof. The command works because it holds the live
`SoulBridge`. A tool registered through `pi.registerTool` is handed the same
`bridge` closure (`registerSoulTools(pi, bridge)`), so it can do what a file edit
cannot:

```
manager.configure(patch)   // update the in-memory config AND persist it
        ↓
bridge.rebuildEngine()     // construct the tier ladder from the NEW config
        ↓
engineStatus()             // report whether tiers actually resolved
```

Reading `config.json` from disk (what the agent had to do) can never trigger the
middle step. That asymmetry is the bug.

---

## 5. Safety model

`annotations` are static per tool, so split by real capability:

| Tool | readOnly | destructive | openWorld | idempotent |
|---|---|---|---|---|
| `soul_engine` | ✓ | ✗ | ✗ | ✓ |
| `soul_config` | ✗ | ✗ (reversible; backups) | ✗ | ✓ |
| `soul_admin` | ✗ | ✗ | export/import = ✓ | ✗ |

Extra guards:

- **Cost changes are explicit.** Moving `engine` to `model`, or `factsMode` to
  `model`, changes spend. The result must state the new tier ladder and the
  per-call budget so the change is never silent.
- **Import/switch/birth create a timestamped backup** of the current soul doc
  before replacing it (`<name>.soul.bak-<iso>`), and refuse to overwrite an
  existing soul directory without an explicit flag.
- **Export path** is validated to be an absolute path or resolved against `cwd`;
  the result reports the resolved absolute path and byte size.
- **Unknown config keys rejected**, enum/range validated — the tool must be
  stricter than the command, not merely equal.
- Secrets: `password` is used transiently, never echoed in the result or written
  to the transcript entry.

---

## 6. Files touched

| File | Change |
|---|---|
| `src/pi/tools-admin.ts` *(new)* | the three tool registrations + param schemas |
| `src/pi/tools.ts` | call `registerAdminTools(pi, bridge)` from `registerSoulTools` |
| `src/pi/bridge.ts` | expose `configure()`/`engineStatus()`/`resetResilience()` helpers if not already public (they exist; only thin wrappers needed) |
| `src/pi/extension.ts` | no change if tools self-register |
| `README.md` §"Tools and commands" | document the new tools and the parity rule |
| `CHANGELOG.md` | entry under the next version |
| `tests/tools-admin.test.ts` *(new)* | unit + parity tests |

---

## 7. Tests & acceptance

1. **Unit — config validation.** Unknown key rejected; out-of-range value
   rejected; enum mismatch rejected; valid patch round-trips through
   `manager.getConfig()`.
2. **e2e — the observed bug.** From a plain tool call with no slash command:
   set `engine=model`, assert `bridge.getEngine().name === "router"` and that
   `engineStatus()` lists resolved tiers; set `engine=heuristic`, assert name
   flips back. This is the regression test for the original failure.
3. **Parity test.** Enumerate registered command ids; assert each is either
   present in the tool map or in `UI_ONLY = {"/soul"}`. Fails loudly when a new
   command ships without a tool.
4. **Annotation test.** `soul_engine` with `readOnlyHint: true` performs no
   mutation (assert config + state bytes unchanged after a status call).
5. **Backup test.** `import` over an existing soul writes a `.bak-<iso>` and the
   backup awakens to the same memory count.
6. **Acceptance (manual, the real goal):** in a plain chat turn, no slash
   commands, the human can say *"flip to the model engine, confirm it isn't
   degrading, and show me the cost"* and the agent completes all three via tools.

---

## 8. Phases

| Phase | Deliverable | Acceptance |
|---|---|---|
| **T1 — Unblock** | `soul_engine` + `soul_config` with validation and atomic rebuild | e2e regression test #2 green; the 2026-10-08 failure cannot recur |
| **T2 — Cognition ops** | `soul_admin`: `dream`, `learning`, `evaluation`, `engine_reset` | dream dry-run via tool matches the command's report |
| **T3 — Identity ops** | `soul_admin`: `list`, `switch`, `birth`, `export`, `import` + backups | backup test #5 green; import round-trips an exported archive |
| **T4 — Lock it in** | parity test, README + CHANGELOG, deploy to `~/pi-soul` | parity test #3 green; `pi install` copy matches repo HEAD |

---

## 9. Open questions

- **Exposure.** Should these be `direct` (always in the model's tool list, small
  prompt cost) or `codemode` (only reachable from codemode scripts)? Leaning
  `direct` for `soul_engine`/`soul_config` because the whole point is
  conversational invocation; `soul_admin` could go either way and may warrant
  `codemode` to keep the direct surface lean. Measure the prompt-token delta
  before deciding.
- **`soul-evaluate` overlap.** `soul_evaluate` scores one exchange; `/soul-evaluate`
  shows per-domain stats. Keep one tool with an `action` discriminator, or leave
  `soul_evaluate` as-is and put stats under `soul_admin {action:"evaluation"}`?
  Current plan: the latter, to avoid churning a shipped tool.
- **Birth questionnaire.** `/soul-birth` interactively prompts when `ctx.hasUI`.
  A tool has no interactive prompts, so every birth field must be an argument,
  and a missing name is an error rather than a prompt. Decide whether to also
  mutate `dna.personality` at birth (currently birth accepts OCEAN in the command
  description but the handler only passes name/archetype/values).

---

## 10. Explicitly out of scope

- No change to the `.soul` file format or the spec port.
- No new lifecycle hooks.
- No change to the human-approval default for evolution (`require_approval: true`
  stays; `soul_evolve` already exposes approve/reject).
- The entity→skill mapping bug found during this investigation
  (`src/runtime/soul.ts:434`, every extracted entity awarded skill XP) is a
  **separate** defect with its own plan; it is noted here only because it was
  found while auditing the surface.
