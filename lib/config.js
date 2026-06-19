'use strict';

/**
 * envpact config — paths, constants, defaults.
 * Cross-platform: HOME via USERPROFILE on Windows.
 *
 * Schema: v3 (flat, single-environment, per-key timestamps).
 */

const path = require('path');
const os = require('os');

const HOME =
  process.env.USERPROFILE || process.env.HOME || os.homedir();

const CONFIG_DIR = path.join(HOME, '.envpact');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SECRETS_DIR = path.join(CONFIG_DIR, 'secrets');
const SECRETS_FILE = path.join(SECRETS_DIR, 'secrets.json');
const AGE_KEY_FILE = path.join(CONFIG_DIR, 'age.key');

const VAULT_SCHEMA_VERSION = 3;
const SCHEMA_URL = 'https://envpact.oriz.in/schema/v3.json';

function defaultVaultObject() {
  const now = new Date().toISOString();
  return {
    $schema: SCHEMA_URL,
    version: VAULT_SCHEMA_VERSION,
    shared: {},
    projects: {},
    metadata: {
      created_at: now,
      updated_at: now,
    },
  };
}

// Note: kept for backwards compatibility with code that imported it,
// but consumers should prefer `defaultVaultObject()` to get fresh
// timestamps each call. Both contain a v3-shaped vault.
const DEFAULT_VAULT = defaultVaultObject();

const DEFAULT_CONFIG = {
  version: 2,
  vault_repo: '',
  vault_url: '',
  last_sync: '',
  auth_method: 'auto',
};

module.exports = {
  HOME,
  CONFIG_DIR,
  CONFIG_FILE,
  SECRETS_DIR,
  SECRETS_FILE,
  AGE_KEY_FILE,
  VAULT_SCHEMA_VERSION,
  SCHEMA_URL,
  DEFAULT_VAULT,
  defaultVaultObject,
  DEFAULT_CONFIG,
};
