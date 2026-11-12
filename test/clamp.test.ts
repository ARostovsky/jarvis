import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'jarvis-clamp-test-'));
const { clampSpawn } = await import('../src/agents.ts');

test('a lead cannot give sub-agents a higher model or effort than its own, capped at medium', () => {
  assert.deepEqual(clampSpawn({ model: 'sonnet', effort: 'medium' }, 'opus', 'high'), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(clampSpawn({ model: 'opus', effort: 'max' }, 'opus', 'xhigh'), { model: 'opus', effort: 'medium' });
  assert.deepEqual(clampSpawn({ model: 'sonnet', effort: 'low' }, 'haiku', 'medium'), { model: 'haiku', effort: 'low' });
  assert.deepEqual(clampSpawn({ model: 'sonnet', effort: 'medium' }, 'sonnet'), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(clampSpawn({ model: 'sonnet', effort: 'low' }, 'sonnet'), { model: 'sonnet', effort: 'low' });
  assert.deepEqual(clampSpawn({ effort: 'medium' }, 'opus', 'low'), { model: 'sonnet', effort: 'low' }); // parent without a model counts as the default, sonnet
  assert.deepEqual(clampSpawn({ model: 'sonnet', effort: 'medium' }, 'claude-opus-5-5'), { model: 'claude-opus-5-5', effort: 'medium' }); // unknown model kept
  assert.deepEqual(clampSpawn({ model: 'claude-sonnet-5-5', effort: 'medium' }, 'opus'), { model: 'opus', effort: 'medium' });
});

test('a bad JARVIS_LEAD_MAX_EFFORT counts as medium', async () => {
  process.env.JARVIS_LEAD_MAX_EFFORT = 'bogus';
  const { clampSpawn: fresh } = await import(String('../src/agents.ts?bad-cap')) as typeof import('../src/agents.ts');
  assert.equal(fresh({ model: 'opus', effort: 'max' }, 'opus', 'max').effort, 'medium');
});
