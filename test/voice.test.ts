import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createSidecar, createRecorder, createMuter, withDebugDump } from '../src/voice.ts';

const stub = join(import.meta.dirname, '..', 'e2e', 'fake-voice.ts');
const mk = (idleMs = 60_000) => createSidecar(process.execPath, [stub], idleMs);
const pcm = (n: number) => Buffer.alloc(n);
const capture = join(import.meta.dirname, '..', 'e2e', 'fake-capture.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('transcribes, spawns lazily and reuses the process', async () => {
  const s = mk();
  assert.equal(s.pid(), undefined);
  assert.equal(await s.transcribe(pcm(100)), 'hello from voice');
  const pid = s.pid();
  assert.ok(pid);
  assert.equal(await s.transcribe(pcm(8)), 'hello from voice');
  assert.equal(s.pid(), pid);
  s.close();
});

test('jobs queue one at a time, in order', async () => {
  const s = mk();
  const r = await Promise.all([s.transcribe(pcm(10)), s.transcribe(pcm(6)), s.transcribe(pcm(12))]);
  assert.deepEqual(r, ['hello from voice', '', 'hello from voice']);
  s.close();
});

test('sidecar error line rejects with its message', async () => {
  const s = mk();
  await assert.rejects(s.transcribe(pcm(4)), /stub error/);
  assert.equal(await s.transcribe(pcm(10)), 'hello from voice');
  s.close();
});

test('a crash fails one job, the next restarts the process', async () => {
  const s = mk();
  await s.transcribe(pcm(10));
  const pid = s.pid();
  await assert.rejects(s.transcribe(pcm(2)), /crashed/);
  assert.equal(await s.transcribe(pcm(10)), 'hello from voice');
  assert.notEqual(s.pid(), pid);
  s.close();
});

test('a hung job times out, kills the process and the next job restarts it', async () => {
  const s = createSidecar(process.execPath, [stub], 60_000, 300);
  await s.transcribe(pcm(10));
  const pid = s.pid()!;
  await assert.rejects(s.transcribe(pcm(14)), /timed out/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(pid), false);
  assert.equal(await s.transcribe(pcm(10)), 'hello from voice');
  assert.notEqual(s.pid(), pid);
  s.close();
});

test('a job queued right behind a hung one is not hit by the killed child', async () => {
  const s = createSidecar(process.execPath, [stub], 60_000, 300);
  const hung = assert.rejects(s.transcribe(pcm(14)), /timed out/);
  const next = s.transcribe(pcm(10)); // queued at once, no wait
  await hung;
  assert.equal(await next, 'hello from voice');
  assert.equal(await s.transcribe(pcm(12)), 'hello from voice');
  s.close();
});

test('a job right after the idle kill gets a fresh process', async () => {
  const s = mk(50);
  await s.transcribe(pcm(10));
  await new Promise((r) => setTimeout(r, 53)); // about when the idle timer fires
  for (let i = 0; i < 5; i++) assert.equal(await s.transcribe(pcm(10)), 'hello from voice');
  assert.ok(s.pid());
  s.close();
});

test('the idle timeout kills the process', async () => {
  const s = mk(100);
  await s.transcribe(pcm(10));
  const pid = s.pid()!;
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(alive(pid), false);
  assert.equal(await s.transcribe(pcm(10)), 'hello from voice');
  s.close();
});

test('JARVIS_VOICE unset: voice is off and the /voice routes are 404', async () => {
  const port = 7900 + (process.pid % 90);
  const code = `
    const r = await fetch('http://127.0.0.1:${port}/workspaces').then((r) => r.json());
    const p = await fetch('http://127.0.0.1:${port}/voice/start', { method: 'POST', headers: { origin: 'http://127.0.0.1:${port}', 'content-type': 'application/json' }, body: '{}' });
    console.log(JSON.stringify({ voice: r.voice, status: p.status }));
    process.exit(0);`;
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const data = mkdtempSync(join(tmpdir(), 'jarvis-voice-'));
  const { spawn } = await import('node:child_process');
  const { JARVIS_VOICE: _, ...base } = process.env;
  const env = { ...base, PORT: String(port), XDG_DATA_HOME: data, JARVIS_STATUS_URL: 'http://127.0.0.1:1/', JARVIS_VOICE_CMD: `${process.execPath} ${stub}`, JARVIS_VOICE_CAPTURE_CMD: `${process.execPath} ${capture}` }; // the stubs must not switch voice on by itself
  const srv = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'server.ts')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((ok) => srv.stdout.on('data', (d) => /jarvis UI/.test(String(d)) && ok(0)));
    const out = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' }).stdout;
    assert.deepEqual(JSON.parse(out), { voice: false, status: 404 });
  } finally { srv.kill(); }
});

