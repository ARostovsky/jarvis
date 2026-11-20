import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PORT as MAIN_PORT } from '../playwright.config.ts';
import { test, expect, createWs, uniq, tmp, say, events, type Page } from './helpers.ts';

// Default bounds: soft 150k, hard 200k, each at most 60% of the window. The fake reports a 200k window until `window` says otherwise,
// so a first turn widens it to 1M and waits for the server to know. The reset acts one quiet second after a result.
async function workspace(page: Page) {
  const project = tmp('rstproj'), notes = tmp('rstnotes');
  const ws = await createWs(page, uniq('rst'), { project, notes });
  await say(page, ws, 'window 1000000', 'say warm');
  await expect.poll(() => events(ws).some((e) => e.type === 'context' && e.agentId === 'arbiter' && e.max === 1_000_000)).toBe(true);
  return { ws, notes };
}
// 'session' events without an id are the reset clearing the old one.
const arbiter = (ws: string, type: string) => events(ws).filter((e) => e.agentId === 'arbiter' && e.type === type && (type !== 'session' || e.sessionId));
const resets = (ws: string) => events(ws).filter((e) => e.type === 'compacted' && e.trigger === 'reset');
const saves = (ws: string) => events(ws).filter((e) => e.type === 'routed' && e.from === 'system' && e.text.includes('The server resets your context after this turn'));
const echoed = (ws: string) => arbiter(ws, 'text').map((e) => e.text).find((t: string) => t.includes('[context reset]'));
// The helper runs `ms`, then its result reaches the arbiter as a script line that makes it say CHILD-REPORT-OK.
const helperTask = (ms: number, word = 'CHILD-REPORT-OK') => `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'slowhelper', task: `sleep ${ms}\nsay say ${word}` })}`;

test('hard bound: reset with a busy agent, state saved once, child report still arrives', async ({ page }) => {
  const { ws, notes } = await workspace(page);
  await say(page, ws, 'usage 210000', helperTask(4500), 'say first');

  await expect.poll(() => arbiter(ws, 'session').length, { timeout: 10_000 }).toBe(2); // the new session started
  expect(saves(ws)).toHaveLength(1);
  expect(saves(ws)[0].text).toContain(`${notes}/status.md`);
  expect(resets(ws)[0]).toMatchObject({ agentId: 'arbiter', pre: 210_000 });
  const [old, fresh] = arbiter(ws, 'session').map((e) => e.sessionId);
  expect(old).not.toBe(fresh);
  // The UI does not keep the old size.
  expect(events(ws).filter((e) => e.type === 'context' && e.agentId === 'arbiter').some((e) => e.tokens === 0)).toBe(true);

  const helper = events(ws).find((e) => e.type === 'spawned' && e.agent.name === 'slowhelper').agent;
  await expect.poll(() => echoed(ws)).toContain(notes);
  expect(echoed(ws)).toContain(`- ${helper.id} (slowhelper): running`);
  expect(echoed(ws)).toContain('README.md, CLAUDE.md, status.md');

  // The child ran through the reset; its report reaches the new arbiter.
  await expect.poll(() => arbiter(ws, 'text').some((e) => e.text === 'CHILD-REPORT-OK'), { timeout: 15_000 }).toBe(true);
  expect(arbiter(ws, 'session')).toHaveLength(2); // the fresh session starts small: no second reset
  expect(resets(ws)).toHaveLength(1);
});

test('soft bound: no reset while an agent runs, reset after it has reported', async ({ page }) => {
  const { ws } = await workspace(page);
  await say(page, ws, 'usage 160000', helperTask(2500), 'say first');
  await expect.poll(() => arbiter(ws, 'result').length).toBe(2);
  await new Promise((r) => setTimeout(r, 1500));
  expect(resets(ws)).toHaveLength(0);
  expect(arbiter(ws, 'session')).toHaveLength(1);

  await expect.poll(() => resets(ws).length, { timeout: 15_000 }).toBe(1);
  const log = events(ws);
  const helper = log.find((e) => e.type === 'spawned' && e.agent.name === 'slowhelper').agent;
  const done = log.findIndex((e) => e.type === 'result' && e.agentId === helper.id);
  expect(done).toBeGreaterThan(-1);
  expect(done).toBeLessThan(log.findIndex((e) => e.type === 'compacted' && e.trigger === 'reset'));
  await expect.poll(() => arbiter(ws, 'session').length).toBe(2);
});

