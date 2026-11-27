import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, createWs, open, tab, uniq, post, addFakeAgent, panelsOf, jobRows, jobsBlock, jobRow, watchJobs, jobsWorkspace, archivePolling, fakeJobSource, tmp, type Page } from './helpers.ts';

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

test('with 12 rows the stack is capped to leave the log 160 px, scrolls inside, keeps its header and leaves the log 160 px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 672 }); // the panel is 56 px from the top and 16 px from the bottom: 600 px
  const p = await jobsWorkspace(page);
  const ids = Array.from({ length: 12 }, (_, i) => `m${String(i).padStart(2, '0')}`);
  for (const id of ids) p.set(id, { state: 'running', step: 'step', progress: { done: 1, total: 4 }, costUsd: 1.5 });
  await watchJobs(page, p.ws, p.name, ids);
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(12);
  const panel = (await page.locator('#panel').boundingBox())!;
  expect(Math.round(panel.height)).toBe(600);
  const panels = (await page.locator('#panels').boundingBox())!;
  expect(panels.height).toBeLessThanOrEqual(panel.height - 380 + 1);
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
  expect(Math.abs((await bodyH()) - set)).toBeLessThanOrEqual(10); // a reload re-fits all panels together: a few px of rounding between them
  await jobsBlock(page).locator('.pn-grip').dblclick();
  expect(await bodyH()).toBe(auto);
  await page.reload();
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(6);
  expect(await bodyH()).toBe(auto);
});

test('dragging the name column edge sets its width for all rows, it survives a reload, double-click resets', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  const p = await jobsWorkspace(page);
  const ids = ['n1', 'n2', 'n3'];
  for (const id of ids) p.set(id, { state: 'running', step: 'step', progress: { done: 1, total: 4 } });
  await watchJobs(page, p.ws, p.name, ids);
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(3);
  const pg = (await page.locator('#pgrip').boundingBox())!; // widen the panel into the one-line layout
  await page.mouse.move(pg.x + pg.width / 2, pg.y + 100);
  await page.mouse.down(); await page.mouse.move(pg.x - 800, pg.y + 100, { steps: 5 }); await page.mouse.up();
  const widths = () => jobsBlock(page).locator('.jr .lab').evaluateAll((l) => l.map((e) => Math.round(e.getBoundingClientRect().width)));
  await expect(jobsBlock(page).locator('.pn-cr').first()).toBeVisible();
  const auto = (await widths())[0];
  expect(auto).toBeGreaterThan(150);
  const drag = async (dx: number) => {
    const g = (await jobsBlock(page).locator('.pn-cr').first().boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down(); await page.mouse.move(g.x + g.width / 2 + dx, g.y + g.height / 2, { steps: 5 }); await page.mouse.up();
  };
  await drag(-100);
  const set = await widths();
  expect(set.every((w) => Math.abs(w - (auto - 100)) <= 1)).toBe(true);
  await page.reload();
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(3);
  expect(await widths()).toEqual(set);
  await jobsBlock(page).locator('.pn-cr').first().dblclick();
  expect((await widths()).every((w) => w === auto)).toBe(true);
});

test('dragging the step column edge widens it, the width is kept when switching workspace and back', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  const p = await jobsWorkspace(page);
  const otherName = uniq('other');
  await createWs(page, otherName);
  const ids = ['s1', 's2'];
  for (const id of ids) p.set(id, { state: 'running', step: 'collect_coverage', progress: { done: 1, total: 4 } });
  await watchJobs(page, p.ws, p.name, ids);
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(2);
  const pg = (await page.locator('#pgrip').boundingBox())!;
  await page.mouse.move(pg.x + pg.width / 2, pg.y + 100);
  await page.mouse.down(); await page.mouse.move(pg.x - 800, pg.y + 100, { steps: 5 }); await page.mouse.up();
  const widths = () => jobsBlock(page).locator('.jr .step').evaluateAll((l) => l.map((e) => Math.round(e.getBoundingClientRect().width)));
  await expect(jobsBlock(page).locator('.pn-cr').nth(3)).toBeVisible();
  const auto = (await widths())[0];
  const g = (await jobsBlock(page).locator('.pn-cr').nth(3).boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down(); await page.mouse.move(g.x + g.width / 2 + 60, g.y + g.height / 2, { steps: 5 }); await page.mouse.up();
  const set = await widths();
  expect(set.every((w) => Math.abs(w - (auto + 60)) <= 1)).toBe(true);
  await tabOf(page, otherName).click();
  await tabOf(page, p.wsName).click();
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(2);
  expect(await widths()).toEqual(set);
  expect((await uiState(page, p.ws))['jobs'].cols.step).toBe(set[0]);
});

