'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseEnvContent,
  renderEnvFile,
  formatValue,
  writeEnvFileAtomic,
  ensureGitignoreCovers,
} = require('../lib/parser');

test('parseEnvContent — simple KEY=VALUE', () => {
  const r = parseEnvContent('A=1\nB=hello\n');
  assert.deepEqual(r.keys, ['A', 'B']);
  assert.deepEqual(r.values, { A: '1', B: 'hello' });
});

test('parseEnvContent — quoted with escapes', () => {
  const r = parseEnvContent('A="line1\\nline2"\nB="quote\\""\n');
  assert.equal(r.values.A, 'line1\nline2');
  assert.equal(r.values.B, 'quote"');
});

test('parseEnvContent — comments and blank lines', () => {
  const r = parseEnvContent('# c\n\nA=1\n# more\nB=2\n');
  assert.deepEqual(r.keys, ['A', 'B']);
});

test('parseEnvContent — invalid keys ignored', () => {
  const r = parseEnvContent('123=bad\nGOOD=ok\n');
  assert.deepEqual(r.keys, ['GOOD']);
});

test('formatValue — quotes when whitespace', () => {
  assert.equal(formatValue('hello world'), '"hello world"');
});

test('formatValue — bare for plain values', () => {
  assert.equal(formatValue('plain123'), 'plain123');
});

test('formatValue — escapes newlines', () => {
  assert.equal(formatValue('a\nb'), '"a\\nb"');
});

test('renderEnvFile — preserves key order', () => {
  const out = renderEnvFile(['B', 'A', 'C'], { A: '1', B: '2', C: '3' });
  const body = out.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(body, ['B=2', 'A=1', 'C=3']);
});

test('writeEnvFileAtomic — round-trip', () => {
  const tmp = path.join(os.tmpdir(), `envpact-test-${process.pid}.env`);
  writeEnvFileAtomic(tmp, 'X=1\n');
  assert.equal(fs.readFileSync(tmp, 'utf8'), 'X=1\n');
  fs.unlinkSync(tmp);
});

test('ensureGitignoreCovers — adds when missing, idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-test-'));
  const a = ensureGitignoreCovers(dir, '.env');
  const b = ensureGitignoreCovers(dir, '.env');
  assert.equal(a, true);
  assert.equal(b, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
