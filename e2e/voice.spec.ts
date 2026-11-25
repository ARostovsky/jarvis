import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PORT as MAIN_PORT } from '../playwright.config.ts';
import { test, expect, open, uniq, tmp, tab, type Page } from './helpers.ts';

// Voice is off on the shared server (the default), so the "on" cases run against servers of their own with the stub sidecar and the stub capture command (no PipeWire, no browser microphone).
const PORT = MAIN_PORT + 1000;
const URL = `http://127.0.0.1:${PORT}`;
const MAIN = `http://127.0.0.1:${MAIN_PORT}`;
let server: ChildProcess | undefined;
// POST to a /voice route of a server of ours; origin '' sends none.
const rpc = (base: string, path: string, body: object = {}, origin = base, type = 'application/json') =>
  fetch(`${base}${path}`, { method: 'POST', headers: { ...(origin ? { origin } : {}), 'content-type': type }, body: JSON.stringify(body) });
const startId = async (base: string) => { const r = await rpc(base, '/voice/start'); expect(r.status).toBe(200); return (await r.json()).id as string; };
const levelOf = async (base: string, id: string) => (await (await rpc(base, '/voice/level', { id })).json()) as { recording: boolean; level: number };
const start = (port: number, extra: object) => spawn(process.execPath, ['src/server.ts'], {
  env: { ...process.env, PORT: String(port), XDG_DATA_HOME: tmp('voice'), JARVIS_FAKE_SDK: join(import.meta.dirname, 'fake-sdk.ts'), JARVIS_STATUS_URL: 'http://127.0.0.1:1/', JARVIS_VOICE: '1', JARVIS_VOICE_CMD: `${process.execPath} ${join(import.meta.dirname, 'fake-voice.ts')}`, JARVIS_VOICE_CAPTURE_CMD: `${process.execPath} ${join(import.meta.dirname, 'fake-capture.ts')}`, ...extra },
  stdio: 'ignore',
});

