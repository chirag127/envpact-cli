'use strict';

/**
 * envpact sync — per-key pull/push pipeline for vault schema v3.
 *
 * Each consumer (cli/mcp/vscode) maintains a `.env.example.lock`
 * file in the project root capturing the last successful sync state
 * per key:
 *
 *   {
 *     "version": 1,
 *     "keys": {
 *       "<KEY>": {
 *         "vault_modified_at": "<ISO>",   // _modified_at last seen
 *         "synced_at":         "<ISO>"    // wall-clock at sync time
 *       }
 *     }
 *   }
 *
 * Lock entries NEVER contain values. They are conflict-detection
 * baselines, not a secrets cache.
 *
 * State enumeration (spec §1.3):
 *   - synced         — local matches vault, lock matches vault
 *   - local_newer    — user edited .env since last sync; vault still
 *                      at lock baseline
 *   - vault_newer    — vault advanced since last sync; .env still at
 *                      lock baseline
 *   - both_diverged  — both local and vault moved
 *   - local_only     — present in .env, absent from vault
 *   - vault_only     — present in vault, absent from .env
 *
 * All writes are atomic (.tmp + rename).
 */

const fs = require('fs');
const path = require('path');

const { formatTimestamp, newerSide } = require('./timestamps');

const LOCK_VERSION = 1;

// ---------------------------------------------------------------
// Lock file I/O
// ---------------------------------------------------------------

function lockPathFor(envExamplePath) {
  // Sit next to the .env.example so the lock travels with the
  // project's required-key spec (it's checked into git).
  return `${envExamplePath}.lock`;
}

/**
 * Load `<envExamplePath>.lock`. Returns an empty lock on ENOENT.
 * Throws on JSON parse errors so a corrupt lock is surfaced instead
 * of silently treating every key as "first sync".
 */
