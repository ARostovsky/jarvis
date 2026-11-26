import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OPEN_LOG } from '../playwright.config.ts';
import { createWs, open, say, tmp, uniq } from './helpers.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('a path in a chat message is a link that serves the file; denied paths 404', async ({ page, request }) => {
  const dir = tmp('lf'), png = join(dir, 'x.png'), svg = join(dir, 'x.svg');
  writeFileSync(png, PNG);
  writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  symlinkSync(join(homedir(), '.ssh'), join(dir, 'ssh'));
  const name = uniq('lf');
  const id = await createWs(page, name);
  await open(page, name);
  await say(page, id, `say see ${png} and \`${svg}\` and https://e.io${png} and ${dir}/none.xyz`);
  // the user's own "say ..." line is linkified too: look at the arbiter reply (last)
  const a = page.locator(`#log a[href="/local-file?path=${encodeURIComponent(png)}"]`).last();
  await expect(a).toHaveText(png);
  await expect(a).toHaveAttribute('target', '_blank');
  await expect(page.locator('#log code a').last()).toHaveText(svg);
  await expect(page.locator('#log a[href*="e.io"][href*="local-file"], #log a[href*="none.xyz"]')).toHaveCount(0);
  const r = await request.get(`/local-file?path=${encodeURIComponent(png)}`);
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toBe('image/png');
  expect(r.headers()['x-content-type-options']).toBe('nosniff');
  expect((await request.get(`/local-file?path=${encodeURIComponent(svg)}`)).headers()['content-security-policy']).toBe('sandbox');
  for (const p of [`${dir}/../${dir.split('/').pop()}/x.png`, join(dir, 'ssh', 'a.txt'), join(homedir(), '.ssh', 'id_rsa.txt'), dir, '/etc/passwd.txt', 'x.png', '']) {
    expect((await request.get(`/local-file?path=${encodeURIComponent(p)}`)).status(), p).toBe(404);
  }
  // plain click: the system opener stub gets the path, no tab opens
  let popped = false;
  page.context().on('page', () => { popped = true; });
  await a.click();
  await expect.poll(() => (existsSync(OPEN_LOG) ? readFileSync(OPEN_LOG, 'utf8') : '')).toContain(`${png}\n`);
  await expect(page.locator('#note')).toHaveText('opened in system viewer');
  expect(popped).toBe(false);
  expect(page.context().pages()).toHaveLength(1);
  // ctrl-click keeps the href fallback: the browser opens a tab
  const [popup] = await Promise.all([page.context().waitForEvent('page'), a.click({ modifiers: ['Control'] })]);
  expect(popup.url()).toContain('/local-file?path=');
});

test('open endpoint: denied paths 404 without calling the opener', async ({ page, request }) => {
  const dir = tmp('lfo'), bad = join(dir, 'x.sh');
  writeFileSync(bad, 'echo');
  await page.goto('/');
  const open = (path: string) => page.evaluate(async (path) => (await fetch('/local-file/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })).status, path);
  expect(await open(bad)).toBe(404);
  expect(await open(dir)).toBe(404);
  expect((await request.get('/local-file/open')).status()).toBe(405);
  expect(existsSync(OPEN_LOG) ? readFileSync(OPEN_LOG, 'utf8') : '').not.toContain(dir);
});

test('relative paths in a chat message link when they resolve in the workspace repo, else stay text', async ({ page }) => {
  const repo = tmp('lfr');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'server.ts'), 'x');
  writeFileSync(join(repo, 'README.md'), 'x');
  const name = uniq('lfr');
  const id = await createWs(page, name, { project: repo });
  await open(page, name);
  await say(page, id, 'say see src/server.ts:12 and README.md and src/none.ts and ../x.md');
  const a = (p: string) => page.locator(`#log a[href="/local-file?path=${encodeURIComponent(join(realpathSync(repo), p))}"]`).last();
  await expect(a('src/server.ts')).toHaveText('src/server.ts:12');
  await expect(a('README.md')).toHaveText('README.md');
  await expect(page.locator('#log a[href*="none.ts"], #log a[href*="x.md"]')).toHaveCount(0);
  await expect(page.locator('#log span', { hasText: /^src\/none\.ts$/ }).last()).toBeVisible();
});
