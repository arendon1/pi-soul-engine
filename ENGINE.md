# ENGINE.md — the cognitive engine strategy

How pi-soul decides *which* mind does *which* cognitive work, what it costs, and
what happens when that mind is unavailable.

Before this layer existed, the soul used the session model for sentiment and
significance on every exchange — two frontier-model calls to produce two labels.
This document is the policy that replaced that.

---

## 1. Routing: one tier per task

Typed, high-volume tasks go to a **classifier** (they are answered as
`choice`/`score`/`bool` questions, output tokens are free, and every answer
carries a confidence). Generative tasks go to a **cheap chat model**. Reasoning
over accumulated state goes to the **reasoning tier**. The **session model** is
the continuity fallback. **Heuristics** are the guaranteed floor.

| # | Task | Cadence | Tier | Default model |
|---|---|---|---|---|
| 1 | sentiment — valence, arousal, label | every exchange | classifier | `openrouter/~typesafe/jev-latest` |
| 2 | significance — novelty, emotional intensity, goal relevance, richness | every exchange | classifier | same call |
| 3 | self-model domain | every exchange | classifier | same call |
| 4 | rubric scores | every exchange | classifier | same call |
| 5 | facts + entities | every exchange | cheap chat | `openrouter/~z-ai/glm-flash-latest` |
| 6 | reflect — themes, patterns, corrections | every 8 observations | reasoning | `openrouter/~deepseek/deepseek-flash-latest` |
| 7 | learn — lesson distillation | notable scores only | reasoning | same |
| 8 | dream synthesis — procedures, drift insights | per dream cycle | reasoning | same |
| 9 | consolidation, archival, dedup, clustering | periodic | heuristics | — |
| 10 | recall + prompt injection | every prompt | none (in-memory) | — |

**Task 1–4 are one call.** Web: `AnalysisService` builds a single classifier
request with 8–13 typed questions (`valence` as a 5-level `score`, `arousal` as
a 4-level `score`, `label` as a `choice` over 8 emotions, four significance
scores, optional `domain` choice, and rubric scores). One round trip, then
per-field confidence filtering.

### Hybrid rubric scoring

The heuristics are *good* exactly where they look strong — `completeness`
(word count), `relevance` (token overlap), `helpfulness` (their average). They
are *weak* at `specificity`, `empathy`, `originality`, `clarity`. So in the
default `hybrid` mode the classifier is asked **only** for the weak criteria
(1 question instead of 4 on `technical_helper`) and the strong ones stay
heuristic. `rubricScoring=classifier` asks for all; `heuristic` asks for none.

This was not a guess: a live run showed the classifier scoring `specificity`
0.88 while the three default criteria fell back to heuristics — the same split,
arrived at by accident. Now it is the design.

## 2. Cost

Per exchange, ~700 input tokens and ~150 output tokens across the two calls.

| Configuration | per 1k exchanges |
|---|---|
| Session model on every exchange (what it did before: 2 calls to `MiniMax-M3`) | **$0.40** |
| The same on a frontier session model (e.g. `~anthropic/claude-fable-latest`, 10/50) | **$15.00** |
| **Routed** (classifier + cheap chat + amortised reflect) | **$0.18** |
| Routed with `resilience.cache` warm and few distinct prompts | lower still |

The classifier tier costs input tokens only, so tasks 1–4 are ~$0.00003 per
exchange; `analysisModel` at 0.0214/0.5 is the dominant term.

## 3. Resilience

Every failure has a class, and every class has a response. Nothing here is a
guess: each row has a test.

| Failure | Detected by | Response |
|---|---|---|
| no/expired credentials | `hasConfiguredAuth()` at tier resolution | tier dropped from the ladder |
| quota exhausted | 402, or `stopReason: error` | breaker + next tier |
| rate limit | 429 (+`Retry-After` honoured by backoff) | one jittered retry, then next tier |
| downtime / network | 5xx, `ECONNRESET`, `fetch failed` | one jittered retry, then next tier |
| timeout / hang | our own per-tier deadline | **no retry**, next tier |
| context overflow | 400 context-length | next tier (input is bounded anyway) |
| malformed / empty output | parse or emptiness check | per-field heuristic fallback |
| out-of-range values | `validate.ts` clamping | field clamped, rest kept |
| **abort** (shutdown, Escape) | `signal.aborted` | **never retried, never fabricated — deferred** |
| cost runaway | budget counters | stop calling, degrade |
| provider outage | provider breaker (shared across its models) | straight to the next tier |

**Layers**

1. **Pre-flight** — auth check per tier (cached), input bounded to
   `maxInputChars` (6000) before *any* analysis, low-value work skipped
   (`learn` only on notable scores, dream synthesis only with material),
   content-hash cache so replayed journal entries are free.