// Messages that reach the old session while it saves: a real SDK may run them as their own turn or fold them into the running one.
for (const fold of ['', ' fold']) {
  test(`a message sent during the save turn${fold} is listed as already handled`, async ({ page }) => {
    const { ws } = await workspace(page);
    try {
      await say(page, ws, `savedelay 1500${fold}`, 'usage 210000', 'say first');
      await expect.poll(() => saves(ws).length).toBe(1);
      await say(page, ws, 'say SENT-DURING-SAVE');
      await expect.poll(() => echoed(ws), { timeout: 15_000 }).toContain('SENT-DURING-SAVE');
      expect(echoed(ws)).toMatch(/do not redo them[^]*SENT-DURING-SAVE/);
      expect(echoed(ws)).not.toContain('The server resets your context'); // the save request is not carried
      expect(resets(ws)).toHaveLength(1);
      // The old session finished the turn that carried the message before it was reset.
      const log = events(ws);
      expect(log.findIndex((e) => e.type === 'text' && e.text === 'SENT-DURING-SAVE')).toBeLessThan(log.findIndex((e) => e.type === 'compacted' && e.trigger === 'reset'));
    } finally {
      await say(page, ws, 'savedelay 0');
    }
  });
}

test('a child report during the save turn is not lost, and mail waits for the seed', async ({ page }) => {
  const { ws } = await workspace(page);
  const other = await createWs(page, uniq('rstmail'));
  try {
    await say(page, ws, 'savedelay 2500 fold', 'usage 210000', helperTask(1800, 'HELPER-DONE-DURING-SAVE'), 'say first');
    await expect.poll(() => saves(ws).length, { timeout: 10_000 }).toBe(1);
    await say(page, other, `tool mcp__jarvis__tell_workspace ${JSON.stringify({ to: [ws], text: 'MAIL-DURING-SAVE', urgent: false })}`);
    await expect.poll(() => echoed(ws), { timeout: 20_000 }).toContain('MAIL-DURING-SAVE'); // unread mail rides with the seed
    expect(echoed(ws)).toContain('[messages from other workspaces]');
    expect(echoed(ws)).toContain('HELPER-DONE-DURING-SAVE');
  } finally {
    await say(page, ws, 'savedelay 0');
  }
});

test('a message queued behind the crossing turn runs before the save request', async ({ page }) => {
  const { ws } = await workspace(page);
  await say(page, ws, 'usage 210000', 'sleep 1500', 'say first');
  await expect.poll(() => events(ws).filter((e) => e.type === 'status' && e.agentId === 'arbiter' && e.status === 'running').length).toBeGreaterThan(1);
  await say(page, ws, 'say QUEUED-DURING-TURN');
  await expect.poll(() => resets(ws).length, { timeout: 15_000 }).toBe(1);
  const log = events(ws);
  const queued = log.findIndex((e) => e.type === 'text' && e.text === 'QUEUED-DURING-TURN');
  expect(queued).toBeGreaterThan(-1);
  expect(queued).toBeLessThan(log.findIndex((e) => e.type === 'routed' && e.from === 'system' && e.text.includes('resets your context')));
  expect(saves(ws)).toHaveLength(1);
});

test('a notification after the result does not stop the reset', async ({ page }) => {
  const { ws } = await workspace(page);
  await say(page, ws, 'trailing', 'usage 210000', 'say first'); // the fake sends session_state_changed idle after this result
  await expect.poll(() => saves(ws).length, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => resets(ws).length, { timeout: 10_000 }).toBe(1);
});

// The fake opens that turn with a status message and sends its first output 1.5 s later, longer than the quiet second.
test('a result nobody asked for delays the save request until it is quiet', async ({ page }) => {
  const { ws } = await workspace(page);
  await say(page, ws, 'usage 210000', 'later 300 say SPONTANEOUS', 'say first');
  await expect.poll(() => saves(ws).length, { timeout: 10_000 }).toBe(1);
  const log = events(ws);
  const spont = log.findIndex((e) => e.type === 'text' && e.text === 'SPONTANEOUS');
  expect(spont).toBeGreaterThan(-1);
  expect(spont).toBeLessThan(log.findIndex((e) => e.type === 'routed' && e.from === 'system'));
  await expect.poll(() => resets(ws).length, { timeout: 10_000 }).toBe(1);
});

