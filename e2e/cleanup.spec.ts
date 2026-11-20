import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, createWs, open, uniq, tmp, say, events, tab, type Page } from './helpers.ts';

// A throwaway repo on main; the agents' worktrees are made by Jarvis under the e2e data dir.
function mainRepo() {
  const repo = tmp('repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  g('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'f'), 'v1\n');
  g('add', 'f');
  g('commit', '-q', '-m', 'init');
  return { repo, g };
}

async function spawnIdle(page: Page, ws: string, name: string, task: string) {
  expect((await say(page, ws, `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name, task })}`)).ok()).toBe(true);
  await expect(page.locator('#nodes .node', { hasText: name })).toHaveClass(/\bidle\b/);
  await expect.poll(() => events(ws).filter((e) => e.type === 'result' && e.agentId === 'arbiter').length).toBeGreaterThan(0);
  return events(ws).find((e) => e.type === 'spawned' && e.agent.name === name).agent;
}
const commitTask = (file: string) => `bash echo ${file} > ${file} && git add ${file} && git -c user.name=t -c user.email=t@t commit -q -m ${file}`;
const hasBranch = (g: (...a: string[]) => string, id: string) => g('branch', '--list', `jarvis/${id}`) !== '';

test('stopping an agent removes a merged or empty worktree and branch, and keeps an unmerged one', async ({ page }) => {
  const { repo, g } = mainRepo();
  const name = uniq('clean');
  const ws = await createWs(page, name, { project: repo });
  await open(page, name);
  const empty = await spawnIdle(page, ws, 'empty', 'say done');
  const merged = await spawnIdle(page, ws, 'merged', `${commitTask('m.txt')}\nsay done`);
  const unmerged = await spawnIdle(page, ws, 'unmerged', `${commitTask('u.txt')}\nsay done`);
  g('merge', '-q', '--ff-only', `jarvis/${merged.id}`);

  for (const a of [empty, merged, unmerged]) await say(page, ws, `tool mcp__jarvis__stop_agent ${JSON.stringify({ id: a.id })}`);
  for (const a of [empty, merged]) {
    await expect.poll(() => existsSync(a.cwd)).toBe(false);
    expect(hasBranch(g, a.id)).toBe(false);
  }
  await expect(page.locator('#nodes .node', { hasText: 'unmerged' })).toHaveClass(/\bstopped\b/);
  await expect.poll(() => events(ws).filter((e) => e.type === 'status' && e.agentId === unmerged.id).pop()?.status).toBe('stopped');
  expect(existsSync(unmerged.cwd)).toBe(true);
  expect(hasBranch(g, unmerged.id)).toBe(true);
});

test('archiving lists what cleanup kept', async ({ page }) => {
  const { repo, g } = mainRepo();
  const name = uniq('keep');
  const ws = await createWs(page, name, { project: repo });
  await open(page, name);
  const empty = await spawnIdle(page, ws, 'empty', 'say done');
  const unmerged = await spawnIdle(page, ws, 'unmerged', `${commitTask('u.txt')}\nsay done`);

  await tab(page, name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive workspace' }).click();
  await page.locator('#choiceButtons button', { hasText: /^ARCHIVE$/ }).click();
  await expect(tab(page, name)).toHaveCount(0);
  await expect(page.locator('#toastText')).toContainText(`jarvis/${unmerged.id} kept: it has commits that are not on main`);
  await expect(page.locator('#toastText')).not.toContainText(empty.id);
  expect(hasBranch(g, empty.id)).toBe(false);
  expect(hasBranch(g, unmerged.id)).toBe(true);
});
