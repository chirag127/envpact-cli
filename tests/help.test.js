'use strict';

/**
 * Help-text smoke tests — pin the canonical CLI flag list (SHARED_SPEC §6).
 * Run the CLI via child_process to exercise printHelp() in isolation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'envpact.js');

function run(...flags) {
  const r = spawnSync(process.execPath, [BIN, ...flags], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('--help prints the spec §6 flag list', () => {
  const { code, stdout } = run('--help');
  assert.equal(code, 0);
  // Spot-check anchors. Don't pin every line — the cosmetic format
  // can drift — but the flag NAMES are part of the canonical CLI
  // surface and must stay.
  assert.match(stdout, /--init/);
  assert.match(stdout, /--vault-url/);
  assert.match(stdout, /--vault-repo/);
  assert.match(stdout, /--project/);
  assert.match(stdout, /--env-file/);
  assert.match(stdout, /--output/);
  assert.match(stdout, /--pull/);
  assert.match(stdout, /--push/);
  assert.match(stdout, /--status/);
  assert.match(stdout, /--force/);
  assert.match(stdout, /-g, --github/);
  assert.match(stdout, /--dry-run/);
  assert.match(stdout, /--rotate/);
  assert.match(stdout, /--list/);
  assert.match(stdout, /--list-shared/);
  assert.match(stdout, /--add /);
  assert.match(stdout, /--add-shared/);
  assert.match(stdout, /--encrypt/);
  assert.match(stdout, /--decrypt/);
  assert.match(stdout, /--vault-pull/);
  assert.match(stdout, /--vault-push/);
  assert.match(stdout, /--no-pull/);
  assert.match(stdout, /--no-push/);
  assert.match(stdout, /--from-stdin/);
});

test('--help mentions the new --sync-global flag (§1.6)', () => {
  const { code, stdout } = run('--help');
  assert.equal(code, 0);
  assert.match(stdout, /--sync-global/);
  // Quick sanity that the description points at the global env file
  // so users discover the feature without reading the spec.
  assert.match(stdout, /\.envpact\/\.env/);
});

test('-h short alias prints the same text', () => {
  const { code, stdout } = run('-h');
  assert.equal(code, 0);
  assert.match(stdout, /--sync-global/);
});

test('--version prints just the version', () => {
  const { code, stdout } = run('--version');
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});
