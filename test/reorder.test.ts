// Tab order: reorderWorkspaces sets it and saves it in the registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-reorder-test-'));
process.env.XDG_DATA_HOME = join(tmp, 'data'); // read when agents.ts loads
const { reorderWorkspaces, workspaces, addWorkspace } = await import('../src/agents.ts');

test('sets the order, ignores unknown ids, keeps unlisted ones last, persists', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((n) => addWorkspace(n).meta.id);
  reorderWorkspaces([c, 'nope', a]);
  assert.deepEqual([...workspaces.keys()], [c, a, b]);
  const saved = JSON.parse(readFileSync(join(tmp, 'data', 'jarvis', 'workspaces.json'), 'utf8')).map((m: { id: string }) => m.id);
  assert.deepEqual(saved, [c, a, b]);
});
