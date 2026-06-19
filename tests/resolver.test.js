'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveProject,
  validateVault,
  resolveString,
  upgradeVault,
} = require('../lib/resolver');

// ------------------------------------------------------------
// v3 fixture (canonical happy-path vault)
// ------------------------------------------------------------

function v3Fixture() {
  return {
    $schema: 'https://envpact.oriz.in/schema/v3.json',
    version: 3,
    shared: {
      OPENAI_API_KEY: {
        value: 'sk-test-shared',
        _modified_at: '2026-06-19T10:00:00.000Z',
      },
      ENC_TOKEN: {
        value: 'enc:abcd',
        _modified_at: '2026-06-19T10:00:00.000Z',
      },
    },
    projects: {
      'my-app': {
        OPENAI_API_KEY: {
          value: 'shared.OPENAI_API_KEY',
          _modified_at: '2026-06-19T10:00:00.000Z',
        },
        PORT: {
          value: '3000',
          _modified_at: '2026-06-19T10:00:00.000Z',
        },
        DATABASE_URL: {
          value: 'postgresql://localhost/myapp',
          _modified_at: '2026-06-19T10:00:00.000Z',
        },
      },
      'flat-app': {
        KEY: {
          value: 'literal-value',
          _modified_at: '2026-06-19T10:00:00.000Z',
        },
        MISSING_REF: {
          value: 'shared.NOT_THERE',
          _modified_at: '2026-06-19T10:00:00.000Z',
        },
        BAD_SHAPE: 'oops-not-an-object',
        ENC_PROJECT: {
          value: 'enc:projectciphertext',
          _modified_at: '2026-06-19T10:00:00.000Z',
        },
        ENC_SHARED_REF: {
          value: 'shared.ENC_TOKEN',
          _modified_at: '2026-06-19T10:00:00.000Z',
        },
      },
    },
    metadata: {
      created_at: '2026-06-15T00:00:00Z',
      updated_at: '2026-06-19T10:01:00.000Z',
    },
  };
}

// ------------------------------------------------------------
// validateVault
// ------------------------------------------------------------

test('validateVault accepts v3', () => {
  validateVault(v3Fixture());
});

test('validateVault accepts v1 and v2 (auto-upgrade later)', () => {
  validateVault({ version: 1, shared: {}, projects: {} });
  validateVault({ version: 2, shared: {}, projects: {} });
});

test('validateVault rejects unknown version', () => {
  assert.throws(() => validateVault({ version: 99 }));
});

test('validateVault rejects null and primitives', () => {
  assert.throws(() => validateVault(null));
  assert.throws(() => validateVault('not an object'));
});

// ------------------------------------------------------------
// resolveProject — v3 happy paths
// ------------------------------------------------------------

test('resolveProject — flat values resolve directly', () => {
  const r = resolveProject(v3Fixture(), 'my-app');
  assert.equal(r.missing, false);
  assert.equal(r.resolved.PORT, '3000');
  assert.equal(r.resolved.DATABASE_URL, 'postgresql://localhost/myapp');
});

test('resolveProject — shared.* references are resolved', () => {
  const r = resolveProject(v3Fixture(), 'my-app');
  assert.equal(r.resolved.OPENAI_API_KEY, 'sk-test-shared');
});

test('resolveProject — missing project returns missing flag', () => {
  const r = resolveProject(v3Fixture(), 'no-such');
  assert.equal(r.missing, true);
  assert.deepEqual(r.resolved, {});
});

test('resolveProject — missing shared ref appears in unresolved', () => {
  const r = resolveProject(v3Fixture(), 'flat-app');
  assert.ok(r.unresolved.includes('MISSING_REF'));
  assert.equal('MISSING_REF' in r.resolved, false);
});

test('resolveProject — non-entry shape is invalid', () => {
  const r = resolveProject(v3Fixture(), 'flat-app');
  assert.ok(r.invalid.includes('BAD_SHAPE'));
});

test('resolveProject — encrypted project value passes through', () => {
  const r = resolveProject(v3Fixture(), 'flat-app');
  assert.equal(r.resolved.ENC_PROJECT, 'enc:projectciphertext');
  assert.ok(r.encrypted.includes('ENC_PROJECT'));
});

