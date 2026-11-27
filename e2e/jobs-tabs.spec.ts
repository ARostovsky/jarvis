import { test, expect, fakeProvider, jobsWorkspace, jobsBlock, jobRow, jobRows, watchJobs, archivePolling } from './helpers.ts';

test.afterEach(({ page }) => archivePolling(page));

const tab = (page: any, name: string) => jobsBlock(page).getByRole('tab', { name: new RegExp(`^${name}`) });

test('two providers get one tab each, with their own rows, badges, highlight and a remembered tab', async ({ page }) => {
  const a = await jobsWorkspace(page);
  const b = fakeProvider();
  await b.approve(page);
  a.set('a1', { state: 'running' }); a.set('a2', { state: 'failed', error: 'boom' });
  b.set('b1', { state: 'running' }); b.set('b2', { state: 'running' });
  await watchJobs(page, a.ws, a.name, ['a1', 'a2']);
  await watchJobs(page, a.ws, b.name, ['b1', 'b2']);

  const tabs = jobsBlock(page).getByRole('tab');
  await expect(tabs).toHaveCount(2);
  const first = [a.name, b.name].sort()[0], second = first === a.name ? b.name : a.name;
  await expect(tabs.first()).toContainText(first);
  // the first tab is open: only its rows
  const own = (n: string) => (n === a.name ? ['a1', 'a2'] : ['b1', 'b2']);
  const other = (n: string) => own(n === a.name ? b.name : a.name);
  for (const id of own(first)) await expect(jobRow(page, first, id)).toBeVisible();
  for (const id of other(first)) await expect(jobRow(page, second, id)).toHaveCount(0);
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(2);
  await expect(tab(page, a.name).locator('.jt-f')).toHaveText('✕1');
  await expect(tab(page, a.name).locator('.jt-r')).toHaveText('▶1');
  await expect(tab(page, b.name).locator('.jt-f')).toHaveCount(0);
  await expect(tab(page, b.name).locator('.jt-r')).toHaveText('▶2');

  // open the other tab with the keyboard; its rows replace the first
  await tab(page, first).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, second)).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, second)).toBeFocused();
  for (const id of own(second)) await expect(jobRow(page, second, id)).toBeVisible();
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(2);

  // Home and End jump to the first and the last tab
  await page.keyboard.press('Home');
  await expect(tab(page, first)).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, first)).toBeFocused();
  await page.keyboard.press('End');
  await expect(tab(page, second)).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, second)).toBeFocused();
  await expect(jobsBlock(page).getByRole('tabpanel')).toHaveAttribute('aria-labelledby', (await tab(page, second).getAttribute('id'))!);

  // a change in the other provider lights its tab until it is opened
  const changer = first === a.name ? a : b;
  changer.set(own(first)[0], { state: 'done' });
  await expect(tab(page, first)).toHaveClass(/chg/);
  await expect(tab(page, second)).not.toHaveClass(/chg/);
  await tab(page, first).click();
  await expect(tab(page, first)).not.toHaveClass(/chg/);

  // the choice survives a reload
  await tab(page, second).click();
  await page.reload();
  await expect(tab(page, second)).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, first)).not.toHaveClass(/chg/); // no false highlight after a reload: the change was seen before
  await expect(tab(page, second)).not.toHaveClass(/chg/);
});

test('Clear done in one tab clears the finished rows of both tabs', async ({ page }) => {
  const a = await jobsWorkspace(page);
  const b = fakeProvider();
  await b.approve(page);
  a.set('a1', { state: 'done' }); a.set('a2', { state: 'running' });
  b.set('b1', { state: 'failed' }); b.set('b2', { state: 'running' });
  await watchJobs(page, a.ws, a.name, ['a1', 'a2']);
  await watchJobs(page, a.ws, b.name, ['b1', 'b2']);
  await expect(jobsBlock(page).getByRole('tab')).toHaveCount(2);
  await tab(page, a.name).click();
  await jobsBlock(page).getByRole('button', { name: 'Clear done' }).click();
  await expect.poll(async () => (await jobRows(page, a.ws)).map((r) => r.id).sort()).toEqual(['a2', 'b2']);
  await expect(jobsBlock(page).getByRole('tab')).toHaveCount(2);
  await expect(jobRow(page, a.name, 'a2')).toBeVisible();
  await tab(page, b.name).click();
  await expect(jobRow(page, b.name, 'b2')).toBeVisible();
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(1);
});

