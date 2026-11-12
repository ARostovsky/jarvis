import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueSuffix, journalKey } from '../src/slug.ts';

test('uniqueSuffix is the clock suffix unless taken, then another one', () => {
  const now = 1_700_000_000_000, free = uniqueSuffix(new Set(), now);
  assert.equal(free, now.toString(36).slice(-4));
  const s = uniqueSuffix(new Set([free]), now);
  assert.notEqual(s, free);
  assert.match(s, /^[a-z0-9]{4}$/);
});

test('journalKey caps a long slug without a trailing dash', () => {
  const key = journalKey({ id: 'x-ab12', name: `${'a'.repeat(39)} ${'b'.repeat(30)}` });
  assert.equal(key, `${'a'.repeat(39)}-ab12`);
  assert.ok(key.length <= 45);
});
