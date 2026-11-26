// Open items wiring: panel from the file, prompt gating, notes change, reset seed. Fake SDK, no API.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-oi-wiring-test-')));
process.env.XDG_DATA_HOME = join(tmp, 'data');
process.env.JARVIS_FAKE_SDK = resolve('e2e/fake-sdk.ts');
process.env.JARVIS_PLAYWRIGHT = '0';
const { archiveWorkspace, restoreWorkspace, addWorkspace, setWorkspaceNotes, loadWorkspaces, workspaces, ARBITER } = await import('../src/agents.ts');
const { openItemsPrompt, OPEN_ITEMS_RULES, openItemsSeed } = await import('../src/openitems-wiring.ts');
const { resetSeed } = await import('../src/reset.ts');
const { workspaceDir } = await import('../src/notes-layout.ts');

const log = (id: string): any[] => readFileSync(join(tmp, 'data', 'jarvis', 'workspaces', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(f()); };
const settled = (id: string, before: number) => until(() => log(id).slice(before).some((e) => e.type === 'result' && e.agentId === ARBITER));
const notes = join(tmp, 'notes');
const itemsFile = (w: { meta: { id: string } }, n = notes) => join(workspaceDir({ id: w.meta.id, notes: n }), 'open-items.md');
const LINES = ['- [ ] 25-11-2026 (you) Decide wake policy', '- [ ] 25-11-2026 Run the e2e', '- [~] 25-11-2026 Old thing (waiting on user)', '- [x] Pushed verified 24-11-2026: git log origin'];
const say = async (w: any, text: string) => {
  const n = log(w.meta.id).length;
  w.tellArbiter(text);
  await settled(w.meta.id, n);
  return log(w.meta.id).slice(n).filter((e) => e.type === 'text' && e.agentId === ARBITER).map((e) => e.text as string).join('\n');
};
const items = (w: any) => w.panels.panels().find((p: any) => p.panelId === 'open-items')?.data.items as any[] | undefined;

after(() => { for (const w of workspaces.values()) w.stopAll?.(); });

test('prompt text: gated by notes and JARVIS_OPEN_ITEMS, no duplicate of the format rules', () => {
  assert.equal(openItemsPrompt(), '');
  const p = openItemsPrompt('/n');
  for (const s of ['"Open items" panel', 're-read it right before each edit', 'verified it yourself', 'read-only', 'telling you in chat', 'unless they block the goal or the user asks']) assert.ok(p.includes(s), s);
  assert.ok(!OPEN_ITEMS_RULES.includes('DD-MM-YYYY'));
  process.env.JARVIS_OPEN_ITEMS = '0';
  try { assert.equal(openItemsPrompt('/n'), ''); } finally { delete process.env.JARVIS_OPEN_ITEMS; }
});

test('seed lines: up to 20 texts, the rest counted, none without items', () => {
  assert.equal(openItemsSeed([]), '');
  const s = openItemsSeed(Array.from({ length: 23 }, (_, i) => `item ${i}`));
  assert.ok(s.includes('- item 19') && !s.includes('- item 20') && s.includes('and 3 more'));
  const base = { workspace: 'W', agents: [], last: '', unhandled: [], handled: [] };
  assert.ok(resetSeed({ ...base, notes: '/n', openItems: ['A-ITEM'] }).includes('- A-ITEM'));
  assert.ok(!resetSeed({ ...base, openItems: ['A-ITEM'] }).includes('A-ITEM')); // only with notes
});

test('panel from the file, read-only, prompt text', async () => {
  const w = addWorkspace('oi', undefined, {}, notes);
  assert.equal(items(w), undefined); // the template holds no item
  appendFileSync(itemsFile(w), `${LINES.join('\n')}\n`);
  w.refreshOpenItems(); // what GET /panels does
  assert.deepEqual(items(w)!.map((i) => i.kind), ['open', 'open', 'parked', 'done']);
  assert.equal(items(w)![0].you, true);
  assert.match(await say(w, 'option systemPrompt'), /pinned above this chat/);
  assert.ok(!(await say(w, 'option allowedTools')).includes('open_items'));
  // read-only: no handler, the next message carries no note
  await assert.rejects(async () => w.panels.runAction('open-items', 'toggle', { key: 'x', done: true }), (e: any) => e.status === 400);
  assert.ok(!(await say(w, 'echo')).includes('[open items]'));
});

test('a workspace gets the panel when its notes folder is set later; switch off removes it', async () => {
  const w = addWorkspace('late');
  const other = join(tmp, 'notes2');
  mkdirSync(other, { recursive: true });
  setWorkspaceNotes(w.meta.id, other);
  appendFileSync(itemsFile(w, other), `${LINES[1]}\n`);
  w.refreshOpenItems();
  assert.equal(items(w)!.length, 1);
  setWorkspaceNotes(w.meta.id, '');
  assert.equal(items(w), undefined);
  setWorkspaceNotes(w.meta.id, other);
  w.refreshOpenItems();
  assert.equal(items(w)!.length, 1);
  process.env.JARVIS_OPEN_ITEMS = '0';
  try {
    setWorkspaceNotes(w.meta.id, other); // re-saves the folder: the source is re-evaluated
    assert.equal(items(w), undefined);
    assert.ok(!(await say(w, 'option systemPrompt')).includes('pinned above this chat'));
  } finally { delete process.env.JARVIS_OPEN_ITEMS; }
});

test('after a restart and a reset the items are in the panels and in the seed', async () => {
  const w = addWorkspace('seeded', undefined, {}, notes);
  const id = w.meta.id;
  writeFileSync(itemsFile(w), `${LINES[0]}\n${LINES[1]}\n`);
  w.refreshOpenItems();
  await say(w, 'say before');
  const line = (e: object) => `${JSON.stringify({ at: 1, ...e })}\n`;
  appendFileSync(join(tmp, 'data', 'jarvis', 'workspaces', id, 'events.jsonl'), line({ type: 'session', agentId: ARBITER }) + line({ type: 'compacted', agentId: ARBITER, trigger: 'reset', pre: 1, unhandled: [], handled: [] }));
  workspaces.clear();
  loadWorkspaces();
  const r = workspaces.get(id)!;
  assert.equal(items(r)!.length, 2); // from the file, no turn
  await until(() => log(id).some((e) => e.type === 'text' && e.text.includes('Decide wake policy') && e.text.includes('Run the e2e')));
});

test('a notes folder created at the first arbiter message gets the watcher without a manual refresh', async () => {
  const n2 = join(tmp, 'notes-late');
  const w = addWorkspace('late-folder', undefined, {}, n2);
  rmSync(n2, { recursive: true, force: true }); // the folder is gone when the session starts
  w.refreshOpenItems();
  await say(w, 'hello'); // ensureOwnNotes recreates the folder and restarts the source
  appendFileSync(itemsFile(w, n2), `${LINES[1]}\n`);
  await until(() => items(w)?.length === 1);
});

test('restore from the archive shows the panel without a panel_removed', () => {
  const n = join(tmp, 'restore-notes');
  const w = addWorkspace('oi-restore', undefined, {}, n);
  writeFileSync(itemsFile(w, n), LINES.join('\n') + '\n');
  w.refreshOpenItems();
  const before = log(w.meta.id).length;
  assert.deepEqual(archiveWorkspace(w.meta.id).notes.result, 'moved');
  restoreWorkspace(w.meta.id);
  const after = log(w.meta.id).slice(before);
  assert.ok(!after.some((e) => e.type === 'panel_removed'), 'no spurious removal');
  assert.ok(items(workspaces.get(w.meta.id))?.length);
});
