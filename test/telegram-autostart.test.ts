// Autostart of the Telegram bridge by the server: the failure paths, the lock retry and the child's end with its parent (no token, 401, lock held, missing binary). Never the real Telegram API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { startTelegram } from '../src/telegram-autostart.ts';
import { lock } from '../src/telegram-bridge.ts';

const TOKEN = '123456:FAKE-token_for-tests';
const tmp = mkdtempSync(join(tmpdir(), 'jarvis-tg-autostart-'));

// Runs the real bridge as the server would and collects the log lines until it is done. The base env has no Telegram setting of the machine, so a test never reaches a real bot, state file or lock.
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^TELEGRAM_|^JARVIS_URL$/.test(k)));
async function run(env: NodeJS.ProcessEnv, cmd?: string[], more: { retries?: number; retryMs?: number } = {}) {
  const lines: string[] = [];
  const h = startTelegram({ cmd, ...more, env: { ...clean, JARVIS_ENV_FILE: '/dev/null', TELEGRAM_ENV_FILE: '/dev/null', XDG_DATA_HOME: tmp, ...env }, log: (s) => lines.push(s) });
  await Promise.race([h.done, new Promise((_, no) => setTimeout(() => no(new Error('bridge did not end')), 15_000).unref())]);
  return lines;
}

test('no token: one clear line, no throw', async () => {
  const lines = await run({ TELEGRAM_BOT_TOKEN: '' });
  assert.ok(lines.some((l) => l.includes('TELEGRAM_BOT_TOKEN is not set')));
  assert.ok(lines.at(-1)!.includes('Jarvis keeps running'));
});

test('ids missing: one clear line', async () => {
  const lines = await run({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER: '', TELEGRAM_CHAT_ID: '' });
  assert.ok(lines.some((l) => l.includes('TELEGRAM_ALLOWED_USER is not set')));
});

test('401 from Telegram: logged without the token', async () => {
  const srv = createServer((req, res) => { req.resume(); res.writeHead(401, { 'content-type': 'application/json' }).end('{"ok":false,"error_code":401,"description":"Unauthorized"}'); });
  const port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as any).port)));
  try {
    const lines = await run({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER: '1', TELEGRAM_CHAT_ID: '-100', TELEGRAM_API_BASE: `http://127.0.0.1:${port}`, TELEGRAM_STATE_FILE: join(tmp, 'a401.json') });
    assert.ok(lines.some((l) => l.includes('getChat: 401')));
    assert.ok(lines.at(-1)!.includes('bridge stopped (exit 1)'));
    assert.ok(!lines.join('\n').includes(TOKEN));
  } finally { srv.close(); }
});

test('lock held by another bridge: no second bridge, no failure line', async () => {
  const state = join(tmp, 'locked.json');
  const unlock = lock(`${state}.lock`);
  try {
    const lines = await run({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER: '1', TELEGRAM_CHAT_ID: '-100', TELEGRAM_API_BASE: 'http://127.0.0.1:1', TELEGRAM_STATE_FILE: state }, undefined, { retries: 1, retryMs: 20 });
    assert.deepEqual(lines, ['telegram: a bridge already runs separately, not starting another']);
  } finally { unlock(); }
});

test('child gets JARVIS_URL from PORT, a set JARVIS_URL stays', async () => {
  const cmd = [process.execPath, '-e', 'console.error(process.env.JARVIS_URL)'];
  assert.deepEqual(await run({ PORT: '7811' }, cmd), ['telegram: http://127.0.0.1:7811']);
  assert.deepEqual(await run({ PORT: '7811', JARVIS_URL: 'http://127.0.0.1:1' }, cmd), ['telegram: http://127.0.0.1:1']);
});

test('missing binary: logged, no throw', async () => {
  const lines = await run({}, [join(tmp, 'no-such-binary')]);
  assert.equal(lines.length, 1);
  assert.ok(lines.some((l) => l.startsWith('telegram: not started:')));
});

// The bridge must not outlive Jarvis: a fake parent runs the fake bridge, then ends in every way a server can end.
const gone = (pid: number) => {
  try { process.kill(pid, 0); } catch { return true; }
  try { return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; } // a zombie is dead too
};
async function parentThen(mode: string, end: (p: ChildProcess) => void) {
  const p = spawn(process.execPath, [join(import.meta.dirname, 'fake-telegram-parent.ts'), mode], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, JARVIS_ENV_FILE: '/dev/null' } });
  let out = '';
  p.stdout!.setEncoding('utf8').on('data', (d) => { out += d; });
  for (let i = 0; i < 500 && !/child \d+/.test(out); i++) await new Promise((r) => setTimeout(r, 20));
  const pid = Number(/child (\d+)/.exec(out)?.[1]);
  assert.ok(pid, 'parent reported no child');
  assert.equal(gone(pid), false, 'child should be running');
  await new Promise((r) => setTimeout(r, 300)); // let the child start for real
  try { end(p); for (let i = 0; i < 250 && !gone(pid); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(gone(pid), `child ${pid} outlived the parent`); }
  finally { p.kill('SIGKILL'); try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

test('child bridge ends when the parent exits normally', () => parentThen('exit', () => {}));
test('child bridge ends on SIGTERM of the parent', () => parentThen('wait', (p) => p.kill('SIGTERM')));
test('child bridge ends on SIGINT of the parent', () => parentThen('wait', (p) => p.kill('SIGINT')));
test('child bridge ends on SIGKILL of the parent (pdeathsig)', { skip: !existsSync('/usr/bin/setpriv') && 'no setpriv' }, () => parentThen('wait', (p) => p.kill('SIGKILL')));

// After `jarvis restart` the old bridge still holds the lock for a moment: the new one retries instead of giving up.
const flaky = (n: number) => {
  const count = join(tmp, `count-${n}-${Math.random()}`);
  writeFileSync(count, '0');
  const js = `const f=${JSON.stringify(count)},fs=require('fs'),k=+fs.readFileSync(f)+1;fs.writeFileSync(f,String(k));if(k<=${n}){console.error('another telegram bridge is running (pid 1); lock file x');process.exit(75)}console.error('telegram bridge up');`;
  return { cmd: [process.execPath, '-e', js], runs: () => Number(readFileSync(count, 'utf8')) };
};

test('a lock held for a moment is retried and the bridge then starts', async () => {
  const f = flaky(2);
  const lines = await run({}, f.cmd, { retries: 3, retryMs: 20 });
  assert.equal(f.runs(), 3);
  assert.deepEqual(lines, ['telegram: telegram bridge up']);
});

test('a lock that stays is logged once after the retries', async () => {
  const f = flaky(99);
  const lines = await run({}, f.cmd, { retries: 2, retryMs: 20 });
  assert.equal(f.runs(), 3);
  assert.deepEqual(lines, ['telegram: a bridge already runs separately, not starting another']);
});
