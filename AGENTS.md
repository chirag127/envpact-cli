# AGENTS.md — envpact-cli

## Project Context

`envpact-cli` is the Node.js CLI for envpact — a centralized,
serverless secrets manager for solo developers. It is the
**reference implementation** of the resolver and vault logic; the
Python module, MCP server, GitHub Action, and VS Code extension all
mirror its semantics bit-for-bit.

## Architecture

- **Vault**: private GitHub repo with `secrets.json` (**v3 schema** —
  flat, single-environment, per-key timestamps for conflict
  detection). See `_build/specs/SHARED_SPEC.md` §1 in the umbrella.
- **Local clone**: `~/.envpact/secrets/`.
- **Resolver**: `lib/resolver.js` — single source of truth for the
  `shared.KEY` reference and v3 entry-shape semantics. Auto-upgrades
  v1/v2 vaults in memory.
- **Sync**: `lib/sync.js` — per-key pull/push pipeline with
  conflict detection via `.env.example.lock` (a checked-in
  value-free state sidecar).
- **Auth**: auto-detected (gh / SSH / HTTPS PAT).

## Key Files

- `bin/envpact.js` — CLI entry point and command router.
- `lib/resolver.js` — vault → resolved secrets transform; v1/v2 → v3
  in-memory upgrade.
- `lib/vault.js` — load/save/mutate `secrets.json`; v3 entry helpers.
- `lib/sync.js` — per-key pull/push, conflict detection,
  `.env.example.lock` I/O.
- `lib/parser.js` — `.env.example` parsing, `.env` rendering,
  `parseEnvFileToMap()` for sync.
- `lib/git.js` — clone/pull/commit/push the vault repo.
- `lib/github.js` — `gh secret set` integration.
- `lib/age.js` — opt-in age encryption.
- `lib/prompt.js` — interactive readline prompts.
- `lib/config.js` — paths and defaults (v3 schema constants).
- `tests/*.test.js` — Node native test runner.

## Conventions

- **Zero runtime dependencies** — Node stdlib only.
- **CommonJS** for the CLI; this remains the reference port.
- Cross-platform paths via `path.join()` — the CLI MUST work on
  Windows, macOS, and Linux without modification.
- Atomic writes for `.env` and `secrets.json` (`.tmp` rename).
- **Never log secret values.** Mask with `****` in any output.
- `--list-shared` shows names only; values never leave the vault.
- All vault commits are `--signoff` and authored by `envpact-cli`.

## Testing

```bash
npm test                # run all tests
node --test tests/resolver.test.js   # run a specific suite
```

Coverage target: ≥80% for `resolver.js`, `parser.js`, `vault.js`,
`sync.js`. Mock the filesystem via `os.tmpdir()`; mock git via
`child_process` test doubles or by injecting stub Symbols.

## Adding a New Command

1. Define a `cmdXxx(...)` function in `bin/envpact.js`.
2. Add the flag to `parseArgs`'s `flags` or `valued` set.
3. Route it in `main()`.
4. Add a test in `tests/cli.test.js` (smoke-test only;
   resolver/vault unit tests are separate).
5. Update `printHelp()` and the README command table.

## Security Rules

- NEVER print secret values.
- NEVER include secret values in error messages.
- ALWAYS validate `secrets.json` schema before use.
- ALWAYS write `.env` with mode 0600.
- ALWAYS append `.env` to `.gitignore`.
- Handle auth failures gracefully — surface the failed method, not
  the credentials.