test('resolveProject — encrypted shared ref passes through encrypted', () => {
  const r = resolveProject(v3Fixture(), 'flat-app');
  assert.equal(r.resolved.ENC_SHARED_REF, 'enc:abcd');
  assert.ok(r.encrypted.includes('ENC_SHARED_REF'));
});

test('resolveProject — never recurses shared refs', () => {
  const v = {
    version: 3,
    shared: {
      A: { value: 'shared.B', _modified_at: 'x' },
      B: { value: 'final', _modified_at: 'x' },
    },
    projects: {
      app: { K: { value: 'shared.A', _modified_at: 'x' } },
    },
  };
  const r = resolveProject(v, 'app');
  assert.ok(r.invalid.includes('K'), 'chained shared.* must be invalid');
});

// ------------------------------------------------------------
// resolveString helpers
// ------------------------------------------------------------

test('resolveString — direct string', () => {
  const r = resolveString('hello', {});
  assert.deepEqual(r, { value: 'hello', status: 'ok' });
});

test('resolveString — shared lookup hit (v3 entry shape)', () => {
  const r = resolveString('shared.A', {
    A: { value: 'val', _modified_at: 'x' },
  });
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

test('resolveString — non-string raw is invalid', () => {
  const r = resolveString(123, {});
  assert.equal(r.status, 'invalid');
});

// ------------------------------------------------------------
// v1/v2 → v3 auto-upgrade equivalence
// ------------------------------------------------------------

test('upgradeVault — v2 vault yields same resolved output as hand-written v3', () => {
  const v2 = {
    version: 2,
    shared: {
      OPENAI: 'sk-test',
      DB_PROD: 'postgres://prod',
    },
    projects: {
      app: {
        _default_env: 'production',
        OPENAI_API_KEY: 'shared.OPENAI',
        PORT: '3000',
        DATABASE_URL: {
          development: 'postgres://localhost/dev',
          production: 'shared.DB_PROD',
        },
      },
    },
    metadata: { updated_at: '2026-06-15T00:00:00Z' },
  };
  const expectedV3 = {
    version: 3,
    shared: {
      OPENAI: { value: 'sk-test', _modified_at: 'x' },
      DB_PROD: { value: 'postgres://prod', _modified_at: 'x' },
    },
    projects: {
      app: {
        OPENAI_API_KEY: { value: 'shared.OPENAI', _modified_at: 'x' },
        PORT: { value: '3000', _modified_at: 'x' },
        // production wins per priority
        DATABASE_URL: { value: 'shared.DB_PROD', _modified_at: 'x' },
      },
    },
  };

  // Suppress the upgrade warning during the test.
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const fromV2 = resolveProject(v2, 'app');
    const fromV3 = resolveProject(expectedV3, 'app');
    assert.deepEqual(fromV2.resolved, fromV3.resolved);
    assert.deepEqual(fromV2.unresolved, fromV3.unresolved);
    assert.deepEqual(fromV2.invalid, fromV3.invalid);
  } finally {
    console.warn = origWarn;
  }
});

test('upgradeVault — v1 vault flat strings wrap into entries', () => {
  const v1 = {
    version: 1,
    shared: { TOKEN: 'sk-x' },
    projects: { app: { K: 'shared.TOKEN' } },
  };
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const r = resolveProject(v1, 'app');
    assert.equal(r.resolved.K, 'sk-x');
  } finally {
    console.warn = origWarn;
  }
});

test('upgradeVault — drops _default_env and other underscore keys', () => {
  const v2 = {
    version: 2,
    shared: {},
    projects: {
      app: {
        _default_env: 'production',
        _meta: 'whatever',
        K: 'val',
      },
    },
  };
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const upgraded = upgradeVault(v2);
    assert.equal('_default_env' in upgraded.projects.app, false);
    assert.equal('_meta' in upgraded.projects.app, false);
    assert.equal(upgraded.projects.app.K.value, 'val');
  } finally {
    console.warn = origWarn;
  }
});

test('upgradeVault — v3 input is idempotent', () => {
  const v3 = v3Fixture();
  const out = upgradeVault(v3);
  assert.equal(out.version, 3);
  assert.equal(out.projects['my-app'].PORT.value, '3000');
});
