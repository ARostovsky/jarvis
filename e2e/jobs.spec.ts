import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PORT as MAIN_PORT } from '../playwright.config.ts';
import { test, expect, createWs, open, uniq, tmp, post, say, events, callTool, fakeProvider, jobRows, panelsOf, jobsBlock, jobRow, watchJobs, jobsWorkspace, archivePolling, type Page } from './helpers.ts';

const block = jobsBlock, row = jobRow, watch = watchJobs, setup = jobsWorkspace;
const jobsMsgs = (ws: string) => events(ws).filter((e) => e.type === 'routed' && e.from === 'system' && e.text.startsWith('[jobs]')).map((e) => e.text as string);
const arbiterResults = (ws: string) => events(ws).filter((e) => e.type === 'result' && e.agentId === 'arbiter').length;
const act = (page: Page, ws: string, action: string, args: object = {}) => post(page, '/panels/action', { ws, panelId: 'jobs', action, ...args });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.afterEach(({ page }) => archivePolling(page));

test('prompt gating: no offer text and no propose_provider without notes; both with notes; never-poll rules in both', async ({ page }) => {
  const bare = await createWs(page, uniq('bare'));
  const withNotes = await createWs(page, uniq('withnotes'), { notes: tmp('notes') });
  const text = async (ws: string, opt: string) => {
    const before = events(ws).filter((e) => e.type === 'result').length;
    await say(page, ws, `option ${opt}`);
    await expect.poll(() => events(ws).filter((e) => e.type === 'result').length).toBeGreaterThan(before);
    return events(ws).filter((e) => e.type === 'result').at(-1).text as string;
  };
  const [bareTools, bareRules, notesTools, notesRules] = [await text(bare, 'allowedTools'), await text(bare, 'systemPrompt'), await text(withNotes, 'allowedTools'), await text(withNotes, 'systemPrompt')];
  for (const t of ['list_providers', 'watch_jobs', 'clear_jobs', 'jobs_status']) { expect(bareTools).toContain(`mcp__jarvis__${t}`); expect(notesTools).toContain(`mcp__jarvis__${t}`); }
  expect(bareTools).not.toContain('propose_provider');
  expect(notesTools).toContain('mcp__jarvis__propose_provider');
  for (const r of [bareRules, notesRules]) {
    expect(r).toContain('Never check a watched job yourself');
    expect(r).toContain('Never spawn an agent or send an agent a message only to check');
  }
  expect(bareRules).not.toContain('status-providers.md');
  expect(bareRules).not.toContain('SKILL.md');
  expect(bareRules).toContain('needs a notes folder');
  expect(notesRules).toContain('status-providers.md');
  expect(notesRules).toContain('SKILL.md');
});

test('propose_provider shows the card, Approve installs it and the arbiter is told', async ({ page }) => {
  const notes = tmp('notes'), name = uniq('prop');
  const ws = await createWs(page, name, { notes });
  const draft = fakeProvider({}, tmp('drafts'));
  await open(page, name);
  const out = await callTool(page, ws, 'propose_provider', { name: draft.name, dir: draft.dir, report: 'provider-check OK' });
  expect(out).toContain('approval card is waiting');
  const card = page.locator(`#asks [data-prov="${draft.name}"]`);
  await expect(card).toBeVisible();
  expect(await draft.info(page)).toBeUndefined(); // nothing installed before the click
  await expect(card.locator('pre', { hasText: '── manifest.json' })).toContainText('manifest.json'); // the files are on the card before Approve works
  await expect(page.getByRole('button', { name: /^PROVIDERS \(1\)$/ })).toBeVisible();
  await page.getByRole('button', { name: /^PROVIDERS/ }).click();
  await expect(page.locator('#provList')).toContainText(`${draft.name}`); // pending proposals are listed in the dialog
  await page.locator('#providers').getByRole('button', { name: 'CLOSE' }).click();
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await draft.info(page))?.status).toBe('approved');
  await expect.poll(() => events(ws).some((e) => e.type === 'routed' && e.from === 'system' && e.text.startsWith(`[providers] The user approved provider ${draft.name}`))).toBe(true);
});

