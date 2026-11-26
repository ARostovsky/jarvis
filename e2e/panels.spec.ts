import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, createWs, open, tab, uniq, post, addFakeAgent, panelsOf, jobRows, jobsBlock, jobRow, watchJobs, jobsWorkspace, archivePolling, fakeProvider, tmp, type Page } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const order = (page: Page) => jobsBlock(page).locator('li.jr').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key!.split(':')[1]));
const tabOf = (page: Page, name: string) => page.locator('#tabs button', { hasText: name }); // the tab also carries badges
const uiState = (page: Page, ws: string) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), `jarvis.panels.${ws}`);

test.afterEach(({ page }) => archivePolling(page));

test('collapse shows the summary with the counts and survives a reload for that workspace only', async ({ page }) => {
  const a = await jobsWorkspace(page);
  const b = await createWs(page, uniq('other'));
  a.set('a-run', { state: 'running' }); a.set('a-fail', { state: 'failed', error: 'x' }); a.set('a-done', { state: 'done' });
  await watchJobs(page, a.ws, a.name, ['a-run', 'a-fail', 'a-done']);
  await expect(jobRow(page, a.name, 'a-fail')).toHaveClass(/st-failed/);
  const block = jobsBlock(page);
  await expect(block).not.toHaveClass(/collapsed/);
  await block.locator('.pn-tog').click();
  await expect(block).toHaveClass(/collapsed/);
  await expect(block.locator('.pn-sum')).toHaveText('1 running · 1 failed · 1 done');
  await expect(block.locator('.pn-tog')).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await tabOf(page, a.wsName).click();
  await expect(jobsBlock(page)).toHaveClass(/collapsed/);
  expect((await uiState(page, a.ws))['jobs'].collapsed).toBe(true);
  expect(await uiState(page, b)).toEqual({}); // another workspace keeps its own state
  await jobsBlock(page).locator('.pn-tog').click();
  await expect(jobsBlock(page)).not.toHaveClass(/collapsed/);
});

test('the VIEW menu hides the block and brings it back, the tab badge stays', async ({ page }) => {
  const p = await jobsWorkspace(page);
  p.set('h1', { state: 'failed', error: 'x' });
  await watchJobs(page, p.ws, p.name, ['h1']);
  await expect(jobsBlock(page)).toBeVisible();
  const badge = tabOf(page, p.wsName).locator('.pbadge');
  await expect(badge).toHaveText('✕1');
  await expect(jobsBlock(page).getByRole('button', { name: 'Hide Jobs' })).toHaveCount(0);
  await page.locator('#pview').click();
  await page.locator('#viewMenu label', { hasText: 'Jobs' }).getByRole('checkbox').uncheck();
  await expect(page.locator('#panels')).toBeHidden();
  await expect(badge).toHaveText('✕1');
  await page.locator('#viewMenu label', { hasText: 'Jobs' }).getByRole('checkbox').check();
  await expect(jobsBlock(page)).toBeVisible();
});

test('selecting another agent hides the panels, closing the panel leaves the tab badge', async ({ page }) => {
  const p = await jobsWorkspace(page);
  await addFakeAgent(page, p.ws, 'helper');
  await page.reload();
  await tabOf(page, p.wsName).click();
  p.set('g1', { state: 'failed', error: 'x' });
  await watchJobs(page, p.ws, p.name, ['g1']);
  await expect(jobsBlock(page)).toBeVisible();
  await page.locator('#nodes .node', { hasText: 'helper' }).press('Enter');
  await expect(page.locator('#ptitle')).toContainText('helper');
  await expect(page.locator('#panels')).toBeHidden();
  await page.locator('#core').press('Enter');
  await expect(jobsBlock(page)).toBeVisible();
  await page.locator('#pclose').click();
  await expect(page.locator('#panel')).not.toHaveClass(/open/);
  await expect(tabOf(page, p.wsName).locator('.pbadge')).toHaveText('✕1');
});

test('an unknown kind shows its title and a plain notice, without console errors', async ({ page }) => {
  const name = uniq('unk');
  await createWs(page, name);
  await open(page, name);
  await page.evaluate(() => (0, eval)('handlers').panel({ type: 'panel', panelId: 'x-nope', kind: 'nope', title: 'Weird thing', data: { a: 1 } }));
  const block = page.locator('#panels section.pn[data-panel="x-nope"]');
  await expect(block).toContainText('Weird thing');
  await expect(block).toContainText('This Jarvis version cannot show this panel');
  // `errors` (auto fixture) fails the test on any console or page error.
});

