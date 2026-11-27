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
  if (process.env.PREFILL_SHOT) await page.locator('#newws').screenshot({ path: process.env.PREFILL_SHOT });

  // Switching projects keeps the prefill logic live; a hand-typed value then survives a re-pick.
  await page.fill('#wsProject', noHistory);
  await page.fill('#wsProject', withHistory);
  await page.fill('#wsNotes', '/typed/by/hand');
  await page.fill('#wsProject', withHistory + ' ');
  await page.fill('#wsProject', withHistory);
  await expect(page.locator('#wsNotes')).toHaveValue('/typed/by/hand');
});