test('a second reset happens after real growth, not at once; a session that starts large does not loop', async ({ page }) => {
  const { ws } = await workspace(page);
  await say(page, ws, 'usage 210000', 'say first');
  await expect.poll(() => resets(ws).length, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => arbiter(ws, 'session').length).toBe(2);
  await say(page, ws, 'usage 260000', 'say again');
  await expect.poll(() => resets(ws).length, { timeout: 10_000 }).toBe(2);
  await expect.poll(() => arbiter(ws, 'session').length).toBe(3);

  const big = await workspace(page);
  try {
    await say(page, big.ws, 'resetusage 210000', 'usage 210000', 'say first');
    await expect.poll(() => big.ws && resets(big.ws).length, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => echoed(big.ws)).toContain('[context reset]'); // the fresh session's first turn already reports 210k
    await new Promise((r) => setTimeout(r, 3500));
    expect(resets(big.ws)).toHaveLength(1);
    expect(saves(big.ws)).toHaveLength(1);
  } finally {
    await say(page, big.ws, 'resetusage 0');
  }
});

async function startServer(page: Page, port: number, data: string, env: Record<string, string>) {
  const url = `http://127.0.0.1:${port}`;
  const server: ChildProcess = spawn(process.execPath, ['src/server.ts'], { env: { ...process.env, PORT: String(port), XDG_DATA_HOME: data, JARVIS_FAKE_SDK: join(import.meta.dirname, 'fake-sdk.ts'), ...env }, stdio: 'ignore' });
  await expect.poll(() => fetch(`${url}/workspaces`).then((r) => r.ok, () => false), { timeout: 15_000 }).toBe(true);
  const stop = async () => { if (server.exitCode !== null) return; const exit = once(server, 'exit'); server.kill(); await exit; };
  return { url, stop };
}
const logOf = (data: string, ws: string) => readFileSync(join(data, 'jarvis', 'workspaces', ws, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('after a reset a restart resumes the new session', async ({ page }) => {
  const data = tmp('rstrestart'), port = MAIN_PORT + 1100;
  let server = await startServer(page, port, data, {});
  try {
    const headers = { origin: server.url };
    const ws = (await (await page.request.post(`${server.url}/workspaces`, { headers, data: { name: uniq('rstrestart') } })).json()).id; // no notes: reset without a save turn
    await page.request.post(`${server.url}/say`, { headers, data: { ws, text: 'usage 210000\nsay first' } });
    await expect.poll(() => logOf(data, ws).some((e) => e.type === 'text' && e.text?.includes('[context reset]')), { timeout: 15_000 }).toBe(true);
    const ids = () => logOf(data, ws).filter((e) => e.type === 'session').map((e) => e.sessionId);
    await expect.poll(() => ids().length).toBe(3); // old, cleared, new
    const [old, cleared, fresh] = ids();
    expect([typeof old, cleared, typeof fresh]).toEqual(['string', undefined, 'string']);
    await server.stop();
    server = await startServer(page, port, data, {});
    await page.request.post(`${server.url}/say`, { headers: { origin: server.url }, data: { ws, text: 'option resume' } });
    await expect.poll(() => logOf(data, ws).some((e) => e.type === 'text' && e.text === `resume="${fresh}"`)).toBe(true);
  } finally {
    await server.stop();
  }
});

test('JARVIS_RESET_HARD_TOKENS=0 disables the reset', async ({ page }) => {
  const data = tmp('rstoff');
  const server = await startServer(page, MAIN_PORT + 1100, data, { JARVIS_RESET_HARD_TOKENS: '0' });
  try {
    const headers = { origin: server.url };
    const ws = (await (await page.request.post(`${server.url}/workspaces`, { headers, data: { name: uniq('rstoff'), notes: tmp('rstoffn') } })).json()).id;
    await page.request.post(`${server.url}/say`, { headers, data: { ws, text: 'usage 210000\nsay hi' } });
    await expect.poll(() => logOf(data, ws).some((e) => e.text === 'hi')).toBe(true);
    await new Promise((r) => setTimeout(r, 3000));
    expect(logOf(data, ws).filter((e) => e.trigger === 'reset')).toHaveLength(0);
    expect(logOf(data, ws).filter((e) => e.type === 'session')).toHaveLength(1);
  } finally {
    await server.stop();
  }
});
