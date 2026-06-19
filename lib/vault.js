'use strict';

/**
 * envpact vault — load/save secrets.json with v1/v2 → v3 in-memory
 * upgrade and centralised mutation helpers (set/find/encrypt).
 *
 * v3 leaves: every shared and project entry is
 *   { value: string, _modified_at: ISO8601 }
 *
 * Reads are idempotent: we DO upgrade in memory but DO NOT rewrite
 * the on-disk file just for reading. The file is rewritten only on a
 * mutating save.
 */

const fs = require('fs');
const path = require('path');
const {
  SECRETS_FILE,
  VAULT_SCHEMA_VERSION,
  SCHEMA_URL,
  defaultVaultObject,
} = require('./config');
const { validateVault, upgradeVault, ENC_PREFIX } = require('./resolver');

function loadVault(filePath) {
  filePath = filePath || SECRETS_FILE;
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Vault file not found: ${filePath}\nRun \`envpact --init <git-url>\` or \`envpact --init auto\`.`
    );
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${filePath}: ${e.message}`);
  }
  validateVault(parsed);
  // upgradeVault is the canonical v1/v2 → v3 transform; on a v3 input
  // it normalises entry shapes and is otherwise a no-op.
  return upgradeVault(parsed);
}

function saveVault(vault, filePath) {
  filePath = filePath || SECRETS_FILE;
  vault.metadata = vault.metadata || {};
  vault.metadata.updated_at = new Date().toISOString();
  vault.$schema = vault.$schema || SCHEMA_URL;
  vault.version = vault.version || VAULT_SCHEMA_VERSION;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(vault, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function ensureProjectExists(vault, projectName) {
  if (!vault.projects) vault.projects = {};
  if (!vault.projects[projectName]) vault.projects[projectName] = {};
}

/**
 * Set a project secret to `value`. Stamps `_modified_at` with the
 * current ISO timestamp. v3 has no `environment` parameter — callers
 * that pass one are accepted for back-compat but the value is
 * ignored (the umbrella migration already flattened them).
 */
function setProjectSecret(vault, projectName, key, value, _ignoredEnv) {
  ensureProjectExists(vault, projectName);
  vault.projects[projectName][key] = {
    value: String(value),
    _modified_at: new Date().toISOString(),
  };
}

/**
 * Set a shared secret to `value`. Stamps `_modified_at`.
 */
function setSharedSecret(vault, key, value) {
  if (!vault.shared) vault.shared = {};
  vault.shared[key] = {
    value: String(value),
    _modified_at: new Date().toISOString(),
  };
}

/**
 * Find every (project, key) tuple whose value is `shared.<sharedKey>`.
 * Used by --rotate to print the affected references.
 */
function findReferencingProjects(vault, sharedKey) {
  const refs = [];
  const ref = `shared.${sharedKey}`;
  for (const [pname, proj] of Object.entries(vault.projects || {})) {
    for (const [k, entry] of Object.entries(proj || {})) {
      if (k.startsWith('_')) continue;
      const v =
        entry && typeof entry === 'object' && typeof entry.value === 'string'
          ? entry.value
          : typeof entry === 'string'
          ? entry
          : null;
      if (v === ref) refs.push({ project: pname, key: k });
    }
  }
  return refs;
}

function defaultVault() {
  return defaultVaultObject();
}

/**
 * Read the value field of a v3 entry safely. Returns undefined for
 * malformed entries.
 */
function getValue(entry) {
  if (entry && typeof entry === 'object' && typeof entry.value === 'string') {
    return entry.value;
  }
  return undefined;
}

/**
 * Read the _modified_at field of a v3 entry. Returns undefined when
 * missing or malformed.
 */
function getModifiedAt(entry) {
  if (
    entry &&
    typeof entry === 'object' &&
    typeof entry._modified_at === 'string'
  ) {
    return entry._modified_at;
  }
  return undefined;
}

/**
 * True if the entry's value is an `enc:…` blob.
 */
function isEncryptedEntry(entry) {
  const v = getValue(entry);
  return typeof v === 'string' && v.startsWith(ENC_PREFIX);
}

module.exports = {
  loadVault,
  saveVault,
  setProjectSecret,
  setSharedSecret,
  ensureProjectExists,
  findReferencingProjects,
  defaultVault,
  getValue,
  getModifiedAt,
  isEncryptedEntry,
};
