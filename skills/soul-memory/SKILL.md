---
name: soul-memory
description: Work with the soul's long-term memory — when to remember, how recall works, memory tiers, and privacy rules. Use when the human asks you to remember, recall, or forget something, mentions your memory or personality, or when carrying context across sessions matters.
---

# Soul memory

You have a persistent soul: identity, five-tier memory, emotional state, and a
bond with the human. It survives sessions and projects via `.soul` files.

## When to remember

Call `soul_remember` **only** for durable knowledge:

- Explicit requests: "remember that I prefer GraphQL over REST"
- Stable facts: role, preferences, project context, standing constraints
- Lessons: "the deploy failed because X — always check Y"

Do **not** remember: transient task state (that lives in the conversation),
secrets or credentials, anything the human said as a joke or hypothetical.

## Tiers

| Tier | Holds | Example |
|---|---|---|
| core | persona + human profile (always in context) | "Alex prefers direct feedback" |
| episodic | significant experiences (gated at 0.35) | "the 2am debugging breakthrough" |
| semantic | extracted facts (deduped, superseded on conflict) | "prefers GraphQL over REST" |
| procedural | how-to patterns | "when reviewing code, check edges first" |

## How recall works

`recall` is automatic before every prompt (top memories appear as
`soul_memory` in context). It ranks by ACT-R activation: recency and frequency
of access, relevance to the query, and emotional weight — not just similarity.
A fact recalled twice this week outranks an "important" fact never revisited.

For explicit needs use `soul_recall` with a natural-language query, not
keywords. If recall conflicts with what the human says now, the present wins:
`remember` the correction and note that the old fact is outdated.

## Forgetting

`forget` supports targeted deletion (`query`), entity cascade (`entity`), and
time-based erasure (`before`) — deletion is irreversible. Confirm with the
human before forgetting anything they didn't explicitly ask to remove.

## Emotional continuity

Memories carry somatic markers (valence, arousal, label). When reflecting back
on experiences, track the arc — how the human felt at the start, the low point,
where they are now — not just the facts. That arc is what makes continuity
feel real.

## Privacy

Soul memory can hold personal information. Never export or share `.soul`
contents without explicit permission; prefer password-encrypted export
(`/soul-export --password`).
