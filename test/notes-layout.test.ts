import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPEN_ITEMS_FORMAT, arbiterNotesPrompt, ensureWorkspaceNotes, migrationNotice, parseOpenItems, restoreArchivedNotes, saveTurnText, workspaceDir, writeIndex } from '../src/notes-layout.ts';
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
  for (const s of ['DD-MM-YYYY', '(you)', 'never for routine work', '[~]', '(waiting on user)', '(not verified)', 'verified', 'open-items.md']) assert.ok(OPEN_ITEMS_FORMAT.includes(s), s);
  const m = { ...meta('/n'), notes: '/n' };
  const p = arbiterNotesPrompt(m, '/n/workspaces/my-ws-ab12');
  for (const s of ['/n/workspaces/my-ws-ab12', 'Summary:', 'DD-MM-YYYY', 'legacy shared files', OPEN_ITEMS_FORMAT, 'journal/YYYY-MM-DD.md', 'index.md', 'notes_message']) assert.ok(p.includes(s), s);
  assert.ok(!p.includes('Mark your status.md entries'));
});

test('save turn texts name the own files and the format', () => {
  const m = { ...meta('/n'), notes: '/n' };
  for (const kind of ['forced', 'auto'] as const) {
    const t = saveTurnText(kind, '/n/workspaces/my-ws-ab12', 160_000);
    for (const s of ['/n/workspaces/my-ws-ab12/status.md', '/n/workspaces/my-ws-ab12/open-items.md', '/n/workspaces/my-ws-ab12/journal/', OPEN_ITEMS_FORMAT]) assert.ok(t.includes(s), s);
  }
  assert.match(saveTurnText('auto', 'w', 160_000), /^\[context 160k tokens/);
  assert.match(saveTurnText('forced', 'w'), /^\[reset ordered by the user\]/);
});

test('migration notice and seed point to the workspace folder', () => {
  const m = { ...meta('/n'), notes: '/n' };
  assert.match(migrationNotice(m, '/n/workspaces/x'), /^\[notes layout changed\][^]*\/n\/workspaces\/x[^]*"My WS"/);
  const seed = resetSeed({ workspace: 'W', notes: '/n', wsNotes: '/n/workspaces/x', agents: [], last: '', unhandled: [], handled: [] });
  for (const s of ['/n/workspaces/x/status.md', '/n/workspaces/x/open-items.md', '/n/workspaces/']) assert.ok(seed.includes(s), s);
});

test('the (you) tag is read on open and parked items and removed from the text', () => {
  const { items, invalid } = parseOpenItems('- [ ] 25-11-2026 (you) Decide the name\n- [~] 25-11-2026 (you) Push (waiting on user)\n- [ ] 25-11-2026 Run e2e\n- [ ] 25-11-2026 (you)');
  assert.deepEqual(items.map((i) => [i.you, i.text]), [[true, 'Decide the name'], [true, 'Push (waiting on user)'], [false, 'Run e2e']]);
  assert.equal(invalid.length, 1); // the tag alone is no item
});

test('index lists every workspace folder with summary and counts, atomically, and skips symlinks', () => {
  const notes = tmp(), outside = tmp();
  ensureWorkspaceNotes({ id: 'a-1111', name: 'A [x]', notes });
  ensureWorkspaceNotes({ id: 'b-2222', name: 'B', notes });
  writeFileSync(join(notes, 'workspaces', 'a-1111', 'status.md'), '# S\nSummary: doing A\n');
  writeFileSync(join(notes, 'workspaces', 'a-1111', 'open-items.md'), '- [ ] 25-11-2026 (you) Decide\n- [~] 25-11-2026 Wait\n- [x] Done verified 25-11-2026: ok\n');
  symlinkSync(outside, join(notes, 'workspaces', 'evil-3333'));
  const f = writeIndex(notes, (id) => (id === 'a-1111' ? 'A [x]' : undefined))!;
  const text = readFileSync(f, 'utf8');
  assert.ok(text.includes('- [A x](a-1111/status.md): doing A (open: 2, you: 1)'));
  assert.ok(text.includes('- [b-2222](b-2222/status.md): - (open: 0, you: 0)')); // the template placeholder is no summary
  assert.ok(!text.includes('evil'));
  assert.deepEqual(readdirSync(join(notes, 'workspaces')).filter((n) => n.includes('tmp')), []);
  // a failure (symlinked workspaces folder) is not fatal
  const bad = tmp();
  symlinkSync(outside, join(bad, 'workspaces'));
  assert.equal(writeIndex(bad), undefined);
  assert.deepEqual(readdirSync(outside), []);
});

test('the journal folder is created with the workspace folder', () => {
  const notes = tmp();
  ensureWorkspaceNotes(meta(notes));
  assert.ok(existsSync(join(workspaceDir({ id: 'my-ws-ab12', notes }), 'journal')));
});

test('index never writes through a planted temp name or a linked index.md', () => {
  const notes = tmp(), other = tmp();
  ensureWorkspaceNotes(meta(notes));
  const root = join(notes, 'workspaces');
  writeFileSync(join(other, 'README.md'), 'precious');
  linkSync(join(other, 'README.md'), join(root, `.index-${process.pid}.tmp`)); // the old predictable name
  linkSync(join(other, 'README.md'), join(root, 'index.md'));
  symlinkSync(join(other, 'README.md'), join(root, '.index-0000.tmp'));
  assert.ok(writeIndex(notes));
  assert.equal(readFileSync(join(other, 'README.md'), 'utf8'), 'precious');
  assert.match(readFileSync(join(root, 'index.md'), 'utf8'), /^# Workspaces/);
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

test('restore moves workspaces/_archive/<id> back, never over an existing folder', () => {
  const notes = tmp();
  const m = meta(notes);
  assert.equal(restoreArchivedNotes(m), 'none');
  mkdirSync(join(notes, 'workspaces', '_archive', m.id), { recursive: true });
  writeFileSync(join(notes, 'workspaces', '_archive', m.id, 'status.md'), 'old');
  assert.equal(restoreArchivedNotes(m), 'moved');
  assert.equal(readFileSync(join(notes, 'workspaces', m.id, 'status.md'), 'utf8'), 'old');
  assert.ok(!existsSync(join(notes, 'workspaces', '_archive', m.id)));
  // collision: both stay, nothing thrown
  mkdirSync(join(notes, 'workspaces', '_archive', m.id), { recursive: true });
  writeFileSync(join(notes, 'workspaces', '_archive', m.id, 'status.md'), 'archived');
  assert.equal(restoreArchivedNotes(m), 'collision');
  assert.equal(readFileSync(join(notes, 'workspaces', m.id, 'status.md'), 'utf8'), 'old');
  assert.equal(readFileSync(join(notes, 'workspaces', '_archive', m.id, 'status.md'), 'utf8'), 'archived');
});

test('the index ignores workspaces/_archive', () => {
  const notes = tmp();
  ensureWorkspaceNotes(meta(notes));
  mkdirSync(join(notes, 'workspaces', '_archive', 'gone-1111'), { recursive: true });
  writeFileSync(join(notes, 'workspaces', '_archive', 'gone-1111', 'status.md'), 'Summary: archived\n');
  const text = readFileSync(writeIndex(notes)!, 'utf8');
  assert.ok(text.includes('(my-ws-ab12/status.md)') && !text.includes('gone-1111') && !text.includes('_archive'));
});
