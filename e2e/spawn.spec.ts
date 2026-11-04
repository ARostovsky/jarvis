import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, createWs, open, uniq, tmp, say, events, DATA } from './helpers.ts';

test('spawn_agent starts an agent in a worktree of the project and its report reaches Jarvis', async ({ page }) => {
  const repo = tmp('repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const name = uniq('spawn');
  const id = await createWs(page, name, { project: repo });
  await open(page, name);
  // The helper runs on the fake SDK too: its task is a script.
  expect((await say(page, id, 'tool mcp__jarvis__spawn_agent {"name":"helper","task":"write out.txt from helper\\nsay helper done"}')).ok()).toBe(true);
  await expect(page.locator('#nodes .node', { hasText: 'helper' })).toBeVisible();

  const agent = events(id).find((e) => e.type === 'spawned' && e.agent.name === 'helper').agent;
  expect(agent.cwd).toBe(join(DATA, 'worktrees', agent.id));
  expect(agent.repo).toBe(repo);
  expect(g('worktree', 'list')).toContain(`${agent.cwd} `);
  expect(g('rev-parse', '--abbrev-ref', `jarvis/${agent.id}`)).toBe(`jarvis/${agent.id}`);
  await expect.poll(() => existsSync(join(agent.cwd, 'out.txt'))).toBe(true);
  expect(readFileSync(join(agent.cwd, 'out.txt'), 'utf8')).toBe('from helper');

  // The report is delivered to Jarvis, which runs a turn on it.
  const report = `[agent ${agent.id} finished, status idle]\nhelper done`;
  await expect.poll(() => events(id).some((e) => e.type === 'routed' && e.from === agent.id && e.to === 'arbiter' && e.text === report)).toBe(true);
  await expect.poll(() => events(id).filter((e) => e.type === 'result' && e.agentId === 'arbiter').length).toBe(2);
  await expect(page.locator('#log .report')).toHaveText(`⇐ ${agent.id}: ${report}`); // in the DOM, hidden by the default VIEW
  await expect(page.locator('#nodes .node', { hasText: 'helper' })).toHaveClass(/\bidle\b/);
});

test('a report to a parent without a workdir goes to the nearest ancestor that has one', async ({ page }) => {
  const repo = tmp('repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const id = await createWs(page, uniq('orphan'), { project: repo });
  const leadTask = `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'child', task: 'sleep 3000\nsay child done' })}\nsay lead done`;
  expect((await say(page, id, `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'lead', task: leadTask })}`)).ok()).toBe(true);
  const spawned = (name: string) => events(id).find((e) => e.type === 'spawned' && e.agent.name === name)?.agent;
  await expect.poll(() => spawned('child')).toBeTruthy();
  const lead = spawned('lead'), child = spawned('child');
  await expect.poll(() => events(id).some((e) => e.type === 'routed' && e.from === lead.id && e.to === 'arbiter')).toBe(true);
  rmSync(lead.cwd, { recursive: true }); // as after a restore whose branch was gone
  const report = `[agent ${child.id} finished, status idle]\nchild done`;
  await expect.poll(() => events(id).some((e) => e.type === 'routed' && e.from === child.id && e.to === 'arbiter' && e.text === report), { timeout: 10_000 }).toBe(true);
  expect(events(id).some((e) => e.type === 'routed' && e.from === child.id && e.to === lead.id)).toBe(false);
});
