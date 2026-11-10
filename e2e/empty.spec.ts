// Zero workspaces shows an empty screen whose button opens the new-workspace dialog.
import { test, expect, post, uniq } from './helpers.ts';

test('empty screen shows with no workspaces and its button creates one', async ({ page }) => {
  // The server is shared: archive every workspace that exists now.
  const { workspaces } = await (await page.request.get('/workspaces')).json();
  for (const w of workspaces) {
    await post(page, '/stopall', { ws: w.id });
    expect((await post(page, '/workspaces/archive', { ws: w.id, commit: true })).ok()).toBe(true);
  }
  await page.goto('/');
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#empty h2')).toHaveText('NO WORKSPACES');
  await expect(page.locator('#emptyArchive')).toBeVisible(); // the archive now holds what we just archived
  await page.locator('#emptyArchive').click();
  await expect(page.locator('#archived')).toBeVisible();
  await page.keyboard.press('Escape');

  const name = uniq('empty-');
  await page.locator('#emptyNew').click();
  await page.locator('#wsName').fill(name);
  await page.locator('#newwsForm button[value="ok"]').click();
  await expect(page.locator('#tabs button.active', { hasText: name })).toBeVisible();
  await expect(page.locator('#empty')).toBeHidden();
});
