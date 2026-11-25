import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildData, createOpenItems, lineKey } from '../src/openitems.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(text?: string, debounceMs = 20) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-C1-'));
  const file = join(dir, 'open-items.md');
  if (text !== undefined) writeFileSync(file, text);
  const calls: any[] = [];
  const panels = {
    setPanel: (p: any) => calls.push(['set', p]),
    removePanel: (id: string) => calls.push(['remove', id]),
    setPanelStatus: (s: any) => calls.push(['status', s]),
  };
  const src = createOpenItems({ panels, file, debounceMs });
  const sets = () => calls.filter((c) => c[0] === 'set').map((c) => c[1]);
  return { dir, file, calls, sets, src, done: () => { src.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

const FILE = `# Open items
- [ ] 20-11-2026 Run e2e
- [ ] 21-11-2026 (you) Decide wake
- [~] 22-11-2026 Check push (waiting on user)
- [x] Old thing verified 19-11-2026: ran npm test
`;

test('buildData: sort, kinds, reason, check', () => {
  const d = buildData(FILE);
  assert.deepEqual(d.items.map((i) => [i.kind, i.text, i.you]), [['open', 'Decide wake', true], ['open', 'Run e2e', false], ['parked', 'Check push', false], ['done', 'Old thing', false]]);
  assert.equal(d.items[2].reason, 'waiting on user');
  assert.equal(d.items[3].check, 'ran npm test');
  assert.equal(d.items[0].key, lineKey('- [ ] 21-11-2026 (you) Decide wake'));
  assert.match(d.items[0].key, /^[0-9a-f]{16}$/);
});

test('buildData: invalid counted, duplicates once, control chars stripped, text cut, 200 cap', () => {
  const d = buildData(`- [ ] 20-11-2026 a\u0007b\n- [ ] 20-11-2026 a\u0007b\n- [ ] 99-99-2026 bad\nnot an item\n- [ ] 20-11-2026 ${'x'.repeat(300)}\n`);
  assert.equal(d.items.length, 2);
  assert.equal(d.items[0].text, 'a b');
  assert.equal(d.items[1].text.length, 200);
  assert.equal(d.invalid, 1);
  const many = Array.from({ length: 205 }, (_, i) => `- [ ] 20-11-2026 item ${i}`).join('\n');
  const m = buildData(many);
  assert.equal(m.items.length, 200);
  assert.equal(m.truncated, 5);
});

test('key: fixed size however long the line, cannot hold control characters', () => {
  const d = buildData(`- [ ] 20-11-2026 ${'x'.repeat(500)}\u0007\n- [ ] 20-11-2026 Foo\n`);
  assert.equal(d.items.length, 2);
  assert.ok(d.items.every((i) => /^[0-9a-f]{16}$/.test(i.key)));
  assert.notEqual(d.items[0].key, d.items[1].key);
});

test('strip drops bidi overrides and zero width characters', () => {
  assert.equal(buildData('- [ ] 20-11-2026 a\u202Eb\u200Bc\u0007d\n').items[0].text, 'abc d');
});

test('setPanel once per real change, not for unchanged re-read', () => {
  const t = setup(FILE);
  t.src.start();
  t.src.refresh();
  t.src.refresh();
  assert.equal(t.sets().length, 1);
  assert.equal(t.sets()[0].kind, 'checklist');
  writeFileSync(t.file, FILE + '- [ ] 23-11-2026 More\n');
  t.src.refresh();
  assert.equal(t.sets().length, 2);
  t.done();
});

test('panel removed without items, returns with them; removed at startup if file missing', () => {
  const t = setup();
  t.src.refresh();
  assert.deepEqual(t.calls.filter((c) => c[0] === 'remove').length, 1);
  t.src.refresh();
  assert.equal(t.calls.filter((c) => c[0] === 'remove').length, 1);
  writeFileSync(t.file, FILE);
  t.src.refresh();
  assert.equal(t.sets().length, 1);
  writeFileSync(t.file, '# nothing\n');
  t.src.refresh();
  assert.equal(t.calls.filter((c) => c[0] === 'remove').length, 2);
  writeFileSync(t.file, FILE);
  t.src.refresh();
  assert.equal(t.sets().length, 2);
  t.done();
});

test('all done: panel still shown', () => {
  const t = setup('- [x] A verified 19-11-2026: ok\n');
  t.src.refresh();
  assert.equal(t.sets()[0].kind, 'checklist');
  t.done();
});

test('panel_status detail counts invalid lines, once', () => {
  const t = setup(FILE + '- [ ] bad line\n');
  t.src.refresh();
  t.src.refresh();
  const st = t.calls.filter((c) => c[0] === 'status');
  assert.equal(st.length, 1);
  assert.deepEqual(st[0][1].detail, { invalid: 1 });
  t.done();
});

test('read error: status not ok, panel kept', () => {
  const t = setup(FILE);
  t.src.refresh();
  rmSync(t.file);
  symlinkSync('/etc/hostname', t.file);
  t.src.refresh();
  assert.equal(t.calls.filter((c) => c[0] === 'status' && !c[1].ok).length, 1);
  assert.equal(t.calls.filter((c) => c[0] === 'remove').length, 0);
  t.done();
});

test('watcher: an external edit updates the panel after debounce', async () => {
  const t = setup(FILE);
  t.src.start();
  assert.equal(t.sets().length, 1);
  writeFileSync(t.file, FILE + '- [ ] 23-11-2026 Added\n');
  await sleep(300);
  assert.equal(t.sets().length, 2);
  t.done();
});

test('watcher starts on a later refresh when the folder was missing at start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-C1-'));
  const folder = join(dir, 'later'), file = join(folder, 'open-items.md');
  const sets: any[] = [];
  const panels = { setPanel: (p: any) => sets.push(p), removePanel: () => {}, setPanelStatus: () => {} };
  const src = createOpenItems({ panels, file, debounceMs: 20 });
  src.start();
  mkdirSync(folder);
  src.refresh(); // the folder exists now: the watcher starts
  writeFileSync(file, '- [ ] 20-11-2026 A\n');
  await sleep(300);
  assert.equal(sets.length, 1);
  src.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('the first refresh always emits a status', () => {
  const t = setup();
  t.src.start();
  assert.equal(t.calls.filter((c) => c[0] === 'status').length, 1);
  t.done();
});

test('the watcher survives its folder being removed and recreated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-C1-'));
  const folder = join(dir, 'ws'), file = join(folder, 'open-items.md');
  mkdirSync(folder);
  const sets: any[] = [];
  const panels = { setPanel: (p: any) => sets.push(p), removePanel: () => {}, setPanelStatus: () => {} };
  const src = createOpenItems({ panels, file, debounceMs: 20 });
  src.start();
  rmSync(folder, { recursive: true });
  await sleep(150);
  mkdirSync(folder);
  writeFileSync(file, '- [ ] 20-11-2026 A\n');
  for (let i = 0; i < 80 && !sets.length; i++) await sleep(100); // the slow retry timer is 5 s
  assert.equal(sets.length, 1);
  writeFileSync(file, '- [ ] 20-11-2026 A\n- [ ] 20-11-2026 B\n');
  for (let i = 0; i < 20 && sets.length < 2; i++) await sleep(50);
  assert.equal(sets.length, 2, 'the new watcher sees later edits');
  src.stop();
  rmSync(dir, { recursive: true, force: true });
});
