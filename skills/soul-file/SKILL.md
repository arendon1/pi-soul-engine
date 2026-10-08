---
name: soul-file
description: Read, inspect, validate, and migrate .soul archives — the Soul Protocol portable file format (ZIP + JSON). Use when the human hands you a .soul file, asks to export/import/migrate a soul, or needs to inspect identity, memories, or state from an archive.
---

# Working with `.soul` files

A `.soul` file is a standard ZIP archive (format 1.0.0). Rename it to `.zip`
and open it with any archive tool.

## Layout

```
manifest.json                  # format_version, soul_id, stats (always readable)
soul.json                      # SoulConfig: identity, DNA, memory, state, evolution
state.json                     # denormalized copy of soul.json#state
dna.md                         # generated human-readable blueprint
memory/core.json               # {persona, human}
memory/episodic.json           # MemoryEntry[] (significance-gated experiences)
memory/semantic.json           # MemoryEntry[] (facts; superseded_by chains)
memory/procedural.json         # MemoryEntry[] (how-to patterns)
memory/graph.json              # {entities: {name: {entity_type, relationships[]}}}
memory/self_model.json         # {self_images: {domain: {confidence, evidence_count}}}
memory/general_events.json     # GeneralEvent[] (Conway theme clusters)
```

Encrypted archives (password export) keep `manifest.json` readable and store
every other entry with an `.enc` suffix (AES-256-GCM; the manifest sets
`encrypted: true`).

## Operations

- **Export the active soul**: `/soul-export [path] [--password]`
- **Import**: `/soul-import <path> [--password]` — replaces the active soul
- **Inspect**: unzip and read `soul.json` + `dna.md`; `jq` works fine
- **Validate**: JSON Schemas live in the reference repo `schemas/`
  (SoulConfig.schema.json, MemoryEntry.schema.json, …)

## MemoryEntry essentials

`id, type, content, importance (1-10), emotion, confidence, entities[],
created_at, access_timestamps[], somatic {valence, arousal, label},
significance, general_event_id, superseded_by`

Entries with `superseded_by` are historical (provenance), not current truth.

## Interop notes

- The directory form (`.soul/`) is identical minus `manifest.json`.
- Readers must ignore unknown keys and missing optional files.
- The manifest `checksum` field is reserved (empty string) in 1.0.0.
- Two layouts exist in the wild: the full runtime layout above and a minimal
  core variant (`identity.json` + `memory/{layer}.json` lists). Prefer the
  full layout when writing; accept both when reading.
