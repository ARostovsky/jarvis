import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PORT as MAIN_PORT } from '../playwright.config.ts';
import { test, expect, open, uniq, tmp } from './helpers.ts';

// A restart needs a server of its own: the shared one must keep running for the other specs.
const PORT = MAIN_PORT + 1000;
const URL = `http://127.0.0.1:${PORT}`;
const data = tmp('resume');
let server: ChildProcess | undefined;

async function start() {
  server = spawn(process.execPath, ['src/server.ts'], { env: { ...process.env, PORT: String(PORT), XDG_DATA_HOME: data, JARVIS_FAKE_SDK: join(import.meta.dirname, 'fake-sdk.ts') }, stdio: 'ignore' });
  await expect.poll(() => fetch(`${URL}/workspaces`).then((r) => r.ok, () => false), { timeout: 15_000 }).toBe(true);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exit = once(server, 'exit');
  server.kill();
  await exit;
}
test.afterEach(stop);
test.use({ baseURL: URL });

const send = async (page: import('@playwright/test').Page, text: string) => {
  await page.fill('#dinput', text);
  await page.locator('#dinput').press('Enter');
};
const line = (page: import('@playwright/test').Page, text: string) => page.locator('#log div:not(.user)').filter({ hasText: new RegExp(`^${text}$`) });

test('after a restart the log is replayed and the next message resumes the SDK session', async ({ page }) => {
  await start();
  const name = uniq('resume');
  const r = await page.request.post('/workspaces', { headers: { origin: URL }, data: { name } });
  const id = (await r.json()).id;
  await open(page, name);
  await send(page, 'say before restart\noption resume');
  await expect(line(page, 'resume=undefined')).toBeVisible(); // a new session: nothing to resume
  const events = (): any[] => readFileSync(join(data, 'jarvis', 'workspaces', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const sessionId = events().find((e) => e.type === 'session' && e.agentId === 'arbiter')?.sessionId;
  expect(sessionId).toBeTruthy();

  await page.goto('about:blank'); // no reconnect errors from the open page while the server is down
  await stop();
  await start();
  await open(page, name);
  await expect(line(page, 'before restart')).toBeVisible();
  await expect(page.locator('#core')).toHaveClass(/\bidle\b/);
  await send(page, 'option resume');
  await expect(line(page, `resume="${sessionId}"`)).toBeVisible();
  await expect(page.locator('#core')).toHaveClass(/\bidle\b/);
  expect(events().filter((e) => e.type === 'session').map((e) => e.sessionId)).toEqual([sessionId]); // the same session continues
});