function loadLock(envExamplePath) {
  const file = lockPathFor(envExamplePath);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { version: LOCK_VERSION, keys: {} };
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid lock shape in ${file}: not an object`);
  }
  if (!parsed.keys || typeof parsed.keys !== 'object') parsed.keys = {};
  parsed.version = parsed.version || LOCK_VERSION;
  return parsed;
}

/**
 * Atomically write the lock file. Creates parent directory if
 * missing. Lock files are NOT secret — readable by default.
 */
function saveLock(envExamplePath, lock) {
  const file = lockPathFor(envExamplePath);
  const dir = path.dirname(path.resolve(file));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function newLockEntry(vaultModifiedAt) {
  return {
    vault_modified_at: vaultModifiedAt || null,
    synced_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------
// State classification
// ---------------------------------------------------------------

/**
 * Classify one key's sync state. Inputs may be undefined to indicate
 * absence:
 *   - localValue:  string or undefined (key absent from .env)
 *   - vaultEntry:  v3 entry { value, _modified_at } or undefined
 *   - lockEntry:   { vault_modified_at, synced_at } or undefined
 *
 * Returns one of the six status strings from spec §1.3.
 */
function getKeyStatus(localValue, vaultEntry, lockEntry) {
  const haveLocal = typeof localValue === 'string';
  const haveVault =
    vaultEntry &&
    typeof vaultEntry === 'object' &&
    typeof vaultEntry.value === 'string';

  if (haveLocal && !haveVault) return 'local_only';
  if (!haveLocal && haveVault) return 'vault_only';
  if (!haveLocal && !haveVault) {
    // Spec doesn't enumerate this; treat as synced (nothing to do).
    return 'synced';
  }

  const vaultMod = vaultEntry._modified_at || null;
  const lockMod = lockEntry ? lockEntry.vault_modified_at || null : null;
  const valueMatches = localValue === vaultEntry.value;
  const vaultMoved = vaultMod !== lockMod;

  if (!lockEntry) {
    // No baseline. Values match → synced; else we can't tell which
    // side moved, so treat as both_diverged (force required).
    return valueMatches ? 'synced' : 'both_diverged';
  }

  // With the lock we can distinguish all four cases:
  //   values match,  vault unchanged → synced
  //   values match,  vault moved     → vault_newer (lock is stale; pull
  //                                     to refresh the baseline)
  //   values differ, vault unchanged → local_newer (user edited .env)
  //   values differ, vault moved     → both_diverged (force required)
  if (valueMatches && !vaultMoved) return 'synced';
  if (valueMatches && vaultMoved) return 'vault_newer';
  if (!valueMatches && !vaultMoved) return 'local_newer';
  return 'both_diverged';
}

// ---------------------------------------------------------------
// Pull (vault → local)
// ---------------------------------------------------------------

class SyncConflictError extends Error {
  constructor(status, key) {
    super(`sync conflict on ${key}: ${status}. Re-run with --force.`);
    this.name = 'SyncConflictError';
    this.status = status;
    this.key = key;
  }
}

/**
 * Resolve the v3 entry the caller will pull. For project keys the
 * entry may itself be a `shared.<KEY>` reference; we follow ONE
 * level into vault.shared. Returns the leaf entry the caller should
 * write (with its source `_modified_at`).
 */
function resolveVaultEntry(vault, projectName, key) {
  const project = (vault.projects || {})[projectName];
  if (!project) return undefined;
  const entry = project[key];
  if (!entry || typeof entry !== 'object' || typeof entry.value !== 'string') {
    return undefined;
  }
  if (entry.value.startsWith('shared.')) {
    const sharedKey = entry.value.slice('shared.'.length);
    const sharedEntry = (vault.shared || {})[sharedKey];
    if (
      sharedEntry &&
      typeof sharedEntry === 'object' &&
      typeof sharedEntry.value === 'string'
    ) {
      // Use the shared entry's value but keep the project entry's
      // _modified_at as the conflict-detection baseline (the project
      // ref itself is what the user manages locally).
      return {
        value: sharedEntry.value,
        _modified_at: entry._modified_at,
      };
    }
  }
  return entry;
}

/**
 * Pull one key from the vault into the local .env.
 *
 * Inputs:
 *   - projectName:  string
 *   - key:          string
 *   - vault:        upgraded v3 vault object
 *   - localEnvMap:  { [KEY]: string } — current .env contents
 *   - lock:         { version, keys } — current lock
 *   - force:        bool — override conflict refusal
 *
 * Returns:
 *   {
 *     newLocalValue: string,   // value to write into .env
 *     newLockEntry:  { vault_modified_at, synced_at },
 *     status:        string    // status BEFORE the pull (informational)
 *   }
 *
 * Throws SyncConflictError on local_newer / both_diverged when force=false.
 * Throws Error('KEY_NOT_IN_VAULT') when the key is missing.
 */
function pullKey({ projectName, key, vault, localEnvMap, lock, force }) {
  const entry = resolveVaultEntry(vault, projectName, key);
  if (!entry) {
    const e = new Error(`KEY_NOT_IN_VAULT: ${key}`);
    e.code = 'KEY_NOT_IN_VAULT';
    throw e;
  }

  const localValue = (localEnvMap || {})[key];
  const lockEntry = lock && lock.keys ? lock.keys[key] : undefined;
  const status = getKeyStatus(localValue, entry, lockEntry);

  if (!force && (status === 'local_newer' || status === 'both_diverged')) {
    throw new SyncConflictError(status, key);
  }

  return {
    newLocalValue: entry.value,
    newLockEntry: newLockEntry(entry._modified_at),
    status,
  };
}

// ---------------------------------------------------------------
// Push (local → vault)
// ---------------------------------------------------------------

/**
 * Push one key from the local .env into the vault.
 *
 * Inputs:
 *   - projectName:  string
 *   - key:          string
 *   - vault:        upgraded v3 vault object (will not be mutated;
 *                    caller writes via setProjectSecret)
 *   - localValue:   string — value to push (must be defined)
 *   - lock:         { version, keys }
 *   - force:        bool
 *
 * Returns:
 *   {
 *     newVaultEntry: { value, _modified_at },
 *     newLockEntry:  { vault_modified_at, synced_at },
 *     status:        string
 *   }
 *
 * Throws SyncConflictError when status is vault_newer (or
 * both_diverged) and force=false.
 * Throws KEY_NOT_IN_LOCAL when localValue is undefined.
 */
function pushKey({ projectName, key, vault, localValue, lock, force }) {
  if (typeof localValue !== 'string') {
    const e = new Error(`KEY_NOT_IN_LOCAL: ${key}`);
    e.code = 'KEY_NOT_IN_LOCAL';
    throw e;
  }

  const project = (vault.projects || {})[projectName] || {};
  const existing = project[key];
  const lockEntry = lock && lock.keys ? lock.keys[key] : undefined;

  let status;
  if (!existing) {
    status = 'local_only';
  } else {
    // Use the on-vault entry directly (NOT shared-resolved) — push
    // operates on the project's own ref.
    status = getKeyStatus(localValue, existing, lockEntry);
  }

  if (
    !force &&
    (status === 'vault_newer' || status === 'both_diverged')
  ) {
    throw new SyncConflictError(status, key);
  }

  const now = new Date().toISOString();
  const newEntry = { value: localValue, _modified_at: now };
  return {
    newVaultEntry: newEntry,
    newLockEntry: newLockEntry(now),
    status,
  };
}

module.exports = {
  loadLock,
  saveLock,
  lockPathFor,
  getKeyStatus,
  pullKey,
  pushKey,
  resolveVaultEntry,
  newLockEntry,
  formatConflictMessage,
  SyncConflictError,
  LOCK_VERSION,
};

// ---------------------------------------------------------------
// Conflict-prompt formatter (SHARED_SPEC §1.5)
//
// Renders both UTC and IST timestamps for the vault and local sides
// of a conflict, with a `(Recommended — newer)` annotation next to
// whichever timestamp is newer. The local side timestamp is the
// `synced_at` field from the lock — that's the closest the consumer
// has to "when the local value last reflected the vault" — but
// callers may pass an explicit local timestamp (e.g. file mtime) for
// a more accurate hint. Returns a multi-line string ready for
// console.error.
//
// Inputs:
//   - key, project: identifiers for the prompt header
//   - status: the SyncConflictError.status string
//   - vaultIso: vault entry's _modified_at (string | undefined)
//   - localIso: local-side timestamp (string | undefined)
//   - direction: 'pull' | 'push' — controls the action menu
// ---------------------------------------------------------------

function formatConflictMessage({
  key,
  project,
  status,
  vaultIso,
  localIso,
  direction,
}) {
  const lines = [];
  lines.push(`Conflict on KEY = ${key} (project: ${project})`);
  lines.push('');

  let vaultLabel = '';
  let localLabel = '';
  if (vaultIso && localIso) {
    const side = newerSide(vaultIso, localIso);
    if (side === 'a') vaultLabel = '   (Recommended — newer)';
    else if (side === 'b') localLabel = '   (Recommended — newer)';
  }

  // Vault side
  if (vaultIso) {
    const v = formatTimestamp(vaultIso);
    lines.push(`  Vault:  ${v.utc}`);
    lines.push(`          → ${v.ist}${vaultLabel}`);
  } else {
    lines.push('  Vault:  (no timestamp)');
  }
  // Local side
  if (localIso) {
    const l = formatTimestamp(localIso);
    lines.push(`  Local:  ${l.utc}`);
    lines.push(`          → ${l.ist}${localLabel}`);
  } else {
    lines.push('  Local:  (no recorded sync timestamp)');
  }
  lines.push('');
  lines.push(`  status: ${status}`);
  if (direction === 'pull') {
    lines.push('  Re-run with --force to overwrite local.');
  } else if (direction === 'push') {
    lines.push('  Re-run with --force to overwrite vault.');
  }
  return lines.join('\n');
}
