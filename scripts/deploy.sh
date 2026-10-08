#!/usr/bin/env bash
#
# Deploy this repository's tracked source into a runnable installation.
#
# Roles: this repository is the *source upstream*; the deployed directory is a
# *derived* installation that Pi loads. Deployment is therefore a one-way sync
# from `git archive HEAD`, never an edit-in-place.
#
# Usage:
#   bash scripts/deploy.sh                 # dry run: show what would change
#   bash scripts/deploy.sh --apply         # perform the deployment
#   bash scripts/deploy.sh --target DIR    # deploy somewhere else
#   bash scripts/deploy.sh --apply --with-npm   # also `npm install` in target
#
# Target resolution: --target DIR, else $PI_SOUL_DEPLOY_DIR, else ~/pi-soul.
#
# Properties:
#   * idempotent — deploying twice changes nothing the second time
#   * only tracked files are deployed (no node_modules, no soul data, no .git)
#   * managed paths are cleared before extraction, so files deleted upstream
#     actually disappear from the installation
#   * node_modules, package-lock.json and anything unmanaged (e.g. a project
#     .pi/ directory) are left untouched
#   * the executable bit on scripts is preserved (git index mode)

set -euo pipefail

APPLY=0
WITH_NPM=0
TARGET=""

while [[ $# -gt 0 ]]; do
	case "$1" in
		--apply) APPLY=1; shift ;;
		--dry-run) APPLY=0; shift ;;
		--with-npm) WITH_NPM=1; shift ;;
		--target)
			[[ $# -ge 2 ]] || { echo "--target needs a directory" >&2; exit 2; }
			TARGET="$2"; shift 2 ;;
		-h|--help) sed -n '2,26p' "$0"; exit 0 ;;
		*) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
	esac
done

cd "$(dirname "$0")/.."
REPO="$(pwd)"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	echo "error: $REPO is not a git repository; deployment is defined by tracked files" >&2
	exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
	echo "error: working tree is dirty; commit or stash first so the deployment is reproducible" >&2
	exit 1
fi

TARGET="${TARGET:-${PI_SOUL_DEPLOY_DIR:-$HOME/pi-soul}}"
TARGET="${TARGET%/}"
REV="$(git rev-parse --short HEAD)"

echo "==> deploying pi-soul-engine"
echo "    source: $REPO @ $REV"
echo "    target: $TARGET"
echo "    mode:   $([[ "$APPLY" == "1" ]] && echo APPLY || echo 'DRY RUN (pass --apply to write)')"

# Safety: refuse to clear anything that does not look like a soul deployment.
if [[ -e "$TARGET" ]]; then
	if [[ ! -d "$TARGET" ]]; then
		echo "error: target exists and is not a directory: $TARGET" >&2
		exit 1
	fi
	suspicious=0
	for marker in src/pi/extension.ts package.json skills prompts; do
		[[ -e "$TARGET/$marker" ]] && suspicious=$((suspicious + 1))
	done
	if [[ "$suspicious" == "0" && -n "$(ls -A "$TARGET" 2>/dev/null)" ]]; then
		echo "error: $TARGET is not empty and does not look like a pi-soul deployment" >&2
		echo "       pass --target DIR to deploy elsewhere" >&2
		exit 1
	fi
else
	echo "    note:   target does not exist yet; it will be created"
fi

# Paths managed by this repository. Cleared before extraction so upstream
# deletions propagate. Everything else in the target is preserved.
MANAGED=(
	.github .gitignore
	CHANGELOG.md COVERAGE.md ENGINE.md LICENSE NOTICE PLAN.md README.md package.json tsconfig.json
	prompts scripts skills src tests vendor
)

if [[ "$APPLY" != "1" ]]; then
	STAGE="$(mktemp -d)"
	trap 'rm -rf "$STAGE"' EXIT
	git archive HEAD | tar -x -C "$STAGE"
	echo "==> files that would be written: $(find "$STAGE" -type f | wc -l)"
	# node_modules and package-lock.json are deployment-owned: expected to differ.
	DIFF="$(diff -rq "$STAGE" "$TARGET" 2>/dev/null | grep -v 'node_modules\|package-lock.json' || true)"
	DRIFT="$(printf '%s' "$DIFF" | grep -c . || true)"
	echo "==> differences vs the current deployment: $DRIFT (excluding node_modules, package-lock.json)"
	if [[ "$DRIFT" != "0" ]]; then
		printf '%s\n' "$DIFF" | head -40 | sed "s|$STAGE|SOURCE|g; s|$TARGET|TARGET|g" | sed 's|^|    |'
	fi
	echo "==> dry run complete; nothing was written"
	exit 0
fi

mkdir -p "$TARGET"
for path in "${MANAGED[@]}"; do
	rm -rf "${TARGET:?}/$path"
done
git archive HEAD | tar -x -C "$TARGET"

if [[ "$WITH_NPM" == "1" ]]; then
	echo "==> npm install (devDependencies: ajv for schema conformance)"
	(cd "$TARGET" && npm install --no-audit --no-fund)
fi

echo "==> deployed $(find "$TARGET" -type f -not -path '*/node_modules/*' | wc -l) files to $TARGET (rev $REV)"
echo "==> verify with: (cd $TARGET && bash scripts/verify.sh)"