2. **Per-call** — `AbortSignal.any([session, AbortSignal.timeout(tier)])`;
   deadlines 20s analysis / 60s reflect / 120s dream; exactly one retry,
   transient classes only, 200–600 ms jitter.
3. **Tier ladder** — classifier → analysis → reflect → session → heuristic.
4. **Breakers** — per model (3 failures → 5 min → single half-open probe) and
   per provider (shared across its models).
5. **Validation** — schema shape, range clamps, **per-field fallback** so a
   batch never fails wholesale; classifier confidence below
   `confidenceFloor` (0.4) hands that field to heuristics.
6. **Guaranteed floor** — heuristics never fail, so `observe()` always
   completes.
7. **Deferral, not fabrication** — aborting mid-observe leaves the journal
   entry in place; the next session replays it. After 3 attempts the
   observation commits with heuristics rather than being carried forever.
8. **Observability** — counters, breakers, budget, cache, deferrals and cost in
   `/soul-engine`; usage flows into pi's session totals.

### Gotchas encoded

- **`classify()` does not throw** on provider errors — it returns
  `stopReason: "error" | "aborted"`. The client normalises both paths, and the
  router treats an error response exactly like a failed tier.
- **Abort is not failure.** It must not degrade to heuristics, or a cancelled
  turn would write fabricated memories.
- **Engine output is untrusted** — it becomes memory content. Facts are
  sanitised (instruction-like text stripped), length-capped, and range-clamped
  before `remember()` ever sees them.

## 4. Configuration

```
engine=model|heuristic              # heuristic = fully offline, no model calls
classifierModel=openrouter/~typesafe/jev-latest
analysisModel=openrouter/~z-ai/glm-flash-latest
reflectModel=openrouter/~deepseek/deepseek-flash-latest
sessionModel=                       # empty → the session's active model
factsMode=model|heuristic
rubricScoring=hybrid|classifier|heuristic
confidenceFloor=0.4
cache=on|off
```

Env: `PI_SOUL_ENGINE`, `PI_SOUL_CLASSIFIER`, `PI_SOUL_ANALYSIS_MODEL`,
`PI_SOUL_REFLECT_MODEL`, `PI_SOUL_MODEL`, `PI_SOUL_FACTS`.

Resilience defaults live in `~/.pi/agent/souls/config.json`:

```json
{
  "resilience": {
    "retries": 1,
    "timeoutMs": { "analysis": 20000, "reflect": 60000, "dream": 120000 },
    "breakerFailures": 3,
    "breakerCooldownMs": 300000,
    "degradeAfter": 5
  },
  "budget": { "perMinute": 20, "perSession": 500 }
}
```

`/soul-engine` shows live status; `/soul-engine reset` clears breakers, budget
counters and the cache.

## 5. Measured (tests/perf.test.ts, on a phone)

| Property | Measurement |
|---|---|
| observation pipeline (heuristics) | **1290 ops/s** (0.78 ms/op) |
| batched analysis | **2 model calls**, vs 5 for the per-task path |
| cache hit vs cold call | **1218× cheaper** (0.006 ms vs 6.7 ms) |
| open breaker, 1000 calls | 13 ms, **0** provider calls |
| budget denial, 1000 calls | 13 ms |
| deadline enforcement | 82 ms for an 80 ms deadline |
| observe kickoff (sync) | **0.4 ms**, work finished at 1510 ms |
| cache under 20k distinct keys | bounded at 512, 37 ms |
| 5000 router calls | 84 ms, cache 128/128, 1 tier counter |
| 1 MB pasted exchange | bounded to **1198 tokens**, 1 ms |
| 500 memories: prompt+recall+stats | 3.6 ms |

## 6. Limits / next

- **Classifier confidence is coarse.** `score` answers are 4–5 level indices (so valence resolution is
  ±0.25), and measured confidences for a rubric criterion ranged **0.47–0.88**. The default
  `confidenceFloor` is therefore **0.4**: at 0.5 roughly a third of observed exchanges silently lost the
  classifier's rubric contribution to a heuristic fallback. Every evaluation records whether it fell
  back and why (`rubric_source` plus the classifier outcome in the trust chain), and the floor is
  configurable with `/soul-config confidenceFloor=…`.
- **No streaming or parallel tier racing** — tiers are tried in order. Racing
  (fire two, take the first) would halve worst-case latency at double cost.
- **Learning events are still command-driven** (`soul_learn`), matching
  upstream. One line in `observe()` (`this.evaluate` → `this.learn`) would make
  lesson distillation automatic — deliberately not taken, since it multiplies
  write volume.
- **`reflect` and `dream` synthesis are single-shot**; no retry-with-feedback
  (`malformed` responses just fall back to heuristics).
- **Budget is per session**, not persisted across sessions — a long-running
  install can spend its per-minute cap every session.