test('debug dump writes last.wav (16 kHz mono s16) and last.txt, overwriting', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'jv-dump-')), 'sub');
  let n = 0;
  const t = withDebugDump(async () => `text ${++n}`, dir);
  assert.equal(await t(Buffer.alloc(6, 1)), 'text 1');
  assert.equal(await t(Buffer.alloc(4, 2)), 'text 2');
  const w = readFileSync(join(dir, 'last.wav'));
  assert.equal(w.length, 48);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(w.readUInt32LE(4), 40);
  assert.equal(w.readUInt16LE(22), 1);
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.readUInt16LE(34), 16);
  assert.equal(w.readUInt32LE(40), 4);
  assert.deepEqual([...w.subarray(44)], [2, 2, 2, 2]);
  assert.equal(readFileSync(join(dir, 'last.txt'), 'utf8'), 'text 2');
});

test('debug dump failure does not fail the transcription', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'jv-dump-')), 'f');
  writeFileSync(dir, 'x'); // a file where the directory should go
  assert.equal(await withDebugDump(async () => 'ok', dir)(Buffer.alloc(2)), 'ok');
  assert.ok(!existsSync(join(dir, 'last.wav')));
});

const rec = (mode = 'tone', o = {}) => {
  const pidfile = join(mkdtempSync(join(tmpdir(), 'jv-cap-')), 'pid');
  const r = createRecorder([process.execPath, capture, mode, pidfile], o);
  return { r, pid: () => Number(readFileSync(pidfile, 'utf8')) };
};

test('recorder: start, stop returns whole s16 samples, the child is gone', async () => {
  const { r, pid } = rec();
  const id = await r.start();
  await sleep(350);
  const l = r.level(id);
  assert.equal(l.recording, true);
  assert.ok(Math.abs(l.level - Math.min(1, (8000 / 32768) * 4)) < 0.01, `level ${l.level}`);
  const p = pid();
  const pcm = await r.stop(id);
  assert.ok(pcm.length >= 3200 * 3 && pcm.length % 2 === 0, `${pcm.length} bytes`);
  assert.equal(pcm.readInt16LE(0), 8000);
  assert.equal(alive(p), false);
  assert.deepEqual(r.level(id), { recording: false, level: 0 });
  await assert.rejects(r.stop(id), /not recording/);
});

test('recorder: odd-sized chunks give an even PCM and a level on whole samples', async () => {
  const { r } = rec('odd');
  const id = await r.start();
  await sleep(450);
  const l = r.level(id);
  assert.ok(Math.abs(l.level - Math.min(1, (8000 / 32768) * 4)) < 0.01, `level ${l.level}`); // a misaligned read would give noise
  const pcm = await r.stop(id);
  assert.ok(pcm.length > 0 && pcm.length % 2 === 0, `${pcm.length} bytes`);
});

test('recorder: a second start is 409, cancel discards and frees the recorder', async () => {
  const { r, pid } = rec();
  const id = await r.start();
  await assert.rejects(r.start(), (e: any) => e.status === 409);
  const p = pid();
  r.cancel(id);
  await sleep(100);
  assert.equal(alive(p), false);
  await assert.rejects(r.stop(id), /not recording/);
  r.cancel(id); // nothing left: a no-op
  r.cancel(await r.start()); // free again
});

test('recorder: another client\'s id cannot stop, cancel or poll the recording', async () => {
  const { r, pid } = rec('tone', { leaseMs: 300 });
  const id = await r.start();
  await assert.rejects(r.stop('stale'), (e: any) => e.status === 409);
  assert.throws(() => r.cancel('stale'), (e: any) => e.status === 409);
  assert.deepEqual(r.level('stale'), { recording: false, level: 0 });
  assert.equal(alive(pid()), true);
  await sleep(500); // the stale polls did not renew the lease
  assert.equal(r.level(id).recording, false);
});

test('recorder: the cap stops the child but keeps the samples for stop', async () => {
  const { r, pid } = rec('tone', { maxMs: 400 });
  const id = await r.start();
  await sleep(700);
  assert.equal(alive(pid()), false);
  const pcm = await r.stop(id);
  assert.ok(pcm.length >= 3200 * 3 && pcm.length <= 3200 * 7, `${pcm.length} bytes`);
});

