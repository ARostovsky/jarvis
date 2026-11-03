import { test as base, expect, type Page } from '@playwright/test';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DATA_HOME } from '../playwright.config.ts';

export { expect, type Page };
export const DATA = join(DATA_HOME, 'jarvis');

// Every test fails on an uncaught page error or a console error.
export const test = base.extend<{ errors: string[] }>({
  errors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    // The browser logs every refused (4xx) request itself (and a host network change, which is not the app); the app shows it as a toast, which the tests check.
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d|ERR_NETWORK_CHANGED/.test(m.text())) errors.push(`console: ${m.text()}`); });
    await use(errors);
    expect(errors).toEqual([]);
  }, { auto: true }],
});

let n = 0;
export const uniq = (prefix: string) => `${prefix}${Date.now().toString(36)}${++n}`;
export const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `jarvis-e2e-${prefix}-`));

// Origin and content-type are required by the server on POST.
export const post = (page: Page, path: string, data: object) =>
  page.request.post(path, { headers: { origin: 'http://127.0.0.1:7798' }, data });

// Persisted events of a workspace, oldest first.
export const events = (ws: string): any[] => readFileSync(join(DATA, 'workspaces', ws, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Lines of a script for the fake SDK (e2e/fake-sdk.ts), sent to the arbiter.
export const say = (page: Page, ws: string, ...lines: string[]) => post(page, '/say', { ws, text: lines.join('\n') });

export async function createWs(page: Page, name: string, extra: object = {}): Promise<string> {
  const r = await post(page, '/workspaces', { name, ...extra });
  expect(r.ok()).toBe(true);
  return (await r.json()).id;
}

export const tab = (page: Page, name: string) => page.locator('#tabs button').filter({ hasText: new RegExp(`^${name}$`) });

// Opens the page on workspace `name` and waits until its tab is the active one.
export async function open(page: Page, name: string) {
  await page.goto('/');
  await tab(page, name).click();
  await expect(tab(page, name)).toHaveClass('active');
}

// The SDK is never started: a second selectable agent is written into an archived log, which restore replays.
export async function addFakeAgent(page: Page, ws: string, agentId: string) {
  expect((await post(page, '/workspaces/archive', { ws })).ok()).toBe(true);
  const agent = { id: agentId, name: agentId, task: '', cwd: tmp('agent'), status: 'idle', lastText: '', costUsd: 0, parentId: 'arbiter' };
  appendFileSync(join(DATA, 'archive', ws, 'events.jsonl'), JSON.stringify({ type: 'spawned', at: Date.now(), agent }) + '\n');
  expect((await post(page, '/workspaces/restore', { id: ws })).ok()).toBe(true);
}
