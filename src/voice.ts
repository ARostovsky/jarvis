// Optional voice input: server-side capture (pw-record) -> Python sidecar (voice/server.py, faster-whisper) -> text.
// Loaded by server.ts only when JARVIS_VOICE is set, so a broken file here cannot break a plain start.
// Sidecar protocol: stdin = frames of 4-byte big-endian length N + N bytes PCM s16le 16 kHz mono; stdout = one JSON line per frame, {"text"} or {"error"}; stderr = logs; EOF on stdin = exit.
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { resolve, delimiter, join } from 'node:path';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
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

// Mutes the default output (sink) while a recording runs, so speakers do not bleed into the microphone. cmd is `wpctl` (JARVIS_VOICE_MUTE_CMD replaces it in tests).
// The sink is resolved to its numeric id and node.name once, at the first mute (`wpctl inspect @DEFAULT_AUDIO_SINK@`), and every later call targets that id: a default sink that changes mid-recording (headset reconnect) must not make the unmute hit another sink. If inspect fails, nothing is muted (one log line): muting the symbolic default could not be undone reliably.
// Ownership lives in `marker` (a JSON file `{sink, name, holders: [{id, pid, start}]}`), shared by every Jarvis process and updated under a lock directory with write-temp + rename. Each muter is one holder, from its first engage() to its last restore() (engage/restore are counted inside a muter). The first holder mutes, the last one unmutes the sink the marker names. A holder whose pid is dead, whose process start time differs (recycled pid) or that has no start time (the old pid-only marker) is dropped.
// A sink that was already muted when no holder existed is the user's: nothing is written and it is never unmuted. A marker without live holders is a mute Jarvis left behind: engage() and recover() (startup) undo it. If its id is gone or belongs to another node, the sink with the same node.name (a headset that came back with a new id) is unmuted instead; a node that is really gone is dropped with a log line. A failed unmute (wpctl error, timeout, or an inspect that cannot say) keeps the marker and is retried every 2 s up to 5 times, by the next engage/recover and by the exit and signal hooks; the last failure logs `voice: cannot unmute sink <id>`.
// Blocking: wpctl runs through execFileSync (CALL_MS each, normally ~20 ms), at most six calls inside the lock, so a hanging wpctl can stall the server loop for seconds. The lock itself is waited for without blocking (a timer, 25 ms steps, LOCK_WAIT_MS) except in recover() and the exit hooks, which block for it. Known by design: a mute the user sets during a recording is undone at its end; if the marker file is deleted while two Jarvis record, the first to finish unmutes.
export const MUTE = ['wpctl'];
const SINK = '@DEFAULT_AUDIO_SINK@';
const CALL_MS = 1_500, LOCK_WAIT_MS = 15_000, LOCK_STALE_MS = 30_000; // the wait exceeds six calls in a row (9 s); a lock older than LOCK_STALE_MS is broken
type Holder = { id: string; pid: number; start?: string };
type MuteState = { sink: string; name?: string; holders: Holder[] };
const startOf = (pid: number) => { try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]; } catch { return undefined; } }; // field 22 (starttime); comm may hold spaces, so cut after the last ')'
const HAVE_PROC = startOf(process.pid) !== undefined;
const holderAlive = (h: Holder) => {
  try { process.kill(h.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  if (!HAVE_PROC) return true; // no start times here: the pid is all there is
  const s = startOf(h.pid);
  return !!h.start && !!s && s === h.start; // no start time (old marker) or another one (recycled pid): not the holder
};
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
type Lock = { dir: string; token: string };
const gone = (dir: string) => { const g = `${dir}.gone.${randomUUID()}`; try { renameSync(dir, g); rmSync(g, { recursive: true, force: true }); } catch {} }; // rename first: only one process wins it
// The lock is the directory `<file>.lock` holding `owner` ({token, pid, start}). undefined: held by a live owner. A dead owner, or a lock older than LOCK_STALE_MS, is broken.
const tryLock = (file: string): Lock | undefined => {
  const dir = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    try { mkdirSync(dir); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { dir: '', token: '' }; // no data folder to lock in: run unlocked
      let stale = false;
      try { const o = JSON.parse(readFileSync(join(dir, 'owner'), 'utf8')); stale = !holderAlive({ id: '', pid: o.pid, start: o.start }); } catch {}
      try { stale ||= Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS; } catch { if (attempt) return undefined; continue; } // the lock vanished: take it
      if (!stale || attempt) return undefined;
      gone(dir); // broken: take it at once
    }
  }
  const token = `${process.pid}:${randomUUID()}`;
  try { writeFileSync(join(dir, 'owner'), JSON.stringify({ token, pid: process.pid, start: startOf(process.pid) })); } catch {}
  return { dir, token };
};
const unlock = (l: Lock) => { // only the owner releases: a lock that was broken as stale and taken by another stays
  if (!l.dir) return;
  try { if (JSON.parse(readFileSync(join(l.dir, 'owner'), 'utf8')).token === l.token) gone(l.dir); } catch {}
};
// Blocks until the lock is ours (after LOCK_WAIT_MS it runs unlocked rather than never unmute).
const withLock = <T>(file: string, f: () => T, waitMs = LOCK_WAIT_MS): T => {
  const t0 = Date.now(); let l: Lock | undefined;
  while (!(l = tryLock(file))) { if (Date.now() - t0 > waitMs) return f(); sleepSync(20); }
  try { return f(); } finally { unlock(l); }
};

export function createMuter(cmd: string[] = MUTE, marker?: string, lockWaitMs = LOCK_WAIT_MS) { // lockWaitMs: tests only
  const me: Holder = { id: randomUUID(), pid: process.pid, start: startOf(process.pid) };
  // n: active recordings; phase: whether the current engage has been carried out; mine/mineName: the sink this muter must still unmute
  let n = 0, phase: 'idle' | 'on' = 'idle', mine: string | undefined, mineName: string | undefined, warned = false, noSink = false, retry: NodeJS.Timeout | undefined, tries = 0, waiting: NodeJS.Timeout | undefined, since = 0, mem: MuteState | undefined, unmuted = false;
  const run = (...a: string[]) => execFileSync(cmd[0], [...cmd.slice(1), ...a], { encoding: 'utf8', timeout: CALL_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  const warn = (e: unknown) => { if (!warned) { warned = true; console.error(`voice: cannot change the output mute: ${(e as Error).message.split('\n')[0]}`); } };
  const load = (): MuteState | undefined => {
    if (!marker) return mem;
    let t: string; try { t = readFileSync(marker, 'utf8'); } catch { return undefined; }
    try { const j = JSON.parse(t); if (j && typeof j.sink === 'string' && Array.isArray(j.holders)) return j; } catch {}
    const pid = Number(t); // the old format: just the pid of the Jarvis that muted the default sink (no start time: never a live holder)
    return { sink: SINK, holders: Number.isInteger(pid) && pid > 0 ? [{ id: 'legacy', pid }] : [] };
  };
  const save = (s?: MuteState) => {
    if (!marker) { mem = s; return; }
    if (!s) { rmSync(marker, { force: true }); return; }
    const tmp = `${marker}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s)); renameSync(tmp, marker);
  };
  const live = (s: MuteState): MuteState => ({ ...s, holders: s.holders.filter((h) => h.id === me.id || holderAlive(h)) });
  const muted = (sink: string) => /\[MUTED\]/.test(run('get-volume', sink));
  // The node behind target; 'gone' only when wpctl says so ("not found", real wpctl: stderr and exit 3). A timeout or any other failure throws: it says nothing about the node.
  const inspect = (target: string): { id: string; name?: string } | 'gone' => {
    let out: string;
    try { out = run('inspect', target); } catch (e) { if (/not found/i.test(String((e as { stderr?: unknown }).stderr ?? ''))) return 'gone'; throw e; }
    const id = /^id (\d+)/.exec(out)?.[1];
    if (!id) throw new Error('unexpected output of wpctl inspect');
    return { id, name: /node\.name = "([^"]*)"/.exec(out)?.[1] };
  };
  const findByName = (name: string) => { // a sink by node.name: wpctl status lists the sink ids, inspect gives each one's name
    const sinks = /Sinks:\n([\s\S]*?)(?:\n\s*[├└]─|$)/.exec(run('status'))?.[1] ?? '';
    for (const m of sinks.matchAll(/^\s*[│ ]*\*?\s*(\d+)\./gm)) { try { const i = inspect(m[1]); if (i !== 'gone' && i.name === name) return i.id; } catch {} }
    return undefined;
  };
  // Unmutes s.sink (nobody holds it) and drops the marker. check: first look whether it is still muted (a marker left behind: the user may have unmuted it since). False when it could not be done; the marker then stays.
  const undo = (s: MuteState, check: boolean) => {
    try {
      let target = s.sink;
      if (s.sink !== SINK) {
        const i = inspect(s.sink);
        if (i === 'gone' || (s.name && i.name && i.name !== s.name)) { // the id is gone or now another node: follow the name
          const alt = s.name ? findByName(s.name) : undefined;
          if (!alt) { console.error(`voice: sink ${s.sink} is gone, nothing to unmute`); save(undefined); return true; }
          target = alt;
        }
      }
      if (!check || muted(target)) { run('set-mute', target, '0'); unmuted = true; }
      save(undefined); return true;
    } catch (e) { warn(e); return false; }
  };
  const engageNow = () => {
    phase = 'on';
    try {
      let s = load();
      if (s) {
        s = live(s);
        if (!s.holders.length) { if (undo(s, true)) { s = undefined; mine = undefined; } } // a mute a dead Jarvis left: undo it, then record normally
        else { save({ ...s, holders: [...s.holders.filter((h) => h.id !== me.id), me] }); mine = s.sink; mineName = s.name; return; } // somebody else holds it: join, nothing to mute
      }
      if (s) { save({ ...s, holders: [me] }); mine = s.sink; mineName = s.name; run('set-mute', s.sink, '1'); return; } // the leftover could not be undone: adopt it, our release retries
      let i; try { i = inspect(SINK); } catch (e) { warn(e); }
      if (!i || i === 'gone') { if (!noSink) { noSink = true; console.error('voice: cannot find the default output sink, it is not muted while recording'); } return; }
      if (muted(i.id)) return; // the user muted it: hold nothing, leave it alone afterwards
      mine = i.id; mineName = i.name; // set before the call: a half-done mute must still be restored
      try { save({ sink: i.id, name: i.name, holders: [me] }); } catch {} // best effort: the mute itself matters more
      run('set-mute', i.id, '1');
    } catch (e) { warn(e); }
  };
  // Gives up this muter's hold; the last holder unmutes. Safe to repeat: it is also the retry.
  const dropNow = () => {
    phase = 'idle'; clearTimeout(retry);
    if (!mine) return;
    const sink = mine;
    const s = load() ?? { sink, name: mineName, holders: [me] };
    const rest = live({ ...s, holders: s.holders.filter((h) => h.id !== me.id) });
    let ok = true;
    if (rest.holders.length) { try { save(rest); } catch {} } // another Jarvis still records: it unmutes
    else if (!undo(rest, false)) { ok = false; try { save(rest); } catch {} } // keep the marker, without us: the next engage or recover (any Jarvis) sees a mute nobody holds
    if (ok) { mine = undefined; tries = 0; return; }
    if (n === 0 && ++tries <= 5) { retry = setTimeout(pump, 2_000); retry.unref(); }
    else console.error(`voice: cannot unmute sink ${sink}`);
  };
  // Brings the sink in line with n (read when it runs, so an engage and its restore that queue behind a busy lock cancel out).
  const reconcile = () => { if (n > 0 && phase === 'idle') engageNow(); else if (n === 0 && (phase === 'on' || mine)) dropNow(); };
  const pump = () => { // runs reconcile under the lock at once, or polls for the lock without blocking
    waiting = undefined;
    if (!marker) return reconcile();
    const l = tryLock(marker);
    if (l) { since = 0; try { reconcile(); } finally { unlock(l); } return; }
    since ||= Date.now();
    if (Date.now() - since > lockWaitMs) { since = 0; return reconcile(); } // never leave it muted for a stuck lock
    waiting = setTimeout(pump, 25); waiting.unref();
  };
  const queue = () => { if (!waiting) pump(); };
  const m = {
    engage() { if (n++ === 0) queue(); },
    restore() { if (n > 0 && --n === 0) queue(); },
    // Unconditional, for exit and signals: unmute now whatever the count is, one try, blocking for the lock.
    restoreAll() {
      n = 0; tries = 5; clearTimeout(waiting); waiting = undefined; clearTimeout(retry);
      if (marker) withLock(marker, reconcile, lockWaitMs); else reconcile();
    },
    // Startup safety net: a marker with no live holder is a mute a dead Jarvis left. Undo only that.
    recover() {
      if (!marker) return;
      withLock(marker, () => {
        const s0 = load(); if (!s0) return;
        const s = live(s0);
        if (s.holders.length) return; // another Jarvis is running and owns the mute
        unmuted = false;
        if (undo(s, true) && unmuted) console.error('voice: restored the output mute left by a previous run');
      });
    },
  };
  process.on('exit', m.restoreAll);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(sig, () => { m.restoreAll(); process.kill(process.pid, sig); }); // the default action (exit) runs once the handler is gone
  return m;
}

// start() returns an id; stop, cancel and level must pass it, so a stale tab cannot touch another tab's recording.
export function createRecorder(cmd: string[], opts: { maxMs?: number; leaseMs?: number; startMs?: number; muter?: { engage: () => void; restore: () => void } } = {}) {
  const { muter, maxMs = 60_000, leaseMs = 4_000, startMs = 3_000 } = opts;
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
      muter?.engage();
      let held = !!muter;
      const release = () => { if (held) { held = false; muter!.restore(); } }; // once per engage
      const args = [...SETPRIV, ...cmd];
      const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      live.add(child);
      let settled = false;
      const t: Take = { id: randomUUID(), child, chunks: [], bytes: 0, tail: Buffer.alloc(0), err: '', open: false, dead: false, gone: new Promise((r) => child.once('close', () => { live.delete(child); release(); r(); })), refuse: (e) => { if (!settled) { settled = true; no(e); } } };
      take = t;
      const lose = (e: Error) => { release(); if (take === t) take = undefined; t.dead = true; reap(t); t.refuse(e); };
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
  let muter: ReturnType<typeof createMuter> | undefined;
  const mc = process.env.JARVIS_VOICE_MUTE_CMD?.trim().split(/\s+/).filter(Boolean) ?? MUTE;
  const muteOff = process.env.JARVIS_VOICE_MUTE_OUTPUT === '0'; // never mutes, but still undoes a mute an earlier run (with the mute on) left behind
  if (found(mc[0])) { const mm = createMuter(mc, join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'jarvis', 'voice-muted')); mm.recover(); if (!muteOff) muter = mm; }
  else if (!muteOff) console.error(`voice: ${mc[0]} not found, the output is not muted while recording`);
  const rec = createRecorder(capture, { maxMs, leaseMs: secs('JARVIS_VOICE_LEASE_S', 4), muter });
  // an empty clip (nothing captured) is no speech, not an error
  return { maxS: maxMs / 1000, start: rec.start, cancel: rec.cancel, level: rec.level, stop: async (id) => { const pcm = await rec.stop(id); return pcm.length ? transcribe(pcm) : ''; } };
}
