import { test, expect, createWs, open, uniq, say, post, events } from './helpers.ts';

// The fake adds 30k tokens per turn and compacts to 3k, of a 200k window.
test('COMPACT on an agent: compacted in the log, context counted again, no report to Jarvis', async ({ page }) => {
  const name = uniq('compact');
  const id = await createWs(page, name);
  await open(page, name);
  await say(page, id, 'tool mcp__jarvis__spawn_agent {"name":"helper","task":"say helper done"}');
  const node = page.locator('#nodes .node', { hasText: 'helper' });
  await expect(node.locator('.sub')).toHaveText(/^idle · .* · 15%$/);
  const agentId = events(id).find((e) => e.type === 'spawned' && e.agent.name === 'helper').agent.id;
  const reports = () => events(id).filter((e) => e.type === 'routed' && e.from === agentId && e.to === 'arbiter').length;
  await expect.poll(() => events(id).filter((e) => e.type === 'result' && e.agentId === 'arbiter').length).toBe(2); // Jarvis has run a turn on the report
  expect(reports()).toBe(1);

  await node.press('Enter');
  await expect(page.locator('#ptitle')).toContainText('helper');
  await page.locator('#pcompact').click();
  await expect(page.locator('#log .result').filter({ hasText: '⇣ compacted 30k → 3k' })).toBeVisible();
  // 'summary' would still report the 30k of the last response; after a compact the server asks for a full count.
  await expect(node.locator('.sub')).toHaveText(/^idle · .* · 2%$/);
  const last = events(id).filter((e) => e.agentId === agentId).at(-1);
  expect(last).toMatchObject({ type: 'context', tokens: 3_000, max: 200_000 });
  expect(events(id).find((e) => e.type === 'compacted' && e.agentId === agentId)).toMatchObject({ trigger: 'manual', pre: 30_000, post: 3_000 });
  expect(reports()).toBe(1);
  expect(events(id).filter((e) => e.type === 'result' && e.agentId === 'arbiter').length).toBe(2);
  await expect(page.locator('#pcompact')).toBeVisible(); // idle again, so it can compact again
});

test('COMPACT is hidden and refused while the agent works', async ({ page }) => {
  const name = uniq('compactbusy');
  const id = await createWs(page, name);
  await open(page, name);
  await say(page, id, 'say first');
  await expect(page.locator('#pcompact')).toBeVisible();
  await say(page, id, 'sleep 1500');
  await expect(page.locator('#pcompact')).toBeHidden();
  const r = await post(page, '/compact', { ws: id, id: 'arbiter' });
  expect(r.status()).toBe(400);
  expect(await r.text()).toContain('is busy');
  await expect(page.locator('#pcompact')).toBeVisible();
  expect(events(id).some((e) => e.type === 'compacted')).toBe(false);
});
