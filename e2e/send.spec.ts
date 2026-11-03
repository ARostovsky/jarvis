import { test, expect, createWs, open, uniq, events } from './helpers.ts';

test('a message to Jarvis gets a reply, busy then idle', async ({ page }) => {
  const name = uniq('send');
  const id = await createWs(page, name);
  await open(page, name);
  await page.locator('#core').click({ force: true }); // the node pulses, so it is never stable
  await page.fill('#dinput', 'sleep 500\nsay hello');
  await page.locator('#dinput').press('Enter');
  await expect(page.locator('#dinput')).toHaveValue('');
  await expect(page.locator('#core')).toHaveClass(/\brunning\b/);
  await expect(page.locator('#log div:not(.user)').filter({ hasText: /^hello$/ })).toBeVisible();
  await expect(page.locator('#core')).toHaveClass(/\bidle\b/);
  await expect(page.locator('#log .result')).toHaveText(/done · \$0\.000/);
  const statuses = events(id).filter((e) => e.type === 'status' && e.agentId === 'arbiter').map((e) => e.status);
  expect(statuses.slice(-2)).toEqual(['running', 'idle']);
});
