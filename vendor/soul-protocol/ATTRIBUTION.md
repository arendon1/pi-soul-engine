# Attribution — vendored Soul Protocol schemas

The JSON Schema files under `schemas/` in this directory are **copied verbatim,
unmodified**, from the upstream Soul Protocol reference implementation. They are
vendored so that conformance can be verified **offline and repeatably**, without
cloning the upstream repository or installing anything from npm.

## Source

- **Repository:** https://github.com/qbtrix/soul-protocol
- **Commit:** `b6ab6ee3bb644a6e27f08af551a155b37c7925c2`
- **Path:** `schemas/`
- **License:** MIT
- **Copyright:** Copyright (c) 2026 OCEAN Foundation

The full upstream license text is reproduced in the project root `LICENSE` /
`NOTICE` files. The vendored files remain under the upstream MIT license; they
are redistributed here under the terms of that license.

## Re-syncing

From the `pi-soul-engine` repository root, with an upstream checkout available:

```sh
cp -r <upstream>/schemas/ vendor/soul-protocol/schemas/
```

For example, for a checkout at `$HOME/soul-work/soul-protocol`:

```sh
cp -r "$HOME/soul-work/soul-protocol/schemas/." vendor/soul-protocol/schemas/
```

After copying, confirm the vendored tree is byte-for-byte identical:

```sh
diff -r "$HOME/soul-work/soul-protocol/schemas/" vendor/soul-protocol/schemas/
```

`tests/interop.test.ts` also asserts the expected schema files are present and
parse as JSON, so a bad or partial sync is caught by the test suite.

## Notes

- The schemas directory is copied **as-is**; do not reformat or edit these files.
- The schema resolution order used by the tests is: `SOUL_SCHEMAS_DIR` (explicit
  override) → this vendored default → a developer checkout under
  `$HOME/soul-work/soul-protocol/schemas`. See `tests/spec.test.ts` and
  `tests/interop.test.ts`.