test('GET /panels returns the jobs panel with the rows the page shows', async ({ page }) => {
  const p = await jobsWorkspace(page);
  p.set('q1', { state: 'running', label: 'One' }); p.set('q2', { state: 'done' });
  await watchJobs(page, p.ws, p.name, ['q1', 'q2']);
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(2);
  const panel = (await panelsOf(page, p.ws)).find((x) => x.panelId === 'jobs');
  expect(panel.kind).toBe('jobs');
  expect(panel.status.ok).toBe(true);
  expect(panel.data.rows.map((r: any) => `${r.id}:${r.state}`).sort()).toEqual(['q1:running', 'q2:done']);
  expect((await order(page)).sort()).toEqual(panel.data.rows.map((r: any) => r.id).sort());
  expect((await page.request.get('/panels?ws=nope')).status()).toBe(404);
});

test('with 12 rows the panel is capped at 40%, scrolls inside, keeps its header and leaves the log 160 px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 672 }); // the panel is 56 px from the top and 16 px from the bottom: 600 px
  const p = await jobsWorkspace(page);
  const ids = Array.from({ length: 12 }, (_, i) => `m${String(i).padStart(2, '0')}`);
  for (const id of ids) p.set(id, { state: 'running', step: 'step', progress: { done: 1, total: 4 }, costUsd: 1.5 });
  await watchJobs(page, p.ws, p.name, ids);
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(12);
  const panel = (await page.locator('#panel').boundingBox())!;
  expect(Math.round(panel.height)).toBe(600);
  const panels = (await page.locator('#panels').boundingBox())!;
  expect(panels.height).toBeLessThanOrEqual(panel.height * 0.4 + 1);
  const body = jobsBlock(page).locator('.pn-body');
  expect(await body.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  await body.evaluate((e) => { e.scrollTop = e.scrollHeight; });
  const head = (await jobsBlock(page).locator('.pn-h').boundingBox())!;
  expect(head.y).toBeGreaterThanOrEqual(panel.y);
  expect(head.y + head.height).toBeLessThanOrEqual(panels.y + panels.height);
  expect(await jobRow(page, p.name, ids[11]).isVisible()).toBe(true);
  const log = (await page.locator('#log').boundingBox())!;
  expect(log.height).toBeGreaterThanOrEqual(160);
  await expect(page.locator('#dinput')).toBeInViewport();
});

test('an expanded panel with one row is as tall as its content, with no reserved blank space', async ({ page }) => {
  const p = await jobsWorkspace(page);
  p.set('h1', { state: 'running', step: 'step', progress: { done: 1, total: 4 }, costUsd: 1.5 });
  await watchJobs(page, p.ws, p.name, ['h1']);
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(1);
  const gap = await jobsBlock(page).locator('.pn-body').evaluate((b) => b.clientHeight - b.scrollHeight);
  expect(gap).toBe(0);
  const body = (await jobsBlock(page).locator('.pn-body').boundingBox())!;
  const row = (await jobsBlock(page).locator('li.jr').boundingBox())!;
  expect(body.height).toBeLessThan(row.height + 24); // list padding only, not two more rows
});

test('dragging the bottom edge sets the body height, it survives a reload, double-click resets', async ({ page }) => {
  const p = await jobsWorkspace(page);
  const ids = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'];
  for (const id of ids) p.set(id, { state: 'running', step: 'step', progress: { done: 1, total: 4 }, costUsd: 1 });
  await watchJobs(page, p.ws, p.name, ids);
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(6);
  const bodyH = async () => Math.round((await jobsBlock(page).locator('.pn-body').boundingBox())!.height);
  const auto = await bodyH();
  const drag = async (dy: number) => {
    const g = (await jobsBlock(page).locator('.pn-grip').boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down(); await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + dy, { steps: 5 }); await page.mouse.up();
  };
  await drag(-60);
  const set = await bodyH();
  expect(set).toBeLessThan(auto - 40);
  await page.reload();
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(6);
  expect(await bodyH()).toBe(set);
  await jobsBlock(page).locator('.pn-grip').dblclick();
  expect(await bodyH()).toBe(auto);
  await page.reload();
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(6);
  expect(await bodyH()).toBe(auto);
});