test('one provider shows no tab bar', async ({ page }) => {
  const p = await jobsWorkspace(page);
  p.set('s1', { state: 'running' });
  await watchJobs(page, p.ws, p.name, ['s1']);
  await expect(jobRow(page, p.name, 's1')).toBeVisible();
  await expect(jobsBlock(page).getByRole('tablist')).toHaveCount(0);
});

test('tabs reorder by drag and Alt+Arrow, the order survives a reload, a click still selects, a new provider goes last', async ({ page }) => {
  const a = await jobsWorkspace(page);
  const b = fakeProvider();
  await b.approve(page);
  a.set('a1', { state: 'running' }); b.set('b1', { state: 'running' });
  await watchJobs(page, a.ws, a.name, ['a1']);
  await watchJobs(page, a.ws, b.name, ['b1']);
  const tabs = jobsBlock(page).getByRole('tab');
  const order = async () => (await tabs.allTextContents()).map((t) => [a.name, b.name].find((n) => t.startsWith(n)));
  const first = [a.name, b.name].sort()[0], second = first === a.name ? b.name : a.name;
  expect(await order()).toEqual([first, second]);

  // a drag moves the tab but keeps the open one open
  await expect(tab(page, first)).toHaveAttribute('aria-selected', 'true');
  await tab(page, second).hover();
  await page.mouse.down();
  await tab(page, first).hover({ position: { x: 4, y: 5 } });
  await tab(page, first).hover({ position: { x: 6, y: 5 } }); // dragover needs a second move
  await expect(tab(page, first)).toHaveClass(/drop-before/);
  if (process.env.JT_SHOT) await page.screenshot({ path: process.env.JT_SHOT });
  await page.mouse.up();
  await expect.poll(order).toEqual([second, first]);
  await expect(tab(page, first)).toHaveAttribute('aria-selected', 'true');
  await expect(jobsBlock(page).locator('.drop-before, .drop-after')).toHaveCount(0);

  await page.reload();
  expect(await order()).toEqual([second, first]);

  // Alt+Arrow moves the focused tab, plain arrows still select; an edge does nothing
  await tab(page, second).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(order).toEqual([first, second]);
  await expect(tab(page, second)).toBeFocused();
  await expect(tab(page, first)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Alt+ArrowRight');
  expect(await order()).toEqual([first, second]);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(order).toEqual([second, first]);
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, first)).toHaveAttribute('aria-selected', 'true');

  // a click without movement selects
  await tab(page, second).click();
  await expect(tab(page, second)).toHaveAttribute('aria-selected', 'true');

  // a new provider goes last
  const c = fakeProvider();
  await c.approve(page);
  c.set('c1', { state: 'running' });
  await watchJobs(page, a.ws, c.name, ['c1']);
  await expect(tabs).toHaveCount(3);
  expect((await tabs.last().textContent())!.startsWith(c.name)).toBe(true);
  expect((await tabs.first().textContent())!.startsWith(second)).toBe(true);
});

test('right-click closes a tab, "+" brings it back, the last tab stays, the choice survives a reload, a hidden change dots the "+"', async ({ page }) => {
  const a = await jobsWorkspace(page);
  const b = fakeProvider();
  await b.approve(page);
  a.set('a1', { state: 'running' }); b.set('b1', { state: 'running' });
  await watchJobs(page, a.ws, a.name, ['a1']);
  await watchJobs(page, a.ws, b.name, ['b1']);
  const [first, second] = [a.name, b.name].sort();
  const changer = first === a.name ? a : b;
  const tabs = jobsBlock(page).getByRole('tab'), add = jobsBlock(page).getByRole('button', { name: /^Add provider tab/ }), menu = page.locator('#menu.open');
  await expect(tabs).toHaveCount(2);
  await expect(add).toBeVisible();

  // close the open (first) tab: the neighbour opens, the closed provider is still watched
  await tab(page, first).click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Close tab' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await tab(page, first).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Close tab' }).click();
  await expect(tabs).toHaveCount(1);
  await expect(tab(page, second)).toHaveAttribute('aria-selected', 'true');
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(1);
  expect((await jobRows(page, a.ws)).map((r) => r.id).sort()).toEqual(['a1', 'b1']);

  // the last open tab cannot be closed
  await tab(page, second).click({ button: 'right' });
  await expect(menu.getByRole('menuitem')).toBeDisabled();
  await page.keyboard.press('Escape');
  await tab(page, second).focus();
  await page.keyboard.press('Delete');
  await expect(tabs).toHaveCount(1);

  // the closed tab is listed in "+"; a change in it dots the "+" but does not reopen it
  await expect(add).not.toHaveClass(/chg/);
  changer.set(first === a.name ? 'a1' : 'b1', { state: 'failed', error: 'x' });
  await expect(add).toHaveClass(/chg/);
  await expect(tabs).toHaveCount(1);
  await page.reload();
  await expect(tabs).toHaveCount(1);
  await expect(add).toHaveClass(/chg/);
  await add.click();
  await expect(menu.getByRole('menuitem', { name: new RegExp(`^${first}`) })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: new RegExp(`^${second}`) })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: new RegExp(`^${first}`) }).click();
  await expect(tabs).toHaveCount(2);
  await expect(tab(page, first)).toHaveAttribute('aria-selected', 'true');
  await expect(add).not.toHaveClass(/chg/);

  // Delete closes the focused tab; an approved provider without jobs opens as an empty tab
  const c = fakeProvider();
  await c.approve(page);
  await page.reload();
  await tab(page, first).focus();
  await page.keyboard.press('Delete');
  await expect(tabs).toHaveCount(1);
  await expect(add).toBeVisible();
  await page.reload();
  await expect(tabs).toHaveCount(1);
  await add.click();
  await menu.getByRole('menuitem', { name: new RegExp(`^${c.name}`) }).click();
  await expect(tab(page, c.name)).toHaveAttribute('aria-selected', 'true');
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(0);
  await expect(jobsBlock(page).locator('.jt-empty')).toContainText(c.name);
});

