import { test, expect, createWs, open, uniq, say, events } from './helpers.ts';

test('streamed text grows in the log, then the final message replaces it once', async ({ page }) => {
  const name = uniq('stream');
  const id = await createWs(page, name);
  await open(page, name);
  // Every text the streamed line shows, in order: polling from the test could miss a step.
  await page.evaluate(() => {
    const seen: string[] = ((window as any).seen = []);
    new MutationObserver(() => {
      const t = document.querySelector('#log .live')?.textContent;
      if (t && seen.at(-1) !== t) seen.push(t);
    }).observe(document.querySelector('#log')!, { childList: true, subtree: true, characterData: true });
  });
  await say(page, id, 'option includePartialMessages\npace 200\nsay one two three');
  await expect(page.locator('#log div:not(.user)').filter({ hasText: /^includePartialMessages=true$/ })).toBeVisible();
  await expect(page.locator('#core')).toHaveClass(/\bidle\b/);
  await expect(page.locator('#log .live')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).seen)).toEqual(['includePartialMessages=true', 'one', 'one two', 'one two three']);
  await expect(page.locator('#log div:not(.user)').filter({ hasText: /one two/ })).toHaveText(['one two three']);
  // Deltas are live-only: the log keeps the final text.
  expect(events(id).filter((e) => e.type === 'delta')).toEqual([]);
  await page.reload();
  await expect(page.locator('#log div:not(.user)').filter({ hasText: /one two/ })).toHaveText(['one two three']);
});