test('a dragged panel collapses to its header only, and the dragged height returns on expand and after a reload', async ({ page }) => {
  const p = await jobsWorkspace(page);
  const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
  for (const id of ids) p.set(id, { state: 'running', step: 'step', progress: { done: 1, total: 4 }, costUsd: 1 });
  await watchJobs(page, p.ws, p.name, ids);
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(6);
  const h = async (sel: string) => Math.round((await (sel ? jobsBlock(page).locator(sel) : jobsBlock(page)).boundingBox())!.height);
  const head = await h('.pn-h');
  const g = (await jobsBlock(page).locator('.pn-grip').boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down(); await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 - 60, { steps: 5 }); await page.mouse.up();
  const dragged = await h('.pn-body');
  const wrapOpen = await h('.pn-wrap');
  await jobsBlock(page).locator('.pn-tog').click();
  await expect(jobsBlock(page)).toHaveClass(/collapsed/);
  await expect.poll(() => h('.pn-wrap')).toBe(0); // waits out the fold transition
  expect(await h('.pn-wrap')).toBe(0);
  expect(Math.abs((await h('')) - head)).toBeLessThanOrEqual(1);
  await page.reload();
  await expect(jobsBlock(page)).toHaveClass(/collapsed/);
  expect(await h('.pn-wrap')).toBe(0);
  expect(Math.abs(await h('') - head)).toBeLessThanOrEqual(2);
  await jobsBlock(page).locator('.pn-tog').click();
  await expect(jobsBlock(page)).not.toHaveClass(/collapsed/);
  await expect.poll(() => h('.pn-body')).toBe(dragged);
  await expect.poll(() => h('.pn-wrap')).toBe(wrapOpen);
});

test('rows sort failed, waiting, running, done, newest change first; a quiet poll keeps the order; a failure moves to the top', async ({ page }) => {
  const p = await jobsWorkspace(page);
  p.set('s-done', { state: 'done' }); p.set('s-run1', { state: 'running' });
  await watchJobs(page, p.ws, p.name, ['s-done']);
  await watchJobs(page, p.ws, p.name, ['s-run1']);
  await sleep(1100);
  p.set('s-run2', { state: 'running' }); p.set('s-wait', { state: 'waiting' }); p.set('s-fail', { state: 'failed', error: 'x' });
  await watchJobs(page, p.ws, p.name, ['s-run2']);
  await watchJobs(page, p.ws, p.name, ['s-wait', 's-fail']);
  await expect(jobRow(page, p.name, 's-fail')).toHaveClass(/st-failed/);
  const expected = ['s-fail', 's-wait', 's-run2', 's-run1', 's-done'];
  await expect.poll(() => order(page)).toEqual(expected);
  await sleep(2500); // polls without a change
  expect(await order(page)).toEqual(expected);
  p.set('s-run1', { state: 'failed', error: 'late' });
  await expect.poll(() => order(page)).toEqual(['s-run1', 's-fail', 's-wait', 's-run2', 's-done']);
});

