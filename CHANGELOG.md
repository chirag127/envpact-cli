# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