test.describe('voice on (autosend off)', () => {
  test.beforeAll(async () => {
    server = start(PORT, { JARVIS_VOICE_AUTOSEND: '0' }); // these cases are about recording; the transcript lands in the input box
    await expect.poll(() => fetch(`${URL}/workspaces`).then((r) => r.json()).then((b) => b.voice, () => false), { timeout: 15_000 }).toBe(true); // voice comes up just after listen
  });
  test.afterAll(async () => {
    if (!server || server.exitCode !== null) return;
    const exit = once(server, 'exit');
    server.kill();
    await exit;
  });
  test.use({ baseURL: URL });

  const arbiter = (page: Page) => page.locator('#core').click({ force: true }); // the node pulses, so it is never stable
  const setup = async (page: Page) => {
    const name = uniq('voice');
    expect((await page.request.post('/workspaces', { headers: { origin: URL }, data: { name } })).ok()).toBe(true);
    await open(page, name);
    await arbiter(page);
    return name;
  };
  const posts = (page: Page) => { const n = { count: 0 }; page.on('request', (r) => r.url().endsWith('/voice/stop') && n.count++); return n; };

  test('GET /workspaces reports voice and the mic button shows', async ({ page }) => {
    expect((await (await page.request.get('/workspaces')).json()).voice).toBe(true);
    await setup(page);
    await expect(page.locator('#mic')).toBeVisible();
  });

  const hold = async (page: Page, ms = 500) => { await page.locator('#mic').hover(); await page.mouse.down(); await expect(page.locator('#mic')).toHaveClass('rec'); await page.waitForTimeout(ms); };

  test('holding the button records, release inserts the text at the caret and Enter sends it', async ({ page }) => {
    await setup(page);
    await page.fill('#dinput', 'before after');
    await page.locator('#dinput').evaluate((t: HTMLTextAreaElement) => { t.focus(); t.setSelectionRange(6, 6); });
    await hold(page, 0);
    await expect.poll(() => page.locator('#mic').evaluate((b) => getComputedStyle(b).getPropertyValue('--lvl'))).not.toBe('');
    await page.waitForTimeout(500);
    await page.mouse.up();
    await expect(page.locator('#dinput')).toHaveValue('before hello from voice after');
    await expect(page.locator('#mic')).not.toHaveClass(/rec|busy/);
    await expect(page.locator('#dinput')).toBeFocused();
    await page.locator('#dinput').press('Enter');
    await expect(page.locator('#log .user').filter({ hasText: 'before hello from voice after' })).toBeVisible();
  });

  test('a short tap sends nothing and shows no error', async ({ page }) => {
    await setup(page);
    const n = posts(page);
    await page.locator('#mic').hover();
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('#mic')).not.toHaveClass(/rec|busy/);
    await expect(page.locator('#toastText')).toHaveText('Hold to talk');
    await page.waitForTimeout(300);
    expect(n.count).toBe(0);
    expect(await page.locator('#dinput').inputValue()).toBe('');
  });

  test('releasing the pointer outside the button still ends the recording', async ({ page }) => {
    await setup(page);
    await hold(page);
    await page.mouse.move(5, 5);
    await expect(page.locator('#mic')).toHaveClass('rec');
    await page.mouse.up();
    await expect(page.locator('#dinput')).toHaveValue('hello from voice');
    await expect(page.locator('#mic')).not.toHaveClass(/rec|busy/);
  });

  test('Ctrl+Space in the input and Alt+V anywhere record while held', async ({ page }) => {
    await setup(page);
    await page.focus('#dinput');
    await page.keyboard.down('Control');
    await page.keyboard.down('Space');
    await expect(page.locator('#mic')).toHaveClass('rec');
    await page.keyboard.down('Space'); // auto-repeat must not restart or stop it
    await page.waitForTimeout(400);
    await expect(page.locator('#mic')).toHaveClass('rec');
    await page.keyboard.up('Space');
    await page.keyboard.up('Control');
    await expect(page.locator('#dinput')).toHaveValue('hello from voice');
    await page.locator('#dinput').evaluate((t) => t.blur());
    await page.keyboard.down('Alt');
    await page.keyboard.down('KeyV');
    await expect(page.locator('#mic')).toHaveClass('rec');
    await page.waitForTimeout(400);
    await page.keyboard.up('Alt'); // releasing the modifier first ends it too
    await expect(page.locator('#dinput')).toHaveValue('hello from voice hello from voice');
    await page.keyboard.up('KeyV');
  });

  test('window blur releases, pointercancel and lostpointercapture end the recording', async ({ page }) => {
    await setup(page);
    await hold(page, 500);
    await page.evaluate(() => dispatchEvent(new Event('blur')));
    await expect(page.locator('#dinput')).toHaveValue('hello from voice');
    await page.mouse.up();
    for (const type of ['pointercancel', 'lostpointercapture']) {
      await hold(page, 400);
      await page.evaluate((t) => document.getElementById('mic')!.dispatchEvent(new PointerEvent(t, { pointerId: (window as any).eval('held.ptr') })), type);
      await expect(page.locator('#mic')).not.toHaveClass(/rec/);
      await expect(page.locator('#dinput')).toHaveValue(/^hello from voice( hello from voice)+$/);
      await page.mouse.up();
    }
  });

  test('Escape while holding cancels without a request and keeps the panel open', async ({ page }) => {
    await setup(page);
    const n = posts(page);
    await hold(page, 0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#mic')).not.toHaveClass(/rec/);
    await page.mouse.up();
    await expect(page.locator('#panel')).toHaveClass(/open/);
    await page.waitForTimeout(300);
    expect(n.count).toBe(0);
    expect(await page.locator('#dinput').inputValue()).toBe('');
  });

  test('releasing while the recorder is still starting cancels and frees it', async ({ page }) => {
    await page.route('**/voice/start', async (r) => { await new Promise((ok) => setTimeout(ok, 700)); await r.continue(); });
    let id = '';
    page.on('response', async (r) => { if (r.url().endsWith('/voice/start')) id = (await r.json()).id; });
    await setup(page);
    const n = posts(page);
    await page.locator('#mic').hover();
    await page.mouse.down();
    await page.waitForTimeout(400);
    await page.mouse.up(); // before /voice/start answers
    await expect.poll(() => id, { timeout: 3000 }).not.toBe(''); // the start went through...
    await expect.poll(async () => (await levelOf(URL, id)).recording, { timeout: 3000 }).toBe(false); // ...and the UI cancelled it
    await expect(page.locator('#mic')).not.toHaveClass(/rec|busy/);
    expect(n.count).toBe(0);
    await page.unroute('**/voice/start');
    await hold(page); // not stuck: a new hold works
    await page.mouse.up();
    await expect(page.locator('#dinput')).toHaveValue('hello from voice');
  });

  test('Escape while transcribing does not abort it: the text still arrives', async ({ page }) => {
    await setup(page);
    await page.route('**/voice/stop', async (r) => { await new Promise((ok) => setTimeout(ok, 700)); await r.continue(); });
    await hold(page, 400);
    await page.mouse.up();
    await expect(page.locator('#mic')).toHaveClass('busy');
    await page.keyboard.press('Escape');
    await page.evaluate(() => dispatchEvent(new Event('blur')));
    await expect(page.locator('#mic')).toHaveClass('busy');
    await expect(page.locator('#dinput')).toHaveValue('hello from voice');
    await expect(page.locator('#mic')).not.toHaveClass(/rec|busy/);
  });

  test('the level poll is one request at a time and stops after release', async ({ page }) => {
    await setup(page);
    let open = 0, most = 0, total = 0;
    page.on('request', (r) => { if (r.url().endsWith('/voice/level')) { total++; most = Math.max(most, ++open); } });
    page.on('requestfinished', (r) => r.url().endsWith('/voice/level') && open--);
    page.on('requestfailed', (r) => r.url().endsWith('/voice/level') && open--);
    await page.route('**/voice/level', async (r) => { await new Promise((ok) => setTimeout(ok, 250)); await r.continue(); }); // a slow server must not pile requests up
    await hold(page, 1200);
    expect(most).toBe(1);
    expect(total).toBeGreaterThan(1);
    await page.mouse.up();
    await expect(page.locator('#dinput')).toHaveValue('hello from voice');
    const after = total;
    await page.waitForTimeout(700);
    expect(total).toBe(after);
  });

  test('a recording the server ended does not leave the button red', async ({ page }) => {
    let id = '';
    page.on('response', async (r) => { if (r.url().endsWith('/voice/start')) id = (await r.json()).id; });
    await setup(page);
    await page.route('**/voice/level', (r) => r.fulfill({ json: { recording: false, level: 0 } })); // lease expiry, a server restart, another tab
    await hold(page, 0);
    await expect(page.locator('#toastText')).toHaveText('Recording stopped');
    await expect(page.locator('#mic')).not.toHaveClass(/rec|busy/);
    await page.mouse.up();
    expect(await page.locator('#dinput').inputValue()).toBe('');
    await page.unroute('**/voice/level');
    await rpc(URL, '/voice/cancel', { id }); // the real recorder was never told
    await hold(page, 300); // and a new hold works
    await page.mouse.up();
    await expect(page.locator('#dinput')).toHaveValue('hello from voice');
  });

  test('recording stops by itself after 60 s', async ({ page }) => {
    await page.clock.install();
    await setup(page);
    await page.locator('#mic').hover();
    await page.mouse.down();
    await expect(page.locator('#mic')).toHaveClass('rec');
    await page.clock.fastForward(61_000);
    await expect(page.locator('#dinput')).toHaveValue('hello from voice');
    expect(await page.evaluate('held')).toBeNull(); // the timer ends the hold, so the late release is a no-op
    await page.mouse.up();
    await expect(page.locator('#mic')).not.toHaveClass(/rec|busy/); // pointer-events:none while busy must not leave it stuck
  });

  test('a recorder that cannot start shows a toast', async ({ page }) => {
    await page.route('**/voice/start', (r) => r.fulfill({ status: 409, body: 'pw-record not found' })); // 4xx: the helper ignores the console line the browser logs for it
    await setup(page);
    await page.locator('#mic').hover();
    await page.mouse.down();
    await expect(page.locator('#toastText')).toContainText('Microphone unavailable: pw-record not found'); // a release before the answer would count as a cancel and stay silent
    await page.mouse.up();
    await expect(page.locator('#mic')).not.toHaveClass(/rec|busy/);
  });

  test('routes: Origin and content-type are checked on every /voice route, one recording at a time, ids, level, cancel', async ({ page }) => {
    for (const path of ['/voice/start', '/voice/stop', '/voice/cancel', '/voice/level']) {
      expect((await rpc(URL, path, {}, '')).status, `${path} without Origin`).toBe(403);
      expect((await rpc(URL, path, {}, 'http://evil.example')).status, `${path} foreign Origin`).toBe(403);
      expect((await rpc(URL, path, {}, URL, 'text/plain')).status, `${path} wrong type`).toBe(403);
    }
    expect((await fetch(`${URL}/voice/level`)).status).toBe(404); // no GET any more: a poll renews a lease and needs the checks
    expect((await rpc(URL, '/voice/stop', { id: 'x' })).status).toBe(409); // nothing recording
    const id = await startId(URL);
    const dup = await rpc(URL, '/voice/start');
    expect(dup.status).toBe(409);
    expect(await dup.text()).toBe('already recording');
    await new Promise((r) => setTimeout(r, 300));
    const lvl = await levelOf(URL, id);
    expect(lvl.recording).toBe(true);
    expect(lvl.level).toBeGreaterThan(0.5); // the stub plays a constant tone
    expect((await levelOf(URL, 'stale')).recording).toBe(false); // another tab sees nothing
    expect((await rpc(URL, '/voice/stop', { id: 'stale' })).status).toBe(409);
    expect((await rpc(URL, '/voice/cancel', { id: 'stale' })).status).toBe(409);
    expect((await levelOf(URL, id)).recording).toBe(true); // and did not touch it
    expect((await rpc(URL, '/voice/cancel', { id })).status).toBe(204);
    expect((await levelOf(URL, id)).recording).toBe(false);
    const id2 = await startId(URL);
    expect(await (await rpc(URL, '/voice/stop', { id: id2 })).json()).toEqual({ text: 'hello from voice' });
    expect((await (await page.request.get('/workspaces')).json()).voiceMaxS).toBe(60);
    await page.goto('about:blank');
  });
});

