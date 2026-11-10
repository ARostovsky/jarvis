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
