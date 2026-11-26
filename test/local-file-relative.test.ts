// resolveRelative: relative chat paths against ordered bases, with the /local-file policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRelative } from '../src/local-file.ts';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-rel-')));
const out = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-rel-out-')));
process.env.JARVIS_FILE_ROOTS = tmp;
const file = (p: string) => (mkdirSync(join(p, '..'), { recursive: true }), writeFileSync(p, 'x'), p);
const repo = join(tmp, 'repo'), notes = join(tmp, 'notes');
file(join(repo, 'src', 'server.ts'));
file(join(repo, 'README.md'));
file(join(notes, 'status.md'));
file(join(repo, 'both.md'));
file(join(notes, 'both.md'));
const bases = [repo, notes];

test('hit in repo, then notes; miss is undefined', () => {
  assert.equal(resolveRelative('src/server.ts', bases), join(repo, 'src', 'server.ts'));
  assert.equal(resolveRelative('./README.md', bases), join(repo, 'README.md'));
  assert.equal(resolveRelative('status.md', bases), join(notes, 'status.md'));
  assert.equal(resolveRelative('nope.md', bases), undefined);
  assert.equal(resolveRelative('src', bases), undefined);
  assert.equal(resolveRelative('foo.ts', bases), undefined); // bare names match only at the top of a base, no tree search
});

test('same path in two bases: the first base wins', () => {
  assert.equal(resolveRelative('both.md', bases), join(repo, 'both.md'));
  assert.equal(resolveRelative('both.md', [notes, repo]), join(notes, 'both.md'));
});

test(':line and :line:col suffixes are dropped', () => {
  assert.equal(resolveRelative('src/server.ts:123', bases), join(repo, 'src', 'server.ts'));
  assert.equal(resolveRelative('src/server.ts:12:5', bases), join(repo, 'src', 'server.ts'));
});

test('.., absolute paths and symlinks out of the base are rejected', () => {
  file(join(out, 'o.md'));
  assert.equal(resolveRelative(`../${out.split('/').pop()}/o.md`, bases), undefined);
  assert.equal(resolveRelative('src/../README.md', bases), undefined);
  assert.equal(resolveRelative(join(repo, 'README.md'), bases), undefined);
  symlinkSync(join(out, 'o.md'), join(repo, 'link.md'));
  assert.equal(resolveRelative('link.md', bases), undefined);
  symlinkSync(join(notes, 'status.md'), join(repo, 'cross.md')); // inside the roots but outside this base
  assert.equal(resolveRelative('cross.md', [repo]), undefined);
  file(join(repo, '.git', 'c.md'));
  assert.equal(resolveRelative('.git/c.md', bases), undefined);
});
