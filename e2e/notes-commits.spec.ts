import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, uniq, tmp, say, events, DATA } from './helpers.ts';

// Two workspaces share one notes folder; each turn of an arbiter should end in one commit with only its own files.
test.describe.configure({ mode: 'serial' });

const notes = tmp('shared-notes');
const gitDir = join(DATA, 'notes-git', createHash('sha256').update(notes).digest('hex').slice(0, 16));
const git = (...args: string[]) => execFileSync('git', ['--git-dir', gitDir, '--work-tree', notes, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const count = () => { try { return Number(git('rev-list', '--count', 'HEAD')); } catch { return 0; } };
const day = new Date().toISOString().slice(0, 10);
const a = { name: uniq('nca'), id: '' }, b = { name: uniq('ncb'), id: '' };
const journal = (w: typeof a) => `journal/${day}-${w.id}.md`;

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
    const r = await request.post('/workspaces', { headers: { origin: 'http://127.0.0.1:7798' }, data: { name: w.name, notes } });
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
