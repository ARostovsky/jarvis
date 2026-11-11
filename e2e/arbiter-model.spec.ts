import { test, expect, createWs, open, uniq } from './helpers.ts';

test('GET /workspaces names the arbiter default, and Jarvis shows it before a session reports a model', async ({ page }) => {
  const name = uniq('model');
  await createWs(page, name);
  const body = await (await page.request.get('/workspaces')).json();
  expect(body.arbiterModel).toBe('sonnet');
  await open(page, name);
  await page.locator('#core').click({ force: true });
  await expect(page.locator('#pmeta')).toContainText(/^sonnet · medium/);
});
