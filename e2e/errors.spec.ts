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
