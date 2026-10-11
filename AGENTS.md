# For AI agents — deploying pi-soul

This file is the **entry point** for an agent being told to deploy
`pi-soul-engine`. Read it top to bottom, run the steps in order, and you
will reach a healthy install. If something goes wrong, the last section
points at the deeper runbook.

The repo is a standard Pi package: a single extension entry, two
auto-loaded skills, three prompt templates. The whole install is a
`pi install` away. The complications are operational, not architectural.

## The minimum to do

From the repo root, in order:

```sh
# 1. Sanity: Node >= 22.6 (needed for TypeScript type stripping).
node --version

# 2. Offline health check. MUST pass before anything else.
#    Runs the dependency-free test suite, the interop suite, and the
#    Soul Health Score over a fresh .soul.
bash scripts/verify.sh

# 3. Install.
pi install "$(pwd)"
# Or, for a one-off trial that does not modify pi settings:
pi -e "$(pwd)"

# 4. Restart pi (or /reload) so the new code is loaded.
```

If `verify.sh` is green and `pi install` produces **no `name "X"
collision` warnings**, the install is healthy. There is no step 5.

## The minimum to know

A soul is healthy when, in order of cost:

1. `bash scripts/verify.sh` exits 0.
2. `pi install` produces no collision warnings for prompts or skills.
3. The 11 model-facing tools, 18 `/soul*` commands, 3 skills, and 3 prompt
   templates (`/recall`, `/remember`, `/soul-report`) all appear in
   `/help`.
4. A short conversation produces a non-empty
   `~/.pi/agent/souls/pending-observations.json` (proves the observe
   pipeline is wired).
5. Soul Health Score on a fresh `.soul` is ≥ 70. Run
   `node scripts/shs.ts <path-to-soul>` for the 7-dimension breakdown
   (D1 memory recall · D2 emotional intelligence · D3 personality
   expression · D4 bond · D5 self-model · D6 identity continuity ·
   D7 portability).

If any of these fail, walk this list backwards — the failure point is
the diagnostic.

## Editing the source

The canonical edit → deploy cycle. `deploy.sh` refuses a dirty tree, so
the commit step is not optional.

```sh
cd /path/to/pi-soul
# Edit. The project .gitignore already excludes node_modules/, *.soul,
# coverage/, *.log, etc.
git add -A
git commit -m "describe the change"
# Default target is the source dir, so on a single-machine install this
# acts as a self-verification — re-extract committed files into place.
bash scripts/deploy.sh --apply
# Re-run the health check after every change to the extension entry,
# the package.json manifest, the cognitive engine, or the .soul codec.
bash scripts/verify.sh
# Restart pi (or /reload) so the new code is loaded.
```

`scripts/deploy.sh --with-npm` adds ajv-based schema conformance. Do not
run it on Termux shared-storage mounts — npm cannot create the symlinks
it needs there. The dependency-free test path (the default) is what
`verify.sh` runs without that flag.

## Hard rules — what will break the install if violated

These are the rules we have already hit and the runbook exists to keep
us from hitting again.

- **One source of truth for resources.** `package.json#pi.prompts` lists
  the three `.md` files; the extension's `resources_discover` handler
  must return only `skillPaths`. Returning `promptPaths` from the handler
  loads every template twice and `dedupePrompts` emits a
  `name "/X" collision` warning per template. To add a new template,
  append its path to `package.json#pi.prompts` and commit. Nothing else.

- **The source must be a git work tree.** `scripts/deploy.sh` uses
  `git archive HEAD` to produce the deployable. Without a HEAD the
  deploy fails with "not a git repository" or "working tree is dirty".
  If you find yourself in either state, see the recovery table in the
  skill.

- **Don't install dependencies in the deploy path.** The extension
  requires no `node_modules`; `node --test` runs the suite with the
  built-in test runner. `npm install` adds `ajv` for full upstream-schema
  conformance, but on a FUSE mount (e.g. Termux shared storage) it fails
  on symlink creation. Verify the offline path first; opt in to npm only
  when the filesystem supports it.

- **The engine needs no credentials to start, only to use model tiers.**
  With no `OPENROUTER_API_KEY` (or equivalent), the engine degrades to
  the heuristic floor — that is a feature, not an error. The `soul_engine`
  tool reports tier state. `soul_admin { action: "engine_reset" }`
  retries a stuck tier after a config change.

## When something is wrong

The deeper runbook is at `skills/soul-engine/SKILL.md` (also
auto-loaded by the extension via `package.json#pi.skills`). It contains
the four hard requirements in detail, a breakage-mode → fix table for
the problems we have actually hit, and the diagnostic ladder:

1. `bash scripts/verify.sh` — first-line health check.
2. `node scripts/shs.ts <path-to-soul>` — 7-dimension soul diagnostic.
3. `soul_engine` — live engine telemetry (tiers, breakers, budget, cache,
   audit). Use this for "model calls are slow" or "engine is degrading
   without explanation".
4. `git log --oneline` in the repo — what changed, when, and by whom.
   If a failure appeared after a commit, that commit is the suspect
   until proven otherwise.

If a future agent reads this file and still has to debug a basic
collision, dirty-tree error, or engine-not-starting issue from first
principles, **update `skills/soul-engine/SKILL.md`** with the new
breakage mode. That is the document that future agents will inherit.
