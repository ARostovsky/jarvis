import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ORIGIN } from '../playwright.config.ts';

const root = mkdtempSync(join(tmpdir(), 'jarvis-e2e-prefill-'));
const dir = (name: string) => { const d = join(root, name); mkdirSync(d); return d; };
const [withHistory, noHistory, notes] = ['with', 'without', 'notes'].map(dir);

test.afterAll(() => rmSync(root, { recursive: true, force: true }));

test('the New workspace dialog prefills the notes folder of the project, never over a typed value', async ({ page }) => {
  const r = await page.request.post('/workspaces', { headers: { origin: ORIGIN }, data: { name: 'prefill', project: withHistory, notes } });
  expect(r.ok()).toBe(true);
  await page.goto('/');
  await page.locator('#tabs button[title="New workspace"]').click();
  await expect(page.locator('#newws')).toBeVisible();

  await page.fill('#wsProject', noHistory);
  await expect(page.locator('#wsNotes')).toHaveValue('');

  await page.fill('#wsProject', withHistory);
  await expect(page.locator('#wsNotes')).toHaveValue(notes);
  await expect(page.locator('#notesHint')).toBeVisible();
  await page.locator('#wsName').focus();
  if (process.env.PREFILL_SHOT) await page.locator('#newws').screenshot({ path: process.env.PREFILL_SHOT });

  // A project without history clears the auto-prefill and its hint.
  await page.fill('#wsProject', noHistory);
  await expect(page.locator('#wsNotes')).toHaveValue('');
  await expect(page.locator('#notesHint')).toBeHidden();
  await page.fill('#wsProject', withHistory + '/');
  await expect(page.locator('#wsNotes')).toHaveValue(notes);

  // Switching projects keeps the prefill logic live; a hand-typed value then survives a re-pick.
  await page.fill('#wsProject', noHistory);
  await page.fill('#wsProject', withHistory);
  await page.fill('#wsNotes', '/typed/by/hand');
  await page.fill('#wsProject', withHistory + ' ');
  await page.fill('#wsProject', withHistory);
  await expect(page.locator('#wsNotes')).toHaveValue('/typed/by/hand');
  await expect(page.locator('#notesHint')).toBeHidden();
});

test('the themed dropdowns work from the keyboard and long paths stay readable', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tabs button[title="New workspace"]').click();
  const model = page.locator('#wsModelBtn');
  await expect(model).toHaveText('default (sonnet)');
  await model.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#wsModelBtn + ul')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(model).toHaveText('opus');
  await expect(page.locator('#wsModel')).toHaveValue('opus');
  await model.press('ArrowDown');
  await page.keyboard.press('Escape'); // closes the list only, not the dialog
  await expect(page.locator('#wsModelBtn + ul')).toBeHidden();
  await expect(page.locator('#newws')).toBeVisible();
  if (process.env.OPEN_SHOT) { await page.locator('#wsEffortBtn').click(); await page.screenshot({ path: process.env.OPEN_SHOT, clip: { x: 0, y: 0, width: 1280, height: 720 } }); await page.keyboard.press('Escape'); }

  const long = join(withHistory, 'a-very-long-folder-name-for-the-project', 'and-another-deep-level', 'final-segment');
  await page.fill('#wsProject', long);
  await page.locator('#wsName').focus();
  await expect(page.locator('.cb:has(#wsProject) .short')).toContainText('…/');
  await expect(page.locator('#wsProject')).toHaveAttribute('title', long);
  if (process.env.LONG_SHOT) await page.locator('#newws').screenshot({ path: process.env.LONG_SHOT });
});
