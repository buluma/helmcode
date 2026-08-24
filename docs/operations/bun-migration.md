# pnpm → Bun Migration

> For maintainers. Assesses migrating the workspace package manager from pnpm to
> Bun. **Status: not recommended at this time** — see [Recommendation](#recommendation).

## Current state

- Package manager pinned at the root: `packageManager: pnpm@11.10.0`, enforced
  via `engines.node: ^24.13.1`.
- 16 `package.json` files across the workspace (`apps/*`, `packages/*`,
  `infra/relay`, `scripts`, `oxlint-plugin-helmcode`) use the `catalog:`
  protocol for shared dependency versions.
- 11 of those packages also use the `workspace:` protocol for internal
  cross-package deps.
- CI (`.github/workflows/ci.yml`, `release.yml`) does not call `pnpm` directly.
  All install/build/test/lint steps route through `vp` (vite-plus, via
  `voidzero-dev/setup-vp@v1`), which wraps the package manager. `release.yml`
  additionally commits `pnpm-lock.yaml` directly as part of its version-bump
  step (around line 1048–1056).
- Bun is already present as a **runtime** dependency
  (`@effect/platform-bun` in `apps/server`), not as the package manager.

## Blockers

`pnpm-workspace.yaml` uses several pnpm-only features with no direct Bun
equivalent:

| Feature                                                                                              | Purpose                                                                                                                      | Bun equivalent                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `allowBuilds`                                                                                        | pnpm 11 build-script gating per dependency                                                                                   | `trustedDependencies` in package.json — different mechanism, needs a full rewrite of the allow/deny list                                                                                   |
| `minimumReleaseAge` / `minimumReleaseAgeExclude`                                                     | Quarantines newly published package versions for 24h as a supply-chain safety net                                            | none — no Bun feature does this                                                                                                                                                            |
| `packageExtensions`                                                                                  | Injects deps/peerDeps into third-party packages that declare them incorrectly (`@clerk/expo`, `@effect/vitest`, `vite-plus`) | none                                                                                                                                                                                       |
| `peerDependencyRules.allowAny`                                                                       | Relaxes peer-dependency version checks (used for `vite`)                                                                     | none exposed the same way                                                                                                                                                                  |
| `overrides` with selector syntax (e.g. `"@clerk/clerk-js>@base-org/account": "-"`)                   | Removes transitive deps by path                                                                                              | Bun has `overrides`, but selector syntax differs and needs re-verification per entry                                                                                                       |
| `patchedDependencies` (12 patches: `@clerk/expo`, `effect`, `react-native-*`, `@pierre/diffs`, etc.) | Applies local patches to third-party packages                                                                                | `bun patch` exists but patch file format and application order differ; every patch needs to be regenerated and re-verified                                                                 |
| `catalog:` protocol (16 packages)                                                                    | Single source of truth for shared dependency versions                                                                        | No catalog support as of pinned pnpm 11 feature parity; would require converting every `catalog:` reference to pinned versions or relying on Bun's own (newer, less proven) catalog syntax |

Additionally:

- `vp` (vite-plus) is the actual interface CI and local scripts use for
  installs/builds — unclear whether it supports Bun as a backend. This needs
  confirming with vite-plus upstream before anything else, since it sits
  between all workspace tooling and the package manager.
- `release.yml` assumes a `pnpm-lock.yaml` file exists and diffs/commits it
  automatically during version bumps; a lockfile-format swap touches that
  release automation, not just install commands.

## What Bun migration would require (if pursued)

1. Confirm `vp`/vite-plus supports Bun as a package-manager backend.
2. Rebuild `allowBuilds` as Bun's `trustedDependencies` per package.
3. Decide how to replace `minimumReleaseAge` — Bun has no equivalent, so this
   supply-chain protection would be dropped or re-implemented externally
   (e.g. a CI check against npm publish timestamps).
4. Rewrite `overrides` and `packageExtensions` behavior — some entries may
   have no Bun equivalent and require patching the affected packages directly
   instead.
5. Regenerate all 12 entries in `patchedDependencies` using `bun patch` and
   verify each against the original pnpm patch's intent.
6. Replace every `catalog:` reference (16 files) with either pinned versions
   or Bun's native catalog support, then verify resolution matches current
   lockfile output for critical deps (`effect`, `@effect/platform-*`, Clerk
   packages).
7. Update `release.yml`'s lockfile commit step to target `bun.lock` instead of
   `pnpm-lock.yaml`.
8. Regenerate the lockfile and diff resolved versions against
   `pnpm-lock.yaml` for any silent version drift, especially around the
   patched and quarantined packages above.
9. Re-run full CI matrix (desktop, server test shards, mobile lint, resource
   monitor) against the new lockfile before cutting over.

## Recommendation

Do not migrate now. `minimumReleaseAge`, `allowBuilds`, and
`packageExtensions` are active supply-chain and dependency-resolution
safeguards with no Bun equivalent — migrating means dropping them or building
replacements from scratch. Combined with 12 unverified patches and 16 files'
worth of `catalog:` references to convert, this is a multi-day effort with
real risk of silent dependency-resolution drift, not a package-manager swap.

Revisit if:

- Bun ships a `minimumReleaseAge`-equivalent supply-chain gate, and
- vite-plus confirms first-class Bun support, and
- there's a concrete driver (e.g. install-speed pain, a pnpm-specific bug)
  that outweighs the rework cost above.
