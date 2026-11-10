import { test, expect, createWs, open, say, uniq } from './helpers.ts';

test('View > Timestamps shows the time of each log line, off by default', async ({ page }) => {
  const name = uniq('ts');
  const id = await createWs(page, name);
  await open(page, name);
  await say(page, id, 'say stamped');
  const line = page.locator('#log div:not(.user)').filter({ hasText: /^stamped$/ });
  await expect(line).toBeVisible();
  const before = () => line.evaluate((el) => getComputedStyle(el, '::before').content);
  expect(await before()).toBe('none');
  await page.locator('#pview').click();
  await page.locator('#viewMenu label').filter({ hasText: 'Timestamps' }).locator('input').check();
  await expect.poll(before).toMatch(/^"\d{2}:\d{2}"$/); // no reload
  await page.locator('#viewMenu label').filter({ hasText: 'Timestamps' }).locator('input').uncheck();
  await expect.poll(before).toBe('none');
});

test('timestamp format: HH:MM today, date and time on another day', async ({ page }) => {
  await page.goto('/');
  const [today, old] = await page.evaluate(() => {
    const now = new Date(2026, 10, 3, 15, 0).getTime();
    return [(window as any).fmtTs(new Date(2026, 10, 3, 9, 5).getTime(), now), (window as any).fmtTs(new Date(2026, 10, 1, 9, 5).getTime(), now)];
  });
  expect(today).toBe('09:05');
  expect(old).toMatch(/^.+ 09:05$/);
  expect(old).not.toBe(today);
});

test('View > USE AS DEFAULT FOR ALL WORKSPACES applies Jarvis view settings to new workspaces', async ({ page }) => {
  const a = uniq('tsa');
  await createWs(page, a);
  await open(page, a);
  await page.locator('#pview').click();
  await page.locator('#viewMenu label').filter({ hasText: 'Timestamps' }).locator('input').check();
  await page.getByRole('button', { name: 'USE AS DEFAULT FOR ALL WORKSPACES' }).click();
  const saved = page.getByRole('button', { name: '✓ DEFAULT FOR ALL WORKSPACES' });
  await expect(saved).toBeDisabled();
  await page.locator('#viewMenu label').filter({ hasText: 'Cost' }).locator('input').click();
  await expect(page.getByRole('button', { name: 'USE AS DEFAULT FOR ALL WORKSPACES' })).toBeEnabled();
  await page.locator('#viewMenu label').filter({ hasText: 'Cost' }).locator('input').click();
  await expect(saved).toBeDisabled();
  const b = uniq('tsb');
  const id = await createWs(page, b);
  await open(page, b);
  await say(page, id, 'say defaulted');
  const line = page.locator('#log div:not(.user)').filter({ hasText: /^defaulted$/ });
  await expect(line).toBeVisible();
  await expect.poll(() => line.evaluate((el) => getComputedStyle(el, '::before').content)).toMatch(/^"\d{2}:\d{2}"$/);
}); // localStorage is per Playwright context, so the default does not leak into other tests