test('every column starts at the same x in all rows, whatever the text lengths', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  const p = await jobsWorkspace(page);
  const rows: [string, object][] = [
    ['idx22-claim-3', { step: 'collect_coverage_22', detail: 'running', progress: { done: 1, total: 8 } }],
    ['idx36', { step: 'generate_tests_36', detail: 'succeeded soon', progress: { done: 4, total: 8 } }],
    ['i51', { step: 'x', detail: 'running' }],
    ['idx42-claim-1-long', { step: 'generate_task_42', detail: 'running', progress: { done: 5, total: 8 } }],
  ];
  for (const [id, f] of rows) p.set(id, { state: 'running', startedAt: new Date(Date.now() - 3600_000).toISOString(), ...f });
  await watchJobs(page, p.ws, p.name, rows.map(([id]) => id));
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(4);
  const pg = (await page.locator('#pgrip').boundingBox())!;
  await page.mouse.move(pg.x + pg.width / 2, pg.y + 100);
  await page.mouse.down(); await page.mouse.move(pg.x - 800, pg.y + 100, { steps: 5 }); await page.mouse.up();
  await expect(jobsBlock(page).locator('.pn-cr').first()).toBeVisible();
  const xs = (sel: string) => jobsBlock(page).locator(`li.jr ${sel}`).evaluateAll((l) => l.map((e) => Math.round(e.getBoundingClientRect().x)));
  for (const sel of ['.lab', '.step', '.det']) {
    const v = await xs(sel);
    expect(v).toHaveLength(4);
    expect(new Set(v).size, sel).toBe(1);
  }
  expect(new Set(await xs('.prog')).size).toBe(1); // rows without a bar have none, the rest line up
  const r = await jobsBlock(page).locator('li.jr .dur').evaluateAll((l) => l.map((e) => Math.round(e.getBoundingClientRect().right)));
  expect(new Set(r).size).toBe(1); // elapsed times end on the same x
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
  const top = async (sel: string) => { let y = NaN; await expect.poll(async () => (y = (await li.locator(sel).first().boundingBox())?.y ?? NaN), { message: `${sel} has a box` }).not.toBeNaN(); return y; }; // a poll re-renders the row: retry while it is detached
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

test('the reorder handle spans the same height as the row stripe and is a wide hit area', async ({ page }) => {
  const p = await jobsWorkspace(page);
  p.set('g-a', { state: 'running' });
  await watchJobs(page, p.ws, p.name, ['g-a']);
  const row = jobRow(page, p.name, 'g-a');
  await expect(row).toBeVisible();
  const m = await row.evaluate((el) => {
    const g = el.querySelector('.dgrip')!.getBoundingClientRect(), r = el.getBoundingClientRect();
    const s = getComputedStyle(el, '::before'); // stripe: top/bottom 2px inside the row
    return { gTop: g.top - r.top, gBottom: r.bottom - g.bottom, w: g.width, sTop: parseFloat(s.top), sBottom: parseFloat(s.bottom) };
  });
  expect(m.gTop).toBeCloseTo(m.sTop, 0);
  expect(m.gBottom).toBeCloseTo(m.sBottom, 0);
  expect(m.w).toBeGreaterThanOrEqual(18);
});

test('two open panels never overlap and every row stays inside its panel, also with a tall dragged body', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const notes = tmp('notes');
  const p = await jobsWorkspace(page, {}, { notes });
  mkdirSync(join(notes, 'workspaces', p.ws), { recursive: true });
  writeFileSync(join(notes, 'workspaces', p.ws, 'open-items.md'), ['- [ ] 25-11-2026 First item', '- [ ] 25-11-2026 Second item', '- [ ] 25-11-2026 Third item', ''].join('\n'));
  const ids = ['o1', 'o2', 'o3', 'o4', 'o5'];
  for (const id of ids) p.set(id, { state: 'running', step: 'step', progress: { done: 1, total: 4 }, costUsd: 1 });
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ jobs: { h: 500 } })), `jarvis.panels.${p.ws}`); // a body height dragged taller than the cap allows
  await page.reload();
  await open(page, p.wsName);
  await watchJobs(page, p.ws, p.name, ids);
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(5);
  const items = page.locator('#panels section.pn[data-kind="checklist"]');
  await expect(items.locator('li.ci')).toHaveCount(3);
  const inside = async () => {
    const a = (await jobsBlock(page).boundingBox())!, b = (await items.boundingBox())!;
    expect(a.y + a.height).toBeLessThanOrEqual(b.y + 1); // the lower panel starts below the upper one
    for (const [blk, sel] of [[jobsBlock(page), 'li.jr'], [items, 'li.ci']] as const) {
      const box = (await blk.boundingBox())!;
      const body = (await blk.locator('.pn-body').boundingBox())!;
      expect(body.y + body.height).toBeLessThanOrEqual(box.y + box.height + 1); // the scroll area ends inside its panel
      // a row whose centre shows in the body paints on top there: the element at that point belongs to its own panel
      const stray = await blk.evaluate((el, q) => [...el.querySelectorAll(q)].filter((r) => {
        const b = r.getBoundingClientRect(), c = el.querySelector('.pn-body')!.getBoundingClientRect(), y = b.y + b.height / 2;
        const st = document.getElementById('panels')!.getBoundingClientRect();
        return y > Math.max(c.y, st.y) && y < Math.min(c.y + c.height, st.y + st.height) && !el.contains(document.elementFromPoint(b.x + 40, y));
      }).length, sel);
      expect(stray).toBe(0);
    }
  };
  await expect(jobRow(page, p.name, 'o5')).toHaveClass(/st-running/);
  await inside();
  await jobsBlock(page).locator('.pn-tog').click(); await jobsBlock(page).locator('.pn-tog').click();
  await expect(jobsBlock(page)).not.toHaveClass(/collapsed/);
  const bodyH = () => jobsBlock(page).locator('.pn-body').evaluate((e) => e.getBoundingClientRect().height);
  let last = -1;
  await expect.poll(async () => { const h = await bodyH(), same = h === last; last = h; return same; }).toBe(true);
  await inside();
});

