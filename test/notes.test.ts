// The server's git in the notes folder must never run code an agent planted there (hooks, config, embedded repos).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-notes-test-'));
process.env.XDG_DATA_HOME = join(tmp, 'data'); // read when agents.ts loads
process.env.GIT_CONFIG_GLOBAL = '/dev/null'; // no user hooks or signing; commitNotes supplies the identity
const { prepareNotes, commitNotes, notesWritten, notesBash, addWorkspace } = await import('../src/agents.ts');

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
// What the arbiter's Write tool call does.
const write = (notes: string, ws: string, file: string, text: string) => (writeFileSync(join(notes, file), text), notesWritten(notes, ws, join(notes, file)));
const marker = join(tmp, 'fired');
const payload = join(tmp, 'payload.sh');
writeFileSync(payload, `#!/bin/sh\ntouch ${marker}\ncat\n`);
chmodSync(payload, 0o755);

// What an agent with write access to notes can do: its own .git with a hook, fsmonitor and a clean filter, plus an embedded repo.
function plant(notes: string) {
  rmSync(join(notes, '.git'), { recursive: true, force: true });
  git(notes, 'init', '-q');
  writeFileSync(join(notes, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(join(notes, '.git', 'hooks', 'pre-commit'), 0o755);
  git(notes, 'config', 'core.fsmonitor', payload);
  git(notes, 'config', 'filter.x.clean', payload);
  writeFileSync(join(notes, '.gitattributes'), '* filter=x\n');
  const sub = join(notes, 'sub');
  mkdirSync(sub);
  git(sub, 'init', '-q');
  git(sub, 'config', 'core.fsmonitor', payload);
  writeFileSync(join(sub, 'f'), 'x');
  if (!existsSync(join(notes, 'root'))) symlinkSync('/', join(notes, 'root')); // the embedded-repo walk must not follow it
}

test('a folder Jarvis puts under git keeps its git dir out of reach and commits without running planted code', () => {
  const notes = join(tmp, 'notes');
  prepareNotes(notes);
  assert.ok(statSync(join(notes, '.git')).isFile(), 'notes/.git is only a pointer');
  const own = git(notes, 'rev-parse', '--absolute-git-dir');
  assert.ok(own.startsWith(join(tmp, 'data')), own);
  write(notes, 'test', 'status.md', 'v1\n');
  commitNotes(notes, 'test', 'test');
  plant(notes);
  write(notes, 'test', 'status.md', 'v2\n');
  commitNotes(notes, 'test', 'test');
  assert.ok(!existsSync(marker), 'planted code ran');
  assert.equal(git(tmp, '--git-dir', own, 'show', 'HEAD:status.md'), 'v2');
  assert.equal(git(tmp, '--git-dir', own, 'ls-tree', 'HEAD', 'sub'), '', 'embedded repo left out');
});

test('notes inside an existing repo commit there, and a .git planted in notes stops commits instead of being used', () => {
  const repo = join(tmp, 'repo'), notes = join(repo, 'notes');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  prepareNotes(notes);
  assert.ok(!existsSync(join(notes, '.git')));
  write(notes, 'test', 'a.md', 'a\n');
  commitNotes(notes, 'test', 'test');
  assert.equal(git(repo, 'show', 'HEAD:notes/a.md'), 'a');
  plant(notes);
  write(notes, 'test', 'a.md', 'b\n');
  commitNotes(notes, 'test', 'test');
  assert.ok(!existsSync(marker), 'planted code ran');
  assert.equal(git(repo, 'show', 'HEAD:notes/a.md'), 'a');
});

test('workspaces sharing notes each commit only their own arbiter\'s changes, and a Bash move as a move', () => {
  const notes = join(tmp, 'shared');
  prepareNotes(notes);
  const own = git(notes, 'rev-parse', '--absolute-git-dir');
  const files = () => git(tmp, '--git-dir', own, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort();
  mkdirSync(join(notes, 'journal'));
  write(notes, 'a', 'old.md', 'old\n');
  write(notes, 'a', 'gone.md', 'gone\n');
  commitNotes(notes, 'a', 'A');
  // b's Bash call moves and deletes files and writes both journals, while a writes status.md by name.
  const done = notesBash(notes, 'b');
  write(notes, 'a', 'status.md', 'a\n');
  renameSync(join(notes, 'old.md'), join(notes, 'new.md'));
  rmSync(join(notes, 'gone.md'));
  writeFileSync(join(notes, 'journal', '2026-11-03-a.md'), 'a log\n');
  writeFileSync(join(notes, 'journal', '2026-11-03-b.md'), 'b log\n');
  done();
  write(notes, 'b', 'ideas.md', 'b\n');
  writeFileSync(join(notes, 'user.md'), 'nobody\'s\n');
  commitNotes(notes, 'a', 'A');
  assert.deepEqual(files(), ['A\tjournal/2026-11-03-a.md', 'A\tstatus.md']);
  const head = git(tmp, '--git-dir', own, 'rev-parse', 'HEAD');
  commitNotes(notes, 'a', 'A');
  assert.equal(git(tmp, '--git-dir', own, 'rev-parse', 'HEAD'), head, 'nothing attributed, no commit');
  commitNotes(notes, 'b', 'B');
  assert.deepEqual(files(), ['A\tideas.md', 'A\tjournal/2026-11-03-b.md', 'D\tgone.md', 'R100\told.md\tnew.md']);
  assert.equal(git(notes, 'status', '--porcelain'), '?? user.md');
});

test('a commit subject is the arbiter\'s message or a file list, then a Workspace trailer, never the old notes: form', () => {
  const notes = join(tmp, 'msgs');
  const ws = addWorkspace('Proj', undefined, {}, notes); // notes_message calls ws.notesMessage; the commit runs under the workspace id
  const own = git(notes, 'rev-parse', '--absolute-git-dir');
  const body = () => git(tmp, '--git-dir', own, 'log', '-1', '--format=%B');
  mkdirSync(join(notes, 'journal'));
  write(notes, ws.meta.id, 'status.md', '1\n');
  ws.notesMessage('  Record the first decision  \nsecond line');
  commitNotes(notes, ws.meta.id, 'Proj');
  assert.equal(body(), 'Record the first decision\n\nWorkspace: Proj');
  write(notes, ws.meta.id, 'status.md', '2\n');
  writeFileSync(join(notes, 'journal', `2026-11-03-${ws.meta.id}.md`), 'log\n');
  commitNotes(notes, ws.meta.id, 'Proj'); // the message was cleared by the last commit
  assert.equal(body(), 'Update status.md and journal\n\nWorkspace: Proj');
  ws.notesMessage('stale'); // nothing to commit: cleared anyway
  commitNotes(notes, ws.meta.id, 'Proj');
  for (const f of ['a', 'b', 'c', 'd']) write(notes, ws.meta.id, `${f}.md`, f);
  commitNotes(notes, ws.meta.id, 'Proj');
  assert.equal(body(), 'Update 4 notes files\n\nWorkspace: Proj');
  write(notes, ws.meta.id, 'status.md', '3\n');
  ws.notesMessage('x'.repeat(300));
  commitNotes(notes, ws.meta.id, 'Proj');
  assert.equal(body().split('\n')[0], 'x'.repeat(100));
  assert.ok(!/^notes: /m.test(git(tmp, '--git-dir', own, 'log', '--format=%s')));
});

test('home and folders above it are refused', () => {
  assert.throws(() => prepareNotes(homedir()));
  assert.throws(() => prepareNotes('/'));
});
