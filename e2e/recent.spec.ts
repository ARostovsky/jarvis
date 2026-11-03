import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DATA_HOME } from '../playwright.config.ts';

// Tests share one server and build on each other: run in order.
test.describe.configure({ mode: 'serial' });

const root = mkdtempSync(join(tmpdir(), 'jarvis-e2e-folders-'));
const dir = (name: string) => { const d = join(root, name); mkdirSync(d); return d; };
const [p1, p2, p3, n1, n2] = ['p1', 'p2', 'p3', 'n1', 'n2'].map(dir);

// Origin and content-type are required by the server on POST.
const create = async (page: Page, name: string, project: string, notes: string) => {
  const r = await page.request.post('/workspaces', { headers: { origin: 'http://127.0.0.1:7798' }, data: { name, project, notes } });
  expect(r.ok()).toBe(true);
  await page.waitForTimeout(5); // distinct timestamps keep the order deterministic
};

const options = async (page: Page) => {
  await page.goto('/');
  await page.locator('#tabs button[title="New workspace"]').click();
  await expect(page.locator('#newws')).toBeVisible();
  const values = (id: string) => page.locator(`#${id} option`).evaluateAll((o) => o.map((e) => (e as HTMLOptionElement).value));
  return { project: await values('recentProject'), notes: await values('recentNotes') };
};

test.afterAll(() => rmSync(root, { recursive: true, force: true }));

test('lists recent folders, newest first', async ({ page }) => {
  await create(page, 'a', p1, n1);
  await create(page, 'b', p2, n2);
  await create(page, 'c', p3, n1);
  expect(await options(page)).toEqual({ project: [p3, p2, p1], notes: [n1, n2] });
});

test('a folder deleted from disk disappears', async ({ page }) => {
  rmSync(p2, { recursive: true });
  expect((await options(page)).project).toEqual([p3, p1]);
});

test('a path typed in the dialog is offered first next time', async ({ page }) => {
  const fresh = dir('fresh');
  await options(page);
  await page.fill('#wsName', 'typed');
  await page.fill('#wsProject', fresh);
  await page.click('#newwsForm button[value=ok]');
  await expect(page.locator('#newws')).toBeHidden();
  expect((await options(page)).project[0]).toBe(fresh);
});

test('a damaged recent.json does not break the page', async ({ page }) => {
  writeFileSync(join(DATA_HOME, 'jarvis', 'recent.json'), '{junk');
  const { project, notes } = await options(page);
  await expect(page.locator('#tabs button').nth(1)).toBeVisible();
  expect(project).toContain(p3);
  expect(notes).toContain(n1);
});