test('a panel can be dragged far past the old 40% limit, neighbours shrink but stay visible, the stack never scrolls, panels never overlap, the height survives reload and workspace switch', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const notes = tmp('notes');
  const p = await jobsWorkspace(page, {}, { notes });
  const otherName = uniq('other');
  await createWs(page, otherName);
  mkdirSync(join(notes, 'workspaces', p.ws), { recursive: true });
  writeFileSync(join(notes, 'workspaces', p.ws, 'open-items.md'), ['- [ ] 25-11-2026 First item', '- [ ] 25-11-2026 Second item', ''].join('\n'));
  const ids = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
  for (const id of ids) p.set(id, { state: 'running', step: 'step', progress: { done: 1, total: 4 }, costUsd: 1 });
  await watchJobs(page, p.ws, p.name, ids);
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(6);
  const items = page.locator('#panels section.pn[data-kind="checklist"]');
  await expect(items.locator('li.ci')).toHaveCount(2);
  const bodyH = async () => Math.round((await jobsBlock(page).locator('.pn-body').boundingBox())!.height);
  const stackH = async () => (await page.locator('#panels').boundingBox())!.height;
  const noOverlap = async () => {
    const a = (await jobsBlock(page).boundingBox())!, b = (await items.boundingBox())!;
    expect(a.y + a.height).toBeLessThanOrEqual(b.y + 1);
    const body = (await jobsBlock(page).locator('.pn-body').boundingBox())!;
    expect(body.y + body.height).toBeLessThanOrEqual(a.y + a.height + 1);
  };
  const g = (await jobsBlock(page).locator('.pn-grip').boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down(); await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + 700, { steps: 8 }); await page.mouse.up();
  const set = await bodyH();
  expect(set).toBeGreaterThan(1000 * 0.4); // the old limit
  await noOverlap();
  const panel = (await page.locator('#panel').boundingBox())!;
  expect(await stackH()).toBeLessThanOrEqual(panel.height - 380 + 1); // the log keeps its room
  expect(await page.locator('#panels').evaluate((e) => e.scrollHeight <= e.clientHeight)).toBe(true); // nothing hides in an outer scroll
  const nb = (await items.boundingBox())!, sb = (await page.locator('#panels').boundingBox())!;
  expect(nb.height).toBeGreaterThanOrEqual(72); expect(nb.y + nb.height).toBeLessThanOrEqual(sb.y + sb.height + 1); // the neighbour shrank to its minimum but is whole and reachable
  await expect(items.locator('li.ci').first()).toBeInViewport();
  expect((await page.locator('#log').boundingBox())!.height).toBeGreaterThanOrEqual(160);
  await page.reload();
  await open(page, p.wsName);
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(6);
  expect(Math.abs((await bodyH()) - set)).toBeLessThanOrEqual(10); // a reload re-fits all panels together: a few px of rounding between them
  await noOverlap();
  await tabOf(page, otherName).click();
  await tabOf(page, p.wsName).click();
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(6);
  expect(Math.abs((await bodyH()) - set)).toBeLessThanOrEqual(10); // a reload re-fits all panels together: a few px of rounding between them
  await noOverlap();
  await jobsBlock(page).locator('.pn-tog').click(); // a folded sized panel is still its header only
  await expect(jobsBlock(page)).toHaveClass(/collapsed/);
  await expect.poll(async () => (await jobsBlock(page).boundingBox())!.height).toBeLessThan(40);
});