// Server-side limits, with short timers: the cap (1 s) and the lease (1 s) of a recording nobody polls.
test.describe('voice server limits', () => {
  const P = MAIN_PORT + 1002, U = `http://127.0.0.1:${P}`;
  const pidfile = join(tmp('voicecap'), 'pid');
  let srv: ChildProcess;
  test.beforeAll(async () => {
    srv = start(P, { JARVIS_VOICE_MAX_S: '1', JARVIS_VOICE_LEASE_S: '1', JARVIS_VOICE_CAPTURE_CMD: `${process.execPath} ${join(import.meta.dirname, 'fake-capture.ts')} tone ${pidfile}` });
    await expect.poll(() => fetch(`${U}/workspaces`).then((r) => r.json()).then((b) => b.voice, () => false), { timeout: 15_000 }).toBe(true);
  });
  test.afterAll(async () => { if (srv.exitCode !== null || srv.signalCode) return; const exit = once(srv, 'exit'); srv.kill(); await exit; }); // the last case already killed it
  const alive = () => { try { process.kill(Number(readFileSync(pidfile, 'utf8')), 0); return true; } catch { return false; } };

  test('the 60 s cap (1 s here) stops capture, the samples still come out at stop, and the UI is told the cap', async () => {
    expect((await (await fetch(`${U}/workspaces`)).json()).voiceMaxS).toBe(1);
    const id = await startId(U);
    for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 250)); await levelOf(U, id); } // keeps the lease alive past the 1 s cap
    expect(alive()).toBe(false); // the recorder is closed
    expect(await (await rpc(U, '/voice/stop', { id })).json()).toEqual({ text: 'hello from voice' });
  });

  test('a client that vanishes without stop leaves no recorder and no open microphone', async () => {
    const id = await startId(U);
    expect(alive()).toBe(true);
    await expect.poll(async () => (await levelOf(U, id)).recording, { timeout: 4000, intervals: [1500] }).toBe(false); // nobody polled in time: the lease ran out
    await expect.poll(alive).toBe(false);
    await rpc(U, '/voice/cancel', { id: await startId(U) }); // and it is free again
  });

  test('killing Jarvis kills the recorder', async () => {
    await startId(U);
    expect(alive()).toBe(true);
    const exit = once(srv, 'exit');
    srv.kill('SIGKILL'); // no exit hook runs: setpriv --pdeathsig does it
    await exit;
    await expect.poll(alive, { timeout: 4000 }).toBe(false);
  });
});

