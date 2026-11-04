import { test, expect, tab, uniq } from './helpers.ts';

// One workspace goes through its whole life: the steps build on each other.
test.describe.configure({ mode: 'serial' });

const name = uniq('life'), renamed = uniq('ren');
const archivedRow = (page: import('@playwright/test').Page, n: string) => page.locator('#archivedList div').filter({ hasText: n });
const archiveButton = (page: import('@playwright/test').Page) => page.locator('#tabs button[title="Archived workspaces"]');

test('create through the dialog', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tabs button[title="New workspace"]').click();
  await page.fill('#wsName', name);
  await page.click('#newwsForm button[value=ok]');
  await expect(tab(page, name)).toHaveClass('active');
  expect(await page.evaluate(() => localStorage.getItem('jarvis.ws'))).toMatch(/^life/);
});

test('rename by double click', async ({ page }) => {
  await page.goto('/');
  await tab(page, name).click();
  page.once('dialog', (d) => d.accept(renamed));
  await tab(page, name).dblclick();
  await expect(tab(page, renamed)).toBeVisible();
  await expect(tab(page, name)).toHaveCount(0);
});

test('rename to nothing keeps the name', async ({ page }) => {
  await page.goto('/');
  page.once('dialog', (d) => d.accept('   '));
  await tab(page, renamed).dblclick();
  await page.waitForTimeout(300);
  await expect(tab(page, renamed)).toBeVisible();
});

test('archive moves it from the tabs to the archive', async ({ page }) => {
  await page.goto('/');
  await tab(page, renamed).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive workspace' }).click();
  await page.locator('#choiceButtons button', { hasText: /^ARCHIVE$/ }).click();
  await expect(tab(page, renamed)).toHaveCount(0);
  await expect(archiveButton(page)).toBeVisible();
  await expect(archivedRow(page, renamed)).toHaveCount(1);
  await expect(page.locator('#tabs button.active')).toHaveCount(1); // the page moved on to another workspace
});

test('restore brings it back and opens it', async ({ page }) => {
  await page.goto('/');
  await archiveButton(page).click();
  await archivedRow(page, renamed).getByRole('button', { name: 'RESTORE' }).click();
  await expect(tab(page, renamed)).toHaveClass('active');
  await expect(archivedRow(page, renamed)).toHaveCount(0);
});

test('delete from the archive needs the right name', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await tab(page, renamed).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive workspace' }).click();
  await page.locator('#choiceButtons button', { hasText: /^ARCHIVE$/ }).click();
  await expect(archivedRow(page, renamed)).toHaveCount(1);

  const del = async (typed: string) => {
    await archiveButton(page).click();
    await archivedRow(page, renamed).getByRole('button', { name: 'DELETE' }).click();
    page.once('dialog', (d) => { expect(d.message()).toContain(renamed); void d.accept(typed); });
    await page.locator('#choiceButtons button', { hasText: 'DELETE FOREVER' }).click();
  };

  await del('wrong name');
  await expect(page.locator('#toast')).toContainText('delete failed');
  await expect(page.locator('#toast')).toContainText('nothing deleted');
  await page.clock.fastForward(7000); // an error toast outlives the old 6 s timeout
  await expect(page.locator('#toast')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await expect(page.locator('#toast')).toBeHidden();
  await expect(archivedRow(page, renamed)).toHaveCount(1);

  await del(renamed);
  await expect(archivedRow(page, renamed)).toHaveCount(0);
  await expect(tab(page, renamed)).toHaveCount(0);
  await page.reload();
  await expect(archivedRow(page, renamed)).toHaveCount(0);
});
