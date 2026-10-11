---
name: soul-engine
description: Operate pi-soul-engine end-to-end — install, source/deploy, engine configuration, health checks, and recovery from the common breakage modes. Use when the human mentions deploying, installing, or upgrading pi-soul, when a soul is "not working", when the extension fails to load, when prompt templates or skills collide, when the engine won't start, or before touching `package.json#pi`, `~/.pi/agent/souls/`, or `scripts/deploy.sh`.
---

# Soul engine — operational runbook

This is the file that should have existed the first three times we tried to
get pi-soul to a clean install. The friction is real, and almost all of it
comes from the source/deploy separation and the dual registration of
resources. Read this before changing anything in `package.json#pi`,
`scripts/deploy.sh`, or the extension entry point.

## What "healthy" means

A soul is healthy when **all** of the following hold, in order of cost:

1. `bash scripts/verify.sh` exits 0 (test suite + interop + SHS).
2. `pi install` produces **no `name "X" collision` warnings** in pi's startup
   diagnostics.
3. The 11 model-facing tools, 18 `/soul*` commands, 2 skills, and 3 prompt
   templates (`recall`, `remember`, `soul-report`) all show up in the help
   output.
4. A short conversation produces a non-empty `pending-observations.json`
   inside `~/.pi/agent/souls/` (proves the observe pipeline is wired).
5. Soul Health Score (D1–D7) on a fresh `.soul` is ≥ 70. Run
   `node scripts/shs.ts <path-to-soul>` for the 7-dimension breakdown.

If any of these fail, do not start changing source code. Walk this skill
backwards and find the earliest failing step.

## Hard requirements

The package works once these four conditions are met. It is broken in
subtle, hard-to-debug ways when any of them is violated.

### 1. The source is a git repo

`scripts/deploy.sh` is the only sanctioned path from source to install. It
uses `git archive HEAD`, so a working tree without a HEAD is a fatal error
("refuses a dirty tree" is the *working-tree* check; "not a git repository"
is the *no-HEAD* failure mode). If `~/pi-soul` is not a git repo:

```sh
cd ~/pi-soul
git init -b main
git add .                      # .gitignore handles node_modules/, *.soul, etc.
git commit -m "Initial commit: pi-soul baseline"
```

The first commit establishes the baseline; subsequent changes commit → deploy
→ verify. The home directory may also be a git repo (`~` is a separate
work-tree from `~/pi-soul`); keep them isolated — pi-soul's `.git/` lives
inside `pi-soul/` and the parent repo treats `pi-soul/` as an untracked
subdirectory.

### 2. `package.json#pi` is the single source of truth for resources

Three sections, **declared in package.json, never duplicated in code**:

- `extensions`: list of extension entry files (currently `src/pi/extension.ts`)
- `skills`: list of skill directories (`skills/soul-memory`, …)
- `prompts`: list of **individual `.md` files** in `prompts/`

The extension entry point's `resources_discover` handler returns
`skillPaths` only. It must **not** return `promptPaths` — the static loader
reads the file list from `package.json#pi.prompts` and the runtime scan
walks the directory, so returning the directory from the handler loads
every template twice and `dedupePrompts` emits a `name "/X" collision`
warning per template. This is the bug we have already fixed; do not
re-introduce it.

If a new template is added, append its path to `package.json#pi.prompts`
**and** commit. That is the only step.

### 3. Engine configuration has a runtime path

Two layers, in order of preference:

- **Persistent config**: `~/.pi/agent/souls/config.json` — survives across
  sessions. Edit with `soul_config { action: "set", key, value }` or by
  hand. The shape is the `SoulManagerConfig` interface; unknown keys are
  rejected.
- **Per-session overrides** (env vars, read by the extension at startup):
  - `PI_SOUL_DIR` — soul data directory (default `~/.pi/agent/souls/`)
  - `PI_SOUL_USER` — bind the active project to a non-default soul
  - `PI_SOUL_ENGINE=heuristic` — disable the model tiers entirely (offline)
  - `PI_SOUL_MODEL` — override the session-model tier
  - `PI_SOUL_CLASSIFIER` / `PI_SOUL_ANALYSIS_MODEL` / `PI_SOUL_REFLECT_MODEL`
    — override individual engine tiers
  - `PI_SOUL_FACTS=heuristic` — disable the model facts/entities pass
  - `PI_SOUL_REFLECT_EVERY=N` — change the reflection cadence (default 8)

