import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DIR = new URL('../templates/job-source/', import.meta.url).pathname;
const run = (...args: string[]) => JSON.parse(execFileSync('python3', [DIR + 'job_source_example.py', ...args], { encoding: 'utf8' }));
const STATES = ['queued', 'running', 'waiting', 'done', 'failed', 'stopped', 'unknown'];

test('example job source prints schema v1 with a row per id', () => {
  const out = run('a1', 'b2');
  assert.equal(out.schema, 1);
  assert.ok(!Number.isNaN(Date.parse(out.checked)));
  assert.deepEqual(out.rows.map((r: any) => r.id), ['a1', 'b2']);
  for (const r of out.rows) assert.ok(STATES.includes(r.state));
});

test('fast run leaves slow fields out, slow run returns only id and the asked fields', () => {
  assert.ok(!('costUsd' in run('a1').rows[0]));
  const slow = run('--fields', 'cost', 'a1');
  assert.deepEqual(Object.keys(slow.rows[0]).sort(), ['costUsd', 'id']);
  assert.equal(typeof slow.rows[0].costUsd, 'number');
});

test('example manifest is valid schema v1 and matches the example script', () => {
  const m = JSON.parse(readFileSync(DIR + 'manifest.example.json', 'utf8'));
  assert.equal(m.schema, 1);
  assert.equal(m.kind, 'jobs');
  assert.match(m.name, /^[a-z0-9][a-z0-9-]{0,39}$/);
  assert.deepEqual(m.args, ['{ids}']);
  assert.ok(m.slow_fields.cost);
  assert.ok(m.command.includes('job_source_example.py'));
});

test('skill template has frontmatter and stays generic', () => {
  const t = readFileSync(DIR + 'SKILL.md', 'utf8');
  assert.match(t, /^---\nname: job-source\ndescription: .+\n---\n/);
  assert.doesNotMatch(t, /zenml|benchroom|long-horizon/i);
});
