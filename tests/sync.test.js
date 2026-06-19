'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadLock,
  saveLock,
  lockPathFor,
  getKeyStatus,
  pullKey,
  pushKey,
  formatConflictMessage,
  SyncConflictError,
  LOCK_VERSION,
} = require('../lib/sync');

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------

function makeVault({ value = 'v', modAt = '2026-06-19T10:00:00.000Z' } = {}) {
  return {
    version: 3,
    shared: {},
    projects: {
      app: {
        KEY: { value, _modified_at: modAt },
      },
    },
  };
}

function entry(value, modAt) {
  return { value, _modified_at: modAt };
}

function lockEntry(modAt) {
  return { vault_modified_at: modAt, synced_at: '2026-06-19T10:05:00.000Z' };
}

// ------------------------------------------------------------
// getKeyStatus — all 6 states
// ------------------------------------------------------------

test('getKeyStatus — synced (values match, lock matches vault)', () => {
  const s = getKeyStatus('v', entry('v', 't1'), lockEntry('t1'));
  assert.equal(s, 'synced');
});

test('getKeyStatus — local_newer (values differ, vault unchanged)', () => {
  const s = getKeyStatus('local-edit', entry('v', 't1'), lockEntry('t1'));
  assert.equal(s, 'local_newer');
});

test('getKeyStatus — vault_newer (values match but lock is stale)', () => {
  const s = getKeyStatus('v', entry('v', 't2'), lockEntry('t1'));
  assert.equal(s, 'vault_newer');
});

test('getKeyStatus — both_diverged (values differ AND vault moved)', () => {
  const s = getKeyStatus('local-edit', entry('vault-new', 't2'), lockEntry('t1'));
  assert.equal(s, 'both_diverged');
});

test('getKeyStatus — local_only (local present, vault absent)', () => {
  const s = getKeyStatus('local', undefined, undefined);
  assert.equal(s, 'local_only');
});

test('getKeyStatus — vault_only (vault present, local absent)', () => {
  const s = getKeyStatus(undefined, entry('v', 't1'), undefined);
  assert.equal(s, 'vault_only');
});

test('getKeyStatus — no lock entry, values match → synced', () => {
  const s = getKeyStatus('v', entry('v', 't1'), undefined);
  assert.equal(s, 'synced');
});

test('getKeyStatus — no lock entry, values differ → both_diverged', () => {
  const s = getKeyStatus('a', entry('b', 't1'), undefined);
  assert.equal(s, 'both_diverged');
});

// ------------------------------------------------------------
// pullKey
// ------------------------------------------------------------

test('pullKey — synced state writes value through', () => {
  const vault = makeVault({ value: 'remote', modAt: 't1' });
  const lock = { version: 1, keys: { KEY: lockEntry('t1') } };
  const r = pullKey({
    projectName: 'app',
    key: 'KEY',
    vault,
    localEnvMap: { KEY: 'remote' },
    lock,
    force: false,
  });
  assert.equal(r.newLocalValue, 'remote');
  assert.equal(r.newLockEntry.vault_modified_at, 't1');
  assert.equal(r.status, 'synced');
});

test('pullKey — both_diverged throws without force', () => {
  const vault = makeVault({ value: 'vault-new', modAt: 't2' });
  const lock = { version: 1, keys: { KEY: lockEntry('t1') } };
  // values differ AND vault moved → both_diverged → throws.
  assert.throws(
    () =>
      pullKey({
        projectName: 'app',
        key: 'KEY',
        vault,
        localEnvMap: { KEY: 'local-edit' },
        lock,
        force: false,
      }),
    SyncConflictError
  );
});

test('pullKey — vault_newer (values currently match) pulls without force', () => {
  const vault = makeVault({ value: 'vault-new', modAt: 't2' });
  const lock = { version: 1, keys: { KEY: lockEntry('t1') } };
  const r = pullKey({
    projectName: 'app',
    key: 'KEY',
    vault,
    localEnvMap: { KEY: 'vault-new' },
    lock,
    force: false,
  });
  assert.equal(r.status, 'vault_newer');
  assert.equal(r.newLocalValue, 'vault-new');
  assert.equal(r.newLockEntry.vault_modified_at, 't2');
});

test('pullKey — refuses on local_newer without force', () => {
  const vault = makeVault({ value: 'remote', modAt: 't1' });
  const lock = { version: 1, keys: { KEY: lockEntry('t1') } };
  assert.throws(
    () =>
      pullKey({
        projectName: 'app',
        key: 'KEY',
        vault,
        localEnvMap: { KEY: 'i-edited-this' },
        lock,
        force: false,
      }),
    SyncConflictError
  );
});

