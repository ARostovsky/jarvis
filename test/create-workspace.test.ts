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

test('refuses a relative project and leaves no workspace', async () => {
  const w = addWorkspace('rel');
  const count = workspaces.size;
  assert.match(await create(w, { name: 'relchild', task: 't', project: 'some/relative' }), /project must be an absolute path/);
  assert.equal(workspaces.size, count);
});

test('at most 3 creates until the user writes again', async () => {
  const w = addWorkspace('cap');
  // One user message: every later message from the user would reset the count.
  const lines = ['one', 'two', 'three', 'four'].map((n) => `tool mcp__jarvis__create_workspace ${JSON.stringify({ name: `cap ${n}`, task: 't' })}\nresult`);
  const before = log(w.meta.id).length;
  w.tellArbiter(lines.join('\n'));
  await until(() => log(w.meta.id).slice(before).some((e) => e.type === 'result' && e.agentId === ARBITER));
  const texts = log(w.meta.id).slice(before).filter((e) => e.type === 'text').map((e) => e.text as string);
  assert.equal(texts.filter((t) => t.startsWith('created workspace')).length, 3);
  assert.match(texts[3], /already created 3 workspaces/);
  assert.equal([...workspaces.values()].some((x) => x.meta.name === 'cap four'), false);
});

test('refused while the turn came from another workspace, allowed again after the user writes', async () => {
  const w = addWorkspace('outside');
  const turn = async (from: string, name: string) => {
    const before = log(w.meta.id).length;
    w.sendToAgent(ARBITER, `tool mcp__jarvis__create_workspace ${JSON.stringify({ name, task: 't' })}\nresult`, from);
    await until(() => log(w.meta.id).slice(before).some((e) => e.type === 'result' && e.agentId === ARBITER));
    return log(w.meta.id).slice(before).filter((e) => e.type === 'text').map((e) => e.text as string).join('\n');
  };
  assert.match(await turn('workspace:zzz', 'outside child'), /refused while working on a message from another workspace/);
  assert.equal([...workspaces.values()].some((x) => x.meta.name === 'outside child'), false);
  assert.match(await turn('user', 'outside child'), /created workspace/);
});

test('an agent that is not the arbiter has no create_workspace tool', async () => {
  const w = addWorkspace('agentcreate');
  const count = workspaces.size;
  const task = `tool mcp__jarvis__create_workspace ${JSON.stringify({ name: 'agentchild', task: 't' })}\nresult`;
  w.tellArbiter(`tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'helper', task })}`);
  await until(() => log(w.meta.id).some((e) => e.type === 'routed' && e.to === ARBITER && /finished/.test(e.text)));
  assert.equal(workspaces.size, count);
  assert.match(log(w.meta.id).find((e) => e.type === 'routed' && e.to === ARBITER && /finished/.test(e.text)).text, /no such tool|not found|unknown|Tool/i);
});

// The fake sessions keep the process alive: end it once the report is out (a failure keeps its exit code).
after(() => void setTimeout(() => process.exit(process.exitCode), 300));
