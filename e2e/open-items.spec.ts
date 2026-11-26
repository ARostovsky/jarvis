import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PORT as MAIN_PORT } from '../playwright.config.ts';
import { test, expect, createWs, open, post, say, uniq, tmp, events, jobsWorkspace, watchJobs, jobsBlock, archivePolling, panelsOf, type Page } from './helpers.ts';

test.afterEach(({ page }) => archivePolling(page));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const d = new Date(), pad = (n: number) => String(n).padStart(2, '0');
const TODAY = `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
const line = (text: string, o: { you?: boolean; kind?: ' ' | '~' } = {}) => `- [${o.kind ?? ' '}] 01-02-2026 ${o.you ? '(you) ' : ''}${text}`;
const done = (text: string) => `- [x] ${text} verified 02-02-2026: ran npm test`;

const block = (page: Page) => page.locator('#panels section.pn[data-panel="open-items"]');
const rows = (page: Page) => block(page).locator('li.ci');
const rowOf = (page: Page, text: string) => rows(page).filter({ hasText: text });
const texts = (page: Page) => rows(page).locator('.txt').allTextContents();
const results = (ws: string) => events(ws).filter((e) => e.type === 'result' && e.agentId === 'arbiter').length;
const routed = (ws: string) => events(ws).filter((e) => e.type === 'routed').length;

// A workspace with its own notes folder whose open-items.md holds `lines`, opened on the arbiter.
async function itemsWorkspace(page: Page, lines: string[], opts: { open?: boolean } = {}) {
  const notes = tmp('oinotes'), name = uniq('oi');
  const ws = await createWs(page, name, { notes });
  const file = join(notes, 'workspaces', ws, 'open-items.md');
  writeFileSync(file, lines.join('\n') + '\n');
  if (opts.open !== false) await open(page, name);
  return { ws, name, notes, file };
}
const fileText = (file: string) => readFileSync(file, 'utf8');

test('gating: the prompt names the panel and the (you) rule; no open_items tool anywhere', async ({ page }) => {
  const w = await itemsWorkspace(page, [line('x')], { open: false });
  const ask = async (opt: string) => {
    const before = results(w.ws);
    await say(page, w.ws, `option ${opt}`);
    await expect.poll(() => results(w.ws)).toBeGreaterThan(before);
    return events(w.ws).filter((e) => e.type === 'result').at(-1).text as string;
  };
  const prompt = JSON.parse((await ask('systemPrompt')).slice('systemPrompt='.length)).append as string;
  expect(prompt).toContain('Open items');
  expect(prompt).toContain('(you)');
  expect(await ask('allowedTools')).not.toContain('open_items');
  // No notes folder: no panel text.
  const bare = await createWs(page, uniq('oibare'));
  const before = results(bare);
  await say(page, bare, 'option systemPrompt');
  await expect.poll(() => results(bare)).toBeGreaterThan(before);
  expect(events(bare).filter((e) => e.type === 'result').at(-1).text).not.toContain('Open items');
});

test('read and show: four items, header, one you badge sorted first, GET /panels', async ({ page }) => {
  const w = await itemsWorkspace(page, [line('first plain'), line('second plain'), line('third plain'), line('only the user can do this', { you: true })]);
  await expect(block(page)).toBeVisible();
  await expect(block(page).locator('.pn-title')).toHaveText('Open items');
  await expect(block(page).locator('.pn-sum')).toHaveText('4 open · 1 for you');
  await expect(rows(page)).toHaveCount(4);
  await expect(block(page).locator('.you')).toHaveCount(1);
  expect(await texts(page)).toEqual(['only the user can do this', 'first plain', 'second plain', 'third plain']);
  await expect(rows(page).first().locator('.you')).toHaveText('you');
  const panel = (await panelsOf(page, w.ws)).find((p) => p.panelId === 'open-items');
  expect(panel.kind).toBe('checklist');
  expect(panel.data.items.map((i: any) => i.text)).toEqual(await texts(page));
});

test('the file is the source: the arbiter and hand edits update the panel with no model turn', async ({ page }) => {
  const w = await itemsWorkspace(page, [line('alpha'), line('beta')]);
  await expect(rows(page)).toHaveCount(2);
  const r = results(w.ws), n = routed(w.ws);
  appendFileSync(w.file, line('gamma by hand') + '\n');
  await expect(rowOf(page, 'gamma by hand')).toBeVisible({ timeout: 3000 });
  writeFileSync(w.file, [line('alpha'), done('beta'), line('gamma by hand')].join('\n') + '\n'); // beta ticked by hand
  await expect(rowOf(page, 'beta')).toHaveClass(/st-done/);
  await expect(block(page).locator('.pn-sum')).toHaveText('2 open');
  writeFileSync(w.file, [line('alpha'), done('beta')].join('\n') + '\n'); // a line removed
  await expect(rowOf(page, 'gamma by hand')).toHaveCount(0);
  expect(results(w.ws)).toBe(r);
  expect(routed(w.ws)).toBe(n);
  // An arbiter turn that edits the file through the fake SDK shows up too.
  await say(page, w.ws, `write ${w.file} ${line('from the arbiter')}`); // the arbiter rewrites the file
  await expect.poll(() => fileText(w.file), { timeout: 5000 }).toContain('from the arbiter');
  await expect(rowOf(page, 'from the arbiter')).toBeVisible({ timeout: 5000 });
});

test('the panel only shows the file: no controls, and every action is refused', async ({ page }) => {
  const w = await itemsWorkspace(page, [line('plain'), line('parked one (waiting on user)', { kind: '~' }), done('finished one')]);
  await expect(rows(page)).toHaveCount(3);
  await expect(rowOf(page, 'finished one')).toHaveClass(/st-done/);
  await expect(rowOf(page, 'finished one').locator('.txt')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(rowOf(page, 'parked one').locator('.why')).toHaveText('waiting on user');
  await expect(block(page).locator('.pn-body input, .pn-body button')).toHaveCount(0);
  await expect(block(page).getByRole('button', { name: 'Clear done' })).toHaveCount(0);
  const before = fileText(w.file), r = results(w.ws), n = routed(w.ws);
  const key = (await panelsOf(page, w.ws)).find((p) => p.panelId === 'open-items').data.items[0].key;
  for (const a of [{ action: 'toggle', key, done: true }, { action: 'remove', key }, { action: 'clear_done' }, { action: 'bogus' }]) {
    expect((await post(page, '/panels/action', { ws: w.ws, panelId: 'open-items', ...a })).status(), a.action).toBe(400);
  }
  expect(fileText(w.file)).toBe(before);
  await sleep(500);
  expect(results(w.ws)).toBe(r);
  expect(routed(w.ws)).toBe(n);
});

test('the panel goes when the file has no items and returns when it has', async ({ page }) => {
  const w = await itemsWorkspace(page, [line('one'), done('two')]);
  await expect(rows(page)).toHaveCount(2);
  writeFileSync(w.file, '# Open items\n<!-- nothing yet -->\n');
  await expect(block(page)).toHaveCount(0, { timeout: 3000 });
  rmSync(w.file);
  await sleep(500);
  await expect(block(page)).toHaveCount(0);
  writeFileSync(w.file, line('back again') + '\n');
  await expect(rowOf(page, 'back again')).toBeVisible({ timeout: 3000 });
});

test('a notes folder set later is watched too', async ({ page }) => {
  const name = uniq('oilate'), notes = tmp('oinotes');
  const ws = await createWs(page, name);
  await open(page, name);
  await expect(block(page)).toHaveCount(0);
  mkdirSync(join(notes, 'workspaces', ws), { recursive: true });
  writeFileSync(join(notes, 'workspaces', ws, 'open-items.md'), line('late item') + '\n');
  expect((await post(page, '/workspaces/notes', { ws, notes })).ok()).toBe(true);
  await expect(rowOf(page, 'late item')).toBeVisible({ timeout: 5000 });
  appendFileSync(join(notes, 'workspaces', ws, 'open-items.md'), line('second late item') + '\n');
  await expect(rowOf(page, 'second late item')).toBeVisible({ timeout: 3000 });
});

test('a reload shows the same rows', async ({ page }) => {
  const w = await itemsWorkspace(page, [line('one'), line('two', { you: true })]);
  await expect(rows(page)).toHaveCount(2);
  await page.reload();
  await page.locator('#tabs button', { hasText: w.name }).click();
  await expect(rows(page)).toHaveCount(2);
  expect(await texts(page)).toEqual(['two', 'one']);
});

test('reset keeps the panel without a model turn and the seed names the open items', async ({ page }) => {
  const w = await itemsWorkspace(page, [line('seed item one'), line('seed item two', { you: true }), done('finished thing')]);
  await expect(rows(page)).toHaveCount(3);
  await say(page, w.ws, 'say warm');
  await expect.poll(() => results(w.ws)).toBeGreaterThan(0);
  expect((await post(page, '/reset', { ws: w.ws })).ok()).toBe(true);
  const echoed = () => events(w.ws).filter((e) => e.type === 'text' && e.agentId === 'arbiter').map((e) => e.text as string).find((t) => t.includes('[context reset]'));
  await expect.poll(echoed, { timeout: 15_000 }).toBeTruthy();
  expect(echoed()).toContain('seed item one');
  expect(echoed()).toContain('seed item two');
  expect(echoed()).not.toContain('finished thing'); // only open and parked items
  await expect(rows(page)).toHaveCount(3);
});

test('parsing: long text is cut, control characters stripped, bad lines not shown, 201 items show 200', async ({ page }) => {
  const bad = ['- [ ] 31-02-2026 impossible date', '- [?] unknown marker', '- [ ]no space', '- [x] done without a check'];
  const w = await itemsWorkspace(page, [line('L'.repeat(300)), line('ctrl\u0001\u0007chars'), line('plain one'), ...bad]);
  await expect(rowOf(page, 'plain one')).toBeVisible();
  const long = (await texts(page)).find((t) => t.startsWith('LLL'))!;
  expect(long).toHaveLength(200);
  expect(await texts(page)).toContain('ctrl chars');
  expect((await texts(page)).length).toBe(3); // the bad lines are not shown
  expect(fileText(w.file)).toContain(bad[0]); // the file itself is never touched

  const many = await itemsWorkspace(page, Array.from({ length: 201 }, (_, i) => line(`item ${i}`)));
  await expect(rows(page)).toHaveCount(200);
  expect(many.ws).toBeTruthy();
});

test('item text is shown as text: no element, no script', async ({ page }) => {
  let dialogs = 0;
  page.on('dialog', (dlg) => { dialogs++; void dlg.dismiss(); });
  await itemsWorkspace(page, [line('<img src=x onerror=alert(1)>'), line('<b>bold</b> & more')]);
  await expect(rows(page)).toHaveCount(2);
  await expect(block(page).locator('img, b')).toHaveCount(0);
  expect(await texts(page)).toContain('<img src=x onerror=alert(1)>');
  expect(await texts(page)).toContain('<b>bold</b> & more');
  await sleep(300);
  expect(dialogs).toBe(0);
});

test('two panels: jobs above items, both scroll inside the shared stack, headers pinned, collapse and hide are independent', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 672 });
  const p = await jobsWorkspace(page, {}, { notes: tmp('oinotes') });
  const meta = (await (await page.request.get('/workspaces')).json()).workspaces.find((x: any) => x.id === p.ws);
  const file = join(meta.notes, 'workspaces', p.ws, 'open-items.md');
  const ids = Array.from({ length: 12 }, (_, i) => `t${String(i).padStart(2, '0')}`);
  for (const id of ids) p.set(id, { state: 'running', step: 'step' });
  writeFileSync(file, ids.map((id) => line(`todo ${id}`)).join('\n') + '\n');
  await watchJobs(page, p.ws, p.name, ids);
  await expect(jobsBlock(page).locator('li.jr')).toHaveCount(12);
  await expect(rows(page)).toHaveCount(12);
  const names = await page.locator('#panels section.pn').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.panel));
  expect(names).toEqual(['jobs', 'open-items']);
  const panel = (await page.locator('#panel').boundingBox())!, panels = (await page.locator('#panels').boundingBox())!;
  expect(panels.height).toBeLessThanOrEqual(panel.height - 380 + 1);
  for (const b of [jobsBlock(page), block(page)]) {
    expect(await b.locator('.pn-body').evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
    await b.locator('.pn-body').evaluate((e) => { e.scrollTop = e.scrollHeight; });
    const h = (await b.locator('.pn-h').boundingBox())!, now = (await page.locator('#panels').boundingBox())!; // measured again: the stack settles as rows arrive
    expect(h.y).toBeGreaterThanOrEqual(now.y - 1);
    expect(h.y + h.height).toBeLessThanOrEqual(now.y + now.height + 1);
  }
  expect((await page.locator('#log').boundingBox())!.height).toBeGreaterThanOrEqual(160);

  await block(page).locator('.pn-tog').click();
  await expect(block(page)).toHaveClass(/collapsed/);
  await expect(jobsBlock(page)).not.toHaveClass(/collapsed/);
  await page.locator('#pview').click();
  await page.locator('#viewMenu label', { hasText: 'Jobs' }).getByRole('checkbox').uncheck();
  await expect(jobsBlock(page)).toHaveCount(0);
  await expect(block(page)).toHaveClass(/collapsed/);
  await page.reload();
  await page.locator('#tabs button', { hasText: p.wsName }).click();
  await expect(block(page)).toHaveClass(/collapsed/);
  await expect(jobsBlock(page)).toHaveCount(0);
});

// Restarts and the JARVIS_OPEN_ITEMS switch need servers of their own, as in resume.spec.ts.
test.describe('own server', () => {
  const PORT = MAIN_PORT + 1000, URL = `http://127.0.0.1:${PORT}`;
  const data = tmp('oi-server');
  let server: ChildProcess | undefined;
  async function start(env: Record<string, string> = {}) {
    server = spawn(process.execPath, ['src/server.ts'], { env: { ...process.env, PORT: String(PORT), XDG_DATA_HOME: data, JARVIS_FAKE_SDK: join(import.meta.dirname, 'fake-sdk.ts'), ...env }, stdio: 'ignore' });
    await expect.poll(() => fetch(`${URL}/workspaces`).then((r) => r.ok, () => false), { timeout: 15_000 }).toBe(true);
  }
  async function stop() {
    if (!server || server.exitCode !== null) return;
    const exit = once(server, 'exit');
    server.kill();
    await exit;
  }
  test.afterEach(stop);
  test.use({ baseURL: URL, cutStream: true }); // the test stops the server under the open page
  const o = { headers: { origin: URL } };

  test('a server restart shows the rows drawn from the file, edits made while it was down included', async ({ page }) => {
    await start();
    const notes = tmp('oinotes'), name = uniq('oirestart');
    const ws = (await (await page.request.post('/workspaces', { ...o, data: { name, notes } })).json()).id;
    const file = join(notes, 'workspaces', ws, 'open-items.md');
    writeFileSync(file, [line('before'), line('also before')].join('\n') + '\n');
    const items = async () => ((await (await page.request.get(`/panels?ws=${ws}`)).json()).find((p: any) => p.panelId === 'open-items')?.data.items ?? []).map((i: any) => i.text);
    await expect.poll(items).toEqual(['before', 'also before']);
    await page.goto('about:blank');
    await stop();
    writeFileSync(file, [line('before'), line('added while down')].join('\n') + '\n');
    await start();
    await expect.poll(items).toEqual(['before', 'added while down']);
    await page.goto('/');
    await page.locator('#tabs button', { hasText: name }).click();
    await expect(rows(page)).toHaveCount(2);
  });

  test('JARVIS_OPEN_ITEMS=0 removes the panel and the prompt text', async ({ page }) => {
    await start({ JARVIS_OPEN_ITEMS: '0' });
    const notes = tmp('oinotes');
    const ws = (await (await page.request.post('/workspaces', { ...o, data: { name: uniq('oioff'), notes } })).json()).id;
    writeFileSync(join(notes, 'workspaces', ws, 'open-items.md'), line('invisible') + '\n');
    await page.request.post('/say', { ...o, data: { ws, text: 'option systemPrompt' } });
    const log = () => readFileSync(join(data, 'jarvis', 'workspaces', ws, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    await expect.poll(() => log().some((e) => e.type === 'result')).toBe(true);
    expect(log().find((e) => e.type === 'result').text).not.toContain('Open items');
    await sleep(800);
    expect(await (await page.request.get(`/panels?ws=${ws}`)).json()).toEqual([]);
  });
});