test('providers dialog keeps unsaved boxes over a refresh and saves [] when all are ticked', async ({ page }) => {
  const name = uniq('dlg');
  const ws = await createWs(page, name);
  const [a, b] = [fakeProvider(), fakeProvider()];
  await a.approve(page); await b.approve(page);
  await open(page, name);
  await page.evaluate(async (id) => { const W = window as any; await W.loadProviders(); W.openProviders((await (await fetch('/workspaces')).json()).workspaces.find((w: any) => w.id === id)); }, ws);
  const box = page.locator(`#provList input[data-name="${a.name}"]`);
  await expect(box).toBeChecked();
  await box.uncheck();
  await page.evaluate(() => (window as any).loadProviders()); // a refresh while the dialog is open
  await expect(box).not.toBeChecked();
  await box.check();
  await page.locator('#provSave').click();
  await expect(page.locator('#providers')).not.toHaveAttribute('open', '');
  const w = (await (await page.request.get('/workspaces')).json()).workspaces.find((x: any) => x.id === ws);
  expect(w.providers ?? []).toEqual([]);
});

test('Reject sends the reason to the arbiter and installs nothing', async ({ page }) => {
  const name = uniq('rej');
  const ws = await createWs(page, name, { notes: tmp('notes') });
  const draft = fakeProvider({}, tmp('drafts'));
  await open(page, name);
  await callTool(page, ws, 'propose_provider', { name: draft.name, dir: draft.dir, report: 'ok' });
  const card = page.locator(`#asks [data-prov="${draft.name}"]`);
  await card.getByPlaceholder('Reason (optional)').fill('polls too often');
  await card.getByRole('button', { name: 'Reject' }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => events(ws).some((e) => e.type === 'routed' && e.from === 'system' && e.text.includes(`rejected provider ${draft.name}`) && e.text.includes('polls too often'))).toBe(true);
  expect(await draft.info(page)).toBeUndefined();
});

test('propose_provider with a folder inside the notes folder is a tool error', async ({ page }) => {
  const notes = tmp('notes'), name = uniq('innotes');
  const ws = await createWs(page, name, { notes });
  const draft = fakeProvider({}, notes);
  const out = await callTool(page, ws, 'propose_provider', { name: draft.name, dir: draft.dir, report: 'ok' });
  expect(out).toMatch(/notes folder/);
  await open(page, name);
  await expect(page.locator(`#asks [data-prov="${draft.name}"]`)).toHaveCount(0);
});

test('watch_jobs pins the jobs panel above the chat, a failure gives one batched [jobs] message and no turn per poll', async ({ page }) => {
  const p = await setup(page);
  const link = 'https://example.test/run/r1';
  p.set('r1', { state: 'running', step: 'train', progress: { done: 2, total: 8 }, link });
  p.set('r2', { state: 'running' });
  const out = await watch(page, p.ws, p.name, ['r1', 'r2'], { r1: 'Nightly train' });
  expect(out).toContain('"added": 2');
  await expect(block(page)).toBeVisible();
  const box = await page.locator('#panels').boundingBox(), log = await page.locator('#log').boundingBox();
  expect(box!.y).toBeLessThan(log!.y); // above the chat log
  const r1 = row(page, p.name, 'r1');
  await expect(r1).toContainText('Nightly train');
  await expect(r1.locator('a')).toHaveAttribute('href', link);
  await expect(r1.locator('.cnt')).toHaveText('2/8');

  // Polls without a state change: rows move, the arbiter gets no turn and no message.
  const results = arbiterResults(p.ws);
  p.set('r1', { state: 'running', step: 'train', progress: { done: 5, total: 8 }, link });
  await expect(r1.locator('.cnt')).toHaveText('5/8');
  await sleep(2500); // at least two more polls
  expect(jobsMsgs(p.ws)).toEqual([]);
  expect(arbiterResults(p.ws)).toBe(results);

  // Two jobs change in one poll: one message with both lines.
  writeFileSync(join(p.jobs, '.hold'), '');
  p.set('r1', { state: 'failed', error: 'CUDA out of memory' });
  p.set('r2', { state: 'done' });
  rmSync(join(p.jobs, '.hold'));
  await expect(r1).toHaveClass(/st-failed/);
  await expect(row(page, p.name, 'r2')).toHaveClass(/st-done/);
  await expect.poll(() => jobsMsgs(p.ws).length).toBe(1);
  const msg = jobsMsgs(p.ws)[0];
  expect(msg).toContain('r1 ("Nightly train")');
  expect(msg).toContain('running -> failed');
  expect(msg).toContain('CUDA out of memory');
  expect(msg).toContain('r2');
  expect(msg).toContain('running -> done');
  await sleep(2500);
  expect(jobsMsgs(p.ws).length).toBe(1); // no repeat for an unchanged state
});

