import { test, expect, createWs, open, say, uniq } from './helpers.ts';

test('every chat code block has a Copy button that copies the block text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const name = uniq('copy');
  const id = await createWs(page, name);
  await open(page, name);
  await say(page, id, 'say a\n```js\nlet x = 1;\n```\nb\n```\nsecond\n```');
  const btns = page.locator('#log .codeblock button');
  await expect(btns).toHaveCount(2);
  await expect(btns.first()).toHaveCSS('opacity', '0');
  await page.locator('#log .codeblock').first().hover();
  await expect(btns.first()).toHaveCSS('opacity', '1');
  for (const [i, text] of ['let x = 1;', 'second'].entries()) {
    await btns.nth(i).click();
    await expect(btns.nth(i)).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
    await expect(btns.nth(i)).toHaveText('Copy');
  }
});

test('Copy shows Failed when the clipboard write is refused', async ({ page }) => {
  const name = uniq('copyfail');
  const id = await createWs(page, name);
  await open(page, name);
  await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('denied')); });
  await say(page, id, 'say a\n```\ncode\n```');
  const btn = page.locator('#log .codeblock button');
  await btn.click();
  await expect(btn).toHaveText('Failed');
  await expect(btn).toHaveText('Copy');
});

test('Copy shows Failed when there is no clipboard', async ({ page }) => {
  const name = uniq('copynone');
  const id = await createWs(page, name);
  await open(page, name);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }));
  await say(page, id, 'say a\n```\ncode\n```');
  const btn = page.locator('#log .codeblock button');
  await btn.click();
  await expect(btn).toHaveText('Failed');
});
