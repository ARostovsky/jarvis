// Prompt rules and the report truncation marker steer the arbiter; guard their key wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'jarvis-prompts-test-')); // read when agents.ts loads
const { ARBITER_PROMPT, capReport, agentRow, readSlice } = await import('../src/agents.ts');
const { OPEN_ITEMS_FORMAT, arbiterNotesPrompt, saveTurnText, notesSizeWarnings, NOTES_SIZE_CAPS } = await import('../src/notes-layout.ts');

test('arbiter prompt: verify claims, read truncated reports, check evidence before done', () => {
  for (const s of ['never state that a step is done or not done', 'not verified', 'A user claim that something is done is not evidence and not an open item: do not list it again', 'otherwise say "Nothing left."', 'never a routine fact of an agent\'s own reported work', 'An agent report in this goal is evidence', 'Do not run the check yourself', 'and the body agrees', 'or the report is TRUNCATED', 'read_agent it before you route', 'contradicts its VERDICT line']) {
    assert.ok(ARBITER_PROMPT.includes(s), s);
  }
});

test('arbiter prompt: voice dictionary words go through voice_vocab, spelled as the user wrote them', () => {
  assert.ok(ARBITER_PROMPT.includes('call voice_vocab, if you have it, and write the word exactly as the user spelled it'));
});

test('capReport marks a cut report loudly and leaves a short one alone', () => {
  assert.equal(capReport('a1', 'short'), 'short');
  const out = capReport('a1', 'x'.repeat(1500));
  assert.match(out, /\[TRUNCATED at 1000 of 1500 chars, open items and caveats may be cut: call read_agent\("a1"\) before you rely on this report\]$/);
});

// BOARD_PROMPT is not exported: check the source text. The notes paragraph and the save turn are pure builders.
test('notes paragraph, save turn and agent report prompt carry the verification wording', () => {
  const src = readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  for (const s of [
    'Do not re-run a check whose result is already in your brief or this turn, unless the brief asks you to verify it or you changed code since.',
    'Read only the sections your task names, not all notes. Never paste long text into README.md, CLAUDE.md, access.md or decisions.md',
    'Then give at most 5 lines: first anything still open or unverified, then what changed (paths, branch) and the reason for partial or failed.',
  ]) assert.ok(src.includes(s), s);
  const wsDir = '/n/workspaces/w-ab12';
  const p = arbiterNotesPrompt({ id: 'w-ab12', name: 'W', notes: '/n' } as never, wsDir);
  for (const s of [
    "Date every open item. Write what the user did in the journal, in past tense with its source ('user said on <DD-MM-YYYY>: pushed'). Never keep it as an open item.",
    "Do not re-check a '[~]' item unless you list it.",
    "in that same turn remove it from open-items.md and write one line in today's journal, /n/workspaces/w-ab12/journal/YYYY-MM-DD.md: 'user said on <DD-MM-YYYY>: pushed'.",
    'Never list a \'[~]\' item in an "Anything left?" answer, not even as "parked" or "waiting on you", and do not say that you left it out. List it only if the current goal cannot continue without it, or the user asks about it;',
    "When you remove a '[x]' line, keep one dated journal line per removed item.",
    "At session start and after a reset, treat every '[ ]' item as not verified: keep its '[ ]' state, and verify it before you report or act on it. Never drop an item you did not verify, unless the user says it is done.",
    'Do not re-check a verified fact that cannot change (a sha is in origin/main, a branch is deleted). Re-check a fact that can change (push state, worktrees, a running service) before you report it.',
    'Add a line only if it is durable, project-wide and prevents a mistake that would repeat',
    'First merge it into or replace an existing line. Never add one-off incident, run or PR details: they go to decisions.md or the journal.',
    'Keep CLAUDE.md small, about 40 lines or 6 KB; when it is over that, shorten or delete lines before you add one.',
    'README.md and access.md stay under about 10 KB, decisions.md is append-only but nobody reads it in full.',
    'never paste long notes into these files: long material goes to the journal or a dedicated file under /n',
    "pass only the sections it needs by path and heading (for example 'read /n/CLAUDE.md, section Voice'), never 'read all notes files' or the whole notes folder",
  ]) assert.ok(p.includes(s), s);
  for (const kind of ['forced', 'auto'] as const) assert.ok(saveTurnText(kind, wsDir, 160_000).includes(OPEN_ITEMS_FORMAT));
});

