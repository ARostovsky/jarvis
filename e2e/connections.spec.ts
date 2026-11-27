import { createServer, type Server } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, post, say, events, uniq, createWs, open, tab, type Page } from './helpers.ts';
import { CONFIG_HOME } from '../playwright.config.ts';

const KEY = 'sk-e2e-secret-0123456789wxyz';
// The fake SDK's `option env` writes the env into the chat; tests that use it have their own key, so the dialog test can check that its key is nowhere in the page.
const ENV_KEY = 'sk-e2e-envdump-0123456789abcd';
type Hit = { url?: string; auth?: string; model?: string };

// A fake gateway: answers POST /v1/messages when the bearer key matches, 401 otherwise; records what it saw.
async function gateway(): Promise<{ url: string; hits: Hit[]; close: () => void }> {
  const hits: Hit[] = [];
  const srv: Server = createServer((req, res) => {
    let b = ''; req.on('data', (x) => (b += x)).on('end', () => {
      const j = (() => { try { return JSON.parse(b); } catch { return {}; } })();
      hits.push({ url: req.url, auth: req.headers.authorization, model: j.model });
      if (req.headers.authorization !== `Bearer ${KEY}`) return void res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `invalid key ${req.headers.authorization}` } }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: j.model, content: [{ type: 'text', text: 'ok' }] }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}/v1/`, hits, close: () => srv.close() };
}

const list = async (page: Page) => (await page.request.get('/connections')).json();
async function reset(page: Page, ids: string[]) {
  await post(page, '/connections/default', { id: '' });
  for (const id of ids) await post(page, '/connections/delete', { id });
}

test('Connections dialog: add, test against a gateway, keep the key on edit, set default; the key never reaches the page or the API', async ({ page }) => {
  const gw = await gateway(), name = uniq('gw');
  let id = '';
  try {
    await page.goto('/');
    const gear = page.getByRole('button', { name: 'Settings' });
    // the icon is centered in its button by geometry, not by font metrics
    const [b, i] = await Promise.all([gear.boundingBox(), page.locator('#gear svg').boundingBox()]);
    expect(Math.abs(b!.x + b!.width / 2 - (i!.x + i!.width / 2))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(b!.y + b!.height / 2 - (i!.y + i!.height / 2))).toBeLessThanOrEqual(0.5);
    await gear.click();
    await page.getByRole('menuitem', { name: 'Connections…' }).click();
    await expect(page.locator('#connections .sub')).toHaveText('How agents reach an LLM');
    await expect(page.locator('#connList')).toContainText('Anthropic login');
    await page.locator('#connAdd').click();
    await expect(page.locator('#cfKey')).toHaveJSProperty('required', true);
    // a new form carries the suggested model ids as real values; focusing one selects all of it
    await expect(page.locator('#cfHaiku')).toHaveValue('claude-haiku-4-5');
    await expect(page.locator('#cfSonnet')).toHaveValue('claude-sonnet-4-5');
    await expect(page.locator('#cfOpus')).toHaveValue('claude-opus-4-1');
    await page.locator('#cfSonnet').focus();
    expect(await page.evaluate(() => { const i = document.getElementById('cfSonnet') as HTMLInputElement; return i.value.slice(i.selectionStart!, i.selectionEnd!); })).toBe('claude-sonnet-4-5');
    await page.fill('#cfName', name);
    await page.fill('#cfUrl', gw.url);
    await page.fill('#cfKey', KEY);
    await page.fill('#cfHaiku', 'haiku-on-gw');
    await page.fill('#cfSonnet', 'sonnet-on-gw');
    await page.fill('#cfOpus', '');
    const before = await list(page);
    await page.locator('#cfTest').click();
    await expect(page.locator('#connResult')).toContainText('All models work');
    await expect(page.locator('#connResult')).toContainText('OK haiku → haiku-on-gw');
    await expect(page.locator('#connResult')).toContainText('OK sonnet → sonnet-on-gw');
    await expect(page.locator('#connResult')).not.toContainText(/saved/i);
    expect(await list(page)).toEqual(before); // Test persists nothing
    await page.locator('#cfSave').click();
    await expect(page.locator('#connResult')).toHaveText('Saved');
    expect(gw.hits.map((h) => h.model).sort()).toEqual(['haiku-on-gw', 'sonnet-on-gw']);
    expect(gw.hits.every((h) => h.url === '/v1/messages' && h.auth === `Bearer ${KEY}`)).toBe(true);

    // after the save the page holds no key: not in the input, not in the markup, not in the placeholder text of the list
    await expect(page.locator('#cfKey')).toHaveValue('');
    await expect(page.locator('#cfKey')).toHaveAttribute('placeholder', 'stored, leave empty to keep');
    expect(await page.locator('#connForm').innerHTML()).not.toContain(KEY); // markup only: input values are not part of innerHTML, the toHaveValue('') above checks the field
    await expect(page.locator('#connList')).toContainText(gw.url.replace(/\/v1\/$/, ''));
    await expect(page.locator('#connList')).not.toContainText(/key stored|haiku →/); // the row is name and URL only; the details are in the edit form

    const api = await list(page);
    id = api.connections.find((c: any) => c.name === name).id;
    expect(JSON.stringify(api)).not.toContain(KEY);
    expect(JSON.stringify(api)).not.toContain('apiKey');
    const file = join(CONFIG_HOME, 'jarvis', 'connections.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain(KEY);

    // editing keeps the stored values (no defaults filled in); Test with an empty key reuses the stored key for the call only and saves nothing
    await expect(page.locator('#cfOpus')).toHaveValue('');
    const stored = await list(page);
    gw.hits.length = 0;
    await page.fill('#cfOpus', 'opus-on-gw');
    await page.fill('#cfHaiku', 'changed-haiku');
    await page.locator('#cfTest').click();
    await expect(page.locator('#connResult')).toContainText('OK opus → opus-on-gw');
    expect(gw.hits.map((h) => h.model).sort()).toEqual(['changed-haiku', 'opus-on-gw', 'sonnet-on-gw']);
    expect(await list(page)).toEqual(stored);
    await page.fill('#cfHaiku', 'haiku-on-gw');

    // a wrong key shows the gateway status and no secret
    await page.fill('#cfKey', 'wrong-key-value-123456');
    await page.locator('#cfTest').click();
    await expect(page.locator('#connResult')).toContainText('FAIL haiku → haiku-on-gw: HTTP 401');
    expect(await page.locator('#connResult').textContent()).not.toContain(KEY);
    await page.fill('#cfKey', KEY);
    await page.locator('#cfSave').click();
    await expect(page.locator('#connResult')).toHaveText('Saved');

    // an empty list of defaults: Anthropic login stays the default (changing it restarts sessions, see connections-default.spec.ts)
    await expect(page.locator('#connList > div').filter({ hasText: 'Anthropic login' }).locator('.pbadge')).toHaveText('DEFAULT');
    await page.locator('#cfDelete').click();
    await page.locator('#choiceButtons button').filter({ hasText: /^DELETE$/ }).click();
    await expect(page.locator('#connList')).not.toContainText(name);
    expect((await list(page)).default).toBeNull();
    id = '';
  } finally { gw.close(); await reset(page, id ? [id] : []); }
});

test('a workspace gets the gateway env in env and settings.env; changing its connection restarts its sessions fresh', async ({ page }) => {
  const gw = await gateway(), a = uniq('ca'), b = uniq('cb');
  const mk = async (name: string, url: string) => (await (await post(page, '/connections/create', { name, baseUrl: url, apiKey: ENV_KEY, modelHaiku: 'h-' + name, modelSonnet: 's-' + name, modelOpus: 'o-' + name })).json()).id as string;
  const ida = await mk(a, gw.url), idb = await mk(b, 'http://127.0.0.1:9/v1');
  const wsName = uniq('cw');
  try {
    const ws = await createWs(page, wsName, { connectionId: ida });
    expect((await (await page.request.get('/workspaces')).json()).workspaces.find((w: any) => w.id === ws).connectionId).toBe(ida);
    await say(page, ws, 'option env', 'option settings');
    await expect.poll(() => events(ws).filter((e) => e.type === 'text' && /^(env|settings)=/.test(e.text)).length).toBe(2);
    const [env, settings] = events(ws).filter((e) => e.type === 'text' && /^(env|settings)=/.test(e.text)).map((e) => JSON.parse(e.text.replace(/^[a-z]+=/, '')));
    const base = gw.url.replace(/\/v1\/$/, '');
    for (const o of [env, settings.env]) {
      expect(o).toMatchObject({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: ENV_KEY, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h-' + a, ANTHROPIC_DEFAULT_SONNET_MODEL: 's-' + a, ANTHROPIC_DEFAULT_OPUS_MODEL: 'o-' + a, ENABLE_TOOL_SEARCH: 'true' });
    }
    const first = events(ws).filter((e) => e.type === 'session').at(-1).sessionId;
    expect(first).toBeTruthy();

    // a connection in use cannot be deleted
    const del = await post(page, '/connections/delete', { id: ida });
    expect(del.status()).toBe(400);
    expect(await del.text()).toContain('1 workspace uses this connection');

    // change it in the UI: choose, then confirm the restart
    await open(page, wsName);
    await expect(page.locator('#via')).toHaveText(`via ${a}`);
    await tab(page, wsName).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Connection…' }).click();
    await page.locator('#choiceButtons button').filter({ hasText: new RegExp(`^${b}$`) }).click();
    await expect(page.locator('#choiceQuestion')).toContainText('without their earlier conversation');
    await page.locator('#choiceButtons button').filter({ hasText: /^CHANGE AND RESTART$/ }).click();
    await expect(page.locator('#via')).toHaveText(`via ${b}`);
    await expect.poll(() => events(ws).filter((e) => e.type === 'session').at(-1).sessionId).toBeUndefined();

    await say(page, ws, 'option env', 'option resume');
    await expect.poll(() => events(ws).filter((e) => e.type === 'text' && /^(env|resume)=/.test(e.text)).length).toBe(3);
    const after = events(ws).filter((e) => e.type === 'text' && /^(env|resume)=/.test(e.text)).slice(1).map((e) => e.text);
    expect(JSON.parse(after[0].replace(/^env=/, '')).ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('h-' + b);
    expect(after[1]).toBe('resume=undefined');
    expect(events(ws).filter((e) => e.type === 'session').at(-1).sessionId).not.toBe(first);
  } finally { gw.close(); await reset(page, [ida, idb]); }
});

test('the New workspace form offers the connections and keeps the pick when the list reloads; a new workspace gets its connection', async ({ page }) => {
  const gw = await gateway(), n = uniq('cd');
  const id = (await (await post(page, '/connections/create', { name: n, baseUrl: gw.url, apiKey: ENV_KEY, modelHaiku: 'h-d' })).json()).id as string;
  try {
    await page.goto('/');
    await page.route('**/connections', async (route) => { await new Promise((r) => setTimeout(r, 300)); await route.continue(); }); // a slow answer must not let the dialog open half-built
    await page.locator('#tabs button[title="New workspace"]').click();
    await expect(page.locator('#newws')).toBeVisible();
    await expect(page.locator('#wsConn option').filter({ hasText: new RegExp(`^${n}$`) })).toHaveCount(1); // loaded before the dialog is shown
    await page.locator('#wsConnBtn').click();
    await page.locator('#wsConnBtn + ul li').filter({ hasText: new RegExp(`^${n}$`) }).click();
    await expect(page.locator('#wsConn')).toHaveValue(id);
    await page.evaluate(() => (window as any).loadConnections()); // a rebuild of the list keeps the pick
    await expect(page.locator('#wsConn')).toHaveValue(id);
    await expect(page.locator('#wsConnBtn')).toHaveText(n);
    const nm = uniq('cm');
    await page.fill('#wsName', nm);
    await page.locator('#newwsForm button[value=ok]').click();
    await expect(tab(page, nm)).toHaveClass('active');
    const w = (await (await page.request.get('/workspaces')).json()).workspaces.find((x: any) => x.name === nm);
    expect(w.connectionId).toBe(id);
    await expect(page.locator('#via')).toHaveText(`via ${n}`);
    expect(await post(page, '/workspaces', { name: uniq('bad'), connectionId: 'nope' }).then((r) => r.status())).toBe(400);
  } finally { gw.close(); await reset(page, []); }
});

test('a connection needs a key; one that only an archived workspace names can be deleted; a created workspace passes its connection to a child', async ({ page }) => {
  const n = uniq('ck');
  expect((await post(page, '/connections/create', { name: n, baseUrl: 'http://127.0.0.1:9' })).status()).toBe(400);
  const id = (await (await post(page, '/connections/create', { name: n, baseUrl: 'http://127.0.0.1:9', apiKey: ENV_KEY })).json()).id as string;
  try {
    const ws = await createWs(page, uniq('cp'), { connectionId: id });
    const child = uniq('cc');
    await say(page, ws, `tool mcp__jarvis__create_workspace ${JSON.stringify({ name: child, task: 'TASK' })}`, 'result');
    await expect.poll(async () => (await (await page.request.get('/workspaces')).json()).workspaces.some((w: any) => w.name === child)).toBe(true);
    const kid = (await (await page.request.get('/workspaces')).json()).workspaces.find((w: any) => w.name === child);
    expect(kid.connectionId).toBe(id);
    expect((await post(page, '/workspaces/archive', { ws: kid.id })).ok()).toBe(true);
    expect((await post(page, '/connections/delete', { id })).status()).toBe(400); // the parent still names it
    expect((await post(page, '/workspaces/archive', { ws })).ok()).toBe(true);
    expect((await post(page, '/connections/delete', { id })).ok()).toBe(true); // only archived workspaces name it now
  } finally { await reset(page, []); }
});
