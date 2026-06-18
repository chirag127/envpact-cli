#!/usr/bin/env node
'use strict';

/**
 * envpact-cli — Centralized, serverless secrets manager for solo
 * developers managing 100+ public GitHub repos. One private vault
 * repo, every project, zero infrastructure.
 *
 * https://github.com/chirag127/envpact-cli
 *
 * Copyright (c) 2026 Chirag Singhal — MIT License
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  CONFIG_DIR,
  CONFIG_FILE,
  SECRETS_DIR,
  SECRETS_FILE,
  DEFAULT_CONFIG,
  DEFAULT_VAULT,
} = require('../lib/config');
const {
  resolveProject,
  listProjectEnvironments,
  maskValue,
  ENC_PREFIX,
} = require('../lib/resolver');
const {
  loadVault,
  saveVault,
  setProjectSecret,
  setSharedSecret,
  ensureProjectExists,
  findReferencingProjects,
  defaultVault,
} = require('../lib/vault');
const {
  parseEnvFile,
  renderEnvFile,
  writeEnvFileAtomic,
  ensureGitignoreCovers,
} = require('../lib/parser');
const {
  clone,
  pull,
  commitAndPush,
  detectProjectFromGit,
  getRemoteUrl,
  ghAvailable,
  ensureRepoExistsViaGh,
} = require('../lib/git');
const { ask, askSecret, confirm, isInteractive } = require('../lib/prompt');
const githubSync = require('../lib/github');
const ageMod = require('../lib/age');

const VERSION = require('../package.json').version;

// ---------------------------------------------------------------
// CLI argument parsing — zero-dep, mirrors POSIX getopt-like rules
// ---------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  const flags = new Set([
    '--github',
    '-g',
    '--dry-run',
    '--list',
    '--list-shared',
    '--vault-pull',
    '--vault-push',
    '--version',
    '-v',
    '--help',
    '-h',
    '--no-push',
    '--no-pull',
    '--from-stdin',
    '--quiet',
    '-q',
  ]);
  const valued = new Set([
    '--init',
    '--project',
    '--env',
    '--env-file',
    '--output',
    '--rotate',
    '--add',
    '--add-shared',
    '--encrypt',
    '--decrypt',
    '--vault-url',
    '--vault-repo',
  ]);
  // AUDIT #15 — allowlist of every recognised flag/short alias. Anything
  // outside this set is rejected loudly so typos like `--rotate-secret`
  // can no longer fall through as a truthy `args.rotate_secret`.
  const known = new Set([...flags, ...valued]);
  let endOfOptions = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (endOfOptions) {
      args._.push(a);
      continue;
    }
    if (a === '--') {
      endOfOptions = true;
      continue;
    }
    if (flags.has(a)) {
      args[a.replace(/^-+/, '').replace(/-/g, '_')] = true;
    } else if (valued.has(a)) {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        args[a.replace(/^-+/, '').replace(/-/g, '_')] = true;
      } else {
        args[a.replace(/^-+/, '').replace(/-/g, '_')] = next;
        i++;
      }
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const base = eq > 0 ? a.slice(0, eq) : a;
      if (!known.has(base)) {
        throw new Error(`unknown flag: ${a}. See \`envpact --help\`.`);
      }
      if (eq > 0) {
        const k = base.slice(2).replace(/-/g, '_');
        args[k] = a.slice(eq + 1);
      } else {
        args[base.slice(2).replace(/-/g, '_')] = true;
      }
    } else if (a.startsWith('-') && a.length > 1) {
      // Short flag — must be in the allowlist (e.g. -g, -v, -h).
      if (!known.has(a)) {
        throw new Error(`unknown flag: ${a}. See \`envpact --help\`.`);
      }
      args[a.replace(/^-+/, '')] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ---------------------------------------------------------------
// Help & version
// ---------------------------------------------------------------

function printHelp() {
  console.log(`envpact v${VERSION} — centralized secrets manager

Usage:
  envpact [options]

Options:
  --init [<git-url>|auto]    Initialize the local vault. Pass 'auto'
                              to create a new private repo via gh CLI.
  --vault-url <url>          Explicit vault git URL (overrides config).
  --vault-repo <slug>        Vault repo slug (e.g. user/envpact-secrets).
  --project <name>           Project override (else: git remote / cwd).
  --env <name>               Environment (development/staging/production).
  --env-file <path>          .env.example path (default: .env.example).
  --output <path>            .env output path (default: .env).
  -g, --github               Sync resolved secrets to GitHub Actions.
  --dry-run                  Print resolved env, do not write.
  --rotate <key>             Rotate a shared secret interactively.
  --list                     List all projects in the vault.
  --list-shared              List shared secret names (values masked).
  --add <KEY>=<VALUE>        Add/update a project secret.
  --add-shared <KEY>=<VAL>   Add/update a shared secret.
  --encrypt <KEY>            Encrypt a shared secret with age.
  --decrypt <KEY>            Decrypt a shared secret with age.
  --vault-pull               Pull latest vault state and exit.
  --vault-push               Push pending vault state and exit.
  --no-pull                  Skip auto-pull this run.
  --no-push                  Skip auto-push this run.
  -v, --version              Print version.
  -h, --help                 Show this help.

Documentation: https://envpact.oriz.in
`);
}

// ---------------------------------------------------------------
// Local config helpers
// ---------------------------------------------------------------

function loadLocalConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch (_e) {
    return { ...DEFAULT_CONFIG };
  }
}

function saveLocalConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

// ---------------------------------------------------------------
// init — clone vault or create-then-clone via gh
// ---------------------------------------------------------------

async function cmdInit(arg) {
  if (fs.existsSync(SECRETS_DIR)) {
    console.log(`Vault already initialised at ${SECRETS_DIR}`);
    return;
  }
  let vaultUrl;
  let repoSlug;
  if (!arg || arg === 'auto') {
    if (!ghAvailable()) {
      throw new Error(
        'gh CLI is not authenticated. Run `gh auth login` or pass an explicit git URL.'
      );
    }
    const ghUser = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
    }).trim();
    repoSlug = `${ghUser}/envpact-secrets`;
    console.log(`Creating private repo ${repoSlug}…`);
    try {
      ensureRepoExistsViaGh(repoSlug, true);
    } catch (e) {
      if (!String(e.message).includes('exists')) throw e;
    }
    vaultUrl = `https://github.com/${repoSlug}.git`;
  } else {
    vaultUrl = arg;
    const m = vaultUrl.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) repoSlug = `${m[1]}/${m[2]}`;
  }

  console.log(`Cloning ${vaultUrl} → ${SECRETS_DIR}`);
  try {
    clone(vaultUrl, SECRETS_DIR, repoSlug);
  } catch (e) {
    // Empty repo case: clone may fail; init manually
    if (!fs.existsSync(SECRETS_DIR)) {
      fs.mkdirSync(SECRETS_DIR, { recursive: true });
    }
    execFileSync('git', ['-C', SECRETS_DIR, 'init', '-q', '-b', 'main']);
    execFileSync('git', [
      '-C',
      SECRETS_DIR,
      'remote',
      'add',
      'origin',
      vaultUrl,
    ]);
  }

  // Seed secrets.json if missing
  if (!fs.existsSync(SECRETS_FILE)) {
    saveVault(defaultVault(), SECRETS_FILE);
    fs.writeFileSync(
      path.join(SECRETS_DIR, '.gitignore'),
      '# envpact vault — keep this repo PRIVATE\n'
    );
    fs.writeFileSync(
      path.join(SECRETS_DIR, 'README.md'),
      `# envpact-secrets

This is your **private** envpact secrets vault. Never make this
repository public.

See https://envpact.oriz.in for documentation.
`
    );
    const r = commitAndPush(SECRETS_DIR, 'envpact: initial vault');
    if (!r.pushed && r.committed) {
      console.warn(`  ! commit succeeded but push failed: ${r.pushError}`);
    }
  }

  saveLocalConfig({
    ...loadLocalConfig(),
    vault_repo: repoSlug || '',
    vault_url: vaultUrl,
    last_sync: new Date().toISOString(),
  });
  console.log(`✓ Vault initialised at ${SECRETS_DIR}`);
}

// ---------------------------------------------------------------
// Generate — the default action
// ---------------------------------------------------------------

async function cmdGenerate(args) {
  if (!fs.existsSync(SECRETS_FILE)) {
    throw new Error(
      'No vault configured. Run `envpact --init <git-url>` or `envpact --init auto`.'
    );
  }

  const cwd = process.cwd();
  const project = (args.project || detectProjectFromGit(cwd)).toLowerCase();
  const envExamplePath = args.env_file || '.env.example';
  const outputPath = args.output || '.env';

  // Auto-pull
  if (!args.no_pull) {
    const r = pull(SECRETS_DIR);
    if (!r.ok) {
      console.warn(`  ! vault pull warning: ${r.stderr.split('\n')[0]}`);
    }
  }

  let vault = loadVault(SECRETS_FILE);
  ensureProjectExists(vault, project);

  const exampleData = parseEnvFile(envExamplePath);
  const requiredKeys = exampleData.keys;

  let mutated = false;

  // First-pass resolve
  let result = resolveProject(vault, project, args.env);
  console.log(
    `→ project=${project} env=${result.environment} keys=${requiredKeys.length}`
  );

  // Walk required keys; prompt for anything missing or unresolved.
  for (const key of requiredKeys) {
    const have = key in result.resolved && result.resolved[key] !== undefined;
    if (have) continue;
    if (!isInteractive() && !args.dry_run) {
      console.warn(`  ! missing: ${key} (non-interactive; skipping)`);
      continue;
    }
    if (args.dry_run) {
      console.warn(`  ? would prompt: ${key}`);
      continue;
    }
    console.log(`  ? ${key} not set for ${project}/${result.environment}`);
    const useShared = await confirm(
      `    Use a shared secret for ${key}?`,
      false
    );
    if (useShared) {
      const sharedKey = (await ask(
        `    Shared key name [default: ${key}]: `
      )).trim() || key;
      if (!(sharedKey in (vault.shared || {}))) {
        const val = await askSecret(
          `    Value for shared.${sharedKey}: `
        );
        setSharedSecret(vault, sharedKey, val);
      }
      setProjectSecret(
        vault,
        project,
        key,
        `shared.${sharedKey}`,
        args.env
      );
    } else {
      const val = await askSecret(
        `    Value for ${project}.${key}${args.env ? ' (' + args.env + ')' : ''}: `
      );
      setProjectSecret(vault, project, key, val, args.env);
    }
    mutated = true;
    result = resolveProject(vault, project, args.env);
  }

  // Decrypt enc: values now (lazy)
  for (const key of Object.keys(result.resolved)) {
    const v = result.resolved[key];
    if (typeof v === 'string' && v.startsWith(ENC_PREFIX)) {
      try {
        result.resolved[key] = ageMod.decryptValue(v);
      } catch (e) {
        console.warn(`  ! could not decrypt ${key}: ${e.message}`);
        delete result.resolved[key];
      }
    }
  }

  if (args.dry_run) {
    console.log('--- DRY RUN OUTPUT ---');
    for (const k of requiredKeys) {
      if (k in result.resolved) {
        console.log(`${k}=${maskValue(result.resolved[k])}`);
      }
    }
    return;
  }

  // Write .env atomically
  const orderedKeys = requiredKeys.length
    ? requiredKeys
    : Object.keys(result.resolved);
  const content = renderEnvFile(orderedKeys, result.resolved, {
    environment: result.environment,
    project,
  });
  writeEnvFileAtomic(outputPath, content);
  ensureGitignoreCovers(cwd, '.env');
  console.log(`✓ Wrote ${outputPath} (${Object.keys(result.resolved).length} keys)`);

  // Persist vault changes
  if (mutated) {
    saveVault(vault, SECRETS_FILE);
    if (!args.no_push) {
      const r = commitAndPush(
        SECRETS_DIR,
        `envpact: update ${project} (${result.environment})`
      );
      if (r.committed && !r.pushed) {
        console.warn(`  ! push failed: ${r.pushError}`);
      } else if (r.pushed) {
        console.log('✓ Vault changes pushed');
      }
    }
  }

  // Optional GitHub Actions sync
  if (args.github) {
    const remote = getRemoteUrl(cwd);
    const m = remote.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!m) {
      throw new Error(
        '--github requires a git remote. Run inside a git repository with origin set.'
      );
    }
    const repoSlug = `${m[1]}/${m[2]}`;
    console.log(`→ syncing to ${repoSlug} GitHub Actions secrets…`);
    const n = githubSync.syncResolved(repoSlug, result.resolved, {
      environment: args.env,
    });
    console.log(`✓ Synced ${n}/${Object.keys(result.resolved).length} secrets`);
  }
}

// ---------------------------------------------------------------
// List / mutate commands
// ---------------------------------------------------------------

function cmdList() {
  const vault = loadVault(SECRETS_FILE);
  const projects = Object.keys(vault.projects || {}).sort();
  if (!projects.length) {
    console.log('(no projects yet)');
    return;
  }
  for (const p of projects) {
    const envs = listProjectEnvironments(vault, p);
    const keyCount = Object.keys(vault.projects[p]).filter(
      (k) => !k.startsWith('_')
    ).length;
    console.log(
      `  ${p}  (${keyCount} keys${envs.length ? ', envs: ' + envs.join('/') : ''})`
    );
  }
}

function cmdListShared() {
  const vault = loadVault(SECRETS_FILE);
  const keys = Object.keys(vault.shared || {}).sort();
  if (!keys.length) {
    console.log('(no shared secrets yet)');
    return;
  }
  for (const k of keys) {
    const v = vault.shared[k];
    const tag =
      typeof v === 'string' && v.startsWith(ENC_PREFIX)
        ? '(encrypted)'
        : '(plain)';
    console.log(`  ${k}  ${tag}`);
  }
}

async function cmdRotate(key, args) {
  const vault = loadVault(SECRETS_FILE);
  if (!vault.shared || !(key in vault.shared)) {
    throw new Error(`Shared secret not found: ${key}`);
  }
  const refs = findReferencingProjects(vault, key);
  if (!args.quiet) {
    console.log(`Rotating shared.${key} (used by ${refs.length} reference(s))`);
    for (const r of refs) {
      console.log(
        `  - ${r.project}.${r.key}${r.environment ? ' (' + r.environment + ')' : ''}`
      );
    }
  }
  let newVal;
  if (args.from_stdin) {
    // Read full stdin until EOF — piped values come this way. We do NOT
    // strip a trailing newline aggressively, but we do trim a single
    // optional trailing \n the way `read` semantics expect.
    newVal = await new Promise((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', reject);
    });
    if (newVal.endsWith('\n')) newVal = newVal.slice(0, -1);
    if (newVal.endsWith('\r')) newVal = newVal.slice(0, -1);
    if (!newVal) {
      throw new Error('--from-stdin received empty value; refusing to rotate.');
    }
  } else {
    newVal = await askSecret(`New value for shared.${key}: `);
  }
  setSharedSecret(vault, key, newVal);
  saveVault(vault, SECRETS_FILE);
  if (!args.no_push) {
    commitAndPush(SECRETS_DIR, `envpact: rotate shared.${key}`);
  }
  console.log(`✓ shared.${key} rotated`);
  if (args.github) {
    console.log(`→ to push to GitHub Actions for each project, run:`);
    for (const r of refs) {
      console.log(`    cd <${r.project}-repo> && envpact --github`);
    }
  }
}

function parseKv(s) {
  const eq = s.indexOf('=');
  if (eq < 0) throw new Error(`expected KEY=VALUE, got: ${s}`);
  return [s.slice(0, eq).trim(), s.slice(eq + 1)];
}

function cmdAdd(arg, args) {
  const [k, v] = parseKv(arg);
  const vault = loadVault(SECRETS_FILE);
  const project = (args.project || detectProjectFromGit(process.cwd())).toLowerCase();
  setProjectSecret(vault, project, k, v, args.env);
  saveVault(vault, SECRETS_FILE);
  if (!args.no_push) {
    commitAndPush(SECRETS_DIR, `envpact: set ${project}.${k}`);
  }
  console.log(`✓ set ${project}.${k}${args.env ? ' (' + args.env + ')' : ''}`);
}

function cmdAddShared(arg, args) {
  const [k, v] = parseKv(arg);
  const vault = loadVault(SECRETS_FILE);
  setSharedSecret(vault, k, v);
  saveVault(vault, SECRETS_FILE);
  if (!args.no_push) {
    commitAndPush(SECRETS_DIR, `envpact: set shared.${k}`);
  }
  console.log(`✓ set shared.${k}`);
}

function cmdEncrypt(key, args) {
  const vault = loadVault(SECRETS_FILE);
  if (!vault.shared || !(key in vault.shared)) {
    throw new Error(`Shared secret not found: ${key}`);
  }
  const current = vault.shared[key];
  if (typeof current === 'string' && current.startsWith(ENC_PREFIX)) {
    console.log(`shared.${key} is already encrypted`);
    return;
  }
  const wrapped = ageMod.encryptValue(current);
  setSharedSecret(vault, key, wrapped);
  saveVault(vault, SECRETS_FILE);
  if (!args.no_push) {
    commitAndPush(SECRETS_DIR, `envpact: encrypt shared.${key}`);
  }
  console.log(`✓ shared.${key} encrypted`);
}

function cmdDecrypt(key, args) {
  const vault = loadVault(SECRETS_FILE);
  if (!vault.shared || !(key in vault.shared)) {
    throw new Error(`Shared secret not found: ${key}`);
  }
  const current = vault.shared[key];
  if (typeof current !== 'string' || !current.startsWith(ENC_PREFIX)) {
    console.log(`shared.${key} is already plaintext`);
    return;
  }
  const plain = ageMod.decryptValue(current);
  setSharedSecret(vault, key, plain);
  saveVault(vault, SECRETS_FILE);
  if (!args.no_push) {
    commitAndPush(SECRETS_DIR, `envpact: decrypt shared.${key}`);
  }
  console.log(`✓ shared.${key} decrypted`);
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || args.h) return printHelp();
  if (args.version || args.v) return console.log(VERSION);

  try {
    if ('init' in args) {
      const arg = typeof args.init === 'string' ? args.init : 'auto';
      return await cmdInit(arg);
    }

    if (args.vault_pull) {
      const r = pull(SECRETS_DIR);
      console.log(r.ok ? '✓ pulled' : `! ${r.stderr.split('\n')[0]}`);
      return;
    }
    if (args.vault_push) {
      const r = commitAndPush(SECRETS_DIR, 'envpact: manual push');
      console.log(`✓ committed=${r.committed} pushed=${r.pushed}`);
      return;
    }

    if (args.list) return cmdList();
    if (args.list_shared) return cmdListShared();

    if (args.rotate && typeof args.rotate === 'string') {
      return await cmdRotate(args.rotate, args);
    }
    if (args.add && typeof args.add === 'string') {
      return cmdAdd(args.add, args);
    }
    if (args.add_shared && typeof args.add_shared === 'string') {
      return cmdAddShared(args.add_shared, args);
    }
    if (args.encrypt && typeof args.encrypt === 'string') {
      return cmdEncrypt(args.encrypt, args);
    }
    if (args.decrypt && typeof args.decrypt === 'string') {
      return cmdDecrypt(args.decrypt, args);
    }

    // Default action: generate .env
    return await cmdGenerate(args);
  } catch (e) {
    process.stderr.write(`envpact: ${e.message}\n`);
    if (process.env.ENVPACT_DEBUG) {
      process.stderr.write(e.stack + '\n');
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs };
