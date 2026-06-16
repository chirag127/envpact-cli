'use strict';

// AUDIT #15 — parseArgs allowlist. The previous parser silently
// accepted any --foo as truthy, so typos like `envpact --rotate-secret KEY`
// became `args.rotate_secret = true` and the user's actual key landed in
// args._ with no error. These tests pin the new behaviour.

const { test } = require('node:test');
const assert = require('node:assert');
const { parseArgs } = require('../bin/envpact.js');

const argv = (...rest) => ['node', 'envpact', ...rest];

test('parseArgs: bare --init defaults to truthy', () => {
  const r = parseArgs(argv('--init'));
  assert.strictEqual(r.init, true);
});

test('parseArgs: --init auto sets the value', () => {
  const r = parseArgs(argv('--init', 'auto'));
  assert.strictEqual(r.init, 'auto');
});

test('parseArgs: --init=auto (= form) sets the value', () => {
  const r = parseArgs(argv('--init=auto'));
  assert.strictEqual(r.init, 'auto');
});

test('parseArgs: -g short alias is accepted', () => {
  const r = parseArgs(argv('-g'));
  assert.strictEqual(r.g, true);
});

test('parseArgs: --rotate-secret is rejected (typo of --rotate)', () => {
  assert.throws(
    () => parseArgs(argv('--rotate-secret', 'FOO')),
    /unknown flag: --rotate-secret/,
  );
});

test('parseArgs: --foo=bar (= form) with unknown base is rejected', () => {
  assert.throws(
    () => parseArgs(argv('--foo=bar')),
    /unknown flag: --foo=bar/,
  );
});

test('parseArgs: unknown short flag -x is rejected', () => {
  assert.throws(
    () => parseArgs(argv('-x')),
    /unknown flag: -x/,
  );
});

test('parseArgs: -- ends option parsing; following tokens go to _', () => {
  const r = parseArgs(argv('--', '--rotate-secret', 'FOO'));
  assert.deepStrictEqual(r._, ['--rotate-secret', 'FOO']);
});

test('parseArgs: positional args after recognised flag are routed to _', () => {
  const r = parseArgs(argv('--list', 'positional1', 'positional2'));
  assert.strictEqual(r.list, true);
  assert.deepStrictEqual(r._, ['positional1', 'positional2']);
});

test('parseArgs: valued flag followed by another flag falls back to truthy', () => {
  const r = parseArgs(argv('--rotate', '--list'));
  assert.strictEqual(r.rotate, true);
  assert.strictEqual(r.list, true);
});
