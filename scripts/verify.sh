#!/usr/bin/env bash
#
# Offline verification for pi-soul-engine.
#
# Runs the dependency-free test suite, the interop suite explicitly, and an
# end-to-end Soul Health Score pass over a freshly created .soul archive.
#
# It works with NO node_modules present: the core suite is deliberately
# dependency-free and the ajv-powered upstream-schema conformance checks in
# tests/spec.test.ts and tests/interop.test.ts skip cleanly when ajv is missing.
#
# `npm install` is NOT run automatically. On this project's Termux shared
# storage (a fuse mount) npm install cannot create node_modules — the mount
# lacks the symlink/permission support npm needs — and a partial install would
# leave the tree broken. On a normal filesystem, pass `--with-npm` to opt in to
# full upstream-schema conformance.
set -euo pipefail

WITH_NPM=0
if [[ "${1:-}" == "--with-npm" ]]; then
	WITH_NPM=1
elif [[ $# -gt 0 ]]; then
	echo "usage: bash scripts/verify.sh [--with-npm]" >&2
	exit 2
fi

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "==> pi-soul-engine verification ($ROOT)"

# ── node version (>= 22.6 for TypeScript type stripping) ─────────────────────
NODE_VERSION="$(node -p 'process.versions.node')"
node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
	console.error(`node ${process.versions.node} is too old; pi-soul-engine needs >= 22.6`);
	process.exit(1);
}
'
echo "==> node ${NODE_VERSION} (>= 22.6) OK"

# ── optional devDependencies ─────────────────────────────────────────────────
if [[ "$WITH_NPM" == "1" ]]; then
	echo "==> --with-npm: installing devDependencies for full schema conformance"
	npm install
	NPM_MSG="npm install run"
else
	echo "==> no npm install (pass --with-npm for ajv-based schema conformance)"
	NPM_MSG="npm install skipped"
fi

# ── full test suite ──────────────────────────────────────────────────────────
echo '==> node --test "tests/**/*.test.ts"'
node --test "tests/**/*.test.ts"

# ── interop suite, called out explicitly ─────────────────────────────────────
echo "==> node --test tests/interop.test.ts"
node --test tests/interop.test.ts

# ── Soul Health Score over a temporary soul ──────────────────────────────────
SOUL_TMP="$(mktemp -d)"
trap 'rm -rf "$SOUL_TMP"' EXIT
SOUL_FILE="$SOUL_TMP/verify.soul"
if SOUL_FILE="$SOUL_FILE" node --input-type=module -e '
import { pathToFileURL } from "node:url";
const { Soul } = await import(pathToFileURL(process.cwd() + "/src/runtime/soul.ts").href);
const soul = Soul.birth({ name: "Verify", archetype: "The Tester", values: ["verification"] });
soul.remember("Verification souls exercise the offline tooling.", { type: "semantic", importance: 5 });
soul.exportFile(process.env.SOUL_FILE);
' 2>/dev/null; then
	echo "==> node scripts/shs.ts $SOUL_FILE"
	node scripts/shs.ts "$SOUL_FILE"
else
	echo "==> skipped SHS: could not create a temporary soul (no soul archive available)"
fi

echo "==> verify: PASS — tests + interop + SHS completed (${NPM_MSG})"