test('the "+" is inactive with a hint while no provider is left to add, and wakes up when one is closed or appears', async ({ page }) => {
  const a = await jobsWorkspace(page);
  const b = fakeProvider(), c = fakeProvider();
  await b.approve(page); await c.approve(page);
  // the server is shared with parallel specs: show the page only the providers of this test
  let only = [a.name, b.name];
  await page.route(/\/providers$/, async (route) => {
    const res = await route.fetch(), j = await res.json();
    await route.fulfill({ response: res, json: { ...j, providers: j.providers.filter((p: any) => only.includes(p.name)) } });
  });
  a.set('a1', { state: 'running' }); b.set('b1', { state: 'running' });
  await watchJobs(page, a.ws, a.name, ['a1']);
  await watchJobs(page, a.ws, b.name, ['b1']);
  await page.reload();
  const tabs = jobsBlock(page).getByRole('tab'), add = jobsBlock(page).locator('.jt-add'), menu = page.locator('#menu.open');
  const tip = 'No other providers to add. Ask the agent to create one (status provider).';
  await expect(tabs).toHaveCount(2);
  await expect(add).toHaveAttribute('aria-disabled', 'true');
  await add.hover();
  await expect(page.locator('#tip')).toHaveText(tip);
  await expect(page.locator('#tip')).toBeVisible();
  await expect(add).toHaveAttribute('aria-label', new RegExp(tip.replace(/[().]/g, '\\$&')));
  await add.click({ force: true });
  await expect(menu).toHaveCount(0); // no empty menu
  await page.mouse.move(5, 300);
  await expect(page.locator('#tip')).toBeHidden();
  await expect(add).toBeVisible();

  // a provider shows up: the "+" turns active with the normal tip
  only = [a.name, b.name, c.name];
  await page.evaluate(() => (window as any).loadProviders());
  await expect(add).not.toHaveAttribute('aria-disabled', 'true');
  await expect(add).toHaveAttribute('title', 'Add provider tab');
  // closing a tab gives the "+" something to add; opening it again turns it inactive after the provider is gone
  only = [a.name, b.name];
  await page.evaluate(() => (window as any).loadProviders());
  await expect(add).toHaveAttribute('aria-disabled', 'true');
  await tabs.first().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Close tab' }).click();
  await expect(tabs).toHaveCount(1);
  await expect(add).not.toHaveAttribute('aria-disabled', 'true');
  await add.click();
  await menu.getByRole('menuitem').first().click();
  await expect(tabs).toHaveCount(2);
  await expect(add).toHaveAttribute('aria-disabled', 'true');
});

