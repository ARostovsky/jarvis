// Intercom mail is persisted in the event log: unseen mail survives a restart, seen mail is not delivered again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-intercom-test-'));
process.env.XDG_DATA_HOME = join(tmp, 'data'); // read when agents.ts loads
process.env.JARVIS_FAKE_SDK = resolve('e2e/fake-sdk.ts');
process.env.JARVIS_PLAYWRIGHT = '0';
const { addWorkspace, loadWorkspaces, workspaces } = await import('../src/agents.ts');

test('unseen mail survives a restart and seen mail is not delivered again', async () => {
  const a = addWorkspace('a'), b = addWorkspace('b');
  b.receive(a.meta.id, 'a', 'first');
  assert.equal(b.summary().intercom, 1);
  const bLog = join(tmp, 'data', 'jarvis', 'workspaces', b.meta.id, 'events.jsonl');
  const texts = () => readFileSync(bLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'text').map((e) => e.text as string);
  const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(f()); };

  // restart 1: still unread, and delivered with the next message
  workspaces.clear();
  loadWorkspaces();
  const b1 = workspaces.get(b.meta.id)!;
  assert.equal(b1.summary().intercom, 1);
  b1.tellArbiter('echo');
  await until(() => texts().some((t) => t.includes(`- from a (${a.meta.id}): first`)));
  assert.equal(b1.summary().intercom, 0);

  // restart 2: seen, so a new message does not bring it back
  await until(() => b1.summary().running === 0);
  workspaces.clear();
  loadWorkspaces();
  const b2 = workspaces.get(b.meta.id)!;
  assert.equal(b2.summary().intercom, 0);
  b2.receive(a.meta.id, 'a', 'second');
  b2.tellArbiter('echo');
  await until(() => texts().some((t) => t.includes('): second')));
  assert.ok(!texts().at(-1)!.includes('first'));
  // Ends the process because the fake sessions keep it alive: tests added after this one in this file would never run, so put them above it.
  process.exit(0);
});
