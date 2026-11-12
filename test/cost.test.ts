// Cost of deleted agents stays in the workspace total and survives a restart (rebuilt from events.jsonl).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-cost-test-'));
process.env.XDG_DATA_HOME = join(tmp, 'data'); // read when agents.ts loads
const { createWorkspace } = await import('../src/agents.ts');

test('removed agents and late removed_cost events count in the summary after restore', () => {
  const dir = join(tmp, 'data', 'jarvis', 'workspaces', 'w-1');
  mkdirSync(dir, { recursive: true });
  const agent = (id: string) => ({ type: 'spawned', agent: { id, name: id, task: '', cwd: tmp, status: 'idle', lastText: '', costUsd: 0, parentId: 'arbiter' } });
  const events = [
    agent('a1'), agent('a2'),
    { type: 'result', agentId: 'a1', costUsd: 1.5 },
    { type: 'result', agentId: 'a2', costUsd: 2 },
    { type: 'removed', agentId: 'a1' },
    { type: 'removed_cost', usd: 0.25 },
  ];
  writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const w = createWorkspace({ id: 'w-1', name: 'w' });
  assert.equal(w.summary().costUsd, 3.75);
});
