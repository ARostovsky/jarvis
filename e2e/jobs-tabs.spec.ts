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
