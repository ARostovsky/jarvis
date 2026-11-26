// POST /local-file/open: same policy as GET /local-file, plus same-origin JSON only, rate limit, and a stub opener (never the real xdg-open).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 17000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), 'jarvis-lfo-'));
const out = mkdtempSync(join(tmpdir(), 'jarvis-lfo-out-'));
const log = join(tmp, '..', `${tmp.split('/').pop()}.log`); // outside the root
const stub = join(out, 'stub.sh');
const file = (p: string, c = 'x') => (mkdirSync(join(p, '..'), { recursive: true }), writeFileSync(p, c), p);
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let server: ChildProcess;

before(async () => {
  writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$JARVIS_OPEN_LOG"\n');
  chmodSync(stub, 0o755);
  server = spawn(process.execPath, ['src/server.ts'], { stdio: 'ignore', env: { ...process.env, PORT: String(PORT), XDG_DATA_HOME: join(out, 'data'), JARVIS_FILE_ROOTS: tmp, JARVIS_OPEN_CMD: stub, JARVIS_OPEN_LOG: log, JARVIS_HEALTH_PROBE: '0', JARVIS_PROVIDERS_DIR: join(out, 'prov'), JARVIS_STATUS_URL: 'http://127.0.0.1:1/' } });
  for (let i = 0; i < 100; i++) { try { await fetch(`${base}/recent`); return; } catch { await wait(100); } }
  throw new Error('server did not start');
});
after(() => server.kill());

const open = (path: unknown, h: Record<string, string> = { origin: base, 'content-type': 'application/json' }) =>
  fetch(`${base}/local-file/open`, { method: 'POST', headers: h, body: JSON.stringify({ path }) }).then((r) => r.status);

// Tests share the rate limit (10 per 10 s): keep the allowed/denied calls under it, the limit test comes last.
test('allowed file: the opener gets the real path', async () => {
  symlinkSync(file(join(tmp, 'real.png')), join(tmp, 'link.png'));
  assert.equal(await open(join(tmp, 'link.png')), 200);
  for (let i = 0; i < 50 && !calls().length; i++) await wait(50);
  assert.deepEqual(calls(), [join(tmp, 'real.png')]);
});

test('html is view-only (like svg): 415 and the opener never runs; GET still serves them', async () => {
  const h = file(join(tmp, 'v.html'), '<script>1</script>'); // one open only: the shared rate limit is nearly used up
  assert.equal(await open(h), 415);
  assert.equal((await fetch(`${base}/local-file?path=${encodeURIComponent(h)}`)).headers.get('content-type'), 'text/plain; charset=utf-8');
  await wait(200);
  assert.equal(calls().length, 1);
});

test('denied paths: 404 and the opener never runs', async () => {
  symlinkSync(file(join(out, 'o.png')), join(tmp, 'esc.png'));
  mkdirSync(join(tmp, 'd.png'));
  for (const p of [file(join(out, 'a.png')), file(join(tmp, '.ssh', 'a.txt')), join(tmp, 'esc.png'), file(join(tmp, 'x.sh')), file(join(tmp, 'x.desktop')), join(tmp, 'd.png'), 'real.png', undefined]) {
    assert.equal(await open(p), 404, String(p));
  }
  await wait(200);
  assert.equal(calls().length, 1); // only the allowed one before
});

test('cross-origin, missing origin, wrong content type: 403; GET: 405', async () => {
  const p = join(tmp, 'real.png');
  assert.equal(await open(p, { origin: 'http://evil.example', 'content-type': 'application/json' }), 403);
  assert.equal(await open(p, { 'content-type': 'application/json' }), 403);
  assert.equal(await open(p, { origin: base, 'content-type': 'text/plain' }), 403);
  assert.equal((await fetch(`${base}/local-file/open?path=${encodeURIComponent(p)}`)).status, 405);
  await wait(200);
  assert.equal(calls().length, 1);
});

test('rate limit: more than 10 opens in 10 s get 429', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 12; i++) codes.push(await open(join(tmp, 'real.png')));
  assert.ok(codes.includes(429), codes.join());
});

test('GET /local-file: only our own page reads (Sec-Fetch-Site / Origin / Referer)', async () => {
  const get = (h: Record<string, string>) => fetch(`${base}/local-file?path=${encodeURIComponent(file(join(tmp, 'g.txt')))}`, { headers: h }).then((r) => r.status);
  assert.equal(await get({ 'sec-fetch-site': 'cross-site' }), 404);
  assert.equal(await get({ 'sec-fetch-site': 'same-site' }), 404);
  assert.equal(await get({ 'sec-fetch-site': 'same-origin' }), 200);
  assert.equal(await get({ 'sec-fetch-site': 'none' }), 200);
  assert.equal(await get({}), 200);
  assert.equal(await get({ referer: `${base}/x` }), 200);
  assert.equal(await get({ origin: 'http://evil.example' }), 404);
  assert.equal(await get({ referer: 'http://evil.example/a' }), 404);
});
