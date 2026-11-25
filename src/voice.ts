// Optional voice input: server-side capture (pw-record) -> Python sidecar (voice/server.py, faster-whisper) -> text.
// Loaded by server.ts only when JARVIS_VOICE is set, so a broken file here cannot break a plain start.
// Sidecar protocol: stdin = frames of 4-byte big-endian length N + N bytes PCM s16le 16 kHz mono; stdout = one JSON line per frame, {"text"} or {"error"}; stderr = logs; EOF on stdin = exit.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { resolve, delimiter } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

type Job = { pcm: Buffer; ok: (text: string) => void; fail: (e: Error) => void };

// One sidecar process, spawned on the first job, one job at a time, killed after idleMs without work.
// A crash or a job running longer than timeoutMs fails that job only (a hung process is killed); the next job spawns a fresh process.
export function createSidecar(cmd: string, args: string[], idleMs: number, timeoutMs = 120_000) {
  let child: ChildProcess | undefined;
  let job: Job | undefined;
  let idle: NodeJS.Timeout | undefined;
  let limit: NodeJS.Timeout | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const finish = (f: (j: Job) => void) => { const j = job; job = undefined; if (j) f(j); };
  const start = () => {
    const c = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    child = c;
    let buf = ''; // per child: a killed child must not feed the next one
    // Every handler ignores a child that is no longer current (killed by the timeout or the idle timer): its events must not touch the next job.
    c.stdout!.setEncoding('utf8').on('data', (d: string) => {
      if (child !== c) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        finish((j) => {
          try {
            const r = JSON.parse(line);
            if (typeof r.error === 'string') j.fail(new Error(r.error));
            else j.ok(String(r.text ?? ''));
          } catch { j.fail(new Error('voice sidecar sent invalid output')); }
        });
      }
    });
    c.stdin!.on('error', () => {}); // a dead child surfaces through 'exit'
    c.on('error', (e) => { if (child !== c) return; child = undefined; finish((j) => j.fail(e)); });
    // 'close', not 'exit': it comes after stdout is fully read, so a reply written just before the exit still counts
    c.on('close', () => { if (child !== c) return; child = undefined; finish((j) => j.fail(new Error('voice sidecar crashed'))); });
    return c;
  };
  const run = (pcm: Buffer) => new Promise<string>((ok, fail) => {
    clearTimeout(idle);
    job = { pcm, ok, fail };
    const c = child ?? start();
    limit = setTimeout(() => {
      finish((j) => j.fail(new Error('voice sidecar timed out')));
      if (child === c) child = undefined;
      c.kill();
    }, timeoutMs);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(pcm.length);
    c.stdin!.write(Buffer.concat([head, pcm]));
  }).finally(() => {
    clearTimeout(limit);
    clearTimeout(idle);
    idle = setTimeout(() => { const c = child; child = undefined; c?.stdin!.end(); c?.kill(); }, idleMs);
    idle.unref();
  });

  return {
    transcribe: (pcm: Buffer) => { const p = chain.then(() => run(pcm)); chain = p.catch(() => {}); return p; },
    pid: () => child?.pid,
    close: () => { clearTimeout(idle); clearTimeout(limit); child?.kill(); },
  };
}

// JARVIS_VOICE_DEBUG_WAV=<dir>: deliberately writes the last clip (last.wav, 16 kHz mono s16) and its text (last.txt) to disk, overwriting. Off by default. A write failure never fails the transcription.
export function withDebugDump(transcribe: (pcm: Buffer) => Promise<string>, dir: string) {
  return async (pcm: Buffer) => {
    const text = await transcribe(pcm);
    try {
      const h = Buffer.alloc(44);
      h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
      h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
      h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // temp file + rename: the rename replaces a symlink at the target instead of writing through it
      const put = (name: string, data: Buffer | string) => { const tmp = resolve(dir, `.${name}.${process.pid}.tmp`); writeFileSync(tmp, data, { mode: 0o600, flag: 'w' }); renameSync(tmp, resolve(dir, name)); };
      put('last.wav', Buffer.concat([h, pcm]));
      put('last.txt', text);
    } catch (e) { console.error(`voice debug dump failed: ${(e as Error).message}`); }
    return text;
  };
}