test('agentRow has no task and a short lastText', () => {
  const row = agentRow({ id: 'a1', name: 'n', task: 'T'.repeat(5000), cwd: '/x', status: 'idle', lastText: 'y'.repeat(900), costUsd: 1 });
  assert.equal('task' in row, false);
  assert.equal('cwd' in row, false);
  assert.equal(row.lastText.length, 200);
  assert.equal(agentRow({ id: 'a2', name: 'n', task: '', cwd: '', status: 'idle', lastText: '', costUsd: 0, parentId: 'arbiter', lead: true, model: 'opus' }).lead, true);
});

test('readSlice pages a long text with a cut notice and the pages join to the original', () => {
  const text = 'abcdefghij'.repeat(1000);
  const first = readSlice('a1', text);
  assert.match(first, /\[cut at 4000 of 10000 chars: call read_agent\("a1", offset=4000\) for the rest\]$/);
  assert.equal(readSlice('a1', 'short'), 'short');
  assert.equal(readSlice('a1', 'short', 9), 'offset 9 past end (5 chars)');
  let got = '', off = 0;
  for (;;) { const p = readSlice('a1', text, off); const cut = p.indexOf('\n… [cut at'); got += cut < 0 ? p : p.slice(0, cut); if (cut < 0) break; off += 4000; }
  assert.equal(got, text);
});

test('notesSizeWarnings warns over the caps, never edits, and reaches the arbiter prompt', () => {
  const d = mkdtempSync(join(tmpdir(), 'notes-caps-'));
  try {
    assert.deepEqual(notesSizeWarnings(d), []);
    writeFileSync(join(d, 'CLAUDE.md'), 'x'.repeat(NOTES_SIZE_CAPS['CLAUDE.md'] + 1));
    writeFileSync(join(d, 'README.md'), 'x'.repeat(NOTES_SIZE_CAPS['README.md']));
    writeFileSync(join(d, 'access.md'), 'x'.repeat(NOTES_SIZE_CAPS['access.md'] + 1));
    const w = notesSizeWarnings(d);
    assert.equal(w.length, 2);
    assert.match(w[0], /^CLAUDE\.md is 6 KB, over 6 KB$/);
    assert.match(w[1], /^access\.md/);
    assert.equal(readFileSync(join(d, 'CLAUDE.md'), 'utf8').length, NOTES_SIZE_CAPS['CLAUDE.md'] + 1);
    const warn = console.warn; console.warn = () => {};
    try { assert.match(arbiterNotesPrompt({ id: 'w-ab12', name: 'W', notes: d } as never, `${d}/workspaces/w-ab12`), /Size warning: CLAUDE\.md .*; access\.md .*\. Shorten them before you add anything\./); } finally { console.warn = warn; }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('arbiter prompt: files for the user are absolute paths in backticks, copied into a served folder when outside', () => {
  for (const s of ['as its full absolute path in backticks, one per line', 'never relative paths', 'also from agent reports', 'copy it into ~/Documents/jarvis-shared/ (never overwrite, add a suffix)']) {
    assert.ok(ARBITER_PROMPT.includes(s), s);
  }
});

test('arbiter prompt: git housekeeping goes to one reused git-ops agent whose id is kept in status.md', () => {
  for (const s of ['one long-lived agent named "git-ops"', 'model sonnet, effort low, repo = the project', 'do not spawn a new agent per merge', 'Record its id in status.md']) {
    assert.ok(ARBITER_PROMPT.includes(s), s);
  }
});
