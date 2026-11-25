import { test as base, expect, type Page } from '@playwright/test';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DATA_HOME, ORIGIN, PROVIDERS_DIR } from '../playwright.config.ts';

export { expect, ORIGIN, type Page };
export const DATA = join(DATA_HOME, 'jarvis');

// Every test fails on an uncaught page error or a console error.
export const test = base.extend<{ errors: string[]; cutStream: boolean }>({
  // A spec that stops its server on purpose while the page is open (resume.spec) sets `test.use({ cutStream: true })`: the browser then logs the cut event stream.
  cutStream: [false, { option: true }],
  errors: [async ({ page, cutStream }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    // The browser logs every refused (4xx) request itself (and a host network change, which is not the app); the app shows it as a toast, which the tests check.
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d|ERR_NETWORK_CHANGED/.test(m.text()) && !(cutStream && /ERR_INCOMPLETE_CHUNKED_ENCODING/.test(m.text()))) errors.push(`console: ${m.text()}`); });
    await use(errors);
    expect(errors).toEqual([]);
  }, { auto: true }],
});

let n = 0;
export const uniq = (prefix: string) => `${prefix}${Date.now().toString(36)}${++n}`;
export const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `jarvis-e2e-${prefix}-`));

// Origin and content-type are required by the server on POST.
export const post = (page: Page, path: string, data: object) =>
  page.request.post(path, { headers: { origin: ORIGIN }, data });

// Persisted events of a workspace, oldest first.
export const events = (ws: string): any[] => readFileSync(join(DATA, 'workspaces', ws, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Lines of a script for the fake SDK (e2e/fake-sdk.ts), sent to the arbiter.
export const say = (page: Page, ws: string, ...lines: string[]) => post(page, '/say', { ws, text: lines.join('\n') });

export async function createWs(page: Page, name: string, extra: object = {}): Promise<string> {
  const r = await post(page, '/workspaces', { name, ...extra });
  expect(r.ok()).toBe(true);
  return (await r.json()).id;
}

// A tab may also carry badges after its name (jobs, unread mail).
export const tab = (page: Page, name: string) => page.locator('#tabs button').filter({ hasText: new RegExp(`^${name}(?!\\w)`) });

// Opens the page on workspace `name` and waits until its tab is the active one and its event log is replayed.
export async function open(page: Page, name: string) {
  await page.goto('/');
  await tab(page, name).click();
  await expect(tab(page, name)).toHaveClass('active');
  // A stream that opens late clears and rebuilds the agent nodes; acting on a node before that loses the click or key press.
  await page.waitForFunction('es.readyState === 1 && !replaying');
}

// The SDK is never started: a second selectable agent is written into an archived log, which restore replays.
export async function addFakeAgent(page: Page, ws: string, agentId: string) {
  expect((await post(page, '/workspaces/archive', { ws })).ok()).toBe(true);
  const agent = { id: agentId, name: agentId, task: '', cwd: tmp('agent'), status: 'idle', lastText: '', costUsd: 0, parentId: 'arbiter' };
  appendFileSync(join(DATA, 'archive', ws, 'events.jsonl'), JSON.stringify({ type: 'spawned', at: Date.now(), agent }) + '\n');
  expect((await post(page, '/workspaces/restore', { id: ws })).ok()).toBe(true);
}

// A copy of e2e/fake-provider under a unique name, placed in the providers folder. `manifest` overrides fields of manifest.json (e.g. slow_fields, notify).
// Not approved yet: `approve()` does what the Approve button does. `set(id, row)` is the state of a job: the provider prints the row in <jobs dir>/<id>.json.
export function fakeProvider(manifest: object = {}, into = PROVIDERS_DIR) {
  const name = uniq('fp'), dir = join(into, name), jobs = tmp('jobs');
  cpSync(join(import.meta.dirname, 'fake-provider'), dir, { recursive: true });
  const base = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...base, name, env: { set: { FAKE_JOBS_DIR: jobs } }, ...manifest }));
  const set = (id: string, row: object) => writeFileSync(join(jobs, `${id}.json`), JSON.stringify(row));
  const info = async (page: Page) => (await (await page.request.get('/providers')).json()).providers.find((p: any) => p.name === name);
  const approve = async (page: Page) => {
    const p = await info(page);
    expect(p?.status, p?.error).toBe('not-approved');
    expect((await post(page, '/providers/approve', { name, hash: p.hash })).ok()).toBe(true);
  };
  return { name, dir, jobs, set, info, approve };
}

// Rows of the jobs panel as the server holds them.
export const panelsOf = async (page: Page, ws: string): Promise<any[]> => (await page.request.get(`/panels?ws=${ws}`)).json();
export const jobRows = async (page: Page, ws: string): Promise<any[]> => (await panelsOf(page, ws)).find((p) => p.panelId === 'jobs')?.data.rows ?? [];

// Tool call through the fake SDK; resolves with the text of the tool result (the arbiter says it with `result`).
export async function callTool(page: Page, ws: string, name: string, input: object) {
  const before = events(ws).filter((e) => e.type === 'result').length;
  await say(page, ws, `tool mcp__jarvis__${name} ${JSON.stringify(input)}`, 'result');
  await expect.poll(() => events(ws).filter((e) => e.type === 'result').length).toBeGreaterThan(before);
  return events(ws).filter((e) => e.type === 'result').at(-1).text as string;
}

// Selectors of the jobs panel and its rows (a row's key is `<provider>:<id>`).
export const jobsBlock = (page: Page) => page.locator('#panels section.pn[data-panel="jobs"]');
export const jobRow = (page: Page, provider: string, id: string) => jobsBlock(page).locator(`li.jr[data-key="${provider}:${id}"]`);
export const watchJobs = (page: Page, ws: string, provider: string, ids: string[], labels: object = {}) => callTool(page, ws, 'watch_jobs', { provider, ids, labels });

// Workspaces with watched jobs keep polling and their badges keep changing, which would shift the tabs of later specs on the same server: archive them after each test.
const polling: string[] = [];
export const archivePolling = async (page: Page) => { for (const ws of polling.splice(0)) await post(page, '/workspaces/archive', { ws }); };

// A workspace with an approved fake provider, opened on the arbiter.
export async function jobsWorkspace(page: Page, manifest: object = {}, extra: object = {}) {
  const p = fakeProvider(manifest);
  await p.approve(page);
  const name = uniq('jobs');
  const ws = await createWs(page, name, extra);
  polling.push(ws);
  await open(page, name);
  return { ...p, ws, wsName: name };
}
