'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseEnvContent,
  parseEnvFileToMap,
  renderEnvFile,
  renderBodyFromExample,
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

test('parseEnvFileToMap — returns flat KEY=value map', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-test-'));
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, 'A=1\nB=hello\n');
  try {
    const map = parseEnvFileToMap(f);
    assert.deepEqual(map, { A: '1', B: 'hello' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseEnvFileToMap — missing file returns empty map', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-test-'));
  try {
    const map = parseEnvFileToMap(path.join(dir, 'nope'));
    assert.deepEqual(map, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------
// Byte-faithful renderer (SHARED_SPEC §5)
// ---------------------------------------------------------------

test('renderBodyFromExample — comments + blanks pass through verbatim', () => {
  const example = '# header comment\n\n  # indented comment\nKEY=hint\n';
  const body = renderBodyFromExample(example, { KEY: 'value' });
  assert.equal(
    body,
    '# header comment\n\n  # indented comment\nKEY=value\n'
  );
});

test('renderBodyFromExample — preserves key order from example', () => {
  const example = 'B=hint\nA=hint\nC=hint\n';
  const body = renderBodyFromExample(example, { A: '1', B: '2', C: '3' });
  assert.equal(body, 'B=2\nA=1\nC=3\n');
});

test('renderBodyFromExample — missing key becomes "# KEY: unresolved"', () => {
  const example = 'A=hint\nMISSING=hint\nC=hint\n';
  const body = renderBodyFromExample(example, { A: '1', C: '3' });
  assert.equal(body, 'A=1\n# MISSING: unresolved\nC=3\n');
});

test('renderBodyFromExample — quotes values with whitespace', () => {
  const example = 'A=\n';
  const body = renderBodyFromExample(example, { A: 'hello world' });
  assert.equal(body, 'A="hello world"\n');
});

test('renderBodyFromExample — preserves trailing newline absence', () => {
  const example = 'A=hint';
  const body = renderBodyFromExample(example, { A: '1' });
  // Input had no trailing \n → output should not invent one.
  assert.equal(body, 'A=1');
});

test('renderBodyFromExample — preserves CRLF line endings', () => {
  const example = '# c\r\nA=hint\r\nB=hint\r\n';
  const body = renderBodyFromExample(example, { A: '1', B: '2' });
  assert.equal(body, '# c\r\nA=1\r\nB=2\r\n');
});

test('renderEnvFile — byte-faithful mode prepends header above body', () => {
  const example = '# section\nFOO=hint\n\n# another\nBAR=hint\n';
  const out = renderEnvFile(['FOO', 'BAR'], { FOO: '1', BAR: '2' }, {
    exampleContent: example,
  });
  // Strip the timestamp line to get a stable comparison.
  const lines = out.split('\n');
  assert.match(lines[0], /^# Generated by envpact on /);
  assert.equal(lines[1], '# DO NOT COMMIT — add .env to .gitignore');
  // Body is the example, byte-faithful, after the header.
  const bodyStart = out.indexOf('\n', out.indexOf('\n') + 1) + 1;
  assert.equal(out.slice(bodyStart), '# section\nFOO=1\n\n# another\nBAR=2\n');
});

test('renderEnvFile — fixture: known example produces deterministic body', () => {
  // The fixture is hand-crafted so we can assert byte equality.
  const example = [
    '# Project secrets',
    '',
    '# Required',
    'DATABASE_URL=postgresql://...',
    'PORT=3000',
    '',
    '# Optional',
    'OPENAI_API_KEY=sk-...',
    '',
  ].join('\n');
  const expectedBody = [
    '# Project secrets',
    '',
    '# Required',
    'DATABASE_URL=postgresql://localhost/myapp',
    'PORT=3000',
    '',
    '# Optional',
    '# OPENAI_API_KEY: unresolved',
    '',
  ].join('\n');
  const body = renderBodyFromExample(example, {
    DATABASE_URL: 'postgresql://localhost/myapp',
    PORT: '3000',
  });
  assert.equal(body, expectedBody);
});

test('renderEnvFile — legacy mode (no exampleContent) still works', () => {
  const out = renderEnvFile(['B', 'A'], { A: '1', B: '2' });
  // Header + blank + body per the legacy emitter.
  assert.match(out, /^# Generated by envpact on /);
  assert.ok(out.includes('B=2\nA=1\n'));
});