test.describe('voice whose capture command fails', () => {
  const P = MAIN_PORT + 1004, U = `http://127.0.0.1:${P}`;
  let srv: ChildProcess;
  test.beforeAll(async () => {
    srv = start(P, { JARVIS_VOICE_CAPTURE_CMD: `${process.execPath} ${join(import.meta.dirname, 'fake-capture.ts')} exit` });
    await expect.poll(() => fetch(`${U}/workspaces`).then((r) => r.json()).then((b) => b.voice, () => false), { timeout: 15_000 }).toBe(true);
  });
  test.afterAll(async () => { const exit = once(srv, 'exit'); srv.kill(); await exit; });
  test.use({ baseURL: U });

  test('start answers 500 with the reason and the UI shows it in a toast', async ({ page, errors }) => {
    const r = await rpc(U, '/voice/start');
    expect(r.status).toBe(500);
    expect(await r.text()).toMatch(/exited with code 1 before any audio: stub: no PipeWire daemon/);
    const name = uniq('voicefail');
    expect((await page.request.post('/workspaces', { headers: { origin: U }, data: { name } })).ok()).toBe(true);
    await open(page, name);
    await page.locator('#core').click({ force: true });
    await page.locator('#mic').hover();
    await page.mouse.down();
    await expect(page.locator('#toastText')).toContainText('Microphone unavailable: ');
    await expect(page.locator('#toastText')).toContainText('stub: no PipeWire daemon');
    await page.mouse.up();
    await expect(page.locator('#mic')).not.toHaveClass(/rec|busy/);
    await expect.poll(() => errors.length).toBeGreaterThan(0); // the browser logs the 500 as a console error
    errors.length = 0;
  });
});