test('drag and drop reorders the rows per workspace; a failure keeps its place and is highlighted; Reset order restores the sort', async ({ page }) => {
  const p = await jobsWorkspace(page);
  const other = await jobsWorkspace(page);
  for (const [x, ids] of [[p, ['d-a', 'd-b', 'd-c']], [other, ['d-a', 'd-b', 'd-c']]] as const) {
    for (const id of ids) x.set(id, { state: 'running' });
  }
  // Same ids in both workspaces: the order of one must not leak to the other.
  await tabOf(page, p.wsName).click();
  await watchJobs(page, p.ws, p.name, ['d-a']); await watchJobs(page, p.ws, p.name, ['d-b']); await watchJobs(page, p.ws, p.name, ['d-c']);
  await tabOf(page, other.wsName).click();
  await watchJobs(page, other.ws, other.name, ['d-a']); await watchJobs(page, other.ws, other.name, ['d-b']); await watchJobs(page, other.ws, other.name, ['d-c']);
  const sorted = await order(page);
  expect(sorted).toHaveLength(3);
  await tabOf(page, p.wsName).click();
  await expect.poll(() => order(page)).toEqual(sorted);
  const reset = jobsBlock(page).getByRole('button', { name: 'Reset order' });
  await expect(reset).toHaveCount(0);

  // Drag the last row onto the top half of the first one.
  const first = jobRow(page, p.name, sorted[0]), last = jobRow(page, p.name, sorted[2]);
  await last.dragTo(first, { targetPosition: { x: 40, y: 2 } });
  const manual = [sorted[2], sorted[0], sorted[1]];
  await expect.poll(() => order(page)).toEqual(manual);
  await expect(reset).toBeVisible();
  await page.reload();
  await tabOf(page, p.wsName).click();
  await expect.poll(() => order(page)).toEqual(manual);
  await tabOf(page, other.wsName).click();
  await expect.poll(() => order(page)).toEqual(sorted); // the other workspace keeps its own
  await expect(jobsBlock(page).getByRole('button', { name: 'Reset order' })).toHaveCount(0);

  // A failing row under manual order stays where it is and is highlighted.
  await tabOf(page, p.wsName).click();
  p.set(manual[1], { state: 'failed', error: 'boom' });
  await expect(jobRow(page, p.name, manual[1])).toHaveClass(/st-failed/);
  await expect(jobRow(page, p.name, manual[1])).toHaveClass(/\bhot\b/);
  expect(await order(page)).toEqual(manual);
  await reset.click();
  await expect(reset).toHaveCount(0);
  await expect.poll(() => order(page)).toEqual([manual[1], ...sorted.filter((k) => k !== manual[1])]);
});

test('two-line rows with the cost on its own line at 440 px, one-line rows above 640 px', async ({ page }) => {
  const p = await jobsWorkspace(page);
  p.set('w1', { state: 'running', step: 'train', progress: { done: 3, total: 6 }, costUsd: 12.4, detail: 'epoch 3' });
  await watchJobs(page, p.ws, p.name, ['w1'], { w1: 'Wide run' });
  const li = jobRow(page, p.name, 'w1');
  await expect(li.locator('.cost')).toBeVisible();
  const top = async (sel: string) => (await li.locator(sel).first().boundingBox())!.y;
  expect((await page.locator('#panel').boundingBox())!.width).toBeCloseTo(440, 0);
  expect(await top('.cost')).toBeGreaterThan(await top('.id')); // narrow: cost wraps to its own line
  expect(await top('.lab')).toBeLessThan(await top('.id')); // label line above the detail line
  await page.evaluate(() => localStorage.setItem('jarvis.panel', JSON.stringify({ w: 760 })));
  await page.reload();
  await tabOf(page, p.wsName).click();
  await expect(li.locator('.cost')).toBeVisible();
  expect((await page.locator('#panel').boundingBox())!.width).toBeCloseTo(760, 0);
  expect(Math.abs((await top('.cost')) - (await top('.lab')))).toBeLessThan(6); // wide: one line
  expect((await li.boundingBox())!.height).toBeLessThan(30);
});

test('Open items shows a static marker per row: no checkbox, no buttons, only collapse and hide', async ({ page }) => {
  const notes = tmp('notes'), name = uniq('oi');
  const ws = await createWs(page, name, { notes });
  mkdirSync(join(notes, 'workspaces', ws), { recursive: true });
  writeFileSync(join(notes, 'workspaces', ws, 'open-items.md'), ['- [ ] 25-11-2026 (you) Decide this', '- [~] 24-11-2026 Park this (waiting on user)', '- [ ] 24-11-2026 Do that', '- [x] Old thing verified 25-11-2026: checked', ''].join('\n'));
  await page.goto('/');
  await tabOf(page, name).click(); // the tab may carry badges, so `open()` cannot match its exact name
  await page.waitForFunction('es.readyState === 1 && !replaying');
  const block = page.locator('#panels section.pn[data-kind="checklist"]');
  await expect(block.locator('li.ci')).toHaveCount(4);
  await expect(block.locator('.pn-sum')).toHaveText('3 open · 1 for you');
  await expect(block.locator('li.ci .mk')).toHaveText(['☐', '~', '☐', '✓']); // (you) first, then file order, done last
  await expect(block.locator('li.ci').first().locator('.you')).toHaveText('you');
  await expect(block.locator('input, li.ci button, .pn-btn')).toHaveCount(0);
  await expect(block.locator('li.ci.st-done .txt')).toHaveCSS('text-decoration-line', 'line-through');
});
