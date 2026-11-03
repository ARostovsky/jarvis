import { test, expect, createWs, open, tab, uniq, post } from './helpers.ts';

const stored = (page: import('@playwright/test').Page) => page.evaluate(() => localStorage.getItem('jarvis.ws'));
const archive = async (page: import('@playwright/test').Page, id: string) => expect((await post(page, '/workspaces/archive', { ws: id })).ok()).toBe(true);

test('the selected workspace survives a reload', async ({ page }) => {
  const a = uniq('rla'), b = uniq('rlb');
  await createWs(page, a);
  const idB = await createWs(page, b);
  await open(page, b);
  expect(await stored(page)).toBe(idB);
  await page.reload();
  await expect(tab(page, b)).toHaveClass('active');
  await expect(tab(page, a)).not.toHaveClass('active');
});

test('a workspace archived elsewhere: reload opens another one', async ({ page }) => {
  const a = uniq('rlc'), b = uniq('rld');
  const idA = await createWs(page, a);
  await createWs(page, b);
  await open(page, a);
  await archive(page, idA);
  await page.reload();
  await expect(page.locator('#tabs button.active')).toHaveCount(1);
  await expect(tab(page, a)).toHaveCount(0);
  expect(await stored(page)).not.toBe(idA);
  const now = await stored(page);
  expect(await page.locator('#tabs button.active').getAttribute('title')).not.toBeNull();
  expect((await (await page.request.get('/workspaces')).json()).workspaces.map((w: { id: string }) => w.id)).toContain(now);
  await expect(page.locator('#conn')).toHaveText('LINK ONLINE');
});

test('a workspace archived while the page is open: the page moves on', async ({ page }) => {
  const a = uniq('rle');
  const idA = await createWs(page, a);
  await open(page, a);
  await archive(page, idA);
  await expect(tab(page, a)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('#tabs button.active')).toHaveCount(1);
  await expect(page.locator('#conn')).toHaveText('LINK ONLINE');
});

test('a stored id that never existed falls back to a real workspace', async ({ page }) => {
  await createWs(page, uniq('rlf'));
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('jarvis.ws', 'no-such-ws'));
  await page.reload();
  await expect(page.locator('#tabs button.active')).toHaveCount(1);
  await expect.poll(() => stored(page)).not.toBe('no-such-ws');
  await expect(page.locator('#conn')).toHaveText('LINK ONLINE');
});
