'use strict';

/**
 * envpact resolver — canonical secret resolution for v3 schema.
 *
 * Zero external dependencies. Single source of truth for resolution
 * semantics across the ecosystem (CLI, MCP server, GitHub Action,
 * VS Code extension, Python library).
 *
 * v3 schema (flat, single-environment, per-key timestamps):
 *
 *   shared.<KEY>            = { value: string, _modified_at: ISO }
 *   projects.<NAME>.<KEY>   = { value: string, _modified_at: ISO }
 *
 * The `value` field can be:
 *   - a plain literal       ("3000", "postgres://…")
 *   - a shared.KEY pointer  ("shared.OPENAI_API_KEY")
 *   - an encrypted blob     ("enc:<base64>")
 *
 * v1 (flat string values, no timestamps) and v2 (per-environment
 * objects + `_default_env`) vaults are auto-upgraded in memory by
 * `upgradeVault()` so resolution is uniform.
 *
 * Inputs:
 *   - vault: parsed secrets.json (any version; auto-upgraded)
 *   - projectName: string
 *
 * Outputs:
 *   {
 *     resolved:   { [key]: string },  // ready for .env (still includes enc:)
 *     unresolved: string[],           // keys whose shared ref is missing
 *     invalid:    string[],           // keys with malformed entry shape
 *     encrypted:  string[],           // keys whose value is enc:…
 *     missing:    boolean             // true iff project not in vault
 *   }
 */

const SHARED_PREFIX = 'shared.';
const ENC_PREFIX = 'enc:';

// ---------------------------------------------------------------
// v1/v2 → v3 in-memory upgrade
// ---------------------------------------------------------------

/**
 * Pick a single string from a v2 per-environment object using the
 * spec §1.4 priority: default → production → first non-empty value.
 */
function pickFlatValue(envObj) {
  if (typeof envObj.default === 'string' && envObj.default.length > 0) {
    return envObj.default;
  }
  if (typeof envObj.production === 'string' && envObj.production.length > 0) {
    return envObj.production;
  }
  for (const v of Object.values(envObj)) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

/**
 * Lossy upgrade of a v1 or v2 vault to a v3 in-memory shape.
 * Idempotent: a v3 input is returned with defensive `_modified_at`
 * fills, but otherwise unchanged. Pure function — does not mutate.
 *
 * Logs a single loud warning on actual upgrade so users notice the
 * irreversible flattening of per-environment values.
 */
function upgradeVault(vault) {
  if (!vault || typeof vault !== 'object') {
    throw new Error('Vault must be a JSON object');
  }
  const incomingVersion = vault.version;
  if (incomingVersion === 3) {
    // Defensive: ensure every entry has a value/_modified_at shape
    // even if the on-disk file was hand-edited.
    return normaliseV3(vault);
  }
  if (incomingVersion !== 1 && incomingVersion !== 2) {
    throw new Error(
      `Unsupported vault version: ${incomingVersion}. Expected 1, 2, or 3.`
    );
  }

  // eslint-disable-next-line no-console
  console.warn(
    `envpact: upgrading vault from v${incomingVersion} → v3. ` +
      'Per-environment values will be flattened. Backup at ' +
      'pre-v3-migration branch (if you didn\'t make one, abort now).'
  );

  const now = new Date().toISOString();
  const baseTs = (vault.metadata && vault.metadata.updated_at) || now;
  const out = {
    $schema: 'https://envpact.oriz.in/schema/v3.json',
    version: 3,
    shared: {},
    projects: {},
    metadata: {
      ...(vault.metadata || {}),
      updated_at: now,
    },
  };

  for (const [k, raw] of Object.entries(vault.shared || {})) {
    if (typeof raw === 'string') {
      out.shared[k] = { value: raw, _modified_at: baseTs };
    } else if (raw && typeof raw === 'object' && typeof raw.value === 'string') {
      out.shared[k] = {
        value: raw.value,
        _modified_at: raw._modified_at || baseTs,
      };
    }
  }

  for (const [pname, project] of Object.entries(vault.projects || {})) {
    if (!project || typeof project !== 'object') continue;
    out.projects[pname] = {};
    for (const [key, raw] of Object.entries(project)) {
      if (key.startsWith('_')) continue; // drop _default_env etc.
      if (typeof raw === 'string') {
        out.projects[pname][key] = { value: raw, _modified_at: baseTs };
      } else if (
        raw &&
        typeof raw === 'object' &&
        typeof raw.value === 'string' &&
        !Array.isArray(raw)
      ) {
        // Pre-shaped v3 entry that snuck into a v2 file.
        out.projects[pname][key] = {
          value: raw.value,
          _modified_at: raw._modified_at || baseTs,
        };
      } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        // v2 per-env object → flatten.
        const picked = pickFlatValue(raw);
        if (picked) {
          out.projects[pname][key] = { value: picked, _modified_at: baseTs };
        }
      }
    }
  }

  return out;
}

/**
 * Normalise a v3 vault: ensure every leaf has a `value` string and
 * `_modified_at`. Defensive no-op for clean files.
 */