test('a failing provider makes the rows stale with the error and keeps them', async ({ page }) => {
  const p = await setup(page);
  p.set('ok-1', { state: 'running' });
  await watch(page, p.ws, p.name, ['ok-1']);
  await expect(row(page, p.name, 'ok-1')).toHaveClass(/st-running/);
  await watch(page, p.ws, p.name, ['fail-1']);
  await expect(block(page)).toHaveClass(/\bstale\b/);
  await expect(block(page).locator('.pn-note')).toContainText('backend refused the request');
  await expect(row(page, p.name, 'ok-1')).toBeVisible();
  await expect(row(page, p.name, 'fail-1')).toBeVisible();
  const status = (await panelsOf(page, p.ws)).find((x) => x.panelId === 'jobs').status;
  expect(status.ok).toBe(false);
  expect(status.error).toContain('backend refused');
});

test('unknown fields are ignored; a schema 2 provider shows its error', async ({ page }) => {
  const p = await setup(page);
  p.set('extra-1', { state: 'running', label: 'Has extras' });
  await watch(page, p.ws, p.name, ['extra-1']);
  await expect(row(page, p.name, 'extra-1')).toContainText('Has extras');
  await expect(block(page)).not.toHaveClass(/\bstale\b/);
  expect(Object.keys((await jobRows(page, p.ws))[0]).sort()).not.toContain('flavour');
  await watch(page, p.ws, p.name, ['v2-1']);
  await expect(block(page).locator('.pn-note')).toContainText('schema 2');
  await expect(block(page)).toHaveClass(/\bstale\b/);
});

test('providers dialog: Approve again of a changed provider works with one click and shows a rejection', async ({ page }) => {
  const p = await setup(page);
  appendFileSync(join(p.dir, 'fake.ts'), '\n// edited\n');
  await expect.poll(async () => (await p.info(page)).status).toBe('changed');
  await page.goto('/');
  await page.waitForFunction('typeof openProviders === "function" && es.readyState === 1');
  await page.evaluate(() => (window as any).openProviders());
  const row = page.locator('#provList > div', { hasText: p.name });
  await expect(row.getByRole('button', { name: 'APPROVE AGAIN' })).toBeEnabled(); // no FILES click first
  appendFileSync(join(p.dir, 'fake.ts'), '\n// edited again\n'); // the hash on the button is now stale: the server refuses
  await row.getByRole('button', { name: 'APPROVE AGAIN' }).click();
  await expect(page.locator('#toast')).toContainText('providers/approve failed');
  await page.evaluate(() => (window as any).loadProviders());
  await row.getByRole('button', { name: 'APPROVE AGAIN' }).click();
  await expect.poll(async () => (await p.info(page)).status).toBe('approved');
});

test('providers dialog: a changed provider with files, screenshot and a long status keeps its name and status line readable', async ({ page }) => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  const p = await setup(page);
  const m = JSON.parse(readFileSync(join(p.dir, 'manifest.json'), 'utf8'));
  writeFileSync(join(p.dir, 'screenshot.png'), PNG);
  writeFileSync(join(p.dir, 'long.ts'), `// ${'x'.repeat(400)}\n`); // an unbreakable wide line in the files view
  writeFileSync(join(p.dir, 'manifest.json'), JSON.stringify({ ...m, screenshot: 'screenshot.png', description: 'ZenML pipeline runs: state, current step and a long tail of words so the status line needs more than one line of the dialog' }));
  await expect.poll(async () => (await p.info(page)).status).toBe('changed');
  await page.setViewportSize({ width: 1480, height: 1880 });
  await page.goto('/');
  await page.waitForFunction('typeof openProviders === "function" && es.readyState === 1');
  await page.evaluate(() => (window as any).openProviders());
  const row = page.locator('#provList > div', { hasText: p.name });
  await expect(row.getByRole('button', { name: 'APPROVE AGAIN' })).toBeEnabled(); // the files are shown
  if (process.env.SHOT_DIR) await page.locator('#providers').screenshot({ path: `${process.env.SHOT_DIR}/providers-changed.png` });
  const b = (await row.locator('small').boundingBox())!;
  expect(b.width).toBeGreaterThan(200);
  expect(b.height).toBeLessThan(150); // a few lines (about 7 in the 640px dialog), not one character per line
});