test('recorder: stop racing the cap neither throws nor hangs nor loses the samples', async () => {
  for (const wait of [330, 380, 395, 400, 405, 420, 470]) {
    const { r } = rec('tone', { maxMs: 400 });
    const t0 = Date.now();
    const id = await r.start();
    await sleep(Math.max(0, wait - (Date.now() - t0)));
    const pcm = await r.stop(id);
    assert.ok(pcm.length >= 3200 && pcm.length % 2 === 0, `${wait}: ${pcm.length} bytes`);
  }
});

test('recorder: without level polls the lease kills the child and frees the recorder', async () => {
  const { r, pid } = rec('tone', { leaseMs: 300 });
  const id = await r.start();
  const p = pid();
  for (let i = 0; i < 5; i++) { await sleep(150); assert.equal(r.level(id).recording, true); } // polling keeps it alive past the lease
  await sleep(600);
  assert.equal(alive(p), false);
  assert.equal(r.level(id).recording, false);
  r.cancel(await r.start());
});

test('recorder: a missing command, an early exit and silence reject start with a clear message', async () => {
  await assert.rejects(createRecorder(['/nonexistent/pw-record']).start(), (e: any) => /pw-record not found/.test(e.message) && e.status === 500);
  await assert.rejects(rec('exit').r.start(), (e: any) => /exited with code 1 before any audio: stub: no PipeWire daemon/.test(e.message) && e.status === 500);
  await assert.rejects(rec('silent', { startMs: 300 }).r.start(), /sent no audio/);
  const { r } = rec();
  r.cancel(await r.start()); // none of the failures left the recorder busy
});

test('debug dump: private modes, and a symlink at last.wav is replaced, not written through', async () => {
  const { symlinkSync, statSync } = await import('node:fs');
  const dir = join(mkdtempSync(join(tmpdir(), 'jv-dump-')), 'd');
  const target = join(mkdtempSync(join(tmpdir(), 'jv-victim-')), 'victim');
  writeFileSync(target, 'keep');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { mode: 0o700 });
  symlinkSync(target, join(dir, 'last.wav'));
  await withDebugDump(async () => 'hi', dir)(Buffer.alloc(2));
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  assert.equal(readFileSync(join(dir, 'last.wav')).length, 46);
  assert.equal(statSync(join(dir, 'last.wav')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'last.txt')).mode & 0o777, 0o600);
  const fresh = join(mkdtempSync(join(tmpdir(), 'jv-dump-')), 'new');
  await withDebugDump(async () => 'x', fresh)(Buffer.alloc(2));
  assert.equal(statSync(fresh).mode & 0o777, 0o700);
});

// Output mute: the stub keeps the sink state in a file and logs every set-mute.
const mutedRec = (mode = 'tone', premuted = false) => {
  const file = join(mkdtempSync(join(tmpdir(), 'jv-mute-')), 'sink');
  if (premuted) writeFileSync(file, '1');
  const muter = createMuter([process.execPath, join(import.meta.dirname, '..', 'e2e', 'fake-mute.ts'), file]);
  const r = createRecorder([process.execPath, capture, mode], { muter });
  return { r, muted: () => existsSync(file) && readFileSync(file, 'utf8') === '1', log: () => existsSync(`${file}.log`) ? readFileSync(`${file}.log`, 'utf8').trim().split('\n') : [] };
};

test('mute: the output is muted while recording and restored by stop', async () => {
  const { r, muted, log } = mutedRec();
  const id = await r.start();
  assert.equal(muted(), true);
  await r.stop(id);
  assert.equal(muted(), false);
  assert.deepEqual(log(), ['1', '0']);
});

test('mute: cancel (tap and Esc end here) restores', async () => {
  const { r, muted } = mutedRec();
  r.cancel(await r.start());
  await sleep(100);
  assert.equal(muted(), false);
});

test('mute: a failed start restores', async () => {
  const { r, muted, log } = mutedRec('exit');
  await assert.rejects(r.start(), /exited/);
  assert.equal(muted(), false);
  assert.deepEqual(log(), ['1', '0']);
});

test('mute: a sink the user muted stays muted', async () => {
  const { r, muted, log } = mutedRec('tone', true);
  await r.stop(await r.start());
  assert.equal(muted(), true);
  assert.deepEqual(log(), []);
});

test('mute: restore is idempotent and a missing command never throws', () => {
  const m = createMuter(['/nonexistent/wpctl']);
  m.engage(); m.restore(); m.restore();
});
