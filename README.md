# envpact-cli

[![npm version](https://img.shields.io/npm/v/envpact-cli.svg)](https://www.npmjs.com/package/envpact-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/chirag127/envpact-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/chirag127/envpact-cli/actions/workflows/ci.yml)

Zero-dependency CLI for **envpact** — a centralized, serverless,
Git-backed secrets manager for solo developers managing 100+ public
GitHub repositories.

> One private vault, every project, zero infrastructure, $0 forever.

## Why envpact?

If you maintain dozens of public repos, you can't commit `.env`
files. You also can't afford to duplicate the same `OPENAI_API_KEY`,
`STRIPE_SECRET_KEY`, and `DATABASE_URL` across 40 projects — when
they leak or expire, rotation becomes a 200-step manual nightmare.

envpact solves this with a **single private GitHub repo** holding a
single `secrets.json` file. Project-specific secrets reference
shared secrets via a `shared.KEY_NAME` syntax. Rotate once → every
project resolves the new value on next run.

## Installation

```bash
# Run with no install (recommended)
npx envpact-cli

# Or install globally
npm install -g envpact-cli
```

## Quick Start

```bash
# 1. Create your private vault (auto via gh CLI)
npx envpact-cli --init auto

# 2. In any project with a .env.example, generate .env
cd my-project
npx envpact-cli
# → resolves shared refs, prompts for missing values, writes .env

# 3. Sync secrets to GitHub Actions for CI/CD
npx envpact-cli --github
```

## How It Works

```
Your machine                 GitHub.com
─────────────────            ──────────────────────────
~/.envpact/secrets/  ←—git—→  chirag127/envpact-secrets (private)
                                ├── secrets.json
                                │   ├── shared: { OPENAI_API_KEY, … }
                                │   └── projects: { my-app: { … } }

cd my-project
envpact
  → reads .env.example
  → resolves "shared.OPENAI_API_KEY" → "sk-..."
  → writes .env (gitignored, mode 0600)
  → commits any new keys back to the vault
```

## Vault Schema

`secrets.json` (v2 — supports per-environment values):

```json
{
  "$schema": "https://envpact.oriz.in/schema/v2.json",
  "version": 2,
  "shared": {
    "OPENAI_API_KEY": "sk-proj-…",
    "DATABASE_URL_PROD": "postgresql://…"
  },
  "projects": {
    "my-app": {
      "_default_env": "production",
      "OPENAI_API_KEY": "shared.OPENAI_API_KEY",
      "PORT": "3000",
      "DATABASE_URL": {
        "development": "postgres://localhost/myapp_dev",
        "production": "shared.DATABASE_URL_PROD"
      }
    }
  }
}
```

**Resolution rules** (canonical, see [SHARED_SPEC](../envpact/blob/main/_build/specs/SHARED_SPEC.md) §1):

- A string starting with `shared.` is looked up in the `shared` block.
- A nested object selects the value for the requested environment
  (with fallback to a `default` key if defined).
- Encrypted values (prefixed `enc:`) are decrypted using your
  local age key (`~/.envpact/age.key`) at resolution time.

## Commands

| Command | Action |
| :--- | :--- |
| `envpact` | Generate `.env` for the current project |
| `envpact --init auto` | Create vault repo + clone via gh CLI |
| `envpact --init <git-url>` | Clone an existing vault repo |
| `envpact --env staging` | Use the `staging` environment |
| `envpact --github` | Sync resolved secrets to GitHub Actions |
| `envpact --rotate <KEY>` | Rotate a shared secret interactively |
| `envpact --list` | List all projects in the vault |
| `envpact --list-shared` | List shared secret names (values masked) |
| `envpact --add KEY=VALUE` | Add a project secret |
| `envpact --add-shared KEY=VAL` | Add a shared secret |
| `envpact --encrypt KEY` | Encrypt a shared secret in place (via age) |
| `envpact --dry-run` | Print what would be written |

Run `envpact --help` for the full flag list.

## Authentication

The CLI auto-detects which auth method to use, in this order:

1. **gh CLI** — if `gh auth status` succeeds, uses HTTPS via gh.
2. **SSH** — if `~/.ssh/id_ed25519` (or `id_rsa`) is present.
3. **HTTPS PAT** — if `GITHUB_TOKEN` env var is set.
4. **Plain HTTPS** — git's stored credentials.

## Encryption (opt-in)

If you want defense-in-depth on top of the private repo:

```bash
# One-time setup (creates ~/.envpact/age.key)
envpact --encrypt OPENAI_API_KEY

# Subsequent reads decrypt transparently if age + key are present.
```

Requires the [age](https://github.com/FiloSottile/age) binary.

## Security Model

- The vault repo MUST be private. envpact only reduces
  duplication and enables rotation; the trust root is GitHub.
- `.env` files are written with mode 0600 and added to
  `.gitignore` automatically.
- `--list-shared` only ever prints names (values masked).
- Encryption is opt-in per secret; never auto-encrypted.

## Multi-Component Ecosystem

| Component | Install |
| :--- | :--- |
| **envpact-cli** | `npx envpact-cli` (this) |
| envpact-mcp | MCP server for AI agents |
| envpact (Python) | `pip install envpact` |
| envpact-action | `chirag127/envpact-action@v0` (GitHub Action) |
| envpact-vscode | "envpact" in VS Code Marketplace |
| envpact-dashboard | https://envpact.oriz.in |

## License

MIT © Chirag Singhal — see [LICENSE](./LICENSE).
