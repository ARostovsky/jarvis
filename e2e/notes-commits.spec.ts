import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, readdirSync, readFileSync, mkdirSync, rmSync, symlinkSync, lstatSync, linkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { journalKey } from '../src/slug.ts';
import { test, expect, uniq, tmp, say, events, DATA, ORIGIN } from './helpers.ts';

// Two workspaces share one notes folder; each turn of an arbiter should end in one commit with only its own files.
test.describe.configure({ mode: 'serial' });

const notes = tmp('shared-notes');
const gitDir = join(DATA, 'notes-git', createHash('sha256').update(notes).digest('hex').slice(0, 16));
const git = (...args: string[]) => execFileSync('git', ['--git-dir', gitDir, '--work-tree', notes, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const count = () => { try { return Number(git('rev-list', '--count', 'HEAD')); } catch { return 0; } };
const day = new Date().toISOString().slice(0, 10);
const a = { name: uniq('nca'), id: '' }, b = { name: uniq('ncb'), id: '' };
const journal = (w: typeof a) => `journal/${day}-${journalKey(w)}.md`;

// The last commit: subject, body, files with status (-M: a move shows as R).
const last = () => ({ subject: git('log', '-1', '--format=%s'), body: git('log', '-1', '--format=%b'), files: git('show', '-M', '--name-status', '--format=', 'HEAD').split('\n').sort() });

// Runs one arbiter turn and returns its commit.
async function turn(page: import('@playwright/test').Page, w: typeof a, ...lines: string[]) {
  const before = count();
  expect((await say(page, w.id, ...lines)).ok()).toBe(true);
  await expect.poll(count).toBe(before + 1);
  return last();
}

test.beforeAll(async ({ request }) => {
  for (const w of [a, b]) {
    const r = await request.post('/workspaces', { headers: { origin: ORIGIN }, data: { name: w.name, notes } });
    expect(r.ok()).toBe(true);
    w.id = (await r.json()).id;
  }
  writeFileSync(join(notes, 'stray.md'), 'nobody claimed this'); // the user's own file: never committed by an arbiter
});

test('a turn commits its own files with the notes_message subject', async ({ page }) => {
  const c = await turn(page, a, `write ${notes}/a.md from A`, `write ${notes}/${journal(a)} A was here`, 'tool mcp__jarvis__notes_message {"message":"Add the A notes\\nsecond line is dropped"}');
  expect(c.subject).toBe('Add the A notes');
  expect(c.body).toMatch(new RegExp(`Workspace: ${a.name}$`));
  expect(c.files).toEqual(['A\ta.md', `A\t${journal(a)}`]);
});

test('the other workspace commits only its files, also while the first one is in a Bash call', async ({ page }) => {
  // A writes a file, then blocks in Bash until the gate opens (20 s at most, so a failed test leaves no loop behind); B's turn runs meanwhile, inside A's Bash snapshot.
  const gate = join(tmp('gate'), 'open');
  expect((await say(page, a.id, `write ${notes}/a2.md written before B`, `bash for i in $(seq 400); do [ -e ${gate} ] && break; sleep 0.05; done`)).ok()).toBe(true);
  await expect.poll(() => events(a.id).some((e) => e.type === 'tool' && e.name === 'Bash')).toBe(true);
  const c = await turn(page, b, `write ${notes}/b.md from B`, `write ${notes}/${journal(b)} B was here`, 'tool mcp__jarvis__notes_message {"message":"Add the B notes"}');
  expect(c.subject).toBe('Add the B notes');
  expect(c.body).toMatch(new RegExp(`Workspace: ${b.name}$`));
  expect(c.files).toEqual(['A\tb.md', `A\t${journal(b)}`]);
  writeFileSync(gate, '');
  await expect.poll(count).toBe(3);
  expect(last()).toEqual({ subject: 'Update a2.md', body: `Workspace: ${a.name}`, files: ['A\ta2.md'] });
});

test('a Bash mv is committed as a rename', async ({ page }) => {
  const c = await turn(page, a, `bash mv ${notes}/a.md ${notes}/moved.md`, 'tool mcp__jarvis__notes_message {"message":"Move the A notes"}');
  expect(c.subject).toBe('Move the A notes');
  expect(c.body).toMatch(new RegExp(`Workspace: ${a.name}$`));
  expect(c.files).toEqual(['R100\ta.md\tmoved.md']);
});

test('without notes_message the subject lists the files', async ({ page }) => {
  const c = await turn(page, b, `write ${notes}/b2.md more from B`);
  expect(c.subject).toBe('Update b2.md');
  expect(c.body).toMatch(new RegExp(`Workspace: ${b.name}$`));
  expect(c.files).toEqual(['A\tb2.md']);
  expect(git('status', '--porcelain')).toBe('?? stray.md');
});

test('a sub-agent\'s notes file, written by absolute path, is committed at the arbiter\'s next turn', async ({ page }) => {
  const before = count();
  const task = `write ${notes}/from-helper.md helper note\nsay helper done`;
  expect((await say(page, a.id, `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'helper', task })}`)).ok()).toBe(true);
  // The helper's report starts an arbiter turn, which ends in the commit.
  await expect.poll(count, { timeout: 15000 }).toBe(before + 1);
  const c = last();
  expect(c.subject).toBe('Update from-helper.md');
  expect(c.body).toMatch(new RegExp(`Workspace: ${a.name}$`));
  expect(c.files).toEqual(['A\tfrom-helper.md']);
});

test('a sub-agent\'s notes file written by a script that never names the notes path is committed too', async ({ page }) => {
  const before = count();
  const task = `write ptr.txt ${notes}\nbash sh -c 'echo helper > "$(cat ptr.txt)/via-script.md"'\nsay helper done`;
  expect((await say(page, a.id, `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'scripter', task })}`)).ok()).toBe(true);
  await expect.poll(count, { timeout: 15000 }).toBe(before + 1);
  expect(last().files).toEqual(['A\tvia-script.md']);
});

test('a commit after a rename names the new workspace name', async ({ page, request }) => {
  await rename(request, a, uniq('ncr'));
  const c = await turn(page, a, `write ${notes}/after-rename.md text`);
  expect(c.body).toBe(`Workspace: ${a.name}`);
});

// Journal tests use a workspace of their own, so they do not depend on each other or on a and b.
const dayFile = (w: typeof a) => journal(w);
async function fresh(request: import('@playwright/test').APIRequestContext, prefix: string) {
  const w = { name: uniq(prefix), id: '' };
  const r = await request.post('/workspaces', { headers: { origin: ORIGIN }, data: { name: w.name, notes } });
  expect(r.ok()).toBe(true);
  w.id = (await r.json()).id;
  return w;
}
// Journal files of a workspace under any name, found by the id's suffix.
const journals = (w: typeof a) => readdirSync(join(notes, 'journal')).filter((f) => f.endsWith(`${w.id.slice(w.id.lastIndexOf('-'))}.md`)).map((f) => `journal/${f}`).sort();
const rename = async (request: import('@playwright/test').APIRequestContext, w: typeof a, name: string) => {
  expect((await request.post('/workspaces/rename', { headers: { origin: ORIGIN }, data: { ws: w.id, name } })).ok()).toBe(true);
  w.name = name;
};
// The files of the last commit with their status, renames shown as a delete and an add.
const changes = () => git('show', '--no-renames', '--name-status', '--format=', 'HEAD').split('\n').sort();

// Only a sanity check: the real guard is the uniqueSuffix unit test (test/slug.test.ts), as a clash needs two workspaces created 36^4 ms apart.
test('workspaces never share an id suffix', async ({ request }) => {
  const w = [await fresh(request, 'ncs'), await fresh(request, 'ncs')];
  expect(w[0].id.slice(-4)).not.toBe(w[1].id.slice(-4));
  expect(a.id.slice(-4)).not.toBe(b.id.slice(-4));
});

test('journals follow renames, also repeated ones: one file, the old name gone in the same commit, the id stays', async ({ page, request }) => {
  const w = await fresh(request, 'ncj');
  const first = dayFile(w);
  await turn(page, w, `write ${notes}/${first} first`);
  expect(journals(w)).toEqual([first]);
  await rename(request, w, uniq('ncj'));
  await rename(request, w, uniq('ncj'));
  expect(journals(w)).toEqual([dayFile(w)]); // moved by the rename itself, not yet committed
  const c = await turn(page, w, `write ${notes}/${dayFile(w)} written after two renames`);
  expect(c.body).toBe(`Workspace: ${w.name}`);
  expect(changes()).toEqual([`A\t${dayFile(w)}`, `D\t${first}`].sort());
  expect(journals(w)).toEqual([dayFile(w)]);
});

test('a stale session writing the id-named journal is merged into the current file', async ({ page, request }) => {
  const w = await fresh(request, 'ncl');
  await turn(page, w, `write ${notes}/${dayFile(w)} first`);
  await rename(request, w, uniq('ncl'));
  await turn(page, w, `write ${notes}/${dayFile(w)} second`);
  await turn(page, w, `write ${notes}/journal/${day}-${w.id}.md late line`);
  expect(journals(w)).toEqual([dayFile(w)]);
  expect(readFileSync(join(notes, dayFile(w)), 'utf8')).toContain('late line');
  expect(changes()).toEqual([`M\t${dayFile(w)}`]);
});

test('a journal file that names no workspace is never moved or committed', async ({ page, request }) => {
  const w = await fresh(request, 'ncd');
  const stray = `journal/${day}-summary.md`;
  mkdirSync(join(notes, 'journal'), { recursive: true });
  writeFileSync(join(notes, stray), 'the user wrote this');
  await rename(request, w, uniq('ncd'));
  await turn(page, w, `write ${notes}/${dayFile(w)} mine`);
  expect(readFileSync(join(notes, stray), 'utf8')).toBe('the user wrote this');
  expect(changes()).toEqual([`A\t${dayFile(w)}`]);
  expect(git('status', '--porcelain')).toContain(`?? ${stray}`);
  rmSync(join(notes, stray));
});

test('journals survive archive and restore under the current name', async ({ page, request }) => {
  const w = await fresh(request, 'ncr');
  const first = dayFile(w);
  await turn(page, w, `bash echo before >> ${notes}/${first}`);
  await rename(request, w, uniq('ncr'));
  expect((await request.post('/workspaces/archive', { headers: { origin: ORIGIN }, data: { ws: w.id, commit: true } })).ok()).toBe(true);
  expect((await request.post('/workspaces/restore', { headers: { origin: ORIGIN }, data: { id: w.id } })).ok()).toBe(true);
  await turn(page, w, `bash echo after >> ${notes}/${dayFile(w)}`);
  expect(journals(w)).toEqual([dayFile(w)]);
  expect(readFileSync(join(notes, dayFile(w)), 'utf8')).toBe('before\nafter\n');
  expect(changes()).toEqual([`A\t${dayFile(w)}`, `D\t${first}`].sort());
});

test('a stale rewrite of the whole file plus a new line adds only the new line', async ({ page, request }) => {
  const w = await fresh(request, 'ncw');
  await turn(page, w, `bash printf 'l1\\n' > ${notes}/${dayFile(w)}`);
  await rename(request, w, uniq('ncw'));
  await turn(page, w, `bash printf 'l1\\nl2\\n' > ${notes}/journal/${day}-${w.id}.md`);
  expect(journals(w)).toEqual([dayFile(w)]);
  expect(readFileSync(join(notes, dayFile(w)), 'utf8')).toBe('l1\nl2\n');
});

test('a symlinked journal is never read, written or committed', async ({ page, request }) => {
  const w = await fresh(request, 'ncy');
  const outside = join(tmp('outside'), 'secret.txt');
  writeFileSync(outside, 'outside content');
  mkdirSync(join(notes, 'journal'), { recursive: true });
  const stale = `journal/${day}-${w.id}.md`;
  symlinkSync(outside, join(notes, stale));
  await rename(request, w, uniq('ncy')); // would move the stale name to the new one
  await turn(page, w, `write ${notes}/plain-${w.id}.md plain`);
  expect(lstatSync(join(notes, stale)).isSymbolicLink()).toBe(true);
  expect(readFileSync(outside, 'utf8')).toBe('outside content');
  expect(journals(w)).toEqual([stale]);
  expect(changes()).toEqual([`A\tplain-${w.id}.md`]);
  expect(git('ls-files', stale)).toBe('');
  rmSync(join(notes, stale));
});

test('a symlink where a journal would be merged to is left alone', async ({ page, request }) => {
  const w = await fresh(request, 'ncz');
  await rename(request, w, uniq('ncz'));
  const outside = join(tmp('outside'), 'secret.txt');
  writeFileSync(outside, 'outside content');
  mkdirSync(join(notes, 'journal'), { recursive: true });
  symlinkSync(outside, join(notes, dayFile(w)));
  writeFileSync(join(notes, `journal/${day}-${w.id}.md`), 'stale text');
  await turn(page, w, `write ${notes}/plain-${w.id}.md plain`);
  expect(readFileSync(outside, 'utf8')).toBe('outside content');
  expect(lstatSync(join(notes, dayFile(w))).isSymbolicLink()).toBe(true);
  expect(git('ls-files', dayFile(w))).toBe('');
  expect(readFileSync(join(notes, `journal/${day}-${w.id}.md`), 'utf8')).toBe('stale text'); // skipped, not deleted
  rmSync(join(notes, dayFile(w)));
});

test('a FIFO or a hard-linked file named like a journal is skipped, and nothing blocks', async ({ page, request }) => {
  const w = await fresh(request, 'ncf');
  mkdirSync(join(notes, 'journal'), { recursive: true });
  const fifo = `journal/${day}-${w.id}.md`;
  execFileSync('mkfifo', [join(notes, fifo)]);
  await rename(request, w, uniq('ncf'));
  await turn(page, w, `write ${notes}/plain-${w.id}.md plain`); // a server blocked on the FIFO never gets here
  expect(lstatSync(join(notes, fifo)).isFIFO()).toBe(true);
  rmSync(join(notes, fifo));
  const linked = `journal/${day}-${w.id}.md`;
  writeFileSync(join(notes, `hl-${w.id}.txt`), 'linked');
  linkSync(join(notes, `hl-${w.id}.txt`), join(notes, linked));
  await rename(request, w, uniq('ncf'));
  await turn(page, w, `write ${notes}/plain2-${w.id}.md plain`);
  expect(lstatSync(join(notes, linked)).nlink).toBe(2);
  expect(journals(w)).toEqual([linked]); // not moved
  rmSync(join(notes, linked));
});

test('a leftover merge file from a crash is merged on the next sync and never committed', async ({ page, request }) => {
  const w = await fresh(request, 'ncm');
  await turn(page, w, `bash echo base >> ${notes}/${dayFile(w)}`);
  await rename(request, w, uniq('ncm'));
  const left = `journal/.merge-${day}-${w.id}-deadbeef`;
  writeFileSync(join(notes, left), 'orphan line\n');
  await turn(page, w, `write ${notes}/plain-${w.id}.md plain`);
  expect(readFileSync(join(notes, dayFile(w)), 'utf8')).toBe('base\norphan line\n');
  expect(existsSync(join(notes, left))).toBe(false);
  expect(git('ls-files', 'journal/.merge-*')).toBe('');
});

test('after a rename the live arbiter is told the new journal name once, and a full rewrite of the old file is not duplicated', async ({ page, request }) => {
  const w = await fresh(request, 'ncn');
  const old = dayFile(w);
  await turn(page, w, `write ${notes}/${old} same line`);
  const quiet = () => events(w.id).length;
  const before = quiet();
  await rename(request, w, uniq('ncn'));
  // Renaming alone wakes nobody.
  expect(quiet()).toBe(before);
  // The stale session rewrites the old path with the content it had; the next message carries the note.
  await turn(page, w, 'echo', `write ${notes}/${old} same line`);
  const told = () => events(w.id).filter((e) => e.type === 'text' && e.text.includes('[workspace renamed]'));
  expect(told().map((e) => e.text).join()).toContain(`journal/YYYY-MM-DD-${journalKey(w)}.md`);
  expect(journals(w)).toEqual([dayFile(w)]);
  expect(readFileSync(join(notes, dayFile(w)), 'utf8')).toBe('same line');
  // Delivered once: a later message carries no note.
  const results = () => events(w.id).filter((e) => e.type === 'result').length;
  const n = results();
  expect((await say(page, w.id, 'echo')).ok()).toBe(true);
  await expect.poll(results).toBe(n + 1);
  expect(told()).toHaveLength(1);
});
