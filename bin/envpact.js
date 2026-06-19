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
 *
 * Schema: vault v3 (flat, single-environment, per-key timestamps).
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
} = require('../lib/config');
const {
  resolveProject,
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
  getValue,
  isEncryptedEntry,
} = require('../lib/vault');
const {
  parseEnvFile,
  parseEnvFileToMap,
  renderEnvFile,
  writeEnvFileAtomic,
  ensureGitignoreCovers,
} = require('../lib/parser');
const {
  loadLock,
  saveLock,
  getKeyStatus,
  pullKey,
  pushKey,
  resolveVaultEntry,
  SyncConflictError,
} = require('../lib/sync');
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
    '--status',
    '--force',
  ]);
  const valued = new Set([
    '--init',
    '--project',
    '--env-file',
    '--output',
    '--rotate',
    '--add',
    '--add-shared',
    '--encrypt',
    '--decrypt',
    '--vault-url',
    '--vault-repo',
    '--pull',
    '--push',
  ]);
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
// Help & version (text mirrors SHARED_SPEC §6 verbatim)
// ---------------------------------------------------------------

function printHelp() {
  console.log(`envpact v${VERSION} — centralized secrets manager

Usage:
  envpact [options]

  --init [<git-url>|auto]    Initialize vault. "auto" creates a new
                              private repo via \`gh repo create\`.
  --vault-url <url>          Explicit vault git URL (overrides config).
  --vault-repo <slug>        Vault repo slug (e.g. user/envpact-secrets).
  --project <name>           Project override (else: git remote / cwd).
  --env-file <path>          .env.example path (default: .env.example).
  --output <path>            .env output path (default: .env).
  --pull <KEY>               Pull a single key from vault → .env.
                              Refuses if local is newer; use --force.
  --push <KEY>               Push a single key from .env → vault.
                              Refuses if vault is newer; use --force.
  --status                   Show per-key sync status (synced /
                              local_newer / vault_newer / both_diverged
                              / local_only / vault_only).
  --force                    Override conflict refusals on pull/push.
  -g, --github               Sync resolved secrets to GitHub Actions
                              via \`gh secret set\`.
  --dry-run                  Print resolved env, do not write.
  --rotate <key>             Rotate a shared secret interactively.
  --list                     List all projects in vault.
  --list-shared              List shared secret names (values masked).
  --add <KEY>=<VALUE>        Add/update a project secret.
  --add-shared <KEY>=<VAL>   Add/update a shared secret.
  --encrypt <KEY>            Encrypt a shared secret with age.
  --decrypt <KEY>            Decrypt a shared secret with age.
  --vault-pull               Pull latest vault git state.
  --vault-push               Push pending vault git changes.
  --no-pull                  Skip auto-pull this run.
  --no-push                  Skip auto-push this run.
  --from-stdin               Read --rotate / --push value from stdin.
  -q, --quiet                Suppress per-reference progress dump.
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
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    // v1 → v2 silent upgrade (drop default_environment).
    if (raw.version === 1) {
      delete raw.default_environment;
      raw.version = 2;
    }
    return { ...DEFAULT_CONFIG, ...raw };
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
  } catch (_e) {
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
// Generate — the default action (full .env from vault)
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

  let result = resolveProject(vault, project);
  console.log(`→ project=${project} keys=${requiredKeys.length}`);

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
    console.log(`  ? ${key} not set for ${project}`);
    const useShared = await confirm(
      `    Use a shared secret for ${key}?`,
      false
    );
    if (useShared) {
      const sharedKey =
        (await ask(`    Shared key name [default: ${key}]: `)).trim() || key;
      if (!(sharedKey in (vault.shared || {}))) {
        const val = await askSecret(`    Value for shared.${sharedKey}: `);
        setSharedSecret(vault, sharedKey, val);
      }
      setProjectSecret(vault, project, key, `shared.${sharedKey}`);
    } else {
      const val = await askSecret(`    Value for ${project}.${key}: `);
      setProjectSecret(vault, project, key, val);
    }
    mutated = true;
    result = resolveProject(vault, project);
  }

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

  const orderedKeys = requiredKeys.length
    ? requiredKeys
    : Object.keys(result.resolved);
  // Read the .env.example contents so `renderEnvFile` can mirror it
  // byte-faithfully (SHARED_SPEC §5). When the example is missing we
  // fall through to legacy mode by leaving exampleContent undefined.
  let exampleContent;
  try {
    exampleContent = fs.readFileSync(envExamplePath, 'utf8');
  } catch (_e) {
    exampleContent = undefined;
  }
  const content = renderEnvFile(orderedKeys, result.resolved, {
    project,
    exampleContent,
  });
  writeEnvFileAtomic(outputPath, content);
  ensureGitignoreCovers(cwd, '.env');
  console.log(
    `✓ Wrote ${outputPath} (${Object.keys(result.resolved).length} keys)`
  );

  if (mutated) {
    saveVault(vault, SECRETS_FILE);
    if (!args.no_push) {
      const r = commitAndPush(SECRETS_DIR, `envpact: update ${project}`);
      if (r.committed && !r.pushed) {
        console.warn(`  ! push failed: ${r.pushError}`);
      } else if (r.pushed) {
        console.log('✓ Vault changes pushed');
      }
    }
  }

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
    const n = githubSync.syncResolved(repoSlug, result.resolved, {});
    console.log(`✓ Synced ${n}/${Object.keys(result.resolved).length} secrets`);
  }
}

// ---------------------------------------------------------------
// Per-key pull / push / status
// ---------------------------------------------------------------

function projectAndPaths(args) {
  const cwd = process.cwd();
  const project = (args.project || detectProjectFromGit(cwd)).toLowerCase();
  const envExamplePath = args.env_file || '.env.example';
  const outputPath = args.output || '.env';
  return { cwd, project, envExamplePath, outputPath };
}

async function cmdPull(args) {
  const key = args.pull;
  if (typeof key !== 'string' || !key) {
    throw new Error('--pull requires a KEY (e.g. envpact --pull NPM_TOKEN)');
  }
  const { cwd, project, envExamplePath, outputPath } = projectAndPaths(args);

  if (!args.no_pull) {
    const r = pull(SECRETS_DIR);
    if (!r.ok) {
      console.warn(`  ! vault pull warning: ${r.stderr.split('\n')[0]}`);
    }
  }

  const vault = loadVault(SECRETS_FILE);
  const localEnvMap = parseEnvFileToMap(outputPath);
  const lock = loadLock(envExamplePath);

  let result;
  try {
    result = pullKey({
      projectName: project,
      key,
      vault,
      localEnvMap,
      lock,
      force: !!args.force,
    });
  } catch (e) {
    if (e instanceof SyncConflictError) {
      console.error(
        `envpact: refusing to pull ${key} (${e.status}). Re-run with --force to overwrite local.`
      );
      process.exit(2);
    }
    throw e;
  }

  // Decrypt enc: values transparently.
  let valueToWrite = result.newLocalValue;
  if (valueToWrite.startsWith(ENC_PREFIX)) {
    try {
      valueToWrite = ageMod.decryptValue(valueToWrite);
    } catch (e) {
      throw new Error(`could not decrypt ${key}: ${e.message}`);
    }
  }

  // Merge into existing .env, preserving order. If the file doesn't
  // exist yet, fall back to .env.example for ordering.
  const existing = parseEnvFile(outputPath);
  const orderedKeys =
    existing.keys.length > 0
      ? existing.keys
      : parseEnvFile(envExamplePath).keys;
  const valueMap = { ...existing.values, [key]: valueToWrite };
  const orderedWithKey = orderedKeys.includes(key)
    ? orderedKeys
    : [...orderedKeys, key];
  // Mirror .env.example byte-faithfully when we have it (§5). The
  // `--pull` path only rewrites a single key, so the body emitter
  // still walks every example line — the unchanged keys keep their
  // existing values from `valueMap`.
  let exampleContent;
  try {
    exampleContent = fs.readFileSync(envExamplePath, 'utf8');
  } catch (_e) {
    exampleContent = undefined;
  }
  const content = renderEnvFile(orderedWithKey, valueMap, {
    project,
    exampleContent,
  });
  writeEnvFileAtomic(outputPath, content);
  ensureGitignoreCovers(cwd, '.env');

  lock.keys[key] = result.newLockEntry;
  saveLock(envExamplePath, lock);

  console.log(`✓ pulled ${key} (was: ${result.status})`);
}

async function cmdPush(args) {
  const key = args.push;
  if (typeof key !== 'string' || !key) {
    throw new Error('--push requires a KEY (e.g. envpact --push NPM_TOKEN)');
  }
  const { project, envExamplePath, outputPath } = projectAndPaths(args);

  if (!args.no_pull) {
    const r = pull(SECRETS_DIR);
    if (!r.ok) {
      console.warn(`  ! vault pull warning: ${r.stderr.split('\n')[0]}`);
    }
  }

  const vault = loadVault(SECRETS_FILE);
  const localEnvMap = parseEnvFileToMap(outputPath);
  let localValue = localEnvMap[key];

  if (args.from_stdin) {
    localValue = await readStdin();
  }

  if (typeof localValue !== 'string') {
    throw new Error(
      `KEY_NOT_IN_LOCAL: ${key} is not in ${outputPath}. Add it first or pipe via --from-stdin.`
    );
  }

  const lock = loadLock(envExamplePath);

  let result;
  try {
    result = pushKey({
      projectName: project,
      key,
      vault,
      localValue,
      lock,
      force: !!args.force,
    });
  } catch (e) {
    if (e instanceof SyncConflictError) {
      console.error(
        `envpact: refusing to push ${key} (${e.status}). Re-run with --force to overwrite vault.`
      );
      process.exit(2);
    }
    throw e;
  }

  ensureProjectExists(vault, project);
  vault.projects[project][key] = result.newVaultEntry;
  saveVault(vault, SECRETS_FILE);

  if (!args.no_push) {
    const r = commitAndPush(SECRETS_DIR, `envpact: push ${project}.${key}`);
    if (r.committed && !r.pushed) {
      console.warn(`  ! push failed: ${r.pushError}`);
    }
  }

  lock.keys[key] = result.newLockEntry;
  saveLock(envExamplePath, lock);

  console.log(`✓ pushed ${key} (was: ${result.status})`);
}

function cmdStatus(args) {
  const { project, envExamplePath, outputPath } = projectAndPaths(args);

  if (!args.no_pull) {
    const r = pull(SECRETS_DIR);
    if (!r.ok) {
      console.warn(`  ! vault pull warning: ${r.stderr.split('\n')[0]}`);
    }
  }

  const vault = loadVault(SECRETS_FILE);
  const localEnvMap = parseEnvFileToMap(outputPath);
  const lock = loadLock(envExamplePath);

  // Compose the universe of keys: every required key in
  // .env.example, plus every project key in the vault, plus every
  // local .env key. This gives accurate local_only / vault_only
  // reporting.
  const required = parseEnvFile(envExamplePath).keys;
  const projectKeys = Object.keys((vault.projects || {})[project] || {}).filter(
    (k) => !k.startsWith('_')
  );
  const localKeys = Object.keys(localEnvMap);
  const universe = Array.from(
    new Set([...required, ...projectKeys, ...localKeys])
  ).sort();

  if (universe.length === 0) {
    console.log(`(no keys in vault, .env, or .env.example for ${project})`);
    return;
  }

  // Counts surface in the summary line; we never echo values.
  const counts = {
    synced: 0,
    local_newer: 0,
    vault_newer: 0,
    both_diverged: 0,
    local_only: 0,
    vault_only: 0,
  };

  const rows = [];
  for (const key of universe) {
    const localValue = localEnvMap[key];
    const entry = resolveVaultEntry(vault, project, key);
    const lockEntry = lock.keys ? lock.keys[key] : undefined;
    const status = getKeyStatus(localValue, entry, lockEntry);
    counts[status] = (counts[status] || 0) + 1;
    rows.push([key, status]);
  }

  const keyW = Math.max(3, ...rows.map((r) => r[0].length));
  console.log(`project: ${project}`);
  console.log(`${'KEY'.padEnd(keyW)}  STATUS`);
  console.log(`${'-'.repeat(keyW)}  ${'-'.repeat(13)}`);
  for (const [k, s] of rows) {
    console.log(`${k.padEnd(keyW)}  ${s}`);
  }
  console.log('');
  const summary = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s}=${n}`)
    .join(' ');
  console.log(summary || 'no keys');
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      if (data.endsWith('\n')) data = data.slice(0, -1);
      if (data.endsWith('\r')) data = data.slice(0, -1);
      resolve(data);
    });
    process.stdin.on('error', reject);
  });
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
    const keyCount = Object.keys(vault.projects[p]).filter(
      (k) => !k.startsWith('_')
    ).length;
    console.log(`  ${p}  (${keyCount} keys)`);
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
    const entry = vault.shared[k];
    const tag = isEncryptedEntry(entry) ? '(encrypted)' : '(plain)';
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
      console.log(`  - ${r.project}.${r.key}`);
    }
  }
  let newVal;
  if (args.from_stdin) {
    newVal = await readStdin();
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
  const project = (
    args.project || detectProjectFromGit(process.cwd())
  ).toLowerCase();
  setProjectSecret(vault, project, k, v);
  saveVault(vault, SECRETS_FILE);
  if (!args.no_push) {
    commitAndPush(SECRETS_DIR, `envpact: set ${project}.${k}`);
  }
  console.log(`✓ set ${project}.${k}`);
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
  const current = getValue(vault.shared[key]);
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
  const current = getValue(vault.shared[key]);
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

    if (args.pull && typeof args.pull === 'string') {
      return await cmdPull(args);
    }
    if (args.push && typeof args.push === 'string') {
      return await cmdPush(args);
    }
    if (args.status) return cmdStatus(args);

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