// One recording at a time, captured by a child that writes raw 16 kHz mono s16le to stdout (pw-record from PipeWire; JARVIS_VOICE_CAPTURE_CMD replaces it in tests). Audio stays in memory.
// The child dies on stop/cancel, at the maxMs cap (the samples stay for stop), when level() has not renewed the lease for leaseMs (a vanished client must not leave the microphone open), and when Jarvis exits (exit hook; setpriv --pdeathsig covers SIGKILL and SIGTERM).
export const CAPTURE = ['pw-record', '--raw', '--rate', '16000', '--channels', '1', '--format', 's16', '-']; // no --target: PipeWire links the default source
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const SETPRIV = process.platform === 'linux' && existsSync('/usr/bin/setpriv') ? ['/usr/bin/setpriv', '--pdeathsig', 'TERM'] : [];

// Every child still running, killed once when Jarvis exits.
const live = new Set<ChildProcess>();
process.on('exit', () => live.forEach((c) => c.kill('SIGKILL')));

// start() returns an id; stop, cancel and level must pass it, so a stale tab cannot touch another tab's recording.
export function createRecorder(cmd: string[], opts: { maxMs?: number; leaseMs?: number; startMs?: number } = {}) {
  const { maxMs = 60_000, leaseMs = 4_000, startMs = 3_000 } = opts;
  type Take = { id: string; child: ChildProcess; chunks: Buffer[]; bytes: number; tail: Buffer; err: string; open: boolean; dead: boolean; lease?: NodeJS.Timeout; cap?: NodeJS.Timeout; boot?: NodeJS.Timeout; gone: Promise<void>; refuse: (e: Error) => void };
  let take: Take | undefined;
  const clear = (t: Take) => { clearTimeout(t.lease); clearTimeout(t.cap); clearTimeout(t.boot); };
  const reap = (t: Take) => { clear(t); t.child.kill('SIGKILL'); };
  const halt = (t: Take) => { // stop capturing, keep the samples (the lease stays: a cap-stopped take must still expire when nobody collects it)
    const k = setTimeout(() => t.child.kill('SIGKILL'), 2_000);
    t.child.kill('SIGTERM');
    return t.gone.then(() => clearTimeout(k));
  };
  const discard = (t: Take, e: Error) => { if (take === t) take = undefined; t.dead = true; t.refuse(e); reap(t); };
  const renew = (t: Take) => { clearTimeout(t.lease); t.lease = setTimeout(() => take === t && discard(t, fail('recording lease expired', 409)), leaseMs); };
  const mine = (id: unknown) => { // the current take, or undefined; another client's id is an error
    if (take && take.id !== id) throw fail('recording belongs to another client', 409);
    return take;
  };

  return {
    // Resolves with the recording id when the first samples arrive (the microphone is open); rejects when the command is missing, exits or stays silent.
    start: () => new Promise<string>((ok, no) => {
      if (take) return no(fail('already recording', 409));
      if (!found(cmd[0])) return no(fail(`${cmd[0]} not found`, 500)); // checked here: behind setpriv a missing command would only show as an exit code
      const args = [...SETPRIV, ...cmd];
      const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      live.add(child);
      let settled = false;
      const t: Take = { id: randomUUID(), child, chunks: [], bytes: 0, tail: Buffer.alloc(0), err: '', open: false, dead: false, gone: new Promise((r) => child.once('close', () => { live.delete(child); r(); })), refuse: (e) => { if (!settled) { settled = true; no(e); } } };
      take = t;
      const lose = (e: Error) => { if (take === t) take = undefined; t.dead = true; reap(t); t.refuse(e); };
      child.on('error', (e) => lose(fail(`cannot start ${cmd[0]}: ${e.message}`, 500)));
      child.stderr!.on('data', (d) => { t.err = (t.err + d).slice(-500); });
      child.stdout!.on('data', (d: Buffer) => {
        if (t.dead) return; // discarded: no timers, no samples
        t.chunks.push(d); t.bytes += d.length;
        t.tail = Buffer.concat([t.tail, d]).subarray(-3200); // the last 100 ms, for the level
        if (t.open) return;
        t.open = true; settled = true; clearTimeout(t.boot);
        t.cap = setTimeout(() => halt(t), maxMs);
        renew(t);
        ok(t.id);
      });
      child.on('close', (code) => { if (!t.open) lose(fail(`${cmd[0]} exited${code === null ? '' : ` with code ${code}`} before any audio: ${t.err.trim().split('\n').pop() || 'no output'}`, 500)); });
      t.boot = setTimeout(() => lose(fail(`${cmd[0]} sent no audio`, 500)), startMs);
    }),
    // Ends capture and returns the samples (whole s16 samples only); the recorder is free again at once.
    stop: async (id: unknown) => {
      const t = mine(id); if (!t) throw fail('not recording', 409);
      take = undefined;
      await halt(t);
      clear(t);
      const pcm = Buffer.concat(t.chunks);
      return pcm.subarray(0, pcm.length & ~1);
    },
    cancel: (id: unknown) => { const t = mine(id); if (t) discard(t, fail('recording cancelled', 409)); },
    // The UI polls this while the button is held: the level for the meter, and the lease that keeps the recording alive. Another client's id sees no recording.
    level: (id: unknown) => {
      const t = take;
      if (!t || t.id !== id) return { recording: false, level: 0 };
      if (!t.open) return { recording: true, level: 0 };
      renew(t);
      let tail = t.tail; if ((t.bytes - tail.length) & 1) tail = tail.subarray(1); // start on a sample boundary
      let s = 0; const n = tail.length >> 1;
      for (let i = 0; i < n; i++) { const v = tail.readInt16LE(i * 2) / 32768; s += v * v; }
      return { recording: true, level: n ? Math.min(1, Math.sqrt(s / n) * 4) : 0 };
    },
  };
}