test('editing an installed provider file asks for approval again and stops polling until then', async ({ page }) => {
  const p = await setup(page);
  p.set('c1', { state: 'running' });
  await watch(page, p.ws, p.name, ['c1']);
  await expect(row(page, p.name, 'c1')).toHaveClass(/st-running/);
  appendFileSync(join(p.dir, 'fake.ts'), '\n// edited\n');
  p.set('c1', { state: 'failed', error: 'late' });
  await expect(block(page).locator('.pn-note', { hasText: 'provider files changed, approve again' })).toBeVisible(); // a second note, files changed, shows up with the next poll
  await expect(block(page).getByRole('button', { name: 'Approve again' })).toBeVisible();
  await expect.poll(async () => (await p.info(page)).status).toBe('changed');
  await expect.poll(() => jobsMsgs(p.ws).some((m) => m.includes('files changed'))).toBe(true);
  await sleep(2500);
  expect((await jobRows(page, p.ws))[0].state).toBe('running'); // not polled while unapproved
  const info = await p.info(page);
  expect((await post(page, '/providers/approve', { name: p.name, hash: info.hash })).ok()).toBe(true);
  await act(page, p.ws, 'refresh');
  await expect(row(page, p.name, 'c1')).toHaveClass(/st-failed/);
  await expect(block(page).locator('.pn-note')).toHaveCount(0);
});

test('× and Clear done remove rows, and a reload keeps what is left', async ({ page }) => {
  const p = await setup(page);
  p.set('d1', { state: 'done' }); p.set('d2', { state: 'failed', error: 'x' }); p.set('d3', { state: 'running' });
  await watch(page, p.ws, p.name, ['d1', 'd2', 'd3']);
  await expect(row(page, p.name, 'd2')).toHaveClass(/st-failed/);
  for (const id of ['d1', 'd2']) { // the plate spans the row (status bar inset 2px) and stays inside it
    const rb = (await row(page, p.name, id).boundingBox())!, xb = (await row(page, p.name, id).getByRole('button', { name: /^Remove/ }).boundingBox())!;
    expect(xb.height).toBeGreaterThanOrEqual(rb.height - 4 - 0.5);
    expect(xb.y).toBeGreaterThanOrEqual(rb.y); expect(xb.y + xb.height).toBeLessThanOrEqual(rb.y + rb.height + 0.5);
  }
  await row(page, p.name, 'd1').getByRole('button', { name: /^Remove/ }).click();
  await expect(row(page, p.name, 'd1')).toHaveCount(0);
  expect((await act(page, p.ws, 'bogus')).status()).toBe(400);
  expect((await act(page, p.ws, 'clear')).ok()).toBe(true);
  await expect(row(page, p.name, 'd2')).toHaveCount(0);
  await page.reload();
  await expect(block(page)).toBeVisible();
  await expect(block(page).locator('li.jr')).toHaveCount(1);
  await expect(row(page, p.name, 'd3')).toBeVisible();
  expect((await jobRows(page, p.ws)).map((r) => r.id)).toEqual(['d3']);
});

test('a slow field shows no value, then the value with its fetch time; fast polls leave it alone', async ({ page }) => {
  const p = await setup(page, { slow_fields: { cost: '2s' } });
  p.set('s1', { state: 'running' });
  await watch(page, p.ws, p.name, ['s1']);
  await expect(row(page, p.name, 's1')).toHaveClass(/st-running/);
  await expect(row(page, p.name, 's1').locator('.cost')).toHaveCount(0);
  p.set('s1', { state: 'running', costUsd: 12.4 });
  await expect(row(page, p.name, 's1').locator('.cost')).toHaveText(/^\$12\.40 \(as of \d\d:\d\d\)$/, { timeout: 15_000 });
});

