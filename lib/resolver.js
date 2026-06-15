'use strict';

/**
 * envpact resolver — canonical secret resolution for v2 schema.
 *
 * This module has ZERO external dependencies. It is the single
 * source of truth for resolution semantics across the ecosystem.
 * The MCP server, GitHub Action, and VS Code extension all import
 * the same logic (or implement bit-for-bit identical Python/TS
 * ports of it).
 *
 * Inputs:
 *   - vault: parsed secrets.json (v2)
 *   - projectName: string
 *   - environment: optional string (development/staging/production/default)
 *
 * Outputs:
 *   {
 *     resolved: { [key]: string },
 *     unresolved: string[],   // keys that reference missing shared secrets
 *                              // or have no value for the requested env
 *     invalid:    string[],   // keys with malformed values
 *     environment: string     // the env actually used
 *   }
 */

const SHARED_PREFIX = 'shared.';
const ENC_PREFIX = 'enc:';

function validateVault(vault) {
  if (!vault || typeof vault !== 'object') {
    throw new Error('Vault must be a JSON object');
  }
  if (vault.version !== 2 && vault.version !== 1) {
    // v1 (flat) is auto-upgraded to v2 semantics.
    throw new Error(
      `Unsupported vault version: ${vault.version}. Expected 1 or 2.`
    );
  }
  if (vault.shared && typeof vault.shared !== 'object') {
    throw new Error('vault.shared must be an object');
  }
  if (vault.projects && typeof vault.projects !== 'object') {
    throw new Error('vault.projects must be an object');
  }
}

/**
 * Resolve a single string value: handle the `shared.` prefix.
 * Does NOT recurse — the prefix is one level only.
 * Returns { value, status: 'ok'|'unresolved'|'encrypted' }.
 */
function resolveString(rawValue, shared) {
  if (typeof rawValue !== 'string') {
    return { value: null, status: 'invalid' };
  }
  if (rawValue.startsWith(ENC_PREFIX)) {
    // Encrypted values are passed through; the caller decides
    // whether to decrypt (decryption is opt-in and async).
    return { value: rawValue, status: 'encrypted' };
  }
  if (rawValue.startsWith(SHARED_PREFIX)) {
    const sharedKey = rawValue.slice(SHARED_PREFIX.length);
    if (!shared || !(sharedKey in shared)) {
      return { value: null, status: 'unresolved' };
    }
    const sharedVal = shared[sharedKey];
    if (typeof sharedVal !== 'string') {
      return { value: null, status: 'invalid' };
    }
    // Shared values that are themselves enc: are still wrapped.
    if (sharedVal.startsWith(ENC_PREFIX)) {
      return { value: sharedVal, status: 'encrypted' };
    }
    return { value: sharedVal, status: 'ok' };
  }
  return { value: rawValue, status: 'ok' };
}

/**
 * Resolve secrets for one project + environment.
 * See SHARED_SPEC.md §1 for the canonical algorithm.
 */
function resolveProject(vault, projectName, environment) {
  validateVault(vault);

  const project = (vault.projects || {})[projectName];
  if (!project) {
    return {
      resolved: {},
      unresolved: [],
      invalid: [],
      environment: environment || 'default',
      missing: true,
    };
  }

  const effectiveEnv =
    environment || project._default_env || 'default';

  const resolved = {};
  const unresolved = [];
  const invalid = [];
  const encrypted = [];
  const shared = vault.shared || {};

  for (const [key, raw] of Object.entries(project)) {
    if (key.startsWith('_')) continue; // metadata key like _default_env

    let candidate;
    if (typeof raw === 'string') {
      candidate = raw;
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      // Per-environment object: try requested env, then 'default',
      // then any single-environment fallback if requested is 'default'.
      if (effectiveEnv in raw) {
        candidate = raw[effectiveEnv];
      } else if ('default' in raw) {
        candidate = raw.default;
      } else {
        unresolved.push(key);
        continue;
      }
    } else {
      invalid.push(key);
      continue;
    }

    const r = resolveString(candidate, shared);
    if (r.status === 'ok') {
      resolved[key] = r.value;
    } else if (r.status === 'encrypted') {
      resolved[key] = r.value; // caller must decrypt
      encrypted.push(key);
    } else if (r.status === 'unresolved') {
      unresolved.push(key);
    } else {
      invalid.push(key);
    }
  }

  return {
    resolved,
    unresolved,
    invalid,
    encrypted,
    environment: effectiveEnv,
    missing: false,
  };
}

/**
 * List the environments a project explicitly references via its
 * per-environment objects. Always includes 'default' if any keys
 * are flat strings.
 */
function listProjectEnvironments(vault, projectName) {
  const project = (vault.projects || {})[projectName];
  if (!project) return [];
  const envs = new Set();
  let hasFlat = false;
  for (const [key, raw] of Object.entries(project)) {
    if (key.startsWith('_')) continue;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const e of Object.keys(raw)) envs.add(e);
    } else if (typeof raw === 'string') {
      hasFlat = true;
    }
  }
  if (hasFlat) envs.add('default');
  if (project._default_env) envs.add(project._default_env);
  return Array.from(envs).sort();
}

/**
 * Mask a secret value for display. Shows length only.
 * Used by list-shared, list-projects --verbose, etc.
 */
function maskValue(_value) {
  return '****';
}

module.exports = {
  resolveProject,
  resolveString,
  listProjectEnvironments,
  validateVault,
  maskValue,
  SHARED_PREFIX,
  ENC_PREFIX,
};
