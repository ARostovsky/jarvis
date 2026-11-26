import { test, expect, archivePolling, jobsBlock, jobRow, watchJobs, jobsWorkspace, type Page } from './helpers.ts';

test.afterEach(({ page }) => archivePolling(page));

// Screenshot the button, find the ink (pixels unlike the box's own background) inside a 3px inset, and return its centre minus the box centre.
async function inkOffset(page: Page, sel: string, shot?: string) {
  const loc = page.locator(sel);
  await loc.evaluate((e) => (e as HTMLElement).style.setProperty('opacity', '1', 'important')); // the dismiss plate is dimmed until hovered
  await page.mouse.move(0, 0);
  const png = (await loc.screenshot()).toString('base64');
  if (shot) await loc.screenshot({ path: shot });
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!; g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data, ref = [d[4 * (3 * c.width + 3)], d[4 * (3 * c.width + 3) + 1], d[4 * (3 * c.width + 3) + 2]];
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
    for (let y = 3; y < c.height - 3; y++) for (let x = 3; x < c.width - 3; x++) {
      const i = 4 * (y * c.width + x);
      if (Math.abs(d[i] - ref[0]) + Math.abs(d[i + 1] - ref[1]) + Math.abs(d[i + 2] - ref[2]) > 60) { x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); }
    }
    return { found: x1 > 0, dx: (x0 + x1) / 2 - c.width / 2, dy: (y0 + y1) / 2 - c.height / 2 };
  }, png);
}

test('every cross button draws its cross centred in its box', async ({ page }) => {
  const p = await jobsWorkspace(page);
  p.set('c1', { state: 'failed', error: 'x' });
  await watchJobs(page, p.ws, p.name, ['c1']);
  await expect(jobRow(page, p.name, 'c1')).toHaveClass(/st-failed/);
  const dir = process.env.SHOT_DIR;
  const rm = jobRow(page, p.name, 'c1').getByRole('button', { name: /^Remove/ });
  await page.evaluate(() => (window as any).toast('boom'));
  await expect(page.locator('#toast')).toBeVisible();
  for (const [name, sel] of [['dismiss', rm], ['header', page.locator('#pclose')], ['toast', page.locator('#toastClose')]] as const) {
    await sel.evaluate((e, n) => e.setAttribute('data-xt', n), name);
    const o = await inkOffset(page, `[data-xt="${name}"]`, dir ? `${dir}/cross-${name}.png` : undefined);
    expect(o.found, name).toBe(true);
    expect(Math.abs(o.dx), `${name} dx`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(o.dy), `${name} dy`).toBeLessThanOrEqual(0.5);
  }
  if (dir) { await jobsBlock(page).screenshot({ path: `${dir}/jobs-block.png` }); await page.locator('#panel header').screenshot({ path: `${dir}/header.png` }); }
});