test('with a long slow interval fast polls never touch the slow value', async ({ page }) => {
  const p = await setup(page, { slow_fields: { cost: '1h' } });
  p.set('s2', { state: 'running', costUsd: 12.4 });
  await watch(page, p.ws, p.name, ['s2']);
  const cost = row(page, p.name, 's2').locator('.cost');
  await expect(cost).toHaveText(/^\$12\.40 \(as of \d\d:\d\d\)$/);
  const asOf = (await jobRows(page, p.ws))[0].asOf;
  p.set('s2', { state: 'running', costUsd: 99, step: 'later' });
  await expect(row(page, p.name, 's2').locator('.step')).toHaveText('later'); // a fast poll ran
  await sleep(1500);
  await expect(cost).toHaveText(/^\$12\.40 /);
  expect((await jobRows(page, p.ws))[0].asOf).toEqual(asOf);
});

test('absent fields are not in the DOM at all', async ({ page }) => {
  const p = await setup(page);
  p.set('bare-1', { state: 'running' });
  p.set('full-1', { state: 'running', step: 'eval', progress: { done: 1, total: 4 }, costUsd: 3.5, link: 'https://example.test/x', error: 'warn text' });
  await watch(page, p.ws, p.name, ['bare-1', 'full-1']);
  await expect(row(page, p.name, 'full-1').locator('.cost')).toHaveText('$3.50'); // no slow field: no "as of"
  for (const sel of ['.cost', '.bar', '.cnt', '.step', 'a', '.err']) await expect(row(page, p.name, 'full-1').locator(sel)).toHaveCount(1);
  for (const sel of ['.cost', '.asof', '.bar', '.cnt', '.step', 'a', '.err']) await expect(row(page, p.name, 'bare-1').locator(sel)).toHaveCount(0);
  await expect(row(page, p.name, 'bare-1').locator('.l2 > *')).toHaveCount(0); // the id is on the first line, nothing else to show
});

test('the progress bar and counter are vertically centered with the row text', async ({ page }) => {
  const p = await setup(page);
  p.set('c-1', { state: 'running', step: 'eval', progress: { done: 1, total: 8 } });
  p.set('c-2', { state: 'running', step: 'eval', progress: { done: 4, total: 8 } });
  await watch(page, p.ws, p.name, ['c-1', 'c-2']);
  const mid = (r: { y: number; height: number }) => r.y + r.height / 2;
  for (const id of ['c-1', 'c-2']) {
    const r = row(page, p.name, id);
    const bar = (await r.locator('.bar').boundingBox())!;
    const cnt = (await r.locator('.cnt').boundingBox())!;
    const lab = (await r.locator('.lab').boundingBox())!;
    expect(Math.abs(mid(bar) - mid(cnt))).toBeLessThanOrEqual(1);
    if ((await r.boundingBox())!.width >= 640) expect(Math.abs(mid(bar) - mid(lab))).toBeLessThanOrEqual(1); // one-line layout: same line as the name
  }
});

test('clear_jobs keepCurrent leaves only the unfinished rows; agents never get watch_jobs or clear_jobs', async ({ page }) => {
  const repo = tmp('repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' });
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const p = await setup(page, {}, { project: repo });
  p.set('k1', { state: 'running' }); p.set('k2', { state: 'done' }); p.set('k3', { state: 'failed' }); p.set('k4', { state: 'waiting' });
  await watch(page, p.ws, p.name, ['k1', 'k2', 'k3', 'k4']);
  await expect(row(page, p.name, 'k3')).toHaveClass(/st-failed/);
  const out = await callTool(page, p.ws, 'clear_jobs', { keepCurrent: true });
  expect(out).toContain('"removed": 2');
  await expect(block(page).locator('li.jr')).toHaveCount(2);
  expect((await jobRows(page, p.ws)).map((r) => r.id).sort()).toEqual(['k1', 'k4']);
  expect(await callTool(page, p.ws, 'clear_jobs', {})).toMatch(/give ids/);
  expect(await callTool(page, p.ws, 'clear_jobs', { ids: ['k4'] })).toContain('"removed": 1');

  expect((await say(page, p.ws, 'tool mcp__jarvis__spawn_agent {"name":"helper","task":"option allowedTools"}')).ok()).toBe(true);
  await expect.poll(() => events(p.ws).some((e) => e.type === 'routed' && e.to === 'arbiter' && /allowedTools=/.test(e.text))).toBe(true);
  const tools = events(p.ws).find((e) => e.type === 'routed' && e.to === 'arbiter' && /allowedTools=/.test(e.text)).text as string;
  for (const t of ['watch_jobs', 'clear_jobs', 'jobs_status', 'propose_provider']) expect(tools).not.toContain(t);
});