test.describe('voice without pw-record', () => {
  test('voice stays off and the log has one clear line', async () => {
    const P = MAIN_PORT + 1003;
    const srv = spawn(process.execPath, ['src/server.ts'], { env: { ...process.env, PORT: String(P), XDG_DATA_HOME: tmp('nopw'), JARVIS_FAKE_SDK: join(import.meta.dirname, 'fake-sdk.ts'), JARVIS_STATUS_URL: 'http://127.0.0.1:1/', JARVIS_VOICE: '1', JARVIS_VOICE_CMD: `${process.execPath} ${join(import.meta.dirname, 'fake-voice.ts')}`, JARVIS_VOICE_CAPTURE_CMD: '/nonexistent/pw-record' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    srv.stderr!.on('data', (d) => { log += d; });
    try {
      await expect.poll(() => log, { timeout: 15_000 }).toContain('voice disabled');
      expect(log.trim().split('\n')).toEqual(['voice disabled: /nonexistent/pw-record not found (install pipewire: PipeWire\'s pw-record captures the microphone)']);
      const body = await (await fetch(`http://127.0.0.1:${P}/workspaces`)).json();
      expect(body.voice).toBe(false);
      expect((await rpc(`http://127.0.0.1:${P}`, '/voice/start')).status).toBe(404);
    } finally { const exit = once(srv, 'exit'); srv.kill(); await exit; }
  });
});

test.describe('voice autosend', () => {
  const P = MAIN_PORT + 1001, U = `http://127.0.0.1:${P}`;
  const dir = tmp('voicesend');
  let srv: ChildProcess;
  test.beforeAll(async () => {
    srv = start(P, { XDG_DATA_HOME: dir });
    await expect.poll(() => fetch(`${U}/workspaces`).then((r) => r.json()).then((b) => b.voice, () => false), { timeout: 15_000 }).toBe(true);
  });
  test.afterAll(async () => { const exit = once(srv, 'exit'); srv.kill(); await exit; });
  test.use({ baseURL: U });

  const setup = async (page: Page) => {
    const name = uniq('voicesend');
    expect((await page.request.post('/workspaces', { headers: { origin: U }, data: { name } })).ok()).toBe(true);
    await open(page, name);
    await page.locator('#core').click({ force: true });
  };
  const mk = async (page: Page) => { const name = uniq('voicesend'); const r = await page.request.post('/workspaces', { headers: { origin: U }, data: { name } }); expect(r.ok()).toBe(true); return { name, id: (await r.json()).id as string }; };
  const posts = (page: Page) => { const n = { count: 0 }; page.on('request', (r) => r.url().endsWith('/voice/stop') && n.count++); return n; };
  const sends = (page: Page) => { const l: any[] = []; page.on('request', (r) => r.url().endsWith('/send') && l.push(r.postDataJSON())); return l; };
  const hold = async (page: Page) => { await page.locator('#mic').hover(); await page.mouse.down(); await expect(page.locator('#mic')).toHaveClass('rec'); await page.waitForTimeout(500); await page.mouse.up(); };

  test('release sends the transcript to the agent selected at press time and leaves the draft', async ({ page }) => {
    expect((await (await page.request.get('/workspaces')).json()).voiceAutosend).toBe(true);
    await setup(page);
    const l = sends(page);
    await page.fill('#dinput', 'my draft');
    await page.route('**/voice/stop', async (r) => { await new Promise((ok) => setTimeout(ok, 600)); await r.continue(); });
    await page.locator('#mic').hover();
    await page.mouse.down();
    await expect(page.locator('#mic')).toHaveClass('rec');
    expect(await page.evaluate('selected')).toBe('arbiter'); // the target is captured now
    await page.waitForTimeout(500);
    await page.mouse.up();
    await expect(page.locator('#mic')).toHaveClass('busy');
    await page.mouse.down(); // presses are ignored while transcribing
    await page.mouse.up();
    await page.locator('#pclose').click({ force: true }); // the user moves on meanwhile
    await expect(page.locator('#log .user').filter({ hasText: 'hello from voice' })).toHaveCount(0);
    await expect.poll(() => l.length).toBe(1);
    expect(l[0]).toMatchObject({ text: 'hello from voice', id: 'arbiter' });
    await page.locator('#core').click({ force: true });
    await expect(page.locator('#log .user').filter({ hasText: 'hello from voice' })).toBeVisible();
    await expect(page.locator('#dinput')).toHaveValue('my draft');
    await expect(page.locator('#mic')).not.toHaveClass(/rec|busy/);
  });

  test('an empty transcript sends nothing', async ({ page }) => {
    await setup(page);
    const l = sends(page);
    await page.route('**/voice/stop', async (r) => r.fulfill({ response: await r.fetch(), json: { text: ' ' } })); // the server must still see the stop, or its recorder stays busy
    await hold(page);
    await expect(page.locator('#toastText')).toHaveText('No speech recognized');
    await page.waitForTimeout(300);
    expect(l.length).toBe(0);
    expect(await page.locator('#dinput').inputValue()).toBe('');
  });

  test('a failed send keeps the text in the draft', async ({ page }) => {
    await setup(page);
    await page.route('**/send', (r) => r.fulfill({ status: 400, body: 'boom' }));
    await hold(page);
    await expect(page.locator('#dinput')).toHaveValue('hello from voice');
    await expect(page.locator('#toastText')).toContainText('send failed');
  });

  test('window blur cancels instead of sending a partial clip', async ({ page }) => {
    await setup(page);
    const l = sends(page), n = posts(page);
    await page.locator('#mic').hover();
    await page.mouse.down();
    await expect(page.locator('#mic')).toHaveClass('rec');
    await page.waitForTimeout(400);
    await page.evaluate(() => dispatchEvent(new Event('blur')));
    await expect(page.locator('#mic')).not.toHaveClass(/rec|busy/);
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(n.count + l.length).toBe(0);
  });

  test('switching the workspace between press and release still sends to the original one', async ({ page }) => {
    const a = await mk(page), b = await mk(page);
    await open(page, a.name);
    await page.locator('#core').click({ force: true });
    const l = sends(page);
    await page.locator('#mic').hover();
    await page.mouse.down();
    await expect(page.locator('#mic')).toHaveClass('rec');
    await page.waitForTimeout(400);
    await tab(page, b.name).evaluate((t) => (t as HTMLElement).click());
    await expect(tab(page, b.name)).toHaveClass('active');
    await page.mouse.up();
    await expect.poll(() => l.length).toBe(1);
    expect(l[0]).toMatchObject({ ws: a.id, id: 'arbiter', text: 'hello from voice' });
  });

  test('a guarded sub-agent: no recording until the input is unlocked, then the voice goes to it', async ({ page }) => {
    const { name, id } = await mk(page);
    expect((await page.request.post('/workspaces/archive', { headers: { origin: U }, data: { ws: id } })).ok()).toBe(true);
    const agent = { id: 'sub1', name: 'sub1', task: '', cwd: tmp('agent'), status: 'idle', lastText: '', costUsd: 0, parentId: 'arbiter' };
    appendFileSync(join(dir, 'jarvis', 'archive', id, 'events.jsonl'), JSON.stringify({ type: 'spawned', at: Date.now(), agent }) + '\n');
    expect((await page.request.post('/workspaces/restore', { headers: { origin: U }, data: { id } })).ok()).toBe(true);
    await open(page, name);
    const l = sends(page), n = posts(page), starts = { count: 0 };
    page.on('request', (r) => r.url().endsWith('/voice/start') && starts.count++);
    await page.locator('#nodes .node', { hasText: 'sub1' }).press('Enter');
    await expect(page.locator('#dinput')).toHaveJSProperty('readOnly', true);
    await page.locator('#mic').hover();
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('#toastText')).toContainText('double-click the input to unlock');
    await page.keyboard.down('Alt'); await page.keyboard.down('KeyV'); await page.keyboard.up('KeyV'); await page.keyboard.up('Alt');
    await page.waitForTimeout(300);
    expect(starts.count).toBe(0);
    expect(l.length + n.count).toBe(0);
    await page.locator('#dinput').dblclick();
    await expect(page.locator('#dinput')).toHaveJSProperty('readOnly', false);
    await hold(page);
    await expect.poll(() => l.length).toBe(1);
    expect(l[0]).toMatchObject({ id: 'sub1', text: 'hello from voice' });
  });
});

test.describe('voice autosend guard', () => {
  const P = MAIN_PORT + 1005, U = `http://127.0.0.1:${P}`;
  const dir = tmp('voiceguard');
  let srv: ChildProcess;
  test.beforeAll(async () => {
    srv = start(P, { XDG_DATA_HOME: dir });
    await expect.poll(() => fetch(`${U}/workspaces`).then((r) => r.json()).then((b) => b.voice, () => false), { timeout: 15_000 }).toBe(true);
  });
  test.afterAll(async () => { const exit = once(srv, 'exit'); srv.kill(); await exit; });
  test.use({ baseURL: U });

  test('selecting another agent while recording re-locks the guard: the text goes to the draft, not to /send', async ({ page }) => {
    const name = uniq('voiceguard');
    const r = await page.request.post('/workspaces', { headers: { origin: U }, data: { name } });
    const id = (await r.json()).id as string;
    expect((await page.request.post('/workspaces/archive', { headers: { origin: U }, data: { ws: id } })).ok()).toBe(true);
    const agent = { id: 'sub1', name: 'sub1', task: '', cwd: tmp('agent'), status: 'idle', lastText: '', costUsd: 0, parentId: 'arbiter' };
    appendFileSync(join(dir, 'jarvis', 'archive', id, 'events.jsonl'), JSON.stringify({ type: 'spawned', at: Date.now(), agent }) + '\n');
    expect((await page.request.post('/workspaces/restore', { headers: { origin: U }, data: { id } })).ok()).toBe(true);
    await open(page, name);
    const sends: any[] = [];
    page.on('request', (q) => q.url().endsWith('/send') && sends.push(q.postDataJSON()));
    await page.locator('#nodes .node', { hasText: 'sub1' }).press('Enter');
    await page.locator('#dinput').dblclick(); // unlock sub1
    await expect(page.locator('#dinput')).toHaveJSProperty('readOnly', false);
    await page.locator('#mic').hover();
    await page.mouse.down();
    await expect(page.locator('#mic')).toHaveClass('rec');
    await page.waitForTimeout(400);
    await page.evaluate("select('arbiter')"); // unlocking is per selection: coming back to sub1 would be guarded again
    await page.evaluate("select('sub1')");
    await page.mouse.up();
    await expect(page.locator('#toastText')).toContainText('Agent is guarded');
    await page.waitForTimeout(300);
    expect(sends).toEqual([]);
    await expect(page.locator('#dinput')).toHaveValue('hello from voice'); // the draft of the agent it was meant for
  });
});

test.describe('voice off', () => {
  test('no button, no recording, routes are 404', async ({ page }) => {
    const reqs: string[] = [];
    page.on('request', (r) => r.url().includes('/voice/') && reqs.push(r.url()));
    expect((await (await page.request.get('/workspaces')).json()).voice).toBe(false);
    const name = uniq('voiceoff');
    await page.request.post('/workspaces', { headers: { origin: MAIN }, data: { name } });
    await open(page, name);
    await page.locator('#core').click({ force: true });
    await expect(page.locator('#mic')).toBeHidden();
    await page.focus('#dinput');
    await page.keyboard.press('Control+Space');
    await page.keyboard.press('Alt+V');
    expect(reqs).toEqual([]);
    for (const path of ['/voice/start', '/voice/stop', '/voice/cancel', '/voice/level']) expect((await page.request.post(path, { headers: { origin: MAIN, 'content-type': 'application/json' }, data: {} })).status()).toBe(404);
    expect((await page.request.post('/voice/level', { headers: { origin: MAIN, 'content-type': 'application/json' }, data: {} })).status()).toBe(404);
  });
});
