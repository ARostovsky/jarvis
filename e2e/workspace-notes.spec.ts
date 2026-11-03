import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { test, expect, createWs, open, tab, tmp, uniq, post, DATA } from './helpers.ts';

test.describe.configure({ mode: 'serial' });

const name = uniq('notes');
let id = '';
const NOTES_GIT = join(DATA, 'notes-git');
const gitDirs = () => (existsSync(NOTES_GIT) ? readdirSync(NOTES_GIT).sort() : []);

// Context menu "Notes folder…" answered with `path` in the prompt.
async function setNotes(page: import('@playwright/test').Page, path: string) {
  page.once('dialog', (d) => { expect(d.message()).toContain('Notes folder'); void d.accept(path); });
  await tab(page, name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Notes folder…' }).click();
}
const meta = async (page: import('@playwright/test').Page) =>
  (await (await page.request.get('/workspaces')).json()).workspaces.find((w: { id: string }) => w.id === id);

test('setting a new empty folder gives it a .git file pointing outside', async ({ page }) => {
  id = await createWs(page, name);
  const dir = join(tmp('notes'), 'fresh');
  await open(page, name);
  await setNotes(page, dir);
  await expect(tab(page, name)).toHaveAttribute('title', new RegExp(`notes ${dir}`));
  expect((await meta(page)).notes).toBe(dir);
  expect(lstatSync(join(dir, '.git')).isFile()).toBe(true);
  const m = /^gitdir: (.+)$/m.exec(readFileSync(join(dir, '.git'), 'utf8'));
  expect(m).not.toBeNull();
  expect(dirname(m![1])).toBe(NOTES_GIT);
  expect(existsSync(join(m![1], 'HEAD'))).toBe(true);
});

test('changing the folder replaces it', async ({ page }) => {
  const dir = tmp('notes2');
  await open(page, name);
  await setNotes(page, dir);
  await expect(tab(page, name)).toHaveAttribute('title', new RegExp(`notes ${dir}`));
  expect((await meta(page)).notes).toBe(dir);
  expect(lstatSync(join(dir, '.git')).isFile()).toBe(true);
});

for (const [label, bad] of [['home', homedir()], ['a folder above home', dirname(homedir())]] as const) {
  test(`${label} is refused with a toast and nothing is created`, async ({ page }) => {
    const before = { dirs: gitDirs(), notes: (await meta(page)).notes, homeGit: existsSync(join(homedir(), '.git')), aboveGit: existsSync(join(dirname(homedir()), '.git')) };
    await open(page, name);
    await setNotes(page, bad);
    await expect(page.locator('#toast')).toContainText('notes failed');
    await expect(page.locator('#toast')).toContainText('must not be your home folder');
    expect({ dirs: gitDirs(), notes: (await meta(page)).notes, homeGit: existsSync(join(homedir(), '.git')), aboveGit: existsSync(join(dirname(homedir()), '.git')) }).toEqual(before);
  });
}

test('the new workspace dialog refuses home too, and creates no workspace', async ({ page }) => {
  const before = (await (await page.request.get('/workspaces')).json()).workspaces.length;
  const dirs = gitDirs();
  await page.goto('/');
  await page.locator('#tabs button[title="New workspace"]').click();
  await page.fill('#wsName', uniq('badnotes'));
  await page.fill('#wsNotes', homedir());
  await page.click('#newwsForm button[value=ok]');
  await expect(page.locator('#toast')).toContainText('create failed');
  expect((await (await page.request.get('/workspaces')).json()).workspaces.length).toBe(before);
  expect(gitDirs()).toEqual(dirs);
});

test('the API refuses home with 400', async ({ page }) => {
  const r = await post(page, '/workspaces/notes', { ws: id, notes: homedir() });
  expect(r.status()).toBe(400);
});

test('an empty answer clears the folder', async ({ page }) => {
  await open(page, name);
  await setNotes(page, ' ');
  await expect.poll(async () => (await meta(page)).notes).toBeUndefined();
});