// `name` is a path or a bare command looked up in PATH.
const found = (name: string) => name.includes('/') ? existsSync(name) : (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(resolve(d, name)));

const probe = (python: string) => new Promise<string | undefined>((ok) =>
  execFile(python, ['-I', '-c', 'import faster_whisper'], { timeout: 30_000 }, (err, _o, stderr) =>
    ok(err ? ((err as any).code === 'ENOENT' ? `${python} not found` : (stderr.trim().split('\n').pop() || err.message.trim().split('\n')[0])) : undefined)));

export type Voice = { maxS: number; start: () => Promise<string>; stop: (id: unknown) => Promise<string>; cancel: (id: unknown) => void; level: (id: unknown) => { recording: boolean; level: number } };

// Returns the voice backend, or undefined (after one log line) when voice cannot work. Never throws.
export async function initVoice(): Promise<Voice | undefined> {
  const mode = process.env.JARVIS_VOICE;
  const secs = (name: string, dflt: number) => { const n = Number(process.env[name] ?? dflt); return (Number.isFinite(n) && n > 0 ? n : dflt) * 1000; }; // invalid values fall back
  const idleMs = secs('JARVIS_VOICE_IDLE_S', 600), timeoutMs = secs('JARVIS_VOICE_TIMEOUT_S', 120);
  const capture = process.env.JARVIS_VOICE_CAPTURE_CMD?.trim().split(/\s+/).filter(Boolean) ?? CAPTURE;
  if (!found(capture[0])) { console.error(`voice disabled: ${capture[0]} not found (install pipewire: PipeWire's pw-record captures the microphone)`); return undefined; }
  const stub = process.env.JARVIS_VOICE_CMD?.trim().split(/\s+/);
  const dump = process.env.JARVIS_VOICE_DEBUG_WAV?.trim();
  const wrap = (t: (pcm: Buffer) => Promise<string>) => dump ? withDebugDump(t, dump) : t;
  let transcribe: (pcm: Buffer) => Promise<string>;
  if (stub?.[0]) transcribe = wrap(createSidecar(stub[0], stub.slice(1), idleMs, timeoutMs).transcribe);
  else {
    const root = resolve(import.meta.dirname, '..', 'voice');
    const venv = resolve(root, '.venv', 'bin', 'python'); // made by voice/setup.sh
    const python = process.env.JARVIS_VOICE_PYTHON || (existsSync(venv) ? venv : 'python3');
    const why = await probe(python);
    if (why) {
      console.error(`voice disabled: ${why} (run voice/setup.sh, or point JARVIS_VOICE_PYTHON at a Python with faster-whisper)`);
      return undefined;
    }
    transcribe = wrap(createSidecar(python, ['-I', resolve(root, 'server.py'), ...(mode === 'cpu' ? ['--cpu'] : [])], idleMs, timeoutMs).transcribe);
  }
  const maxMs = secs('JARVIS_VOICE_MAX_S', 60);
  const rec = createRecorder(capture, { maxMs, leaseMs: secs('JARVIS_VOICE_LEASE_S', 4) });
  // an empty clip (nothing captured) is no speech, not an error
  return { maxS: maxMs / 1000, start: rec.start, cancel: rec.cancel, level: rec.level, stop: async (id) => { const pcm = await rec.stop(id); return pcm.length ? transcribe(pcm) : ''; } };
}
