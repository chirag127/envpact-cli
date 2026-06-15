# Contributing to envpact-cli

Thanks for your interest! This project is part of the
[envpact ecosystem](https://github.com/chirag127/envpact).

## Development Setup

```bash
git clone https://github.com/chirag127/envpact-cli.git
cd envpact-cli
# No install needed — zero runtime dependencies.
node --test tests/*.test.js
```

## Pull Requests

1. Fork & branch from `main`.
2. Add tests covering your change.
3. Run `node --test tests/*.test.js` and confirm 100% pass.
4. Update `CHANGELOG.md` under "Unreleased".
5. Open a PR with a clear description.

## Code Style

- Zero external runtime dependencies. The CLI must remain stdlib-only.
- CommonJS modules (`require`/`module.exports`).
- Cross-platform paths (`path.join`).
- Atomic writes for any user-facing file.
- Never log secret values, even in error paths.

## Reporting Issues

Please open issues at https://github.com/chirag127/envpact-cli/issues.
For security disclosures, email whyiswhen@gmail.com directly.