function normaliseV3(vault) {
  const out = {
    ...vault,
    shared: { ...(vault.shared || {}) },
    projects: {},
  };
  const now = new Date().toISOString();
  for (const [k, v] of Object.entries(vault.shared || {})) {
    if (v && typeof v === 'object' && typeof v.value === 'string') {
      out.shared[k] = {
        value: v.value,
        _modified_at: v._modified_at || now,
      };
    }
    // Anything else stays in place; resolver will mark INVALID.
  }
  for (const [pname, proj] of Object.entries(vault.projects || {})) {
    out.projects[pname] = {};
    for (const [key, raw] of Object.entries(proj || {})) {
      if (key.startsWith('_')) continue;
      if (raw && typeof raw === 'object' && typeof raw.value === 'string') {
        out.projects[pname][key] = {
          value: raw.value,
          _modified_at: raw._modified_at || now,
        };
      } else {
        // Preserve as-is so resolver flags it as invalid.
        out.projects[pname][key] = raw;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------
// Validation
// ---------------------------------------------------------------

/**
 * Accept v1, v2, or v3. v1/v2 callers MUST upgrade in memory before
 * doing further work; we still validate the basic shape here.
 */
function validateVault(vault) {
  if (!vault || typeof vault !== 'object') {
    throw new Error('Vault must be a JSON object');
  }
  if (vault.version !== 1 && vault.version !== 2 && vault.version !== 3) {
    throw new Error(
      `Unsupported vault version: ${vault.version}. Expected 1, 2, or 3.`
    );
  }
  if (vault.shared && typeof vault.shared !== 'object') {
    throw new Error('vault.shared must be an object');
  }
  if (vault.projects && typeof vault.projects !== 'object') {
    throw new Error('vault.projects must be an object');
  }
}

// ---------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------

/**
 * Read the current value out of a v3 entry. Returns `undefined` if
 * the entry is malformed.
 */
function entryValue(entry) {
  if (entry && typeof entry === 'object' && typeof entry.value === 'string') {
    return entry.value;
  }
  return undefined;
}

/**
 * Resolve a single string value: handle `shared.` and `enc:`
 * prefixes. The shared lookup is one-level only; chained shared
 * references are NOT followed (return invalid).
 *
 * `shared` here is the v3 shared block (entry-shaped). For
 * back-compat the function accepts a plain `{KEY: string}` map too.
 */
function resolveString(rawValue, shared) {
  if (typeof rawValue !== 'string') {
    return { value: null, status: 'invalid' };
  }
  if (rawValue.startsWith(ENC_PREFIX)) {
    return { value: rawValue, status: 'encrypted' };
  }
  if (rawValue.startsWith(SHARED_PREFIX)) {
    const sharedKey = rawValue.slice(SHARED_PREFIX.length);
    if (!shared || !(sharedKey in shared)) {
      return { value: null, status: 'unresolved' };
    }
    const sharedEntry = shared[sharedKey];
    let sharedVal;
    if (typeof sharedEntry === 'string') {
      sharedVal = sharedEntry; // v1/v2-style fallback
    } else {
      sharedVal = entryValue(sharedEntry);
    }
    if (typeof sharedVal !== 'string') {
      return { value: null, status: 'invalid' };
    }
    if (sharedVal.startsWith(SHARED_PREFIX)) {
      // No recursion: spec §1.2 step 2.iv.
      return { value: null, status: 'invalid' };
    }
    if (sharedVal.startsWith(ENC_PREFIX)) {
      return { value: sharedVal, status: 'encrypted' };
    }
    return { value: sharedVal, status: 'ok' };
  }
  return { value: rawValue, status: 'ok' };
}

/**
 * Resolve every key in a project. See SHARED_SPEC §1.2.
 *
 * Note: NO `environment` parameter. v3 vaults are flat.
 */
function resolveProject(vault, projectName) {
  validateVault(vault);
  const upgraded = upgradeVault(vault);

  const project = (upgraded.projects || {})[projectName];
  if (!project) {
    return {
      resolved: {},
      unresolved: [],
      invalid: [],
      encrypted: [],
      missing: true,
    };
  }

  const resolved = {};
  const unresolved = [];
  const invalid = [];
  const encrypted = [];
  const shared = upgraded.shared || {};

  for (const [key, entry] of Object.entries(project)) {
    if (key.startsWith('_')) continue;
    const raw = entryValue(entry);
    if (raw === undefined) {
      invalid.push(key);
      continue;
    }
    const r = resolveString(raw, shared);
    if (r.status === 'ok') {
      resolved[key] = r.value;
    } else if (r.status === 'encrypted') {
      resolved[key] = r.value;
      encrypted.push(key);
    } else if (r.status === 'unresolved') {
      unresolved.push(key);
    } else {
      invalid.push(key);
    }
  }

  return { resolved, unresolved, invalid, encrypted, missing: false };
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function maskValue(_value) {
  return '****';
}

module.exports = {
  resolveProject,
  resolveString,
  validateVault,
  upgradeVault,
  entryValue,
  maskValue,
  SHARED_PREFIX,
  ENC_PREFIX,
};
