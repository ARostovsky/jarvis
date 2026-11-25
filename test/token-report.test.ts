import { test } from 'node:test';
import assert from 'node:assert/strict';
import { report } from '../scripts/token-report.ts';

test('token report sums per-turn usage, keeps cumulative cost max and reads the first context breakdown', () => {
  const { rows, sizes } = report([
    { type: 'spawned', agent: { id: 'arbiter' } }, { type: 'spawned', agent: { id: 'k1', parentId: 'arbiter' } },
    { type: 'context', agentId: 'k1', tokens: 9000, categories: { system_prompt: 3000, mcp_tools_deferred: 500, messages: 100 } },
    { type: 'result', agentId: 'k1', costUsd: 0.1, usage: { input: 5, output: 10, cacheRead: 100, cacheCreate: 20 } },
    { type: 'result', agentId: 'k1', costUsd: 0.3, usage: { input: 1, output: 2, cacheRead: 200, cacheCreate: 0 } },
    { type: 'context', agentId: 'k1', tokens: 12000 },
    { type: 'tool', agentId: 'k1', name: 'Read', input: { file_path: 'x' } }, { type: 'routed', text: 'abc' },
  ]);
  const k = rows.find((r) => r.agent === 'k1')!;
  assert.deepEqual([k.role, k.turns, k.costUsd, k.input, k.cacheRead, k.cacheCreate, k.output, k.firstContext, k.maxContext], ['agent', 2, 0.3, 6, 300, 20, 12, 9000, 12000]);
  assert.deepEqual(k.overhead, { system_prompt: 3000, mcp_tools_deferred: 500 });
  assert.equal(sizes.routed.chars, 3);
  assert.equal(rows[0].role, 'arbiter');
});
