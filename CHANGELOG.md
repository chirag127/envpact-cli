# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-06-19

### Changed (BREAKING)

- **Vault schema bumped to v3** (flat, single-environment, per-key
  timestamps). Every shared and project leaf is now an entry object
  `{ value: string, _modified_at: ISO }` instead of a bare string or
  per-environment object. The resolver no longer takes an
  `environment` parameter — there is one environment per project. See
  [SHARED_SPEC §1](https://github.com/chirag127/envpact/blob/main/_build/specs/SHARED_SPEC.md).

### Removed

- `--env <name>` flag and the per-environment routing it implied.
  Users wanting multi-environment isolation use multiple project
  names (e.g. `my-app-prod` / `my-app-dev`) or multiple vaults.
- `listProjectEnvironments()` and the `_default_env` per-project
  metadata key.

### Added

- `--pull <KEY>` — pull a single key from the vault into the local
  `.env`. Refuses if the local copy is newer (per the
  `.env.example.lock` sidecar); use `--force` to override.
- `--push <KEY>` — push a single key from the local `.env` into the
  vault. Refuses if the vault is newer; use `--force` to override.
- `--status` — prints a per-key sync status table (`synced` /
  `local_newer` / `vault_newer` / `both_diverged` / `local_only` /
  `vault_only`). Never echoes values.
- `--force` — override conflict refusals on `--pull`/`--push`.
- `lib/sync.js` — per-key pull/push pipeline with conflict detection
  via `.env.example.lock` (a value-free state sidecar checked into
  git alongside `.env.example`).
- `lib/parser.js`: `parseEnvFileToMap()` returning a flat
  `{KEY: value}` map for sync comparisons.
- `lib/vault.js`: `getValue()`, `getModifiedAt()`,
  `isEncryptedEntry()` helpers for v3 entry inspection.

### Migration

- v1 (flat-string) and v2 (per-environment object) vaults
  **auto-upgrade lossily** in memory on first read. A loud warning is
  logged so the user notices the irreversible flattening of
  per-environment values. Reads do NOT rewrite the on-disk file —
  re-saving (e.g. via `--add`, `--push`, `--rotate`) is what
  persists the v3 shape. The umbrella ships
  `scripts/migrate-vault-v2-to-v3.mjs` for an explicit one-shot
  migration with a reviewable diff.

## [0.2.0] - 2026-06-16

### Fixed

- **AUDIT #15** — `parseArgs` now maintains an allowlist (flags ∪
  valued ∪ short aliases) and throws `unknown flag: <name>` for any
  unrecognised `--flag`, `--flag=value`, or unknown short flag. `--`
  is honoured as end-of-options, so `envpact -- --rotate-secret FOO`
  routes both tokens to `args._` unchanged. Bare `--init`,
  `--init auto`, and `--init=auto` continue to work because the
  allowlist check runs after the valued-flag fallback. Closes the
  silent-typo failure where `envpact --rotate-secret KEY` previously
  set `args.rotate_secret = true` and the actual key fell through to
  `args._`.

### Added

- `tests/argv.test.js` — 10 cases covering bare/valued/`=value` forms,
  rejection of `--rotate-secret`, `--foo=bar`, and unknown short flags,
  the `--` end-of-options behaviour, and short-alias acceptance.
- `parseArgs` is now exported from `bin/envpact.js`; `main()` is gated
  behind `require.main === module` so tests can require the file
  without firing the CLI.

### Notes

- AUDIT #1 (private-vault assertion), #2 (slug validation +
  array-form spawn), and #11 (decryptValue trailing-newline) shipped
  separately at commit `8013804` and remain in this release.

## [0.1.0] - 2026-06-15

### Added

- Initial release of `envpact-cli`.
- Zero-dependency Node.js CLI for resolving secrets from a private
  Git-backed vault into local `.env` files.
- Vault schema v2 with per-environment values and `shared.KEY` references.
- Auto-detection of git auth method (gh CLI / SSH / HTTPS PAT).
- Auto-pull / auto-push of vault state on each run.
- GitHub Actions secret sync via `gh secret set`.
- Opt-in age encryption for shared secrets.
- Interactive prompts for missing keys with shared/project routing.
- `--init auto` flow that creates the private vault repo via gh CLI.
- Full test suite (29 tests).

[0.1.0]: https://github.com/chirag127/envpact-cli/releases/tag/v0.1.0