test('pullKey — force overrides local_newer', () => {
  const vault = makeVault({ value: 'remote', modAt: 't1' });
  const lock = { version: 1, keys: { KEY: lockEntry('t1') } };
  const r = pullKey({
    projectName: 'app',
    key: 'KEY',
    vault,
    localEnvMap: { KEY: 'i-edited-this' },
    lock,
    force: true,
  });
  assert.equal(r.newLocalValue, 'remote');
  assert.equal(r.status, 'local_newer');
});

test('pullKey — refuses on both_diverged without force', () => {
  const vault = makeVault({ value: 'vault-new', modAt: 't2' });
  const lock = { version: 1, keys: { KEY: lockEntry('t1') } };
  assert.throws(
    () =>
      pullKey({
        projectName: 'app',
        key: 'KEY',
        vault,
        localEnvMap: { KEY: 'local-edit' },
        lock,
        force: false,
      }),
    SyncConflictError
  );
});

test('pullKey — KEY_NOT_IN_VAULT', () => {
  const vault = makeVault();
  assert.throws(
    () =>
      pullKey({
        projectName: 'app',
        key: 'OTHER',
        vault,
        localEnvMap: {},
        lock: { version: 1, keys: {} },
        force: false,
      }),
    /KEY_NOT_IN_VAULT/
  );
});

test('pullKey — follows shared.* one level', () => {
  const vault = {
    version: 3,
    shared: {
      THE_KEY: { value: 'sk-shared', _modified_at: 'sm1' },
    },
    projects: {
      app: {
        K: { value: 'shared.THE_KEY', _modified_at: 'pm1' },
      },
    },
  };
  const r = pullKey({
    projectName: 'app',
    key: 'K',
    vault,
    localEnvMap: { K: 'sk-shared' },
    lock: { version: 1, keys: { K: lockEntry('pm1') } },
    force: false,
  });
  assert.equal(r.newLocalValue, 'sk-shared');
});

// ------------------------------------------------------------
// pushKey
// ------------------------------------------------------------

test('pushKey — synced state writes new entry with current ts', () => {
  const vault = makeVault({ value: 'remote', modAt: 't1' });
  const lock = { version: 1, keys: { KEY: lockEntry('t1') } };
  const before = Date.now();
  const r = pushKey({
    projectName: 'app',
    key: 'KEY',
    vault,
    localValue: 'new-local',
    lock,
    force: false,
  });
  const after = Date.now();
  assert.equal(r.newVaultEntry.value, 'new-local');
  const t = Date.parse(r.newVaultEntry._modified_at);
  assert.ok(t >= before - 5 && t <= after + 5);
  assert.equal(r.status, 'local_newer');
});

test('pushKey — local_only (new key) pushes without conflict', () => {
  const vault = { version: 3, shared: {}, projects: { app: {} } };
  const r = pushKey({
    projectName: 'app',
    key: 'NEW',
    vault,
    localValue: 'fresh',
    lock: { version: 1, keys: {} },
    force: false,
  });
  assert.equal(r.status, 'local_only');
  assert.equal(r.newVaultEntry.value, 'fresh');
});

test('pushKey — refuses on vault_newer without force', () => {
  // vault advanced past lock; local matches latest vault (rare but
  // possible after a racy pull).
  const vault = makeVault({ value: 'remote', modAt: 't2' });
  const lock = { version: 1, keys: { KEY: lockEntry('t1') } };
  assert.throws(
    () =>
      pushKey({
        projectName: 'app',
        key: 'KEY',
        vault,
        localValue: 'remote',
        lock,
        force: false,
      }),
    SyncConflictError
  );
});

test('pushKey — refuses on both_diverged without force', () => {
  const vault = makeVault({ value: 'remote-new', modAt: 't2' });
  const lock = { version: 1, keys: { KEY: lockEntry('t1') } };
  assert.throws(
    () =>
      pushKey({
        projectName: 'app',
        key: 'KEY',
        vault,
        localValue: 'local-edit',
        lock,
        force: false,
      }),
    SyncConflictError
  );
});

test('pushKey — force overrides vault_newer', () => {
  const vault = makeVault({ value: 'remote', modAt: 't2' });
  const lock = { version: 1, keys: { KEY: lockEntry('t1') } };
  const r = pushKey({
    projectName: 'app',
    key: 'KEY',
    vault,
    localValue: 'remote',
    lock,
    force: true,
  });
  assert.equal(r.newVaultEntry.value, 'remote');
  assert.equal(r.status, 'vault_newer');
});

