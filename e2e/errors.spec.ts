import { test, expect, createWs, open, uniq, say, events } from './helpers.ts';

const line = (page: import('@playwright/test').Page, text: string) => page.locator('#log div:not(.user)').filter({ hasText: new RegExp(`^${text}$`) });

test('an error result: status error, the log says why, the next message works', async ({ page }) => {
  const name = uniq('fail');
  const id = await createWs(page, name);
  await open(page, name);
  await say(page, id, 'say partial\nfail error_during_execution\nsay never');
  await expect(page.locator('#core')).toHaveClass(/\berror\b/);
  await expect(page.locator('#log .result')).toHaveText(/error: error_during_execution · \$0\.000/);
  await expect(line(page, 'partial')).toBeVisible();
  await expect(line(page, 'never')).toHaveCount(0); // the turn ended at the error
  expect(events(id).filter((e) => e.type === 'status' && e.agentId === 'arbiter').map((e) => e.status).slice(-2)).toEqual(['running', 'error']);

  await page.fill('#dinput', 'say recovered');
  await page.locator('#dinput').press('Enter');
  await expect(line(page, 'recovered')).toBeVisible();
  await expect(page.locator('#core')).toHaveClass(/\bidle\b/);
  await expect(page.locator('#log .result').last()).toHaveText(/done · \$0\.000/);
  await page.reload(); // the replayed log tells the two turns apart too
  await expect(page.locator('#log .result')).toHaveText([/error: error_during_execution/, /done/]);
});

test('an agent that ends with an error reports it to Jarvis', async ({ page }) => {
  const name = uniq('failagent');
  const id = await createWs(page, name);
  await open(page, name);
  await say(page, id, 'tool mcp__jarvis__spawn_agent {"name":"breaks","task":"fail error_max_turns"}');
  const node = page.locator('#nodes .node', { hasText: 'breaks' });
  await expect(node).toHaveClass(/\berror\b/);
  const agentId = events(id).find((e) => e.type === 'spawned' && e.agent.name === 'breaks').agent.id;
  await expect.poll(() => events(id).find((e) => e.type === 'routed' && e.from === agentId)?.text).toBe(`[agent ${agentId} finished, status error]\nerror: error_max_turns`);
});

test('a refused /send keeps the typed text and the draft; one request in flight; success clears', async ({ page }) => {
  const name = uniq('refused');
  const id = await createWs(page, name);
  await open(page, name);
  await page.locator('#core').click({ force: true }); // the node pulses, so it is never stable
  let sends = 0;
  await page.route('**/send', async (route) => {
    sends++;
    await new Promise((r) => setTimeout(r, 300)); // in flight long enough for a second Enter
    await route.fulfill({ status: 400, body: 'agent refused: ' + 'x'.repeat(120) });
  });
  await page.fill('#dinput', 'say precious');
  await page.locator('#dinput').press('Enter');
  await page.locator('#dinput').press('Enter');
  await expect(page.locator('#toast')).toContainText('send failed: agent refused: xxx');
  expect(sends).toBe(1);
  await page.getByRole('button', { name: 'Dismiss error' }).click(); // the open panel must not cover the button
  await expect(page.locator('#toast')).toBeHidden();
  await expect(page.locator('#dinput')).toHaveValue('say precious');

  await page.unroute('**/send');
  await page.reload(); // the draft is saved on pagehide: the refused text survives it
  await open(page, name);
  await page.locator('#core').click({ force: true });
  await expect(page.locator('#dinput')).toHaveValue('say precious');
  await page.locator('#dinput').press('Enter');
  await expect(page.locator('#dinput')).toHaveValue('');
  await expect(line(page, 'precious')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.drafts') ?? '{}'))).not.toHaveProperty(`${id}/arbiter`);
});

test('a network failure on /send shows a toast and keeps the text', async ({ page, errors }) => {
  const name = uniq('offline');
  await createWs(page, name);
  await open(page, name);
  await page.locator('#core').click({ force: true });
  await page.route('**/send', (route) => route.abort());
  await page.fill('#dinput', 'say kept');
  await page.locator('#dinput').press('Enter');
  await expect(page.locator('#toast')).toContainText('send failed:');
  await expect(page.locator('#dinput')).toHaveValue('say kept');
  expect(errors.splice(0)).toEqual(['console: Failed to load resource: net::ERR_FAILED']); // the browser logs the aborted request itself
});

test('a sent text does not come back as a draft after the panel was closed', async ({ page }) => {
  const name = uniq('moved');
  const id = await createWs(page, name);
  await open(page, name);
  await page.locator('#core').click({ force: true });
  await page.route('**/send', async (route) => { await new Promise((r) => setTimeout(r, 300)); await route.continue(); });
  await page.fill('#dinput', 'say gone\n');
  await page.locator('#dinput').press('Enter');
  await page.keyboard.press('Escape'); // closes the panel while /send is in flight
  await expect.poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem('jarvis.drafts') ?? '{}')[k], `${id}/arbiter`)).toBeUndefined();
});

test('Enter on the focused × hides the toast and does not open the chat', async ({ page }) => {
  const name = uniq('enter');
  await createWs(page, name);
  await open(page, name);
  await page.keyboard.press('Escape'); // close the panel
  await expect(page.locator('#panel')).not.toHaveClass(/\bopen\b/);
  await page.evaluate(() => (window as any).toast('boom'));
  await expect(page.locator('#toast')).toBeVisible();
  await page.locator('#toastClose').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toBeHidden();
  await expect(page.locator('#panel')).not.toHaveClass(/\bopen\b/);
});
