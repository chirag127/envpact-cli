'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSafeRepoSlug } = require('../lib/git');

test('assertSafeRepoSlug accepts plain owner/repo', () => {
  assertSafeRepoSlug('chirag127/envpact-secrets');
  assertSafeRepoSlug('a/b');
  assertSafeRepoSlug('user.name/repo.name');
  assertSafeRepoSlug('with-dash/under_score');
});

test('assertSafeRepoSlug rejects shell metacharacters', () => {
  assert.throws(() => assertSafeRepoSlug('foo;rm -rf /'));
  assert.throws(() => assertSafeRepoSlug('foo/bar; cat /etc/passwd'));
  assert.throws(() => assertSafeRepoSlug('foo/bar`whoami`'));
  assert.throws(() => assertSafeRepoSlug('foo/$(echo bad)'));
  assert.throws(() => assertSafeRepoSlug('foo/bar\nbaz'));
});

test('assertSafeRepoSlug rejects path traversal', () => {
  assert.throws(() => assertSafeRepoSlug('../etc/passwd'));
  assert.throws(() => assertSafeRepoSlug('foo/../bar'));
  assert.throws(() => assertSafeRepoSlug('/foo/bar'));
});

test('assertSafeRepoSlug rejects malformed', () => {
  assert.throws(() => assertSafeRepoSlug(''));
  assert.throws(() => assertSafeRepoSlug('justone'));
  assert.throws(() => assertSafeRepoSlug('foo/bar/baz'));
  assert.throws(() => assertSafeRepoSlug('foo/'));
  assert.throws(() => assertSafeRepoSlug('/bar'));
  assert.throws(() => assertSafeRepoSlug(null));
  assert.throws(() => assertSafeRepoSlug(undefined));
});

test('assertSafeRepoSlug rejects spaces and unicode tricks', () => {
  assert.throws(() => assertSafeRepoSlug('foo bar/baz'));
  assert.throws(() => assertSafeRepoSlug('foo/bar baz'));
  assert.throws(() => assertSafeRepoSlug(' foo/bar'));
  assert.throws(() => assertSafeRepoSlug('foo/bar '));
});
