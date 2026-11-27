import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PORT as MAIN_PORT } from '../playwright.config.ts';
import { test, expect, tmp, uniq } from './helpers.ts';

// Changing the default connection or a connection's address restarts the sessions of every workspace that follows it. That would stop the agents of other specs on the shared server, so these tests have their own server.
const PORT = MAIN_PORT + 1200;
const URL = `http://127.0.0.1:${PORT}`;
const KEY = 'sk-e2e-default-0123456789abcd';
let server: ChildProcess | undefined;
const data = tmp('conn-data'), config = tmp('conn-config');
const file = join(config, 'jarvis', 'connections.json');
test.describe.configure({ mode: 'serial' });
test.use({ baseURL: URL });

test.beforeAll(async () => {
  server = spawn(process.execPath, ['src/server.ts'], { env: { ...process.env, PORT: String(PORT), XDG_DATA_HOME: data, XDG_CONFIG_HOME: config, JARVIS_FAKE_SDK: join(import.meta.dirname, 'fake-sdk.ts'), JARVIS_STATUS_URL: 'http://127.0.0.1:1/', JARVIS_HEALTH_PROBE: '0' }, stdio: 'ignore' });
  await expect.poll(() => fetch(`${URL}/workspaces`).then((r) => r.ok, () => false), { timeout: 15_000 }).toBe(true);
});
test.afterAll(async () => { if (server && server.exitCode === null) { const exit = once(server, 'exit'); server.kill(); await exit; } });

