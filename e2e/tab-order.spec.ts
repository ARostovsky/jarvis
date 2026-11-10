import { test, expect, createWs, open, tab, uniq } from './helpers.ts';

test('dragging a tab reorders it and the order survives a reload', async ({ page }) => {
  const [a, b] = [uniq('ordA'), uniq('ordB')];
  await createWs(page, a);
  await createWs(page, b);
  await open(page, a);
  await tab(page, b).dragTo(tab(page, a), { targetPosition: { x: 2, y: 5 } });
  const names = async () => (await (await page.request.get('/workspaces')).json()).workspaces.map((w: { name: string }) => w.name);
  await expect.poll(async () => { const n = await names(); return n.indexOf(b) < n.indexOf(a); }).toBe(true);
  await page.reload();
  const boxA = await tab(page, a).boundingBox();
  const boxB = await tab(page, b).boundingBox();
  expect(boxB!.x).toBeLessThan(boxA!.x);
});

test('the active tab stays visible in a scrolled tab bar and a poll keeps the scroll', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 600 });
  const names = Array.from({ length: 10 }, () => uniq('scr'));
  for (const n of names) await createWs(page, n);
  const last = names[names.length - 1];
  await open(page, names[0]);
  await tab(page, last).click();
  await expect(tab(page, last)).toHaveClass(/active/);
  const inView = () => page.evaluate((name) => {
    const bar = document.getElementById('tabs')!.getBoundingClientRect();
    const r = [...document.querySelectorAll('#tabs button')].find((b) => b.firstChild?.textContent === name)!.getBoundingClientRect();
    return r.left >= bar.left && r.right <= bar.right;
  }, last);
  await page.waitForTimeout(2500); // next poll
  expect(await inView()).toBe(true);
  await page.evaluate(() => { document.getElementById('tabs')!.scrollLeft = 0; });
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => document.getElementById('tabs')!.scrollLeft)).toBe(0);
});
