// create_workspace: refusals, and a new workspace that shares project, notes and arbiter setup while the old one stays untouched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-create-ws-test-'));
process.env.XDG_DATA_HOME = join(tmp, 'data'); // read when agents.ts loads
process.env.JARVIS_FAKE_SDK = resolve('e2e/fake-sdk.ts');
process.env.JARVIS_PLAYWRIGHT = '0';
const { addWorkspace, workspaces, ARBITER } = await import('../src/agents.ts');

const log = (id: string): any[] => readFileSync(join(tmp, 'data', 'jarvis', 'workspaces', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(f()); };

// The tool handler is not exported: drive it as the fake SDK does, through the arbiter's session. Returns the arbiter's text of that turn.
async function create(w: ReturnType<typeof addWorkspace>, input: object) {
  const before = log(w.meta.id).length;
  w.tellArbiter(`tool mcp__jarvis__create_workspace ${JSON.stringify(input)}\nresult`);
  await until(() => log(w.meta.id).slice(before).some((e) => e.type === 'result' && e.agentId === ARBITER));
  return log(w.meta.id).slice(before).filter((e) => e.type === 'text' && e.agentId === ARBITER).map((e) => e.text as string).join('\n');
}

test('refuses a duplicate live name, an empty name or task, and an over-cap task', async () => {
  const a = addWorkspace('dup a');
  addWorkspace('dup b');
  const count = workspaces.size;
  assert.match(await create(a, { name: 'DUP B', task: 't' }), /a workspace named "dup b" exists/);
  assert.match(await create(a, { name: 'dup a', task: 't' }), /exists/);
  assert.match(await create(a, { name: '  ', task: 't' }), /name is empty/);
  assert.match(await create(a, { name: 'x', task: ' ' }), /task is empty/);
  assert.match(await create(a, { name: 'x', task: 'y'.repeat(12001) }), /limit is 12000/);
  assert.equal(workspaces.size, count);
});

test('success: same project, notes and arbiter setup, task reaches the new arbiter, old workspace untouched', async () => {
  const project = join(tmp, 'proj'), notes = join(tmp, 'notes');
  mkdirSync(project);
  const old = addWorkspace('old', project, { model: 'opus', effort: 'high' }, notes);
  old.sendToAgent(ARBITER, `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'busy', task: 'sleep 5000' })}\nresult`, 'user');
  await until(() => log(old.meta.id).some((e) => e.type === 'status' && e.status === 'running' && e.agentId !== ARBITER));

  const text = await create(old, { name: 'child', task: 'DO-THE-THING' }); // a running agent does not block it
  const next = [...workspaces.values()].find((w) => w.meta.name === 'child')!;
  assert.match(text, new RegExp(`created workspace child \\(${next.meta.id}\\)`));
  assert.deepEqual([next.meta.project, next.meta.notes], [resolve(project), resolve(notes)]);
  const cfg = log(next.meta.id).find((e) => e.type === 'config');
  assert.deepEqual([cfg.model, cfg.effort], ['opus', 'high']);
  const first = log(next.meta.id).find((e) => e.type === 'routed');
  assert.equal(first.from, `workspace:${old.meta.id}`);
  assert.match(first.text, /not from the user[\s\S]*DO-THE-THING/);

  assert.equal(old.summary().running, 1); // the old workspace's agent still runs
});

// The fake sessions keep the process alive: end it once the report is out (a failure keeps its exit code).
after(() => void setTimeout(() => process.exit(process.exitCode), 300));
