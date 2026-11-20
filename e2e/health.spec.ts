import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { PORT as MAIN_PORT } from '../playwright.config.ts';
import { test, expect, tmp } from './helpers.ts';

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
  server = spawn(process.execPath, ['src/server.ts'], { env: { ...process.env, PORT: String(PORT), XDG_DATA_HOME: tmp('health'), JARVIS_FAKE_SDK: join(import.meta.dirname, 'fake-sdk.ts'), JARVIS_STATUS_URL: `http://127.0.0.1:${(stub.address() as AddressInfo).port}/`, JARVIS_STATUS_POLL_MS: '200' }, stdio: 'ignore' });
  await expect.poll(() => fetch(`${URL}/workspaces`).then((r) => r.ok, () => false), { timeout: 15_000 }).toBe(true);

  await page.goto('/');
  const dot = page.locator('#health');
  const cases: [object | string, string, RegExp?][] = [
    [summary('none'), 'ok', /desc none/],
    [summary('minor', 'operational', ['Elevated errors']), 'minor', /desc minor\nElevated errors\nchecked /],
    [summary('major'), 'major'],
    [summary('critical'), 'critical'],
    [summary('none', 'degraded_performance'), 'minor'], // the API component is worse than the overall indicator
    [summary('minor', 'major_outage'), 'critical'],
    ['not json', 'unknown'],
  ];
  for (const [b, cls, title] of cases) {
    body = b; version++;
    await expect(dot).toHaveClass(cls);
    if (title) await expect(dot).toHaveAttribute('title', title);
  }
  body = summary('none'); version++;
  await expect(dot).toHaveClass('ok');
  await expect.poll(() => etags).toBeGreaterThan(0); // later polls revalidate with If-None-Match
  stub.close(); stub.closeAllConnections();
  await expect(dot).toHaveClass('unknown');
  await expect(dot).toHaveAttribute('href', 'https://status.claude.com');
});
