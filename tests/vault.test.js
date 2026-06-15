'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  setProjectSecret,
  setSharedSecret,
  findReferencingProjects,
  defaultVault,
  loadVault,
  saveVault,
} = require('../lib/vault');

test('defaultVault has v2 schema', () => {
  const v = defaultVault();
  assert.equal(v.version, 2);
  assert.deepEqual(v.shared, {});
  assert.deepEqual(v.projects, {});
});

test('setProjectSecret — flat', () => {
  const v = defaultVault();
  setProjectSecret(v, 'app', 'KEY', 'val');
  assert.equal(v.projects.app.KEY, 'val');
});

test('setProjectSecret — environment-scoped', () => {
  const v = defaultVault();
  setProjectSecret(v, 'app', 'KEY', 'val-prod', 'production');
  assert.deepEqual(v.projects.app.KEY, { production: 'val-prod' });
  setProjectSecret(v, 'app', 'KEY', 'val-dev', 'development');
  assert.deepEqual(v.projects.app.KEY, { production: 'val-prod', development: 'val-dev' });
});

test('setSharedSecret', () => {
  const v = defaultVault();
  setSharedSecret(v, 'TOKEN', 'sk-x');
  assert.equal(v.shared.TOKEN, 'sk-x');
});

test('findReferencingProjects — flat and env refs', () => {
  const v = defaultVault();
  setSharedSecret(v, 'API', 'k');
  setProjectSecret(v, 'a', 'K1', 'shared.API');
  setProjectSecret(v, 'b', 'K2', 'shared.API', 'production');
  setProjectSecret(v, 'b', 'K2', 'shared.API', 'staging');
  const refs = findReferencingProjects(v, 'API');
  assert.equal(refs.length, 3);
});

test('save+load round-trip preserves data', () => {
  const tmp = path.join(os.tmpdir(), `envpact-vault-${process.pid}.json`);
  const v = defaultVault();
  setSharedSecret(v, 'X', 'y');
  setProjectSecret(v, 'a', 'K', 'shared.X');
  saveVault(v, tmp);
  const loaded = loadVault(tmp);
  assert.equal(loaded.shared.X, 'y');
  assert.equal(loaded.projects.a.K, 'shared.X');
  fs.unlinkSync(tmp);
});
