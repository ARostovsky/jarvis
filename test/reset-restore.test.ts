// A restart between a reset and the new session's start resends the seed instead of resuming the old session.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-reset-restore-test-'));
process.env.XDG_DATA_HOME = join(tmp, 'data');
process.env.JARVIS_FAKE_SDK = resolve('e2e/fake-sdk.ts');
process.env.JARVIS_PLAYWRIGHT = '0';
const { addWorkspace, loadWorkspaces, workspaces, ARBITER } = await import('../src/agents.ts');

const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(f()); };

test('log ending in a reset without a new session id gets the seed again, resuming nothing', async () => {
  const w = addWorkspace('restart');
  const log = join(tmp, 'data', 'jarvis', 'workspaces', w.meta.id, 'events.jsonl');
  const events = (): any[] => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  w.tellArbiter('say before');
  await until(() => events().some((e) => e.type === 'session') && w.summary().running === 0);
  const line = (e: object) => `${JSON.stringify({ at: 1, ...e })}\n`;
  appendFileSync(log, line({ type: 'session', agentId: ARBITER }) + line({ type: 'compacted', agentId: ARBITER, trigger: 'reset', pre: 1, unhandled: ['UNHANDLED-LOGGED'], handled: [{ text: 'HANDLED-LOGGED', reply: 'R' }] }));
  w.tellArbiter('resetusage 210000'); // the resent seed's first turn starts at 210k: only a session marked as reset-born stays below the floor guard
  await until(() => w.summary().running === 0);
  workspaces.clear();
  loadWorkspaces();
  await until(() => events().some((e) => e.type === 'text' && e.text.includes('UNHANDLED-LOGGED') && e.text.includes('HANDLED-LOGGED'))); // seed rebuilt from the logged lists
  assert.equal(events().filter((e) => e.type === 'session' && e.sessionId).length, 2); // a new session, not the first one resumed
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(events().filter((e) => e.type === 'compacted' && e.trigger === 'reset').length, 1); // born: no second reset at 210k
  workspaces.get(w.meta.id)!.tellArbiter('resetusage 0');
});

test('a restart keeps the create_workspace guards: outside sender and the create count', async () => {
  const create = async (w: ReturnType<typeof addWorkspace>, name: string) => {
    const log = join(tmp, 'data', 'jarvis', 'workspaces', w.meta.id, 'events.jsonl');
    const n = readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
    w.sendToAgent(ARBITER, `tool mcp__jarvis__create_workspace ${JSON.stringify({ name, task: 't' })}\nresult`, 'system'); // 'system' leaves the guards as they are
    const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(n);
    await until(() => lines().some((e) => e.type === 'result' && e.agentId === ARBITER));
    return lines().filter((e) => e.type === 'text').map((e) => e.text as string).join('\n');
  };
  const line = (e: object) => `${JSON.stringify({ at: 1, ...e })}\n`;
  const w = addWorkspace('guards a'), v = addWorkspace('guards b');
  appendFileSync(join(tmp, 'data', 'jarvis', 'workspaces', w.meta.id, 'events.jsonl'), line({ type: 'routed', from: 'workspace:zzz', to: ARBITER, text: 'x' }));
  const tool = line({ type: 'tool', agentId: ARBITER, name: 'mcp__jarvis__create_workspace', input: {} });
  appendFileSync(join(tmp, 'data', 'jarvis', 'workspaces', v.meta.id, 'events.jsonl'), line({ type: 'routed', from: 'user', to: ARBITER, text: 'x' }) + tool + tool + tool);
  workspaces.clear();
  loadWorkspaces();
  assert.match(await create(workspaces.get(w.meta.id)!, 'guard child a'), /refused while working on a message from another workspace/);
  assert.match(await create(workspaces.get(v.meta.id)!, 'guard child b'), /already created 3 workspaces/);
});

after(() => void setTimeout(() => process.exit(process.exitCode), 300));
