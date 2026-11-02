// The server's git in the notes folder must never run code an agent planted there (hooks, config, embedded repos).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-notes-test-'));
process.env.XDG_DATA_HOME = join(tmp, 'data'); // read when agents.ts loads
process.env.GIT_CONFIG_GLOBAL = '/dev/null'; // no user hooks or signing; commitNotes supplies the identity
const { prepareNotes, commitNotes } = await import('../src/agents.ts');

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
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
  writeFileSync(join(notes, 'status.md'), 'v1\n');
  commitNotes(notes, 'test');
  plant(notes);
  writeFileSync(join(notes, 'status.md'), 'v2\n');
  commitNotes(notes, 'test');
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
  writeFileSync(join(notes, 'a.md'), 'a\n');
  commitNotes(notes, 'test');
  assert.equal(git(repo, 'show', 'HEAD:notes/a.md'), 'a');
  plant(notes);
  writeFileSync(join(notes, 'a.md'), 'b\n');
  commitNotes(notes, 'test');
  assert.ok(!existsSync(marker), 'planted code ran');
  assert.equal(git(repo, 'show', 'HEAD:notes/a.md'), 'a');
});

test('home and folders above it are refused', () => {
  assert.throws(() => prepareNotes(homedir()));
  assert.throws(() => prepareNotes('/'));
});
