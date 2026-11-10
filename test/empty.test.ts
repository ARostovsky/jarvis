// Zero workspaces is a valid state: nothing re-creates a placeholder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-empty-test-'));
process.env.XDG_DATA_HOME = join(tmp, 'data'); // read when agents.ts loads
const { workspaces, addWorkspace, archiveWorkspace, loadWorkspaces, listArchived } = await import('../src/agents.ts');

test('loadWorkspaces with an empty registry creates none', () => {
  loadWorkspaces();
  assert.equal(workspaces.size, 0);
  mkdirSync(join(tmp, 'data', 'jarvis'), { recursive: true });
  writeFileSync(join(tmp, 'data', 'jarvis', 'workspaces.json'), '[]');
  loadWorkspaces();
  assert.equal(workspaces.size, 0);
});

test('archiving the last workspace leaves zero workspaces', () => {
  const { id } = addWorkspace('only').meta;
  archiveWorkspace(id);
  assert.equal(workspaces.size, 0);
  assert.deepEqual(listArchived().map((a) => a.id), [id]);
});