test('many tabs overflow without a scrollbar: the wheel scrolls the strip, the "+" stays in view, Shift+F10 and the context-menu key open the close menu', async ({ page }) => {
  const a = await jobsWorkspace(page);
  const ps = [a, ...Array.from({ length: 5 }, () => fakeProvider())];
  for (const p of ps.slice(1)) await p.approve(page);
  for (const [i, p] of ps.entries()) { p.set(`j${i}`, { state: 'running' }); await watchJobs(page, a.ws, p.name, [`j${i}`]); }
  await page.setViewportSize({ width: 560, height: 700 });
  const tabs = jobsBlock(page).getByRole('tab'), strip = jobsBlock(page).locator('.jt-tabs'), menu = page.locator('#menu.open');
  await expect(tabs).toHaveCount(6);
  const before = await strip.evaluate((e) => e.scrollLeft);
  await strip.hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => strip.evaluate((e) => e.scrollLeft)).toBeGreaterThan(before);
  await expect(jobsBlock(page).locator('.jt-add')).toBeInViewport();
  for (const key of ['ContextMenu', 'Shift+F10']) {
    await tabs.nth(1).focus();
    await page.keyboard.press(key);
    await expect(menu.getByRole('menuitem', { name: 'Close tab' })).toBeFocused();
    await page.keyboard.press('Escape'); // closes the menu only, not the agent panel
    await expect(menu).toHaveCount(0);
    await expect(jobsBlock(page)).toBeVisible();
  }
  await tabs.nth(1).focus();
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('Enter');
  await expect(tabs).toHaveCount(5);
});

test('closing a lit tab keeps the "+" dot, focus returns after a menu, the empty note sits in the tabpanel, stale or corrupt saved state is repaired', async ({ page }) => {
  const a = await jobsWorkspace(page);
  const b = fakeProvider(), c = fakeProvider();
  await b.approve(page); await c.approve(page);
  a.set('a1', { state: 'running' }); b.set('b1', { state: 'running' });
  await watchJobs(page, a.ws, a.name, ['a1']);
  await watchJobs(page, a.ws, b.name, ['b1']);
  const [first, second] = [a.name, b.name].sort();
  const lit = first === a.name ? b : a, litRow = first === a.name ? 'b1' : 'a1';
  const tabs = jobsBlock(page).getByRole('tab'), add = jobsBlock(page).locator('.jt-add'), menu = page.locator('#menu.open');
  await expect(tabs).toHaveCount(2);
  // the strip has no vertical overflow (it showed a tiny vertical scrollbar) and no visible scrollbar
  const strip = await jobsBlock(page).locator('.jt-tabs').evaluate((e) => ({ over: e.scrollHeight - e.clientHeight, y: getComputedStyle(e).overflowY, bar: (e as HTMLElement).offsetWidth - e.clientWidth }));
  expect(strip).toEqual({ over: 0, y: 'hidden', bar: 0 });

  // Esc on a menu hands the focus back to the tab it came from
  await tab(page, first).focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(tab(page, first)).toBeFocused();

  // the other tab lights up; closing it unseen keeps the dot on the "+"; the menu's close leaves the focus on the open tab
  lit.set(litRow, { state: 'failed', error: 'x' });
  await expect(tab(page, second)).toHaveClass(/chg/);
  await tab(page, second).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Close tab' }).click();
  await expect(tabs).toHaveCount(1);
  await expect(add).toHaveClass(/chg/);
  await expect(tab(page, first)).toBeFocused();
  await page.reload();
  await expect(add).toHaveClass(/chg/);

  // "+" restores it and focus lands on the restored tab
  await add.click();
  await menu.getByRole('menuitem', { name: new RegExp(`^${second}`) }).click();
  await expect(tab(page, second)).toBeFocused();

  // a provider without jobs: the note is inside the tabpanel
  await add.click();
  await menu.getByRole('menuitem', { name: new RegExp(`^${c.name}`) }).click();
  await expect(jobsBlock(page).getByRole('tabpanel').locator('.jt-empty')).toContainText(c.name);

  // saved state: a gone provider in `added` is dropped, wrong types do not break the panel
  await page.evaluate(([ws]) => {
    const k = `jarvis.panels.${ws}`, v = JSON.parse(localStorage.getItem(k) ?? '{}');
    v.jobs = { ...v.jobs, added: ['no-such-provider', ...(v.jobs?.added ?? [])], tabOrder: 'x', closedTabs: { a: 1 } };
    localStorage.setItem(k, JSON.stringify(v));
  }, [a.ws]);
  await page.reload();
  await expect(tabs.first()).toBeVisible();
  await expect.poll(() => page.evaluate(([ws]) => JSON.parse(localStorage.getItem(`jarvis.panels.${ws}`) ?? '{}').jobs, [a.ws])).toMatchObject({ added: expect.arrayContaining([c.name]), tabOrder: expect.any(Array), closedTabs: [] });
  expect((await page.evaluate(([ws]) => localStorage.getItem(`jarvis.panels.${ws}`), [a.ws]))).not.toContain('no-such-provider');
});