test('each panel scrolls its own rows with the wheel: the other panel and the stack stay put, the header stays in view', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const notes = tmp('notes');
  const p = await jobsWorkspace(page, {}, { notes });
  mkdirSync(join(notes, 'workspaces', p.ws), { recursive: true });
  writeFileSync(join(notes, 'workspaces', p.ws, 'open-items.md'), Array.from({ length: 12 }, (_, i) => `- [ ] 25-11-2026 Item number ${i}`).join('\n') + '\n');
  const ids = Array.from({ length: 12 }, (_, i) => `w${String(i).padStart(2, '0')}`);
  for (const id of ids) p.set(id, { state: 'running', step: 'step', progress: { done: 1, total: 4 }, costUsd: 1 });
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ jobs: { h: 120 }, 'open-items': { h: 120 } })), `jarvis.panels.${p.ws}`);
  await page.reload();
  await open(page, p.wsName);
  await watchJobs(page, p.ws, p.name, ids);
  const items = page.locator('#panels section.pn[data-kind="checklist"]');
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(12);
  await expect(items.locator('li.ci')).toHaveCount(12);
  const top = (loc: ReturnType<Page['locator']>) => loc.evaluate((e) => e.scrollTop);
  const a = jobsBlock(page).locator('.pn-body'), b = items.locator('.pn-body'), stack = page.locator('#panels');
  expect(await a.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  expect(await b.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  const log = page.locator('#log'), logTop = await log.evaluate((e) => e.scrollTop);
  const box = (await a.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 150);
  await expect.poll(() => top(a)).toBeGreaterThan(0);
  expect(await top(b)).toBe(0);
  expect(await log.evaluate((e) => e.scrollTop)).toBe(logTop);
  const head = (await jobsBlock(page).locator('.pn-h').boundingBox())!, panel = (await jobsBlock(page).boundingBox())!;
  expect(head.y).toBeGreaterThanOrEqual(panel.y - 1);
  await expect(jobsBlock(page).locator('.pn-h')).toBeInViewport();
  const boxB = (await b.boundingBox())!;
  await page.mouse.move(boxB.x + boxB.width / 2, boxB.y + boxB.height / 2);
  await page.mouse.wheel(0, 150);
  await expect.poll(() => top(b)).toBeGreaterThan(0);
  expect(await log.evaluate((e) => e.scrollTop)).toBe(logTop);
});

