'use strict';

/**
 * envpact age — opt-in age encryption for shared secret values.
 * Uses the `age` binary (https://github.com/FiloSottile/age) via
 * stdin/stdout so we keep zero npm dependencies.
 *
 * Encrypted values look like: "enc:<base64-armored-ciphertext>"
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const { AGE_KEY_FILE } = require('./config');
const { ENC_PREFIX } = require('./resolver');

function ageAvailable() {
  const r = spawnSync('age', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

function ensureAgeKey() {
  if (fs.existsSync(AGE_KEY_FILE)) return;
  if (!ageAvailable()) {
    throw new Error(
      'age binary not found. Install it from https://github.com/FiloSottile/age'
    );
  }
  // age-keygen prints both private and public; we capture and write
  // the private key with mode 0600.
  const r = spawnSync('age-keygen', { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`age-keygen failed: ${r.stderr}`);
  }
  fs.writeFileSync(AGE_KEY_FILE, r.stdout, { mode: 0o600 });
}

function getRecipient() {
  ensureAgeKey();
  const content = fs.readFileSync(AGE_KEY_FILE, 'utf8');
  const m = content.match(/^# public key: (age1[a-z0-9]+)/m);
  if (!m) throw new Error('Could not parse public key from age.key');
  return m[1];
}

function encryptValue(plaintext) {
  if (!ageAvailable()) {
    throw new Error('age binary required for --encrypt');
  }
  const recipient = getRecipient();
  const r = spawnSync(
    'age',
    ['-a', '-r', recipient],
    { input: plaintext, encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error(`age encrypt failed: ${r.stderr}`);
  // Single-line base64 of armored ciphertext for JSON-safety
  const ciphertext = Buffer.from(r.stdout, 'utf8').toString('base64');
  return ENC_PREFIX + ciphertext;
}

function decryptValue(wrapped) {
  if (!wrapped.startsWith(ENC_PREFIX)) {
    return wrapped; // not encrypted
  }
  if (!ageAvailable()) {
    throw new Error('age binary required to decrypt vault values');
  }
  if (!fs.existsSync(AGE_KEY_FILE)) {
    throw new Error(`age key not found at ${AGE_KEY_FILE}`);
  }
  const ciphertext = Buffer.from(
    wrapped.slice(ENC_PREFIX.length),
    'base64'
  ).toString('utf8');
  const r = spawnSync(
    'age',
    ['-d', '-i', AGE_KEY_FILE],
    { input: ciphertext, encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error(`age decrypt failed: ${r.stderr}`);
  return r.stdout.replace(/\r?\n$/, '');
}

module.exports = {
  ageAvailable,
  ensureAgeKey,
  getRecipient,
  encryptValue,
  decryptValue,
};
