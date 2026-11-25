import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atResult, resetLimit, resetSeed } from '../src/reset.ts';

test('limit is min(cap, 60% of the window), 200k window until known, 0 disables', () => {
  assert.equal(resetLimit(200_000), 200_000); // window unknown: the plain bound
  assert.equal(resetLimit(200_000, 200_000), 120_000);
  assert.equal(resetLimit(200_000, 1_000_000), 200_000);
  assert.equal(resetLimit(100_000, 1_000_000), 100_000);
  assert.equal(resetLimit(0, 1_000_000), 0);
});

test('hard bound acts at once, soft bound only when calm, 0 switches off', () => {
  const b = { soft: 120_000, hard: 150_000 };
  assert.deepEqual(atResult('none', 100_000, b, true, true), { phase: 'none' });
  assert.deepEqual(atResult('none', 130_000, b, false, true), { phase: 'none' }); // soft, but an agent runs
  assert.deepEqual(atResult('none', 130_000, b, true, true), { phase: 'saving', act: 'ask' });
  assert.deepEqual(atResult('none', 160_000, b, false, true), { phase: 'saving', act: 'ask' }); // hard, busy
  assert.deepEqual(atResult('saving', 160_000, b, false, true), { phase: 'saving', act: 'reset' }); // once: the save turn's result resets
  assert.deepEqual(atResult('none', 160_000, b, true, false), { phase: 'saving', act: 'reset' }); // no notes: nothing to save
  assert.deepEqual(atResult('none', 130_000, { soft: 0, hard: 150_000 }, true, true), { phase: 'none' });
  assert.deepEqual(atResult('none', 160_000, { soft: 0, hard: 150_000 }, false, true), { phase: 'saving', act: 'ask' });
  assert.deepEqual(atResult('none', 999_999, { soft: 120_000, hard: 0 }, true, true), { phase: 'none' });
});

test('a queue the SDK merged or never reports cannot block hard or saving; only soft waits for it', () => {
  const b = { soft: 120_000, hard: 150_000 };
  // `calm` already folds in "SDK queue empty": a queue that stays non-empty (merged sends) is a permanently not-calm soft check.
  assert.deepEqual(atResult('none', 130_000, b, false, true), { phase: 'none' });
  assert.deepEqual(atResult('none', 151_000, b, false, true), { phase: 'saving', act: 'ask' });
  assert.deepEqual(atResult('saving', 10_000, b, false, true), { phase: 'saving', act: 'reset' }); // the context may have shrunk: still resets
});

test('seed carries unhandled messages as work and handled ones as done, after the facts', () => {
  const seed = resetSeed({ workspace: 'W', agents: [], last: 'L', unhandled: ['QUEUED-ONE', 'QUEUED-TWO'], handled: [{ text: 'DONE-MSG', reply: 'DONE-REPLY' }] });
  assert.ok(seed.indexOf('QUEUED-ONE') > seed.indexOf('Agents:') && seed.includes('QUEUED-TWO'));
  assert.match(seed, /do not redo them[^]*DONE-MSG\n=> DONE-REPLY/);
  assert.match(seed, /handle them now:\nQUEUED-ONE/);
});

test('seed without a workspace notes folder warns about staleness but names no open-items file', () => {
  const seed = resetSeed({ workspace: 'W', agents: [], last: 'LAST', unhandled: [], handled: [] });
  assert.match(seed, /may be stale/);
  assert.ok(!seed.includes('open-items.md') && !seed.includes("Treat every '- [ ]'"));
});

test('seed names workspace, notes, agents and last text, and is capped', () => {
  const agents = [{ id: 'a-1', name: 'A', status: 'running', repo: '/r', lastText: 'x'.repeat(500) }, { id: 'b-2', name: 'B', status: 'idle', lastText: '' }];
  const seed = resetSeed({ workspace: 'W', project: '/p', notes: '/n', wsNotes: '/n/workspaces/w-1', agents, last: 'LAST', unhandled: ['REPORT'], handled: [] });
  assert.match(seed, /may be stale/);
  assert.match(seed, /Treat every '- \[ \]' item as not verified: keep its '\[ \]' state, and check it before you claim its state\. Never drop an item you did not verify, unless the user says it is done\./);
  for (const s of ['[context reset]', 'same workspace "W"', 'do not tell the user to start a new workspace', '/n', 'status.md', '- a-1 (A): running, repo /r, branch jarvis/a-1', '- b-2 (B): idle', 'LAST', 'REPORT']) assert.ok(seed.includes(s), s);
  assert.ok(!seed.includes('x'.repeat(301)));
  const many = Array.from({ length: 100 }, (_, i) => ({ id: `i${i}`, name: 'n', status: 'idle', lastText: 'y'.repeat(400) }));
  const big = resetSeed({ workspace: 'W', agents: many, last: 'z'.repeat(5000), unhandled: ['q'.repeat(5000)], handled: [{ text: 'h'.repeat(900), reply: 'r'.repeat(900) }] });
  assert.ok(big.length <= 16_001);
  assert.match(big, /… and \d+ more/);
  assert.ok(big.includes('zzz') && big.includes('qqq')); // last text and late messages survive many agents
});

test('force resets or asks whatever the size and the bounds', () => {
  const b = { soft: 120_000, hard: 150_000 };
  assert.deepEqual(atResult('none', 1_000, b, false, true, true), { phase: 'saving', act: 'ask' });
  assert.deepEqual(atResult('none', 1_000, b, false, false, true), { phase: 'saving', act: 'reset' });
  assert.deepEqual(atResult('none', 1_000, { soft: 0, hard: 0 }, false, true, true), { phase: 'saving', act: 'ask' }); // automatic reset off
  assert.deepEqual(atResult('saving', 1_000, b, false, true, true), { phase: 'saving', act: 'reset' });
});
