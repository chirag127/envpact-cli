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
  getValue,
  getModifiedAt,
  isEncryptedEntry,
} = require('../lib/vault');

test('defaultVault has v3 schema', () => {
  const v = defaultVault();
  assert.equal(v.version, 3);
  assert.deepEqual(v.shared, {});
  assert.deepEqual(v.projects, {});
  assert.ok(v.metadata.created_at);
});

test('setProjectSecret stamps _modified_at', () => {
  const v = defaultVault();
  const before = Date.now();
  setProjectSecret(v, 'app', 'KEY', 'val');
  const after = Date.now();
  const entry = v.projects.app.KEY;
  assert.equal(entry.value, 'val');
  assert.ok(typeof entry._modified_at === 'string');
  const t = Date.parse(entry._modified_at);
  assert.ok(t >= before - 5 && t <= after + 5);
});

test('setProjectSecret ignores legacy environment param', () => {
  const v = defaultVault();
  setProjectSecret(v, 'app', 'KEY', 'val-prod', 'production');
  // v3 has no per-env nesting; the entry is flat.
  assert.equal(v.projects.app.KEY.value, 'val-prod');
  assert.ok(v.projects.app.KEY._modified_at);
});

test('setSharedSecret stamps _modified_at', () => {
  const v = defaultVault();
  setSharedSecret(v, 'TOKEN', 'sk-x');
  assert.equal(v.shared.TOKEN.value, 'sk-x');
  assert.ok(v.shared.TOKEN._modified_at);
});

test('findReferencingProjects — finds shared.* refs', () => {
  const v = defaultVault();
  setSharedSecret(v, 'API', 'k');
  setProjectSecret(v, 'a', 'K1', 'shared.API');
  setProjectSecret(v, 'b', 'K2', 'shared.API');
  setProjectSecret(v, 'b', 'OTHER', 'literal');
  const refs = findReferencingProjects(v, 'API');
  assert.equal(refs.length, 2);
  assert.deepEqual(refs.map((r) => r.project).sort(), ['a', 'b']);
});

test('save+load round-trip preserves data and timestamps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-vault-'));
  const tmp = path.join(dir, 'secrets.json');
  try {
    const v = defaultVault();
    setSharedSecret(v, 'X', 'y');
    setProjectSecret(v, 'a', 'K', 'shared.X');
    saveVault(v, tmp);
    const loaded = loadVault(tmp);
    assert.equal(loaded.version, 3);
    assert.equal(loaded.shared.X.value, 'y');
    assert.equal(loaded.projects.a.K.value, 'shared.X');
    assert.ok(loaded.shared.X._modified_at);
    assert.ok(loaded.projects.a.K._modified_at);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadVault — missing file throws helpful error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-vault-'));
  try {
    assert.throws(
      () => loadVault(path.join(dir, 'does-not-exist.json')),
      /Vault file not found/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadVault — auto-upgrades v2 in memory (no file rewrite)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-vault-'));
  const tmp = path.join(dir, 'secrets.json');
  try {
    const v2 = {
      version: 2,
      shared: { TOKEN: 'sk-x' },
      projects: { app: { _default_env: 'production', K: 'lit' } },
      metadata: { updated_at: '2026-06-15T00:00:00Z' },
    };
    fs.writeFileSync(tmp, JSON.stringify(v2));
    const origWarn = console.warn;
    console.warn = () => {};
    let loaded;
    try {
      loaded = loadVault(tmp);
    } finally {
      console.warn = origWarn;
    }
    assert.equal(loaded.version, 3);
    assert.equal(loaded.projects.app.K.value, 'lit');
    assert.equal('_default_env' in loaded.projects.app, false);

    // Verify the file on disk is UNCHANGED — reads must be idempotent.
    const onDisk = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    assert.equal(onDisk.version, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getValue / getModifiedAt / isEncryptedEntry helpers', () => {
  const e = { value: 'plain', _modified_at: '2026-06-19T00:00:00Z' };
  assert.equal(getValue(e), 'plain');
  assert.equal(getModifiedAt(e), '2026-06-19T00:00:00Z');
  assert.equal(isEncryptedEntry(e), false);

  const enc = { value: 'enc:xxx', _modified_at: 'now' };
  assert.equal(isEncryptedEntry(enc), true);

  assert.equal(getValue(undefined), undefined);
  assert.equal(getValue('legacy-string'), undefined);
});
