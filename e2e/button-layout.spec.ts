import { test, expect, createWs, open, uniq } from './helpers.ts';

const arbiter = (page: import('@playwright/test').Page) => page.locator('#core').click({ force: true }); // the node pulses, so it is never stable
const box = (page: import('@playwright/test').Page, sel: string) => page.locator(sel).evaluate((e) => { const r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right, w: (e as HTMLElement).offsetWidth }; });
// Centre of the label text, measured with a Range, minus the centre of the button.
const labelOff = (page: import('@playwright/test').Page, sel: string) => page.locator(sel).evaluate((e) => {
  const rg = document.createRange(); rg.selectNodeContents(e.firstChild!);
  const t = rg.getBoundingClientRect(), b = e.getBoundingClientRect(), ls = parseFloat(getComputedStyle(e).letterSpacing) || 0;
  return (t.left + (t.right - ls - t.left) / 2) - (b.left + b.width / 2); // the last letter's spacing is trailing air, not ink
});

test('input row: buttons share size and one spacing, one-line and tall drafts', async ({ page }) => {
  await page.goto('/');
  const name = uniq('btnrow');
  await createWs(page, name);
  await open(page, name);
  await arbiter(page);
  await page.evaluate(() => { document.getElementById('mic')!.hidden = false; }); // voice is off in this server
  await page.fill('#dinput', 'one line');
  const row = await box(page, '#direct'), send = await box(page, '#send'), mic = await box(page, '#mic'), ta = await box(page, '#dinput');
  expect(send.w).toBe(mic.w);
  for (const id of ['#send', '#mic']) expect(await page.locator(id).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true); // the label fits
  const gapBetween = mic.l - send.r, gapRight = row.r - mic.r, gapTop = send.t - row.t - 1 /* border */, gapBottom = row.b - send.b;
  expect(Math.abs(gapRight - gapBetween)).toBeLessThanOrEqual(2);
  expect(gapTop).toBeGreaterThanOrEqual(4);
  expect(Math.abs(gapTop - gapBottom)).toBeLessThanOrEqual(2);
  expect(Math.abs(gapBottom - gapBetween)).toBeLessThanOrEqual(2);
  expect(ta.b - ta.t).toBeCloseTo(send.b - send.t, 0); // one-line textarea as tall as the buttons
  const line = await page.locator('#dinput').evaluate((t: HTMLTextAreaElement) => { const r = t.getBoundingClientRect(), s = getComputedStyle(t), lh = parseFloat(s.lineHeight); return r.top + parseFloat(s.paddingTop) + lh / 2; });
  expect(Math.abs(line - (send.t + send.b) / 2)).toBeLessThanOrEqual(3);
  expect(Math.abs(await labelOff(page, '#send'))).toBeLessThanOrEqual(2);
  expect(Math.abs(await labelOff(page, '#mic'))).toBeLessThanOrEqual(2);
  await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/input-one.png` : undefined, clip: { x: 0, y: Math.max(0, row.t - 20), width: (await page.viewportSize())!.width, height: row.b - row.t + 30 } });

  await page.fill('#dinput', Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'));
  const tall = await box(page, '#direct'), sendT = await box(page, '#send'), taT = await box(page, '#dinput');
  expect(sendT.b - sendT.t).toBe(send.b - send.t);
  expect(Math.abs(taT.b - sendT.b)).toBeLessThanOrEqual(1); // buttons pinned to the textarea's bottom edge
  expect(Math.abs(tall.b - sendT.b - gapBottom)).toBeLessThanOrEqual(1);
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/input-tall.png`, clip: { x: 0, y: tall.t - 20, width: (await page.viewportSize())!.width, height: tall.b - tall.t + 30 } });
});

for (const id of ['jobSourceDetails']) {
  test(`dialog ${id}: CLOSE keeps a gap below the list and its label is centred`, async ({ page }) => {
    await page.goto('/');
    await page.evaluate((d) => { const el = document.getElementById(d) as HTMLDialogElement; if (d === 'jobSourceDetails') document.getElementById('pdBody')!.textContent = 'body text'; el.showModal(); }, id);
    const close = `#${id} button[value=""]`;
    const gap = await page.evaluate(([d, c]) => {
      const dl = document.getElementById(d)!, b = dl.querySelector(c)!.getBoundingClientRect(), form = dl.querySelector('form')!.getBoundingClientRect(), prev = dl.querySelector('form')!.previousElementSibling!.getBoundingClientRect();
      return { top: b.top - prev.bottom, bottom: dl.getBoundingClientRect().bottom - b.bottom, formTop: form.top - prev.bottom };
    }, [id, close]);
    expect(gap.top).toBeGreaterThanOrEqual(8);
    expect(gap.bottom).toBeGreaterThanOrEqual(8);
    expect(Math.abs(await labelOff(page, close))).toBeLessThanOrEqual(2);
    if (process.env.SHOT_DIR) await page.locator(`#${id}`).screenshot({ path: `${process.env.SHOT_DIR}/dialog-${id}.png` });
  });
}

