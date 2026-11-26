import { test, expect, createWs, open, tab, uniq, addFakeAgent } from './helpers.ts';

// Sending would start an SDK session, so "a send clears the draft" is not tested here.
const stored = (page: import('@playwright/test').Page) => page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.drafts') ?? '{}'));
const arbiter = (page: import('@playwright/test').Page) => page.locator('#core').click({ force: true }) // the node pulses, so it is never stable;

test('a draft stays in its workspace and comes back', async ({ page }) => {
  const a = uniq('dra'), b = uniq('drb');
  const idA = await createWs(page, a);
  const idB = await createWs(page, b);
  await open(page, a);
  await arbiter(page);
  await page.fill('#dinput', 'text for A');
  await tab(page, b).click();
  await expect(tab(page, b)).toHaveClass('active');
  await arbiter(page);
  await expect(page.locator('#dinput')).toHaveValue('');
  await page.fill('#dinput', 'text for B');
  await tab(page, a).click();
  await expect(tab(page, a)).toHaveClass('active');
  await arbiter(page);
  await expect(page.locator('#dinput')).toHaveValue('text for A');
  expect(await stored(page)).toMatchObject({ [`${idA}/arbiter`]: 'text for A', [`${idB}/arbiter`]: 'text for B' });
});

test('each agent in a workspace has its own draft', async ({ page }) => {
  const name = uniq('dag');
  const id = await createWs(page, name);
  await addFakeAgent(page, id, 'helper');
  await open(page, name);
  await arbiter(page);
  await page.fill('#dinput', 'to jarvis');
  await page.locator('#nodes .node').first().press('Enter');
  await expect(page.locator('#dinput')).toHaveValue('');
  await page.locator('#dinput').dblclick(); // agents led by Jarvis are read-only until then
  await page.fill('#dinput', 'to helper');
  await arbiter(page);
  await expect(page.locator('#dinput')).toHaveValue('to jarvis');
  await page.locator('#nodes .node').first().press('Enter');
  await expect(page.locator('#dinput')).toHaveValue('to helper');
  expect(await stored(page)).toMatchObject({ [`${id}/arbiter`]: 'to jarvis', [`${id}/helper`]: 'to helper' });
});

test('a draft survives a reload', async ({ page }) => {
  const name = uniq('drr');
  const id = await createWs(page, name);
  await open(page, name);
  await arbiter(page);
  await page.fill('#dinput', 'keep me');
  await page.reload();
  await expect(tab(page, name)).toHaveClass('active');
  expect(await stored(page)).toMatchObject({ [`${id}/arbiter`]: 'keep me' });
  await arbiter(page);
  await expect(page.locator('#dinput')).toHaveValue('keep me');
});

test('archiving a workspace drops its drafts', async ({ page }) => {
  const a = uniq('drx'), b = uniq('dry');
  const idA = await createWs(page, a);
  const idB = await createWs(page, b);
  await open(page, a);
  await arbiter(page);
  await page.fill('#dinput', 'doomed');
  await tab(page, b).click();
  await expect(tab(page, b)).toHaveClass('active');
  await arbiter(page);
  await page.fill('#dinput', 'survivor');
  await tab(page, a).click();
  await expect(tab(page, a)).toHaveClass('active');
  await tab(page, b).click();
  await expect(tab(page, b)).toHaveClass('active');
  expect(await stored(page)).toMatchObject({ [`${idA}/arbiter`]: 'doomed', [`${idB}/arbiter`]: 'survivor' });
  await tab(page, a).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive workspace' }).click();
  await page.locator('#choiceButtons button', { hasText: /^ARCHIVE$/ }).click();
  await expect(tab(page, a)).toHaveCount(0);
  const d = await stored(page);
  expect(Object.keys(d).filter((k) => k.startsWith(`${idA}/`))).toEqual([]);
  expect(d[`${idB}/arbiter`]).toBe('survivor');
});

test('a restored draft gets its own input height, not a squeezed one', async ({ page }) => {
  const a = uniq('drh'), b = uniq('dri');
  await createWs(page, a);
  await createWs(page, b);
  await open(page, a);
  await arbiter(page);
  const h = () => page.locator('#dinput').evaluate((t) => t.getBoundingClientRect().height);
  const empty = await h();
  await page.fill('#dinput', 'one\ntwo\nthree\nfour');
  const grown = await h();
  expect(grown).toBeGreaterThan(empty);
  await tab(page, b).click();
  await expect(tab(page, b)).toHaveClass('active');
  await expect(page.locator('#dinput')).toHaveValue(''); // the switch selects Jarvis by itself: no click, so the panel was hidden during the restore
  expect(await h()).toBe(empty);
  await tab(page, a).click();
  await expect(tab(page, a)).toHaveClass('active');
  await expect(page.locator('#dinput')).toHaveValue('one\ntwo\nthree\nfour');
  expect(await h()).toBe(grown);
});

test('SEND keeps its compact height and bottom edge when the draft grows tall', async ({ page }) => {
  const n = uniq('btn');
  await createWs(page, n);
  await open(page, n);
  await arbiter(page);
  const box = () => page.evaluate(() => {
    const s = document.getElementById('send')!.getBoundingClientRect(), t = document.getElementById('dinput')!.getBoundingClientRect();
    return { h: s.height, bottomGap: t.bottom - s.bottom, textarea: t.height };
  });
  await page.fill('#dinput', 'short');
  const short = await box();
  await page.fill('#dinput', Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'));
  const tall = await box();
  expect(tall.textarea).toBeGreaterThan(short.textarea * 2);
  expect(tall.h).toBe(short.h);
  expect(tall.bottomGap).toBe(0);
});

test('a tall draft grows to a capped height, then scrolls', async ({ page }) => {
  const name = uniq('dsc');
  await createWs(page, name);
  await open(page, name);
  await arbiter(page);
  await page.fill('#dinput', Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'));
  const m = await page.locator('#dinput').evaluate((t: HTMLTextAreaElement) => {
    t.scrollTop = 0; const top = t.scrollTop; t.scrollTop = 50;
    return { sh: t.scrollHeight, ch: t.clientHeight, oy: getComputedStyle(t).overflowY, st: t.scrollTop, top, vh: innerHeight };
  });
  expect(m.sh).toBeGreaterThan(m.ch);
  expect(['auto', 'scroll']).toContain(m.oy);
  expect(m.ch).toBeLessThan(m.vh / 2);
  expect(m.st).toBeGreaterThan(m.top);
});

test('a draft that fits shows whole, with no scrollbar and nothing scrolled off the top', async ({ page }) => {
  const name = uniq('dfit');
  await createWs(page, name);
  await open(page, name);
  await arbiter(page);
  await page.fill('#dinput', ' first line\nsecond\nthird\nfourth\nfifth');
  const m = await page.locator('#dinput').evaluate((t: HTMLTextAreaElement) => ({ sh: t.scrollHeight, ch: t.clientHeight, st: t.scrollTop, vh: innerHeight }));
  expect(m.st).toBe(0);
  expect(m.sh).toBeLessThanOrEqual(m.ch);
  expect(m.ch).toBeLessThan(m.vh * 0.4);
});