test('watch_jobs refuses an unapproved provider and a bad id', async ({ page }) => {
  const draft = fakeProvider(); // placed, not approved
  const ws = await createWs(page, uniq('refuse'));
  expect(await callTool(page, ws, 'watch_jobs', { provider: draft.name, ids: ['a'] })).toMatch(/not approved/);
  await draft.approve(page);
  expect(await callTool(page, ws, 'watch_jobs', { provider: draft.name, ids: ['bad id'] })).toMatch(/id not accepted/);
  expect(await callTool(page, ws, 'watch_jobs', { provider: 'no-such-provider', ids: ['a'] })).toMatch(/unknown provider/);
});

// A restart needs a server of its own, as in resume.spec.ts.
test.describe('restart', () => {
  const PORT = MAIN_PORT + 1000, URL = `http://127.0.0.1:${PORT}`;
  const data = tmp('jobs-restart');
  let server: ChildProcess | undefined;
  async function start(providers: string) {
    server = spawn(process.execPath, ['src/server.ts'], { env: { ...process.env, PORT: String(PORT), XDG_DATA_HOME: data, JARVIS_PROVIDERS_DIR: providers, JARVIS_JOBS_MIN_POLL_S: '1', JARVIS_FAKE_SDK: join(import.meta.dirname, 'fake-sdk.ts') }, stdio: 'ignore' });
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

  test('after a restart the rows are still there and an unfinished job is polled again', async ({ page }) => {
    const providers = tmp('providers');
    const p = fakeProvider({}, providers);
    await start(providers);
    const o = { headers: { origin: URL } };
    const hash = (await (await page.request.get('/providers')).json()).providers.find((x: any) => x.name === p.name).hash;
    expect((await page.request.post('/providers/approve', { ...o, data: { name: p.name, hash } })).ok()).toBe(true);
    const name = uniq('restart');
    const ws = (await (await page.request.post('/workspaces', { ...o, data: { name } })).json()).id;
    p.set('u1', { state: 'running', label: 'Long run' }); p.set('u2', { state: 'done' });
    await page.request.post('/say', { ...o, data: { ws, text: `tool mcp__jarvis__watch_jobs ${JSON.stringify({ provider: p.name, ids: ['u1', 'u2'] })}` } });
    const rows = async () => (await (await page.request.get(`/panels?ws=${ws}`)).json()).find((x: any) => x.panelId === 'jobs')?.data.rows ?? [];
    await expect.poll(async () => (await rows()).map((r: any) => `${r.id}:${r.state}`).sort()).toEqual(['u1:running', 'u2:done']);

    await page.goto('about:blank');
    await stop();
    p.set('u1', { state: 'failed', error: 'died while down' });
    await start(providers);
    await expect.poll(async () => (await rows()).map((r: any) => `${r.id}:${r.state}`).sort()).toContain('u1:failed');
    expect((await rows()).find((r: any) => r.id === 'u2').state).toBe('done');
    await expect.poll(() => readFileSync(join(data, 'jarvis', 'workspaces', ws, 'events.jsonl'), 'utf8')).toContain('[jobs] Status from provider');
    await page.goto('/');
    await page.locator('#tabs button', { hasText: name }).click(); // the tab also carries the jobs badge
    await expect(row(page, p.name, 'u1')).toHaveClass(/st-failed/);
  });
});

test('provider details: manifest with masked env, approval state, changed manifest, traversal rejected', async ({ page }) => {
  const p = fakeProvider({ args: ['{ids}', '--flag'], env: { pass: ['HOME'], set: { FAKE_JOBS_DIR: '/tmp/x', MY_SECRET: 'hunter2' } } });
  await page.goto('/');
  const open = async () => {
    await page.evaluate(() => (window as any).openProviders());
    await page.locator(`#provList button.pdet[data-name="${p.name}"]`).click();
  };
  await p.approve(page);
  await open();
  const body = page.locator('#pdBody');
  await expect(body.locator('.pd-state')).toHaveText(/^Approved · \S/);
  await expect(body).not.toContainText(/Approved.*Approved/s);
  // no error, warning, screenshot or docs: no stray "undefined", "null" or "0" text next to the state line
  await expect(body.locator('.pd-state + small')).toHaveText('Folder');
  await expect(body.locator('.pd-manifest')).toContainText('"--flag"');
  await expect(body.locator('.pd-manifest')).toContainText('"node"');
  await expect(body.locator('.pd-manifest')).toContainText('"MY_SECRET": "••••"');
  await expect(body.locator('.pd-manifest')).not.toContainText('hunter2');
  const hash = (await p.info(page)).hash;
  await expect(body).not.toContainText(hash);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  writeFileSync(join(p.dir, 'README.md'), 'changed');
  await open();
  await expect(body.locator('.pd-state')).toHaveText('Changed since approval, needs re-approval');
  await expect(body.locator('.pd-state')).toHaveClass(/bad/);
  await expect(body).not.toContainText(/[0-9a-f]{64}/);
  await expect(body.locator('.pd-files')).toContainText('README.md');
  for (const n of ['../x', '..%2Fx', 'nope']) expect((await page.request.get(`/providers/details?name=${n}`)).status()).toBe(404);
});

test('provider screenshot: thumbnail in the list, image in the details, approval kept, traversal and bad field handled', async ({ page }) => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  const p = fakeProvider(), bare = fakeProvider();
  await page.goto('/');
  const m = JSON.parse(readFileSync(join(p.dir, 'manifest.json'), 'utf8'));
  writeFileSync(join(p.dir, 'screenshot.png'), PNG);
  writeFileSync(join(p.dir, 'manifest.json'), JSON.stringify({ ...m, screenshot: 'screenshot.png' }));
  await p.approve(page); await bare.approve(page);
  expect((await p.info(page)).status).toBe('approved');
  const r = await page.request.get(`/providers/screenshot?name=${p.name}`);
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toBe('image/png');
  expect((await r.body()).equals(PNG)).toBe(true);
  for (const n of ['../x', '..%2Fx', 'nope', bare.name]) expect((await page.request.get(`/providers/screenshot?name=${n}`)).status()).toBe(404);

  await page.evaluate(() => (window as any).openProviders());
  await expect(page.locator(`#provList img.pthumb[alt="${p.name} screenshot"]`)).toBeVisible();
  await expect(page.locator(`#provList img.pthumb[alt="${bare.name} screenshot"]`)).toHaveCount(0);
  await page.locator(`#provList button.pdet[data-name="${p.name}"]`).click();
  const img = page.locator('#pdBody .pd-shot img');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(1);
  await expect(page.locator('#pdBody .pd-shot a')).toHaveAttribute('target', '_blank');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');

  // the picture is part of the approval: changing it needs a new approval
  writeFileSync(join(p.dir, 'screenshot.png'), Buffer.concat([PNG, Buffer.from('x')]));
  expect((await p.info(page)).status).toBe('changed');
  writeFileSync(join(p.dir, 'screenshot.png'), PNG);
  expect((await p.info(page)).status).toBe('approved');

  // a bad field: warning in the details, no image (the member is not hashed and the file is unchanged, so still approved)
  writeFileSync(join(p.dir, 'manifest.json'), JSON.stringify({ ...m, screenshot: '../x.png' }));
  expect((await p.info(page)).status).toBe('approved');
  expect((await page.request.get(`/providers/screenshot?name=${p.name}`)).status()).toBe(404);
  await page.evaluate(() => (window as any).openProviders());
  await page.locator(`#provList button.pdet[data-name="${p.name}"]`).click();
  await expect(page.locator('#pdBody .pd-warn')).toContainText('screenshot ignored');
  await expect(page.locator('#pdBody .pd-shot')).toHaveCount(0);
});
