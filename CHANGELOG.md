# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
