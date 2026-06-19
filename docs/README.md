# envpact-cli — documentation

> The terminal CLI for envpact: initialize a vault, generate `.env`
> files for any project, rotate shared secrets across every project
> at once, sync to GitHub.

This is the reference implementation of envpact's vault format and
resolver pipeline; every other component (`envpact-mcp`,
`envpact-vscode`, the dashboard, etc.) reads and writes the same
schema this CLI does.

## Quick start

```bash
gh auth login                       # if you don't already have GitHub auth
npx -y envpact-cli --init           # creates <you>/envpact-secrets (private)
cd ~/my-project
npx -y envpact-cli                  # reads .env.example, writes .env
```

## Commands

| Command | What it does |
| :--- | :--- |
| `envpact-cli` (no args) | Read `.env.example` in cwd, resolve every key from your vault, write `.env`. Idempotent. |
| `envpact-cli --init` | One-time setup. Creates `<you>/envpact-secrets` repo and clones it to `~/.envpact/secrets`. |
| `envpact-cli add-shared <KEY> <VALUE>` | Add or update a shared secret. Available to every project that references `shared.<KEY>`. |
| `envpact-cli add <KEY> <VALUE>` | Add or update a project-local secret. |
| `envpact-cli rotate <KEY> <NEW_VALUE>` | Rotate a shared secret. Updates the value once; every project resolves to it next run. |
| `envpact-cli list` | Print every project / shared key currently in your vault. |
| `envpact-cli pull` | `git pull` your vault repo. |
| `envpact-cli push` | `git commit && git push` your vault repo. |

## Auth model

envpact-cli **only** uses your existing `gh auth` token. There is no
separate CLI login. If `gh auth status` says you're authenticated,
envpact-cli is authenticated.

If `gh` isn't installed, the CLI prompts you to install it. We don't
ship our own GitHub credential storage — that's an attack surface
that already has a battle-tested implementation in `gh`.

## Vault layout

The CLI creates and reads `~/.envpact/secrets/` — a clone of your
private `<you>/envpact-secrets` GitHub repo. Inside:

```
secrets.json    # the entire vault, JSON, schema v3
.git/           # standard git checkout
```

`secrets.json` shape:

```jsonc
{
  "version": 3,
  "metadata": { "updated_at": "2026-06-19T10:00:00Z" },
  "shared": {
    "OPENAI_API_KEY": { "value": "sk-...", "_modified_at": "2026-06-19T10:00:00Z" }
  },
  "projects": {
    "chirag127/my-app": {
      "OPENAI_API_KEY": { "value": "shared.OPENAI_API_KEY", "_modified_at": "2026-06-19T10:00:00Z" },
      "DATABASE_URL":   { "value": "postgresql://...",       "_modified_at": "2026-06-19T10:00:00Z" }
    }
  }
}
```

A leaf whose `value` starts with `shared.` is a **reference**: the
resolver substitutes the matching `shared` entry's value at read time.
Rotation is just updating one shared entry — every reference picks up
the new value next read.

## Multi-environment

Set `ENVPACT_ENV=production` (or pass `--env production`) to read the
production slot of any per-environment key. Per-environment keys look
like:

```jsonc
"DATABASE_URL": {
  "default":    { "value": "postgresql://localhost/dev",  "_modified_at": "..." },
  "production": { "value": "postgresql://prod-host/...", "_modified_at": "..." }
}
```

## Configuration

| Env var | Default | Purpose |
| :--- | :--- | :--- |
| `ENVPACT_VAULT_PATH` | `~/.envpact/secrets` | Override vault checkout path |
| `ENVPACT_ENV` | `default` | Which environment slot to resolve |
| `ENVPACT_PROJECT` | (auto-detected from git remote) | Override project name |

## See also

- [Umbrella docs](https://chirag127.github.io/envpact/) — project overview, security model
- [Architecture](https://chirag127.github.io/envpact/architecture.html) — how this CLI fits with the other tools
- [envpact-mcp](https://github.com/chirag127/envpact-mcp) — MCP server using the same vault
- [envpact-vscode](https://github.com/chirag127/envpact-vscode) — VS Code wrapper around this CLI