The model tiers need `OPENROUTER_API_KEY` (or the equivalent provider key
configured in `~/.pi/agent/auth.json`). With no credentials the engine
degrades to heuristics — that is a feature, not an error; `soul_engine`
will report it as expected.

### 4. The detached worker can spawn

The soul worker is a `node` child process running TypeScript via type
stripping (Node ≥ 22.6). It owns persistence, ZIP deflate, and AES-256-GCM
so the agent loop is never blocked. On filesystems that cannot create the
node IPC channel (some FUSE mounts, see `scripts/verify.sh` for the
discussion), the client degrades to inline mode — everything still works,
just on pi's event loop. `soul_engine { action: "engine_reset" }` retries
the spawn; check `soul_engine`'s `audit.lastError` if it keeps failing.

## Deploy workflow

This is the one path from a source edit to a running install. Do not invent
new ones.

```sh
cd ~/pi-soul
# 1. Edit source. The .gitignore at the project root already excludes
#    node_modules/, *.soul, coverage/, *.log, etc.
# 2. Commit. deploy.sh refuses a dirty tree, so this step is mandatory.
git add -A
git commit -m "describe the change"
# 3. Sync to the deploy target. Default target is ~/pi-soul itself, so on
#    a single-machine install this acts as a self-verification — re-extract
#    the committed files into the same path, fail loudly on drift.
bash scripts/deploy.sh --apply
# 4. Offline health check. Runs the dependency-free test suite, interop
#    suite, and the SHS over a fresh .soul.
bash scripts/verify.sh
# 5. Restart pi (or run /reload) so the new extension code is loaded.
```

`scripts/deploy.sh --with-npm` adds `npm install` for full ajv-based schema
conformance. Do not run this on Termux shared-storage mounts — npm cannot
create the symlinks it needs there.

## Common breakage and the fix

| Symptom | Cause | Fix |
|---|---|---|
| `name "/recall" collision` warning at startup | `promptPaths` returned from `resources_discover` while `package.json#pi.prompts` already lists the files | Remove the `promptPaths` line from `src/pi/extension.ts`. Skills stay. |
| `error: $REPO is not a git repository` from deploy.sh | pi-soul is not a git work tree | `git init -b main` in `~/pi-soul`, commit, retry. |
| `error: working tree is dirty` from deploy.sh | Uncommitted edits in `~/pi-soul` | Commit (or stash) first. |
| `/recall`, `/remember`, `/soul-report` missing | Extension not loaded, or loaded with no `pi` manifest | Check `pi` packages list includes pi-soul; restart pi. |
| All model calls fail with auth errors | `OPENROUTER_API_KEY` missing | Run `/login` or set the env var. Heuristics will still work. |
| Engine stuck on a tier (e.g. analysis) | Circuit breaker open | `soul_admin { action: "engine_reset" }`. Inspect `soul_engine` for breaker state. |
| `pending-observations.json` never appears | Extension not running, or `agent_end` not firing | Open the logs, confirm the extension loaded (look for the bridge attach in startup). |
| `node_modules` keeps getting committed | The source dir's `.gitignore` was missing or wrong | The shipped `.gitignore` covers `node_modules/`, `*.soul`, `coverage/`, `*.log`, `tmp/`, IDE dirs. If missing, restore from the repo. |
| `deploy.sh --with-npm` fails on FUSE | Filesystem can't create npm symlinks | Drop `--with-npm`; the dependency-free test path is what `verify.sh` runs by default. |
| Bare extension load has no prompt templates | `pi --extension src/pi/extension.ts` does not read `package.json#pi.prompts` | Expected. Use `pi install` for the full feature set. |

## When in doubt

1. `bash scripts/verify.sh` — first-line health check. If this fails, no
   further work makes sense until it passes.
2. `node scripts/shs.ts <path-to-soul>` — 7-dimension diagnostic on a
   specific soul. Use this to localise a "the soul feels off" complaint.
3. `soul_engine` — live engine telemetry (tiers, breakers, budget, cache,
   audit). Use this when the issue is "model calls are slow" or "engine is
   degrading without explanation".
4. `git log --oneline` in `~/pi-soul` — what changed, when, and by whom.
   If the failure appeared after a commit, that commit is the suspect
   until proven otherwise.

The cost of an hour spent reading this file is small. The cost of an hour
spent debugging a duplicate-resource warning that the runbook already
documents is not.
