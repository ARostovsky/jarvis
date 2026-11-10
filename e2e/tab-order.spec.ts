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
    return r.left >= bar.left && r.right <= bar.right - 28; // clear of the right-edge fade
  }, last);
  await page.waitForTimeout(2500); // next poll
  expect(await inView()).toBe(true);
  await page.evaluate(() => { document.getElementById('tabs')!.scrollLeft = 0; });
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => document.getElementById('tabs')!.scrollLeft)).toBe(0);
  await page.reload(); // the agent panel opens after the first render and narrows the bar
  await expect.poll(inView).toBe(true);
});

test('a real mouse drag shows the drop bar on the hovered tab and reorders', async ({ page }) => {
  const [a, b] = [uniq('barA'), uniq('barB')];
  await createWs(page, a);
  await createWs(page, b);
  await open(page, a);
  const [src, dst] = [(await tab(page, b).boundingBox())!, (await tab(page, a).boundingBox())!];
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + src.width / 2 - 5, src.y + src.height / 2, { steps: 3 });
  await page.mouse.move(dst.x + 4, dst.y + dst.height / 2, { steps: 10 });
  // inset: the tab's clip-path would cut an outer shadow
  await expect(tab(page, a)).toHaveClass(/drop-before/);
  expect(await tab(page, a).evaluate((el) => getComputedStyle(el).boxShadow)).toContain('inset');
  await page.mouse.up();
  const x = async (n: string) => (await tab(page, n).boundingBox())?.x ?? Infinity; // null while the bar rebuilds
  await expect.poll(async () => (await x(b)) < (await x(a))).toBe(true);
});
