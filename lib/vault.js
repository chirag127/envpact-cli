'use strict';

/**
 * envpact vault — load/save secrets.json with v1→v2 migration,
 * and centralised mutation helpers (add/rotate/remove).
 */

const fs = require('fs');
const path = require('path');
const {
  SECRETS_DIR,
  SECRETS_FILE,
  DEFAULT_VAULT,
  VAULT_SCHEMA_VERSION,
  SCHEMA_URL,
} = require('./config');
const { validateVault } = require('./resolver');

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
  // v1 → v2 silent upgrade (the schemas are forward-compatible
  // because v1 is just v2 with no per-env objects).
  if (parsed.version === 1) {
    parsed.version = VAULT_SCHEMA_VERSION;
    parsed.$schema = SCHEMA_URL;
  }
  validateVault(parsed);
  return parsed;
}

function saveVault(vault, filePath) {
  filePath = filePath || SECRETS_FILE;
  vault.metadata = vault.metadata || {};
  vault.metadata.updated_at = new Date().toISOString();
  vault.$schema = vault.$schema || SCHEMA_URL;
  vault.version = vault.version || VAULT_SCHEMA_VERSION;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(vault, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function ensureProjectExists(vault, projectName) {
  if (!vault.projects) vault.projects = {};
  if (!vault.projects[projectName]) vault.projects[projectName] = {};
}

function setProjectSecret(vault, projectName, key, value, environment) {
  ensureProjectExists(vault, projectName);
  const project = vault.projects[projectName];
  if (environment) {
    if (
      typeof project[key] !== 'object' ||
      project[key] === null ||
      Array.isArray(project[key])
    ) {
      project[key] = {};
    }
    project[key][environment] = value;
  } else {
    project[key] = value;
  }
}

function setSharedSecret(vault, key, value) {
  if (!vault.shared) vault.shared = {};
  vault.shared[key] = value;
}

function findReferencingProjects(vault, sharedKey) {
  const refs = [];
  const ref = `shared.${sharedKey}`;
  for (const [pname, proj] of Object.entries(vault.projects || {})) {
    for (const [k, v] of Object.entries(proj)) {
      if (k.startsWith('_')) continue;
      if (typeof v === 'string' && v === ref) {
        refs.push({ project: pname, key: k });
      } else if (v && typeof v === 'object') {
        for (const [env, ev] of Object.entries(v)) {
          if (typeof ev === 'string' && ev === ref) {
            refs.push({ project: pname, key: k, environment: env });
          }
        }
      }
    }
  }
  return refs;
}

function defaultVault() {
  return JSON.parse(JSON.stringify(DEFAULT_VAULT));
}

module.exports = {
  loadVault,
  saveVault,
  setProjectSecret,
  setSharedSecret,
  ensureProjectExists,
  findReferencingProjects,
  defaultVault,
};
