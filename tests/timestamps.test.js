'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatTimestamp, newerSide } = require('../lib/timestamps');

// ---------------------------------------------------------------
// formatTimestamp — UTC pass-through, IST in Asia/Kolkata
// ---------------------------------------------------------------

test('formatTimestamp — UTC pass-through is byte-identical', () => {
  const iso = '2026-06-19T07:30:00.000Z';
  const r = formatTimestamp(iso);
  assert.equal(r.utc, iso);
});

test('formatTimestamp — IST is +05:30 from UTC', () => {
  const r = formatTimestamp('2026-06-19T07:30:00.000Z');
  assert.equal(r.ist, '2026-06-19 13:00:00 IST');
});

test('formatTimestamp — IST date rolls forward when UTC is late evening', () => {
  // 19:30 UTC → 01:00 IST next day.
  const r = formatTimestamp('2026-06-18T19:30:00.000Z');
  assert.equal(r.ist, '2026-06-19 01:00:00 IST');
});

test('formatTimestamp — IST date rolls backward when UTC is past midnight', () => {
  // 00:30 UTC = 06:00 IST same day.
  const r = formatTimestamp('2026-06-19T00:30:00.000Z');
  assert.equal(r.ist, '2026-06-19 06:00:00 IST');
});

test('formatTimestamp — midnight UTC renders as 05:30 IST same day', () => {
  const r = formatTimestamp('2026-06-19T00:00:00.000Z');
  assert.equal(r.ist, '2026-06-19 05:30:00 IST');
});

test('formatTimestamp — IST does NOT depend on host TZ env var', () => {
  // No DST in IST — fixed +05:30 — but verify the formatter ignores
  // process.env.TZ regardless. Save/restore to keep the suite hermetic.
  const orig = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const r = formatTimestamp('2026-06-19T07:30:00.000Z');
    assert.equal(r.ist, '2026-06-19 13:00:00 IST');
  } finally {
    if (orig === undefined) delete process.env.TZ;
    else process.env.TZ = orig;
  }
});

test('formatTimestamp — handles ISO without milliseconds', () => {
  const r = formatTimestamp('2026-06-19T07:30:00Z');
  assert.equal(r.ist, '2026-06-19 13:00:00 IST');
  assert.equal(r.utc, '2026-06-19T07:30:00Z');
});

test('formatTimestamp — throws on non-string input', () => {
  assert.throws(() => formatTimestamp(undefined), TypeError);
  assert.throws(() => formatTimestamp(null), TypeError);
  assert.throws(() => formatTimestamp(1234), TypeError);
});

test('formatTimestamp — throws on unparseable string', () => {
  assert.throws(() => formatTimestamp('not-a-date'), RangeError);
  assert.throws(() => formatTimestamp(''), TypeError);
});

// ---------------------------------------------------------------
// newerSide — three-way comparator
// ---------------------------------------------------------------

test('newerSide — a > b returns "a"', () => {
  assert.equal(
    newerSide('2026-06-19T08:00:00.000Z', '2026-06-19T07:00:00.000Z'),
    'a'
  );
});

test('newerSide — b > a returns "b"', () => {
  assert.equal(
    newerSide('2026-06-19T07:00:00.000Z', '2026-06-19T08:00:00.000Z'),
    'b'
  );
});

test('newerSide — equal timestamps return "tie"', () => {
  assert.equal(
    newerSide('2026-06-19T07:00:00.000Z', '2026-06-19T07:00:00.000Z'),
    'tie'
  );
});

test('newerSide — both invalid returns "tie"', () => {
  assert.equal(newerSide('garbage', 'also-garbage'), 'tie');
});

test('newerSide — only a invalid returns "b"', () => {
  assert.equal(newerSide('garbage', '2026-06-19T07:00:00.000Z'), 'b');
});

test('newerSide — only b invalid returns "a"', () => {
  assert.equal(newerSide('2026-06-19T07:00:00.000Z', 'garbage'), 'a');
});
