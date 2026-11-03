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
