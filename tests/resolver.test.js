'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProject, listProjectEnvironments, validateVault, resolveString } = require('../lib/resolver');

const v = {
  $schema: 'https://envpact.oriz.in/schema/v2.json',
  version: 2,
  shared: {
    OPENAI_API_KEY: 'sk-test-shared',
    DB_URL_PROD: 'postgres://prod',
  },
  projects: {
    'my-app': {
      _default_env: 'production',
      OPENAI_API_KEY: 'shared.OPENAI_API_KEY',
      PORT: '3000',
      DATABASE_URL: {
        development: 'postgres://localhost/dev',
        staging: 'shared.DB_URL_PROD',
        production: 'shared.DB_URL_PROD',
      },
    },
    'flat-app': {
      KEY: 'literal-value',
      MISSING_REF: 'shared.NOT_THERE',
    },
  },
};

test('validateVault accepts v2', () => {
  validateVault(v);
});

test('validateVault rejects unknown version', () => {
  assert.throws(() => validateVault({ version: 99 }));
});

test('resolveProject — default env from project metadata', () => {
  const r = resolveProject(v, 'my-app');
  assert.equal(r.environment, 'production');
  assert.equal(r.resolved.PORT, '3000');
  assert.equal(r.resolved.OPENAI_API_KEY, 'sk-test-shared');
  assert.equal(r.resolved.DATABASE_URL, 'postgres://prod');
});

test('resolveProject — explicit environment override', () => {
  const r = resolveProject(v, 'my-app', 'development');
  assert.equal(r.environment, 'development');
  assert.equal(r.resolved.DATABASE_URL, 'postgres://localhost/dev');
});

test('resolveProject — flat project, no envs', () => {
  const r = resolveProject(v, 'flat-app');
  assert.equal(r.resolved.KEY, 'literal-value');
  assert.deepEqual(r.unresolved, ['MISSING_REF']);
});

test('resolveProject — missing project returns missing flag', () => {
  const r = resolveProject(v, 'no-such');
  assert.equal(r.missing, true);
  assert.deepEqual(r.resolved, {});
});

test('listProjectEnvironments — gathers env names', () => {
  const envs = listProjectEnvironments(v, 'my-app');
  assert.deepEqual(envs.sort(), ['default', 'development', 'production', 'staging'].sort());
});

test('resolveString — direct string', () => {
  const r = resolveString('hello', {});
  assert.deepEqual(r, { value: 'hello', status: 'ok' });
});

test('resolveString — shared lookup hit', () => {
  const r = resolveString('shared.A', { A: 'val' });
  assert.deepEqual(r, { value: 'val', status: 'ok' });
});

test('resolveString — shared lookup miss', () => {
  const r = resolveString('shared.MISS', {});
  assert.equal(r.status, 'unresolved');
});

test('resolveString — encrypted value passes through', () => {
  const r = resolveString('enc:abcd', {});
  assert.equal(r.status, 'encrypted');
  assert.equal(r.value, 'enc:abcd');
});

test('resolveProject — _default_env is hidden from output', () => {
  const r = resolveProject(v, 'my-app');
  assert.equal('_default_env' in r.resolved, false);
});

test('resolveProject — env object falls back to default key', () => {
  const vault = {
    version: 2,
    shared: {},
    projects: {
      app: { K: { default: 'fallback', production: 'p-val' } },
    },
  };
  const r = resolveProject(vault, 'app', 'staging'); // staging not present
  assert.equal(r.resolved.K, 'fallback');
});
