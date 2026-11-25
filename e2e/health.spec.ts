import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { PORT as MAIN_PORT } from '../playwright.config.ts';
import { test, expect, tmp, uniq, tab } from './helpers.ts';

// Own server (poll every 200 ms) against a local stub of the Statuspage: the shared server must not poll the network.
const PORT = MAIN_PORT + 2000;
const URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess | undefined;
let stub: Server | undefined;
test.use({ baseURL: URL });
test.afterEach(async () => {
  stub?.close();
  stub?.closeAllConnections();
  if (server && server.exitCode === null) { const exit = once(server, 'exit'); server.kill(); await exit; }
});

test('the status dot follows the Statuspage indicator and the API component, grey when unreachable', async ({ page }) => {
  let body: object | string = {};
  let version = 0; // the stub's etag, bumped with every body
  let etags = 0;
  stub = createServer((req, res) => {
    if (req.headers['if-none-match'] === `W/"${version}"`) { etags++; return void res.writeHead(304).end(); }
    res.writeHead(200, { 'content-type': 'application/json', etag: `W/"${version}"` }).end(typeof body === 'string' ? body : JSON.stringify(body));
  }).listen(0, '127.0.0.1');
  await once(stub, 'listening');
  const summary = (indicator: string, api = 'operational', incidents: string[] = []) => ({
    status: { indicator, description: `desc ${indicator}` },
    components: [{ name: 'claude.ai', status: 'operational' }, { name: 'Claude API (api.anthropic.com)', status: api }],
    incidents: incidents.map((name) => ({ name })),
  });
  server = spawn(process.execPath, ['src/server.ts'], { env: { ...process.env, PORT: String(PORT), XDG_DATA_HOME: tmp('health'), JARVIS_FAKE_SDK: join(import.meta.dirname, 'fake-sdk.ts'), JARVIS_STATUS_URL: `http://127.0.0.1:${(stub.address() as AddressInfo).port}/`, JARVIS_STATUS_POLL_MS: '200', JARVIS_HEALTH_PROBE: '0', JARVIS_HEALTH_SLOW_MS: '1500' }, stdio: 'ignore' });
  await expect.poll(() => fetch(`${URL}/workspaces`).then((r) => r.ok, () => false), { timeout: 15_000 }).toBe(true);

  await page.goto('/');
  const dot = page.locator('#health');
  body = summary('none'); version++;
  await expect(dot).toHaveAttribute('title', /Anthropic status: desc none/);
  await expect(dot).toHaveClass('unknown'); // a green status page alone says nothing about this user's access: no local outcome yet
  const name = uniq('health');
  const send = (path: string, data: object) => page.request.post(path, { headers: { origin: URL }, data }); // this server has its own origin
  const ws = (await (await send('/workspaces', { name })).json()).id;
  await page.goto('/');
  await tab(page, name).click();
  const turn = async (...lines: string[]) => {
    const mark = uniq('turn');
    await send('/say', { ws, text: [...lines, `say ${mark}`].join('\n') });
    await expect(page.getByText(mark).first()).toBeVisible();
    await expect.poll(async () => ((await (await fetch(`${URL}/workspaces`)).json()).workspaces.find((w: any) => w.id === ws)?.running ?? 0)).toBe(0);
  };
  await turn(); // a successful run: the dot follows the status page from here on
  const cases: [object | string, string, RegExp?][] = [
    [summary('none'), 'ok', /Anthropic status: desc none/],
    [summary('minor', 'operational', ['Elevated errors']), 'minor', /Anthropic status: desc minor\nElevated errors\nchecked /],
    [summary('major'), 'major'],
    [summary('critical'), 'critical'],
    [summary('none', 'degraded_performance'), 'minor'], // the API component is worse than the overall indicator
    [summary('minor', 'major_outage'), 'critical'],
    ['not json', 'ok'], // unreadable status page: the local success stands
  ];
  for (const [b, cls, title] of cases) {
    body = b; version++;
    await expect(dot).toHaveClass(cls);
    if (title) await expect(dot).toHaveAttribute('title', title);
  }
  body = summary('none'); version++;
  await expect(dot).toHaveClass('ok');
  // The local outcome follows the error type: auth and connection errors are red, rate limit yellow, unrelated errors change nothing.
  await turn('apierror authentication_failed API Error: 401 invalid credentials');
  await expect(dot).toHaveClass('major');
  await expect(dot).toHaveAttribute('title', /Your Claude: auth/);
  await turn();
  await expect(dot).toHaveClass('ok');
  await turn('apierror unknown API Error: Connection error.');
  await expect(dot).toHaveClass('major');
  await turn();
  await expect(dot).toHaveClass('ok');
  await turn('apierror rate_limit API Error: 429');
  await expect(dot).toHaveClass('minor');
  await turn();
  await turn('sleep 2500'); // the first token comes late: slow
  await expect(dot).toHaveClass('minor');
  await expect(dot).toHaveAttribute('title', /Your Claude: slow/);
  await turn();
  await expect(dot).toHaveClass('ok');
  await turn('subapierror server_error'); // a sub-agent's API error does not fail the turn
  await expect(dot).toHaveClass('ok');
  await turn('apierror invalid_request bad prompt', 'fail error_during_execution'); // ignored types: the green success above stays
  await expect(dot).toHaveClass('ok');
  await expect.poll(() => etags).toBeGreaterThan(0); // later polls revalidate with If-None-Match
  stub.close(); stub.closeAllConnections();
  await expect(dot).toHaveAttribute('title', /Anthropic status: Status unavailable/); // the page is unreachable, but the local outcome still decides
  await expect(dot).toHaveClass('ok');
  await expect(dot).toHaveAttribute('href', 'https://status.claude.com');
});
