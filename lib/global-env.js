'use strict';

/**
 * envpact global vault `.env` — the single mirror of every shared
 * secret per SHARED_SPEC §1.6 / §5.1.
 *
 * Paths:
 *   ~/.envpact/.env.example.global   (owner-maintained template)
 *   ~/.envpact/.env                  (generated mirror, mode 0600)
 *
 * The example file is byte-identical in shape to a per-project
 * `.env.example`, so we reuse `renderBodyFromExample()` from the
 * parser. The example file is auto-created on first run if absent —
 * alphabetical list of every `shared.*` key, no comments.
 *
 * Resolution scope: `vault.shared.*` only. Encrypted (`enc:*`) values
 * surface as `# KEY: encrypted — decrypt via CLI` comment lines so
 * we never leak ciphertext into a `.env` (the CLI is the only port
 * that holds the age key).
 *
 * The mirror is read-only with respect to the vault — there is no
 * `--push-global`. Mutations go through `--add-shared` or the
 * dashboard.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ENC_PREFIX } = require('./resolver');
const { renderBodyFromExample, formatValue } = require('./parser');
const { getValue } = require('./vault');

const GLOBAL_EXAMPLE_BASENAME = '.env.example.global';
const GLOBAL_ENV_BASENAME = '.env';

/**
 * Resolve the envpact config dir at CALL TIME so tests can override
 * `process.env.USERPROFILE` / `process.env.HOME` per-case. The
 * canonical lookup mirrors `lib/config.js`.
 */
function resolveConfigDir() {
  const home =
    process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.envpact');
}

function globalExamplePath() {
  return path.join(resolveConfigDir(), GLOBAL_EXAMPLE_BASENAME);
}

function globalEnvPath() {
  return path.join(resolveConfigDir(), GLOBAL_ENV_BASENAME);
}

function ensureConfigDir() {
  const dir = resolveConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(file, content, mode) {
  ensureConfigDir();
  const dir = path.dirname(path.resolve(file));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8' });
  if (typeof mode === 'number') {
    try {
      fs.chmodSync(tmp, mode);
    } catch (_e) {
      // Windows / unprivileged FS — best-effort per spec.
    }
  }
  fs.renameSync(tmp, file);
}

/**
 * Create `~/.envpact/.env.example.global` if it doesn't already
 * exist. The auto-generated file lists every `shared.*` key in
 * alphabetical order with no comments and a trailing newline. Atomic.
 *
 * @returns {boolean}  true iff this call created the file.
 */
function ensureGlobalExample(vault) {
  const file = globalExamplePath();
  if (fs.existsSync(file)) return false;
  const sharedKeys = Object.keys((vault && vault.shared) || {}).sort();
  const body = sharedKeys.map((k) => `${k}=`).join('\n') + (sharedKeys.length ? '\n' : '');
  atomicWrite(file, body);
  return true;
}

/**
 * Render the body of `~/.envpact/.env` from the global example file
 * by walking it line-by-line per §5.1:
 *   - blank / comment lines pass through verbatim
 *   - `KEY=` resolves via `vault.shared[KEY]`:
 *       - present and plain     → `KEY=<quoted value>`
 *       - present and `enc:…`   → `# KEY: encrypted — decrypt via CLI`
 *       - absent                → `# KEY: not in vault`
 *
 * Returns `{body, resolved_count, encrypted, not_in_vault}`.
 */
function renderGlobalBody(exampleContent, vault) {
  const shared = (vault && vault.shared) || {};
  // Build a synthetic value-map first; encrypted/missing keys are
  // omitted so `renderBodyFromExample` would emit `# KEY: unresolved`.
  // We post-process those lines to switch to the §1.6-mandated wording.
  const valueMap = {};
  const encrypted = [];
  const notInVault = [];
  // First pass — parse keys present in the example (we re-walk inside
  // the renderer too, but we need to know which keys to classify).
  const lines = exampleContent.split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = raw.indexOf('=');
    if (eq < 0) continue;
    const key = raw.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const entry = shared[key];
    const value = getValue(entry);
    if (typeof value !== 'string') {
      notInVault.push(key);
      continue;
    }
    if (value.startsWith(ENC_PREFIX)) {
      encrypted.push(key);
      continue;
    }
    valueMap[key] = value;
  }

  // Render byte-faithful. Then post-process the `# KEY: unresolved`
  // sentinels into the §1.6-specific messages so the caller can tell
  // encrypted from not-in-vault at a glance.
  let body = renderBodyFromExample(exampleContent, valueMap);
  for (const k of encrypted) {
    body = body.replace(
      new RegExp(`^# ${escapeForRegex(k)}: unresolved$`, 'm'),
      `# ${k}: encrypted — decrypt via CLI`
    );
  }
  for (const k of notInVault) {
    body = body.replace(
      new RegExp(`^# ${escapeForRegex(k)}: unresolved$`, 'm'),
      `# ${k}: not in vault`
    );
  }
  return {
    body,
    resolved_count: Object.keys(valueMap).length,
    encrypted,
    not_in_vault: notInVault,
  };
}

function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generate `~/.envpact/.env` from the global example. Creates the
 * example on first run; writes the mirror atomically with mode 0600
 * (best-effort on Windows).
 *
 * @returns {{
 *   output_path: string,
 *   resolved_count: number,
 *   encrypted: string[],
 *   not_in_vault: string[],
 *   generated_global_example: boolean,
 * }}
 */
function generateGlobalEnv(vault) {
  const generated_global_example = ensureGlobalExample(vault);
  const examplePath = globalExamplePath();
  const exampleContent = fs.existsSync(examplePath)
    ? fs.readFileSync(examplePath, 'utf8')
    : '';
  const { body, resolved_count, encrypted, not_in_vault } = renderGlobalBody(
    exampleContent,
    vault
  );

  const ts = new Date().toISOString();
  const header =
    `# Generated by envpact (global) on ${ts}\n` +
    `# DO NOT COMMIT — managed by envpact\n`;
  const content = header + body;

  const out = globalEnvPath();
  atomicWrite(out, content, 0o600);
  return {
    output_path: out,
    resolved_count,
    encrypted,
    not_in_vault,
    generated_global_example,
  };
}

module.exports = {
  globalExamplePath,
  globalEnvPath,
  ensureGlobalExample,
  generateGlobalEnv,
  // Internal — exported for tests:
  renderGlobalBody,
  GLOBAL_EXAMPLE_BASENAME,
  GLOBAL_ENV_BASENAME,
  // Re-exported for convenience:
  formatValue,
};
