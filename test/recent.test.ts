// recent.json: folders sorted by last use, updated on use, gone folders left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-recent-test-'));
process.env.XDG_DATA_HOME = join(tmp, 'data'); // read when agents.ts loads
const { touchRecent, recentFolders, addWorkspace } = await import('../src/agents.ts');
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