for (const id of ['archived', 'job-sources', 'connections']) {
  test(`dialog ${id}: the X stays in view while a long body scrolls, and closes the dialog`, async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto('/');
    await page.evaluate((d) => {
      const list = document.getElementById({ archived: 'archivedList', 'job-sources': 'jobSourceList', connections: 'connList' }[d]!)!;
      list.innerHTML = Array.from({ length: 150 }, (_, i) => `<div>row ${i}</div>`).join('');
      (document.getElementById(d) as HTMLDialogElement).showModal();
    }, id);
    const dlg = page.locator(`#${id}`), x = dlg.getByRole('button', { name: 'Close' });
    await expect(dlg.locator('button', { hasText: /^CLOSE$/ })).toHaveCount(0);
    const body = dlg.locator('.dlg-list');
    await body.evaluate((e) => { e.scrollTop = e.scrollHeight; });
    expect(await body.evaluate((e) => e.scrollTop)).toBeGreaterThan(0); // only the list scrolls
    expect(await dlg.evaluate((e) => e.scrollHeight <= e.clientHeight)).toBe(true); // not the dialog, so the header, its X and the actions stay put
    const [d, b] = [await dlg.boundingBox(), await x.boundingBox()];
    expect(b!.y).toBeGreaterThanOrEqual(d!.y); expect(b!.y + b!.height).toBeLessThanOrEqual(d!.y + 80); // still at the top
    if (process.env.SHOT_DIR) await dlg.screenshot({ path: `${process.env.SHOT_DIR}/dialog-x-${id}.png` });
    await x.click();
    await expect(dlg).not.toBeVisible();
  });
  test(`dialog ${id}: Esc closes only the dialog, the chat behind it stays open`, async ({ page }) => {
    await page.goto('/');
    const name = uniq('dlgesc');
    await createWs(page, name);
    await open(page, name);
    await arbiter(page);
    await expect(page.locator('#panel')).toHaveClass(/open/);
    await page.evaluate((d) => (document.getElementById(d) as HTMLDialogElement).showModal(), id);
    await page.keyboard.press('Escape');
    await expect(page.locator(`#${id}`)).not.toBeVisible();
    await expect(page.locator('#panel')).toHaveClass(/open/);
    await page.keyboard.press('Escape'); // no dialog: closes the chat as before
    await expect(page.locator('#panel')).not.toHaveClass(/open/);
  });
}

test('input row at 360px: SEND alone and with MIC keep the same narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await page.goto('/');
  const name = uniq('btnnarrow');
  await createWs(page, name);
  await open(page, name);
  await arbiter(page);
  const alone = await box(page, '#send'); // voice is off in this server: SEND only
  await page.evaluate(() => { document.getElementById('mic')!.hidden = false; });
  const send = await box(page, '#send'), mic = await box(page, '#mic');
  expect(alone.w).toBe(send.w);
  expect(send.w).toBe(mic.w);
  for (const id of ['#send', '#mic']) expect(await page.locator(id).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true); // the label fits
  expect(mic.r).toBeLessThanOrEqual(360);
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/input-360.png`, clip: { x: 0, y: 700 - 120, width: 360, height: 120 } });
});

test('SEND idles with an empty box and is bright with a draft', async ({ page }) => {
  await page.goto('/');
  const name = uniq('sendidle');
  await createWs(page, name);
  await open(page, name);
  await arbiter(page);
  const look = () => page.locator('#send').evaluate((e) => { const s = getComputedStyle(e); return { bg: s.backgroundColor, shadow: s.boxShadow }; });
  await page.fill('#dinput', '');
  const idle = await look();
  if (process.env.SHOT_DIR) await page.locator('#direct').screenshot({ path: `${process.env.SHOT_DIR}/send-empty.png` });
  expect(idle.bg).toBe('rgba(0, 0, 0, 0)');
  expect(idle.shadow).toBe('none');
  await page.locator('#send').hover();
  await page.waitForTimeout(200);
  expect((await look()).shadow).toBe('none'); // hover on an empty box stays calm
  await page.fill('#dinput', 'hello');
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await look()).bg).toBe('rgb(79, 216, 255)'); // past the .12s transition
  const active = await look();
  if (process.env.SHOT_DIR) await page.locator('#direct').screenshot({ path: `${process.env.SHOT_DIR}/send-draft.png` });
  expect(active.shadow).not.toBe('none');
  await page.fill('#dinput', '');
  await expect.poll(look).toEqual(idle);
});