const send = (path: string, body: object) => fetch(`${URL}${path}`, { method: 'POST', headers: { origin: URL, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const json = async (path: string, body: object) => { const r = await send(path, body); expect(r.ok, `${path}: ${await r.clone().text()}`).toBe(true); const t = await r.text(); return (t ? JSON.parse(t) : {}) as any; };
const evs = (ws: string): any[] => readFileSync(join(data, 'jarvis', 'workspaces', ws, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sessions = (ws: string) => evs(ws).filter((e) => e.type === 'session');
const texts = (ws: string, re: RegExp) => evs(ws).filter((e) => e.type === 'text' && re.test(e.text)).map((e) => e.text as string);
const mkConn = async (name: string, url = 'http://127.0.0.1:9') => (await json('/connections/create', { name, baseUrl: url, apiKey: KEY, modelHaiku: 'h-' + name })).id as string;
const mkWs = async (extra: object = {}) => (await json('/workspaces', { name: uniq('cdw'), ...extra })).id as string;
const idle = (ws: string) => expect.poll(async () => ((await (await fetch(`${URL}/workspaces`)).json()).workspaces.find((w: any) => w.id === ws)?.running ?? 0)).toBe(0);
const turn = async (ws: string, ...lines: string[]) => { const n = texts(ws, /^turn-/).length; await send('/say', { ws, text: [...lines, `say turn-${n}`].join('\n') }); await expect.poll(() => texts(ws, /^turn-/).length).toBe(n + 1); await idle(ws); };
async function healthLocal() {
  const r = await fetch(`${URL}/health`), rd = r.body!.getReader();
  const { value } = await rd.read(); rd.cancel().catch(() => {});
  return JSON.parse(new TextDecoder().decode(value).replace(/^data: /, '').trim()).local;
}

test('the default connection changes: workspaces that follow it restart fresh on the new endpoint, one with its own choice is untouched', async ({ page }) => {
  const a = uniq('da'), own = uniq('do'), ida = await mkConn(a), idOwn = await mkConn(own);
  const follower = await mkWs(), mine = await mkWs({ connectionId: idOwn });
  await turn(follower); await turn(mine);
  const sFollower = sessions(follower).at(-1).sessionId, nMine = sessions(mine).length;
  expect(sFollower).toBeTruthy();

  // the UI confirms first and says that sessions restart; the result is shown
  await page.goto('/');
  await page.getByRole('button', { name: 'CONNECTIONS' }).click();
  await page.locator('#connList > div').filter({ hasText: a }).getByRole('button', { name: 'EDIT' }).click();
  await page.locator('#cfDefault').click();
  await expect(page.locator('#choiceQuestion')).toContainText('stop and start new sessions without their earlier conversation');
  await page.locator('#choiceButtons button').filter({ hasText: /^CHANGE AND RESTART$/ }).click();
  await expect(page.locator('#connResult')).toContainText(`Default connection: ${a}`);
  await expect(page.locator('#cfDefault')).toBeDisabled();

  await expect.poll(() => sessions(follower).at(-1).sessionId).toBeUndefined();
  expect(sessions(mine)).toHaveLength(nMine);
  expect(texts(follower, /^Connection is now /).at(-1)).toContain(a);
  await turn(follower, 'option env', 'option resume');
  expect(texts(follower, /^resume=/).at(-1)).toBe('resume=undefined');
  expect(texts(follower, /^env=/).at(-1)).toContain(`"ANTHROPIC_DEFAULT_HAIKU_MODEL":"h-${a}"`);
  expect(sessions(follower).at(-1).sessionId).not.toBe(sFollower);

  // a new base URL of a connection in use restarts too (confirmed); a new key alone does not
  await turn(follower);
  const s2 = sessions(follower).at(-1).sessionId;
  await json('/connections/update', { id: ida, name: a, baseUrl: 'http://127.0.0.1:9', apiKey: 'another-key-0123456789', modelHaiku: 'h-' + a });
  await turn(follower);
  expect(sessions(follower).at(-1).sessionId).toBe(s2);
  await json('/connections/update', { id: ida, name: a, baseUrl: 'http://127.0.0.1:19', modelHaiku: 'h-' + a });
  await expect.poll(() => sessions(follower).at(-1).sessionId).toBeUndefined();

  // deleting the default (no workspace names it) is a change for the followers too
  await turn(follower);
  await json('/connections/delete', { id: ida });
  await expect.poll(() => sessions(follower).at(-1).sessionId).toBeUndefined();
});

test('a saved session id is dropped when the resolved connection differs, also after a change by hand', async () => {
  const id = await mkConn(uniq('hb'));
  const ws = await mkWs({ connectionId: id });
  await turn(ws);
  const s1 = sessions(ws).at(-1).sessionId;
  await send('/stopall', { ws }); await idle(ws);
  await turn(ws, 'option resume'); // control: the same connection resumes
  expect(texts(ws, /^resume=/).at(-1)).toBe(`resume=${JSON.stringify(s1)}`);
  await send('/stopall', { ws }); await idle(ws);
  const store = JSON.parse(readFileSync(file, 'utf8'));
  store.connections.find((c: any) => c.id === id).baseUrl = 'http://127.0.0.1:29'; // hand edit: no route ran, no restart
  mkdirSync(join(config, 'jarvis'), { recursive: true }); writeFileSync(file, JSON.stringify(store));
  await turn(ws, 'option resume');
  expect(texts(ws, /^resume=/).at(-1)).toBe('resume=undefined');
  expect(sessions(ws).at(-1).sessionId).not.toBe(s1);
});

test('only workspaces on the default connection feed the health dot: a gateway 401 does not', async () => {
  const id = await mkConn(uniq('hg'));
  const gw = await mkWs({ connectionId: id }), plain = await mkWs();
  await send('/say', { ws: gw, text: 'apierror authentication_failed API Error: 401 invalid key' }); // the turn ends at the error: wait for its text, not for a mark
  await expect.poll(() => texts(gw, /invalid key/).length).toBe(1);
  await idle(gw);
  expect((await healthLocal())?.ok).not.toBe(false); // earlier tests left a success on the default connection; the gateway 401 must not replace it
  await send('/say', { ws: plain, text: 'apierror authentication_failed API Error: 401 invalid credentials' });
  await expect.poll(async () => (await healthLocal())?.kind).toBe('auth');
});
