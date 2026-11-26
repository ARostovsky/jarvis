import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, createWs, open, uniq, tmp, tab } from './helpers.ts';

test('archiving moves the notes folder, names the open items, and restore brings it back', async ({ page }) => {
  const notes = tmp('archnotes'), name = uniq('arn');
  const ws = await createWs(page, name, { notes });
  const dir = join(notes, 'workspaces', ws), archived = join(notes, 'workspaces', '_archive', ws);
  writeFileSync(join(dir, 'open-items.md'), '- [ ] 25-11-2026 first\n- [ ] 25-11-2026 second\n- [~] 25-11-2026 third (waiting on user)\n');
  await open(page, name);

  await tab(page, name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive workspace' }).click();
  await expect(page.locator('#choiceQuestion')).toContainText('2 open and 1 parked items stay in its notes folder');
  await page.locator('#choiceButtons button').filter({ hasText: /^ARCHIVE$/ }).click();
  await expect(tab(page, name)).toHaveCount(0);
  await expect(page.locator('#toastText')).toContainText(`archived; 2 open and 1 parked items stay in workspaces/_archive/${ws}/open-items.md`);
  expect(existsSync(dir)).toBe(false);
  expect(readFileSync(join(archived, 'open-items.md'), 'utf8')).toContain('second');
  expect(readFileSync(join(notes, 'workspaces', 'index.md'), 'utf8')).not.toContain(ws);

  await page.locator('#tabs button[title="Archived workspaces"]').click();
  await page.locator('#archivedList div').filter({ hasText: name }).getByRole('button', { name: 'RESTORE' }).click();
  await expect(tab(page, name)).toHaveClass('active');
  expect(readFileSync(join(dir, 'open-items.md'), 'utf8')).toContain('second');
  expect(existsSync(archived)).toBe(false);
});