test('in a short window every open panel keeps its header inside the stack, panels squeeze to the header', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 500 });
  const notes = tmp('notes');
  const p = await jobsWorkspace(page, {}, { notes });
  mkdirSync(join(notes, 'workspaces', p.ws), { recursive: true });
  writeFileSync(join(notes, 'workspaces', p.ws, 'open-items.md'), Array.from({ length: 12 }, (_, i) => `- [ ] 25-11-2026 Item number ${i}`).join('\n') + '\n');
  const ids = Array.from({ length: 12 }, (_, i) => `s${String(i).padStart(2, '0')}`);
  for (const id of ids) p.set(id, { state: 'running', step: 'step', progress: { done: 1, total: 4 }, costUsd: 1 });
  await watchJobs(page, p.ws, p.name, ids);
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(12);
  await expect(page.locator('#panels section.pn[data-kind="checklist"] li.ci')).toHaveCount(12);
  // Only two real panels exist: clone the open-items one to get 5 open, and measure in the same tick so a re-render cannot interfere.
  const bad = await page.evaluate(() => {
    const stack = document.getElementById('panels')!, src = stack.querySelector('section.pn[data-kind="checklist"]')!;
    for (let i = 0; i < 3; i++) stack.append(src.cloneNode(true));
    const s = stack.getBoundingClientRect();
    const open = [...stack.querySelectorAll('section.pn:not(.collapsed)')];
    const out = open.map((e) => e.querySelector('.pn-h')!.getBoundingClientRect()).filter((r) => r.top < s.top - 0.5 || r.bottom > s.bottom + 0.5 || r.height < 20).length;
    return { open: open.length, out };
  });
  expect(bad.open).toBe(5);
  expect(bad.out).toBe(0);
});

test('the fold icon is one axis-aligned triangle: same size and centre x in both states, centred on the title', async ({ page }) => {
  const a = await jobsWorkspace(page);
  a.set('c1', { state: 'running' });
  await watchJobs(page, a.ws, a.name, ['c1']);
  const block = jobsBlock(page), chev = block.locator('.chev');
  await expect(block).not.toHaveClass(/collapsed/);
  const measure = async () => {
    const c = (await chev.boundingBox())!, t = (await block.locator('.pn-title').boundingBox())!;
    return { w: c.width, h: c.height, cx: c.x + c.width / 2, dy: Math.abs(c.y + c.height / 2 - (t.y + t.height / 2)) };
  };
  const rot = () => chev.evaluate((e) => getComputedStyle(e).transform);
  await expect.poll(rot).toBe('matrix(1, 0, 0, 1, 0, 0)'); // down, no leftover angle
  const open = await measure();
  await block.locator('.pn-tog').click();
  await expect(block).toHaveClass(/collapsed/);
  await expect.poll(rot).toBe('matrix(0, -1, 1, 0, 0, 0)'); // rotate(-90deg): right
  const shut = await measure();
  expect(open.w).toBeCloseTo(10, 0);
  expect(shut.w).toBeCloseTo(open.w, 1); expect(shut.h).toBeCloseTo(open.h, 1);
  expect(shut.cx).toBeCloseTo(open.cx, 1);
  expect(open.dy).toBeLessThanOrEqual(2); expect(shut.dy).toBeLessThanOrEqual(2);
});
