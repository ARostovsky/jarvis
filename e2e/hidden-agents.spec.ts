import { execFileSync } from 'node:child_process';
import { test, expect, createWs, open, tab, tmp, uniq, say, post, events } from './helpers.ts';

test('an agent hidden by hand stays hidden after switching workspace and back', async ({ page }) => {
  const repo = tmp('repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const a = uniq('hid'), b = uniq('oth');
  const id = await createWs(page, a, { project: repo });
  await createWs(page, b);
  await open(page, a);
  await say(page, id, 'tool mcp__jarvis__spawn_agent {"name":"helper","task":"say helper done"}');
  const node = page.locator('#nodes .node', { hasText: 'helper' });
  const spawned = () => events(id).find((e) => e.type === 'spawned' && e.agent.name === 'helper')?.agent.id;
  await expect.poll(spawned).toBeTruthy();
  const helper = spawned();
  await expect.poll(() => events(id).some((e) => e.type === 'status' && e.agentId === helper && e.status === 'idle')).toBe(true);

  await node.dispatchEvent('contextmenu');
  await page.getByRole('menuitem', { name: 'Hide', exact: true }).click();
  await expect(node).toHaveClass(/folded/);

  await tab(page, b).click();
  await tab(page, a).click();
  await expect(page.locator('#log .report')).toContainText('helper done'); // replay reached the report, after the busy stretch
  await expect(node).toHaveClass(/folded/); // replayed busy history must not unhide it
  expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), `jarvis.hidden.${id}`)).toHaveProperty(helper);

  // Live work brings it back.
  expect((await post(page, '/send', { ws: id, id: helper, text: 'say again' })).ok()).toBe(true);
  await expect(node).not.toHaveClass(/folded/);
});

// A guard: without the fix this passes too, since the unhide also happens when the work comes in while the workspace is open.
test('an agent hidden by hand comes back when it got work while another workspace was open', async ({ page }) => {
  const repo = tmp('repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const a = uniq('away'), b = uniq('oth');
  const id = await createWs(page, a, { project: repo });
  await createWs(page, b);
  await open(page, a);
  await say(page, id, 'tool mcp__jarvis__spawn_agent {"name":"helper","task":"say helper done"}');
  const node = page.locator('#nodes .node', { hasText: 'helper' });
  await expect(node).toBeVisible();
  const helper = events(id).find((e) => e.type === 'spawned' && e.agent.name === 'helper').agent.id;
  await expect.poll(() => events(id).some((e) => e.type === 'status' && e.agentId === helper && e.status === 'idle')).toBe(true);
  await node.dispatchEvent('contextmenu');
  await page.getByRole('menuitem', { name: 'Hide', exact: true }).click();
  await expect(node).toHaveClass(/folded/);

  await tab(page, b).click();
  expect((await post(page, '/send', { ws: id, id: helper, text: 'say again' })).ok()).toBe(true);
  await expect.poll(() => events(id).filter((e) => e.type === 'status' && e.agentId === helper && e.status === 'idle').length).toBe(2);
  await tab(page, a).click();
  await expect(page.locator('#log .report').first()).toBeAttached(); // replay is through
  await expect(node).not.toHaveClass(/folded/);
});

test('a hand-set expand of a lead survives a workspace switch', async ({ page }) => {
  const repo = tmp('repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const a = uniq('exp'), b = uniq('oth');
  const id = await createWs(page, a, { project: repo });
  await createWs(page, b);
  await open(page, a);
  const leadTask = `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'child', task: 'say child done' })}\nsay lead done`;
  await say(page, id, `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'lead', task: leadTask })}`);
  const lead = page.locator('#nodes .node', { hasText: 'lead' }), child = page.locator('#nodes .node', { hasText: 'child' });
  const spawnedChild = () => events(id).find((e) => e.type === 'spawned' && e.agent.name === 'child')?.agent.id;
  await expect.poll(spawnedChild).toBeTruthy();
  const childId = spawnedChild();
  await expect.poll(() => events(id).some((e) => e.type === 'status' && e.agentId === childId && e.status === 'idle')).toBe(true);
  await expect(child).toHaveClass(/folded/); // idle lead: auto fold
  await lead.locator('.badge').dispatchEvent('pointerdown');
  await expect(child).not.toHaveClass(/folded/);

  await tab(page, b).click();
  await tab(page, a).click();
  await expect(page.locator('#log .report').first()).toBeAttached(); // replay is through
  await expect(child).not.toHaveClass(/folded/); // replay passes through a busy lead stretch that must not drop the override
});

test('an agent hidden before hide times were stored stays hidden on replay and comes back with live work', async ({ page }) => {
  const repo = tmp('repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const a = uniq('old');
  const id = await createWs(page, a, { project: repo });
  await say(page, id, 'tool mcp__jarvis__spawn_agent {"name":"helper","task":"say helper done"}');
  const spawned = () => events(id).find((e) => e.type === 'spawned' && e.agent.name === 'helper')?.agent.id;
  await expect.poll(spawned).toBeTruthy();
  const helper = spawned();
  await expect.poll(() => events(id).some((e) => e.type === 'status' && e.agentId === helper && e.status === 'idle')).toBe(true);
  await page.addInitScript(([k, h]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify({ [h]: true })); }, [`jarvis.hidden.${id}`, helper]);
  await open(page, a);
  const node = page.locator('#nodes .node', { hasText: 'helper' });
  await expect(page.locator('#log .report').first()).toBeAttached(); // replay is through
  await expect(node).toHaveClass(/folded/);

  expect((await post(page, '/send', { ws: id, id: helper, text: 'say again' })).ok()).toBe(true);
  await expect(node).not.toHaveClass(/folded/);
});
