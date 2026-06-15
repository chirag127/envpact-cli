'use strict';

/**
 * envpact config — paths, constants, defaults.
 * Cross-platform: HOME via USERPROFILE on Windows.
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

const VAULT_SCHEMA_VERSION = 2;
const SCHEMA_URL = 'https://envpact.oriz.in/schema/v2.json';

const DEFAULT_VAULT = {
  $schema: SCHEMA_URL,
  version: VAULT_SCHEMA_VERSION,
  shared: {},
  projects: {},
  metadata: {
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
};

const DEFAULT_CONFIG = {
  version: 1,
  vault_repo: '',
  vault_url: '',
  last_sync: '',
  default_environment: 'default',
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
  DEFAULT_CONFIG,
};
