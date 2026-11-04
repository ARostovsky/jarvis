import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, createWs, open, uniq, tmp, say, post, events, tab, DATA, type Page } from './helpers.ts';

// Spawns one agent that runs `task` on the fake SDK and waits until it and Jarvis (its report turn) are idle.
async function spawnIdle(page: Page, ws: string, name: string, task: string) {
  expect((await say(page, ws, `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name, task })}`)).ok()).toBe(true);
  await expect(page.locator('#nodes .node', { hasText: name })).toHaveClass(/\bidle\b/);
  await expect.poll(() => events(ws).filter((e) => e.type === 'result' && e.agentId === 'arbiter').length).toBe(2);
  return events(ws).find((e) => e.type === 'spawned' && e.agent.name === name).agent;
}

async function askDelete(page: Page, name: string) {
  await page.locator('#nodes .node', { hasText: name }).press('Enter'); // the graph keeps moving, so no click
  page.once('dialog', (d) => void d.accept());
  await page.click('#pdelete');
  await expect(page.locator('#choice')).toBeVisible();
}

const buttons = (page: Page) => page.locator('#choiceButtons button');

// A repo whose .gitignore ignores .env.
function ignoringRepo() {
  const repo = tmp('repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  g('init', '-q');
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  g('add', '.gitignore');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return repo;
}

test('files git ignores move with the archive, come back on restore, and are named before a delete', async ({ page }) => {
  const repo = ignoringRepo();
  const name = uniq('ign');
  const ws = await createWs(page, name, { project: repo });
  await open(page, name);
  const agent = await spawnIdle(page, ws, 'keeper', 'write .env SECRET=1\nsay done');
  expect(readFileSync(join(agent.cwd, '.env'), 'utf8')).toBe('SECRET=1');

  await tab(page, name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive workspace' }).click();
  await expect(page.locator('#choiceQuestion')).toContainText('files ignored by git');
  await buttons(page).filter({ hasText: /^ARCHIVE$/ }).click();
  await expect(tab(page, name)).toHaveCount(0);
  expect(existsSync(agent.cwd)).toBe(false);
  expect(readFileSync(join(DATA, 'archive', ws, 'parked-ignored', agent.id, '.env'), 'utf8')).toBe('SECRET=1');

  // The delete-forever dialog lists them; cancel it.
  const row = page.locator('#archivedList div').filter({ hasText: name });
  await page.locator('#tabs button[title="Archived workspaces"]').click();
  await row.getByRole('button', { name: 'DELETE' }).click();
  await expect(page.locator('#choiceText')).toContainText(`files ignored by git, parked from agent workdirs:\n  ${agent.id}: .env`);
  await buttons(page).filter({ hasText: 'CANCEL' }).click();

  await page.locator('#tabs button[title="Archived workspaces"]').click();
  await row.getByRole('button', { name: 'RESTORE' }).click();
  await expect(tab(page, name)).toHaveClass('active');
  expect(readFileSync(join(agent.cwd, '.env'), 'utf8')).toBe('SECRET=1');

  // Uncommitted changes can be committed; the ignored .env is named either way.
  writeFileSync(join(agent.cwd, 'todo.txt'), 'later\n');
  await askDelete(page, 'keeper');
  await expect(page.locator('#choiceTitle')).toHaveText('UNCOMMITTED CHANGES');
  await expect(page.locator('#choiceText')).toHaveText(`${agent.id} has uncommitted changes:\n?? todo.txt\n\n${agent.id} has files ignored by git, they cannot be committed and are deleted with the workdir:\n.env`);
  await expect(buttons(page)).toHaveText(['COMMIT & DELETE', 'DISCARD & DELETE', 'CANCEL']);
  await buttons(page).filter({ hasText: 'CANCEL' }).click();
  rmSync(join(agent.cwd, 'todo.txt'));

  // Only ignored files: nothing to commit, so only discard.
  await askDelete(page, 'keeper');
  await expect(page.locator('#choiceTitle')).toHaveText('FILES IGNORED BY GIT');
  await expect(page.locator('#choiceText')).toHaveText(`${agent.id} has files ignored by git, they cannot be committed and are deleted with the workdir:\n.env`);
  await expect(buttons(page)).toHaveText(['DISCARD & DELETE', 'CANCEL']);
  await buttons(page).filter({ hasText: 'DISCARD & DELETE' }).click();
  await expect(page.locator('#nodes .node', { hasText: 'keeper' })).toHaveCount(0);
  expect(existsSync(agent.cwd)).toBe(false);
  await expect(page.locator('#toast')).toBeHidden();
});

test('an agent whose branch is gone offers only discard for its parked ignored files', async ({ page }) => {
  const repo = ignoringRepo();
  const name = uniq('gone');
  const ws = await createWs(page, name, { project: repo });
  await open(page, name);
  const agent = await spawnIdle(page, ws, 'leaver', 'write .env SECRET=2\nsay done');
  expect((await post(page, '/workspaces/archive', { ws })).ok()).toBe(true);
  execFileSync('git', ['-C', repo, 'branch', '-D', `jarvis/${agent.id}`]); // merged and deleted
  expect((await post(page, '/workspaces/restore', { id: ws })).ok()).toBe(true);
  const parked = join(DATA, 'workspaces', ws, 'parked-ignored', agent.id, '.env');
  expect(readFileSync(parked, 'utf8')).toBe('SECRET=2');

  await open(page, name);
  await askDelete(page, 'leaver');
  await expect(page.locator('#choiceTitle')).toHaveText('FILES IGNORED BY GIT');
  await expect(page.locator('#choiceText')).toHaveText(`${agent.id} has files ignored by git parked by an archive that could not be put back, they are deleted with the agent:\n.env`);
  await expect(buttons(page)).toHaveText(['DISCARD & DELETE', 'CANCEL']);
  await buttons(page).filter({ hasText: 'DISCARD & DELETE' }).click();
  await expect(page.locator('#nodes .node', { hasText: 'leaver' })).toHaveCount(0);
  expect(existsSync(parked)).toBe(false);
});

test('deleting an agent with a plain workdir names its files and offers only discard', async ({ page }) => {
  const name = uniq('plain');
  const ws = await createWs(page, name);
  await open(page, name);
  const agent = await spawnIdle(page, ws, 'scribe', 'write notes.txt mine\nsay done');
  expect(agent.repo).toBeUndefined();

  await askDelete(page, 'scribe');
  await expect(page.locator('#choiceTitle')).toHaveText('FILES OUTSIDE GIT');
  await expect(page.locator('#choiceText')).toHaveText(`${agent.id}'s workdir is not in git, its files are deleted with it:\nnotes.txt`);
  await expect(buttons(page)).toHaveText(['DISCARD & DELETE', 'CANCEL']);
  await buttons(page).filter({ hasText: 'CANCEL' }).click();
  expect(readFileSync(join(agent.cwd, 'notes.txt'), 'utf8')).toBe('mine');

  await askDelete(page, 'scribe');
  await buttons(page).filter({ hasText: 'DISCARD & DELETE' }).click();
  await expect(page.locator('#nodes .node', { hasText: 'scribe' })).toHaveCount(0);
  expect(existsSync(agent.cwd)).toBe(false);
});
