// recent.json: folders sorted by last use, updated on use, gone folders left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-recent-test-'));
process.env.XDG_DATA_HOME = join(tmp, 'data'); // read when agents.ts loads
const { touchRecent, recentFolders, addWorkspace, notesByProject, normPath } = await import('../src/agents.ts');
const dir = (n: string) => (mkdirSync(join(tmp, n)), join(tmp, n));
const [a, b, c, n1] = ['a', 'b', 'c', 'n1'].map(dir);

test('newest first, a reused folder moves up, missing folders are left out', () => {
  touchRecent({ project: a }, 1);
  touchRecent({ project: b, notes: n1 }, 2);
  touchRecent({ project: join(tmp, 'gone') }, 3);
  assert.deepEqual(recentFolders(), { project: [b, a], notes: [n1] });
  touchRecent({ project: a }, 4);
  assert.deepEqual(recentFolders().project, [a, b]);
});

test('addWorkspace records its folders', () => {
  addWorkspace('x', c);
  assert.equal(recentFolders().project[0], c);
});

test('a corrupt or malformed recent.json is seeded again, not thrown on', () => {
  for (const bad of ['{not json', '{"project":{}}']) {
    writeFileSync(join(tmp, 'data', 'jarvis', 'recent.json'), bad);
    assert.equal(recentFolders().project[0], c); // seeded from the workspace made above
    touchRecent({ notes: n1 });
    assert.equal(recentFolders().notes[0], n1);
  }
});

test('notesByProject: newest workspace of a project wins, none gives no entry, gone folders are skipped', () => {
  const [n2, n3] = ['n2', 'n3'].map(dir);
  const r = notesByProject([
    { meta: { project: a, notes: n2 }, at: 5 },
    { meta: { project: a, notes: n1 }, at: 1 },
    { meta: { project: b }, at: 9 },
    { meta: { project: c, notes: join(tmp, 'gone') }, at: 9 },
    { meta: { project: c, notes: n3 }, at: 2 },
  ]);
  assert.deepEqual(r, { [a]: n2, [c]: n3 });
  assert.equal(r[b], undefined);
});

test('normPath: trailing slash and symlink find the same key, a missing path does not throw', () => {
  const [p, n] = ['np', 'nn'].map(dir);
  symlinkSync(p, join(tmp, 'np-link'));
  const r = notesByProject([{ meta: { project: p, notes: n }, at: 1 }]);
  assert.equal(r[normPath(p + '/')], n);
  assert.equal(r[normPath(join(tmp, 'np-link'))], n);
  assert.equal(normPath(join(tmp, 'gone', 'deeper')), join(tmp, 'gone', 'deeper'));
});

test('notes folder equal to the project folder is rejected and never prefilled', () => {
  const p = dir('same');
  assert.throws(() => addWorkspace('same', p, {}, p + '/'), /must not be the project folder/);
  assert.deepEqual(notesByProject([{ meta: { project: p, notes: p }, at: 1 }]), {});
});