test('pushKey — KEY_NOT_IN_LOCAL', () => {
  const vault = makeVault();
  assert.throws(
    () =>
      pushKey({
        projectName: 'app',
        key: 'KEY',
        vault,
        localValue: undefined,
        lock: { version: 1, keys: {} },
        force: false,
      }),
    /KEY_NOT_IN_LOCAL/
  );
});

// ------------------------------------------------------------
// loadLock / saveLock round-trip
// ------------------------------------------------------------

test('loadLock — missing file returns empty lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-sync-'));
  try {
    const lock = loadLock(path.join(dir, '.env.example'));
    assert.equal(lock.version, LOCK_VERSION);
    assert.deepEqual(lock.keys, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadLock + saveLock round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-sync-'));
  const ex = path.join(dir, '.env.example');
  fs.writeFileSync(ex, 'KEY=\n');
  try {
    const lock = {
      version: 1,
      keys: { KEY: { vault_modified_at: 't1', synced_at: 't1' } },
    };
    saveLock(ex, lock);
    const reloaded = loadLock(ex);
    assert.deepEqual(reloaded, lock);
    assert.ok(fs.existsSync(`${ex}.lock`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lockPathFor sits next to the .env.example', () => {
  assert.equal(lockPathFor('foo/.env.example'), 'foo/.env.example.lock');
});

test('loadLock — corrupt JSON throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-sync-'));
  const ex = path.join(dir, '.env.example');
  try {
    fs.writeFileSync(`${ex}.lock`, '{not json');
    assert.throws(() => loadLock(ex), /Invalid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------
// formatConflictMessage — UTC + IST dual-render with newer label
// ------------------------------------------------------------

test('formatConflictMessage — vault newer is labelled (Recommended — newer)', () => {
  const msg = formatConflictMessage({
    key: 'OPENAI_API_KEY',
    project: 'my-app',
    status: 'vault_newer',
    vaultIso: '2026-06-19T07:30:00.000Z',
    localIso: '2026-06-19T07:25:00.000Z',
    direction: 'pull',
  });
  assert.ok(msg.includes('Conflict on KEY = OPENAI_API_KEY (project: my-app)'));
  // Both UTC strings appear verbatim.
  assert.ok(msg.includes('2026-06-19T07:30:00.000Z'));
  assert.ok(msg.includes('2026-06-19T07:25:00.000Z'));
  // Both IST strings appear.
  assert.ok(msg.includes('2026-06-19 13:00:00 IST'));
  assert.ok(msg.includes('2026-06-19 12:55:00 IST'));
  // Recommended label is on the vault's IST line (vault is newer).
  const istLines = msg.split('\n').filter((l) => l.includes('IST'));
  const vaultIstLine = istLines.find((l) => l.includes('13:00:00'));
  const localIstLine = istLines.find((l) => l.includes('12:55:00'));
  assert.match(vaultIstLine, /\(Recommended — newer\)/);
  assert.doesNotMatch(localIstLine, /\(Recommended — newer\)/);
  // Pull-direction hint surfaces.
  assert.ok(msg.includes('--force to overwrite local'));
});

test('formatConflictMessage — local newer flips the label', () => {
  const msg = formatConflictMessage({
    key: 'K',
    project: 'p',
    status: 'local_newer',
    vaultIso: '2026-06-19T07:00:00.000Z',
    localIso: '2026-06-19T07:30:00.000Z',
    direction: 'push',
  });
  const istLines = msg.split('\n').filter((l) => l.includes('IST'));
  const localIstLine = istLines.find((l) => l.includes('13:00:00'));
  const vaultIstLine = istLines.find((l) => l.includes('12:30:00'));
  assert.match(localIstLine, /\(Recommended — newer\)/);
  assert.doesNotMatch(vaultIstLine, /\(Recommended — newer\)/);
  assert.ok(msg.includes('--force to overwrite vault'));
});

test('formatConflictMessage — equal timestamps render no label', () => {
  const msg = formatConflictMessage({
    key: 'K',
    project: 'p',
    status: 'both_diverged',
    vaultIso: '2026-06-19T07:00:00.000Z',
    localIso: '2026-06-19T07:00:00.000Z',
    direction: 'pull',
  });
  assert.doesNotMatch(msg, /\(Recommended — newer\)/);
});

test('formatConflictMessage — handles missing local timestamp', () => {
  const msg = formatConflictMessage({
    key: 'K',
    project: 'p',
    status: 'vault_only',
    vaultIso: '2026-06-19T07:00:00.000Z',
    localIso: undefined,
    direction: 'pull',
  });
  assert.ok(msg.includes('no recorded sync timestamp'));
  // No crash, no Recommended label (only one side known).
  assert.doesNotMatch(msg, /\(Recommended — newer\)/);
});
