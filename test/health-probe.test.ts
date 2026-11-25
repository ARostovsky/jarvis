import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'jarvis-probe-test-'));
process.env.JARVIS_STATUS_URL = 'http://127.0.0.1:1/';
process.env.JARVIS_FAKE_SDK = resolve('test/fake-throw-sdk.ts');
await import('../src/agents.ts'); // registers the probe
const { maybeProbe, resetOutcome, health } = await import('../src/health.ts');

const probe = async (code: string, thrown: string) => {
  resetOutcome();
  process.env.FAKE_CODE = code;
  process.env.FAKE_THROW = thrown;
  const client = () => {};
  health.on('change', client);
  await maybeProbe();
  health.off('change', client);
  return (await import('../src/health.ts')).current;
};

test('a probe whose query yields authentication_failed and then throws unclassifiable text turns the dot red', async () => {
  const now = await probe('authentication_failed', 'Claude Code returned an error result: unclassifiable text');
  assert.equal(now.local?.kind, 'auth');
  assert.equal(now.level, 'major');
});

test('a typed error classify() ignores does not mask a classifiable thrown text', async () => {
  assert.equal((await probe('invalid_request', 'read ECONNRESET')).local?.kind, 'network');
  assert.equal((await probe('invalid_request', 'API Error: 503 upstream')).local?.kind, 'server');
});
