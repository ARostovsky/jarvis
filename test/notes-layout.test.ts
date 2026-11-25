import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPEN_ITEMS_FORMAT, arbiterNotesPrompt, ensureWorkspaceNotes, migrationNotice, parseOpenItems, saveTurnText, workspaceDir } from '../src/notes-layout.ts';
import { resetSeed } from '../src/reset.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'jarvis-layout-'));
const meta = (notes?: string) => ({ id: 'my-ws-ab12', name: 'My WS', ...(notes ? { notes } : {}) });

test('templates are created once and never overwritten', () => {
  const notes = tmp();
  const first = ensureWorkspaceNotes(meta(notes));
  assert.equal(first.created.length, 2);
  const dir = workspaceDir({ id: 'my-ws-ab12', notes });
  assert.match(readFileSync(join(dir, 'status.md'), 'utf8'), /^# Status: My WS\n.*my-ws-ab12[^]*Summary:/);
  writeFileSync(join(dir, 'status.md'), 'edited by user');
  assert.deepEqual(ensureWorkspaceNotes(meta(notes)).created, []);
  assert.equal(readFileSync(join(dir, 'status.md'), 'utf8'), 'edited by user');
});

test('no notes folder: nothing written', () => {
  assert.deepEqual(ensureWorkspaceNotes(meta()).created, []);
});

test('bad id throws', () => {
  for (const id of ['../x', 'a/b', 'A', '']) assert.throws(() => ensureWorkspaceNotes({ id, name: 'n', notes: tmp() }), /bad workspace id/);
});

test('a symlinked workspaces folder, id folder or file is refused or left alone', () => {
  const outside = tmp();
  const a = tmp();
  symlinkSync(outside, join(a, 'workspaces'));
  assert.throws(() => ensureWorkspaceNotes(meta(a)), /not a plain folder/);
  const b = tmp();
  mkdirSync(join(b, 'workspaces'));
  symlinkSync(outside, join(b, 'workspaces', 'my-ws-ab12'));
  assert.throws(() => ensureWorkspaceNotes(meta(b)), /not a plain folder/);
  const c = tmp();
  mkdirSync(join(c, 'workspaces', 'my-ws-ab12'), { recursive: true });
  symlinkSync(join(outside, 'target.md'), join(c, 'workspaces', 'my-ws-ab12', 'status.md'));
  ensureWorkspaceNotes(meta(c));
  assert.ok(!existsSync(join(outside, 'target.md')));
  assert.ok(!existsSync(join(outside, 'status.md')) && !existsSync(join(outside, 'open-items.md')));
});

test('parseOpenItems reads the three kinds, both date orders and [X]', () => {
  const { items, invalid } = parseOpenItems([
    '# Open items', 'prose', '',
    '- [ ] 25-11-2026 Merge branch',
    '- [~] 2026-11-25 Push main (waiting on user)',
    '- [x] Alerts fixed verified 19-11-2026: gh api shows 0',
    '- [X] Upper verified 20-11-2026: ok',
    '- [x] It said verified 01-01-2026: x and then verified 02-01-2026: real check',
  ].join('\n'));
  assert.deepEqual(invalid, []);
  assert.deepEqual(items.map((i) => i.kind), ['open', 'parked', 'done', 'done', 'done']);
  assert.equal(items[1].text, 'Push main (waiting on user)');
  assert.equal(items[2].check, 'gh api shows 0');
  assert.equal(items[4].text, 'It said verified 01-01-2026: x and then');
  assert.equal(items[4].date, '02-01-2026');
});

test('parseOpenItems returns bad "- [" lines as invalid', () => {
  const { items, invalid } = parseOpenItems('- [ ] no date here\n- [x] done without check\n- [!] 25-11-2026 x\n- [ ] 25-11-2026 ok');
  assert.equal(items.length, 1);
  assert.equal(invalid.length, 3);
});

test('the template comment blocks contain no item', () => {
  const notes = tmp();
  ensureWorkspaceNotes(meta(notes));
  const text = readFileSync(join(workspaceDir({ id: 'my-ws-ab12', notes }), 'open-items.md'), 'utf8');
  assert.deepEqual(parseOpenItems(text), { items: [], invalid: [] });
});

test('format sentence and arbiter notes paragraph', () => {
  for (const s of ['DD-MM-YYYY', '[~]', '(waiting on user)', '(not verified)', 'verified', 'open-items.md']) assert.ok(OPEN_ITEMS_FORMAT.includes(s), s);
  const m = { ...meta('/n'), notes: '/n' };
  const p = arbiterNotesPrompt(m, '/n/workspaces/my-ws-ab12');
  for (const s of ['/n/workspaces/my-ws-ab12', 'Summary:', 'DD-MM-YYYY', 'legacy shared files', OPEN_ITEMS_FORMAT, 'journal/YYYY-MM-DD-my-ws-ab12.md', 'notes_message']) assert.ok(p.includes(s), s);
  assert.ok(!p.includes('Mark your status.md entries'));
});

test('save turn texts name the own files and the format', () => {
  const m = { ...meta('/n'), notes: '/n' };
  for (const kind of ['forced', 'auto'] as const) {
    const t = saveTurnText(kind, m, '/n/workspaces/my-ws-ab12', 160_000);
    for (const s of ['/n/workspaces/my-ws-ab12/status.md', '/n/workspaces/my-ws-ab12/open-items.md', OPEN_ITEMS_FORMAT]) assert.ok(t.includes(s), s);
  }
  assert.match(saveTurnText('auto', m, 'w', 160_000), /^\[context 160k tokens/);
  assert.match(saveTurnText('forced', m, 'w'), /^\[reset ordered by the user\]/);
});

test('migration notice and seed point to the workspace folder', () => {
  const m = { ...meta('/n'), notes: '/n' };
  assert.match(migrationNotice(m, '/n/workspaces/x'), /^\[notes layout changed\][^]*\/n\/workspaces\/x[^]*"My WS"/);
  const seed = resetSeed({ workspace: 'W', notes: '/n', wsNotes: '/n/workspaces/x', agents: [], last: '', unhandled: [], handled: [] });
  for (const s of ['/n/workspaces/x/status.md', '/n/workspaces/x/open-items.md', '/n/workspaces/']) assert.ok(seed.includes(s), s);
});

test('parser: an unclosed comment opener hides nothing, indented items and impossible dates are invalid', () => {
  const stray = parseOpenItems('<!-- stray opener\n- [ ] 25-11-2026 still seen\n- [~] 25-11-2026 also (not verified)\n<!-- real -->\n-->');
  assert.deepEqual(stray.items.map((i) => i.text), ['still seen', 'also (not verified)']);
  const opener = parseOpenItems('- [ ] 25-11-2026 item <!-- note\nprose\n-->\n- [ ] 25-11-2026 next');
  assert.deepEqual(opener.items.map((i) => i.text), ['item <!-- note', 'next']);
  const far = parseOpenItems(`<!-- opener\n${'prose\n'.repeat(12)}- [ ] 25-11-2026 far item\n-->`);
  assert.equal(far.items.length, 1);
  const { items, invalid } = parseOpenItems('  - [ ] 25-11-2026 indented\n- [ ] 99-99-9999 nonsense\n- [ ] 31-02-2026 no such day\n- [ ] 2026-13-01 no such month\n- [x] x verified 40-01-2026: y\n- [ ] 29-02-2028 leap day');
  assert.deepEqual(items.map((i) => i.text), ['leap day']);
  assert.equal(invalid.length, 5);
});
