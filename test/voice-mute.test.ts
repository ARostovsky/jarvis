// Output mute ownership (createMuter in src/voice.ts) against e2e/fake-wpctl.ts: several sinks, a default that moves, holders in one or several processes that share one marker file. Never touches real audio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createMuter } from '../src/voice.ts';

const fake = join(import.meta.dirname, '..', 'e2e', 'fake-wpctl.ts');
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jv-mute-'));
  const marker = join(dir, 'voice-muted');
  const cmd = [process.execPath, fake, dir];
  return {
    dir, marker, cmd,
    mk: () => createMuter(cmd, marker),
    def: (id: string) => writeFileSync(join(dir, 'default'), id),
    muted: () => readdirSync(dir).filter((f) => f.startsWith('mute.')).map((f) => f.slice(5)).sort(),
    log: () => existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8').trim().split('\n') : [],
    flag: (name: string, on = true) => on ? writeFileSync(join(dir, name), '') : spawnSync('rm', ['-f', join(dir, name)]),
    holders: (): { pid: number }[] => JSON.parse(readFileSync(marker, 'utf8')).holders,
  };
};
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

test('the unmute targets the sink that was muted, not the new default', () => {
  const t = setup(); t.def('1');
  const m = t.mk(); m.engage();
  assert.deepEqual(t.muted(), ['1']);
  t.def('2'); // headset reconnect: the default moved while recording
  m.restore();
  assert.deepEqual(t.muted(), []);
  assert.deepEqual(t.log(), ['1 1', '1 0']);
  assert.equal(existsSync(t.marker), false);
});

test('overlapping engage/restore in one muter: unmuted by the last restore only', () => {
  const t = setup();
  const m = t.mk(); m.engage(); m.engage(); m.restore();
  assert.deepEqual(t.muted(), ['1']);
  m.restore();
  assert.deepEqual(t.muted(), []);
});

for (const order of ['AaBb', 'ABab', 'ABba', 'BAab', 'BAba', 'BbAa']) {
  test(`two muters sharing one marker, order ${order} (capital = engage, lower = restore): muted until the last restore`, () => {
    const t = setup();
    const ms: Record<string, ReturnType<typeof t.mk>> = { a: t.mk(), b: t.mk() };
    const live = new Set<string>(); let cycles = 0;
    for (const c of order) {
      const k = c.toLowerCase();
      if (c === k) { ms[k].restore(); live.delete(k); } else { if (!live.size) cycles++; ms[k].engage(); live.add(k); }
      assert.deepEqual(t.muted(), live.size ? ['1'] : [], `after ${c}`);
    }
    assert.deepEqual(t.log(), Array.from({ length: cycles }, () => ['1 1', '1 0']).flat()); // one mute and one unmute per stretch with a holder
    assert.equal(existsSync(t.marker), false);
  });
}

test('a second holder never mistakes our mute for the user\'s', () => {
  const t = setup();
  const a = t.mk(), b = t.mk();
  a.engage(); b.engage(); a.restore();
  assert.deepEqual(t.muted(), ['1']); // B still holds it
  b.restore();
  assert.deepEqual(t.muted(), []);
});

test('a sink the user muted first is never unmuted, by one muter or by several', () => {
  const t = setup(); t.flag('mute.1');
  const a = t.mk(), b = t.mk();
  a.engage(); b.engage(); a.restore(); b.restore();
  assert.deepEqual(t.muted(), ['1']);
  assert.equal(existsSync(t.marker), false);
  assert.deepEqual(t.log(), []);
});

test('two real processes share the mute: it ends with the last one', async () => {
  const t = setup();
  const src = `import { createMuter } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'voice.ts'))};
const m = createMuter(${JSON.stringify(t.cmd)}, ${JSON.stringify(t.marker)}); m.engage(); console.log('ready');
process.stdin.on('data', () => { m.restore(); process.exit(0); });`;
  const start = () => { const c = spawn(process.execPath, ['-e', src, '--input-type=module'], { stdio: ['pipe', 'pipe', 'inherit'] }); return new Promise<typeof c>((ok) => c.stdout.once('data', () => ok(c))); };
  const stop = (c: Awaited<ReturnType<typeof start>>) => new Promise((ok) => { c.once('close', ok); c.stdin.write('x\n'); });
  const [x, y] = [await start(), await start()];
  assert.equal(t.holders().length, 2);
  await stop(x);
  assert.deepEqual(t.muted(), ['1']);
  await stop(y);
  assert.deepEqual(t.muted(), []);
  assert.deepEqual(t.log(), ['1 1', '1 0']);
});

test('a dead holder is dropped at engage: the mute it left is undone first, then recording mutes again', () => {
  const t = setup(); t.flag('mute.1');
  writeFileSync(t.marker, JSON.stringify({ sink: '1', holders: [{ id: 'x', pid: deadPid() }] }));
  t.def('2'); // the default moved since
  const m = t.mk(); m.engage();
  assert.deepEqual(t.muted(), ['2']); // old one undone by id, new default muted
  m.restore();
  assert.deepEqual(t.muted(), []);
});

test('a recycled pid (alive, other start time) does not block recovery; a live holder does', () => {
  const t = setup(); t.flag('mute.1');
  writeFileSync(t.marker, JSON.stringify({ sink: '1', holders: [{ id: 'x', pid: process.pid, start: 'not-the-start' }] }));
  t.mk().recover();
  assert.deepEqual(t.muted(), []);
  assert.equal(existsSync(t.marker), false);
  t.flag('mute.1');
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8'), start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  writeFileSync(t.marker, JSON.stringify({ sink: '1', holders: [{ id: 'x', pid: process.pid, start }] }));
  t.mk().recover();
  assert.deepEqual(t.muted(), ['1']);
  assert.equal(existsSync(t.marker), true);
});

test('recover undoes only what was muted: the marker sink, not the default; a sink unmuted since is left', () => {
  const t = setup(); t.flag('mute.1'); t.flag('mute.2'); t.def('2');
  writeFileSync(t.marker, JSON.stringify({ sink: '1', holders: [{ id: 'x', pid: deadPid() }] }));
  t.mk().recover();
  assert.deepEqual(t.muted(), ['2']); // 2 was the user's
  t.flag('mute.1', false);
  writeFileSync(t.marker, JSON.stringify({ sink: '1', holders: [] }));
  t.mk().recover();
  assert.deepEqual(t.log(), ['1 0']); // no second call
  assert.equal(existsSync(t.marker), false);
});

test('a marker of a vanished sink is dropped with a note, not retried forever', () => {
  const t = setup(); t.flag('gone.7');
  writeFileSync(t.marker, JSON.stringify({ sink: '7', holders: [] }));
  t.mk().recover();
  assert.equal(existsSync(t.marker), false);
});

test('an unmute that hits the 2 s timeout keeps the marker and is retried until it works', async () => {
  const t = setup();
  const m = t.mk(); m.engage();
  t.flag('hang');
  m.restore();
  assert.deepEqual(t.muted(), ['1']); // killed by the timeout
  assert.equal(existsSync(t.marker), true);
  t.flag('hang', false);
  for (let i = 0; i < 60 && t.muted().length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(t.muted(), []);
  assert.equal(existsSync(t.marker), false);
});

test('a final unmute failure logs the sink and a later recover undoes it', () => {
  const t = setup();
  const m = t.mk(); m.engage();
  t.flag('hang');
  const err: string[] = []; const orig = console.error; console.error = (s: string) => err.push(String(s));
  try { m.restoreAll(); } finally { console.error = orig; }
  assert.ok(err.some((l) => l.includes('voice: cannot unmute sink 1')), err.join('|'));
  assert.deepEqual(t.muted(), ['1']);
  assert.equal(existsSync(t.marker), true);
  t.flag('hang', false);
  const spent = t.mk(); spent.recover(); // this muter's pid is alive but its holder entry is gone
  assert.deepEqual(t.muted(), []);
});

test('an old-format marker (pid only) is never a live holder, even when that pid exists now', () => {
  const t = setup(); t.flag('mute.1');
  writeFileSync(t.marker, String(process.pid)); // a recycled pid: alive, but no start time to prove it is the old Jarvis
  t.mk().recover();
  assert.deepEqual(t.muted(), []);
  assert.equal(existsSync(t.marker), false);
});

test('inspect failing: nothing is muted and one line is logged', () => {
  const t = setup(); t.flag('gone.1');
  const err: string[] = []; const orig = console.error; console.error = (s: string) => err.push(String(s));
  try { const m = t.mk(); m.engage(); m.restore(); m.engage(); m.restore(); } finally { console.error = orig; }
  assert.deepEqual(t.log(), []);
  assert.equal(err.filter((l) => l.includes('cannot find the default output sink')).length, 1);
  assert.equal(existsSync(t.marker), false);
});

test('a wpctl timeout during the "gone" check is not "gone": the marker stays', () => {
  const t = setup(); t.flag('mute.7');
  writeFileSync(t.marker, JSON.stringify({ sink: '7', name: 'sink7', holders: [] }));
  t.flag('hang-inspect');
  t.mk().recover();
  assert.equal(existsSync(t.marker), true);
  assert.deepEqual(t.muted(), ['7']);
  t.flag('hang-inspect', false);
  t.mk().recover();
  assert.equal(existsSync(t.marker), false);
  assert.deepEqual(t.muted(), []);
});

test('a sink that came back with a new id is unmuted by its node.name; an id taken by another node is not touched', () => {
  const t = setup(); t.flag('mute.9'); t.flag('mute.3');
  writeFileSync(join(t.dir, 'sinks'), '3 speakers\n9 headset\n');
  t.flag('gone.7');
  writeFileSync(t.marker, JSON.stringify({ sink: '7', name: 'headset', holders: [] }));
  t.mk().recover();
  assert.deepEqual(t.muted(), ['3']); // headset (id 9) unmuted
  t.flag('mute.9');
  writeFileSync(t.marker, JSON.stringify({ sink: '3', name: 'headset', holders: [] })); // id 3 now belongs to "speakers"
  t.mk().recover();
  assert.deepEqual(t.muted(), ['3']);
  assert.deepEqual(t.log(), ['9 0', '9 0']);
});

test('a stale lock (dead owner, or older than the limit) is broken; a live one is waited for, not blocked on', async () => {
  const t = setup();
  const lock = `${t.marker}.lock`;
  spawnSync('mkdir', [lock]);
  writeFileSync(join(lock, 'owner'), JSON.stringify({ token: 'x', pid: deadPid() }));
  const m = t.mk(); m.engage(); // the dead owner's lock is broken, the mute is made at once
  assert.deepEqual(t.muted(), ['1']);
  m.restore();
  assert.equal(existsSync(lock), false);
  // a live owner: engage returns at once (no event-loop block) and the mute follows when the lock is released
  const start = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  spawnSync('mkdir', [lock]);
  writeFileSync(join(lock, 'owner'), JSON.stringify({ token: 'live', pid: process.pid, start: start.slice(start.lastIndexOf(')') + 2).split(' ')[19] }));
  const t0 = Date.now(); const m2 = t.mk(); m2.engage();
  assert.ok(Date.now() - t0 < 500);
  assert.deepEqual(t.muted(), []);
  spawnSync('rm', ['-rf', lock]);
  for (let i = 0; i < 40 && !t.muted().length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(t.muted(), ['1']);
  m2.restore();
  for (let i = 0; i < 40 && t.muted().length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(t.muted(), []);
});

test('a lock owned by a live process is never broken or released by another: the hold waits for it', async () => {
  const t = setup();
  const m = t.mk(); m.engage();
  const lock = `${t.marker}.lock`, stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  spawnSync('mkdir', [lock]); writeFileSync(join(lock, 'owner'), JSON.stringify({ token: 'other', pid: process.pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }));
  m.restore(); // queued behind the foreign lock
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(existsSync(lock), true);
  assert.deepEqual(t.muted(), ['1']);
  spawnSync('rm', ['-rf', lock]);
  for (let i = 0; i < 40 && t.muted().length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(t.muted(), []);
});

// Truly concurrent: several child processes, a barrier (a file), then engage and release interleaved at random.
test('concurrent holders in separate processes: never a stuck mute, never an early unmute', async () => {
  for (let round = 0; round < 3; round++) {
    const t = setup();
    const go = join(t.dir, 'go');
    const src = `import { createMuter } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'voice.ts'))};
import { existsSync } from 'node:fs';
const m = createMuter(${JSON.stringify(t.cmd)}, ${JSON.stringify(t.marker)});
console.log('ready');
while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 2));
const hold = Number(process.argv[1]);
m.engage();
await new Promise((r) => setTimeout(r, hold));
m.restore();
await new Promise((r) => setTimeout(r, 300)); // queued work (lock polling) finishes
process.exit(0);`;
    const kids = [40, 120, 60, 200].map((h) => spawn(process.execPath, ['-e', src, '--input-type=module', '--', String(h)], { stdio: ['ignore', 'pipe', 'inherit'] }));
    await Promise.all(kids.map((c) => new Promise((ok) => c.stdout.once('data', ok))));
    writeFileSync(go, '');
    await Promise.all(kids.map((c) => new Promise((ok) => c.once('close', ok))));
    assert.deepEqual(t.muted(), [], `round ${round}: the output is still muted`);
    assert.equal(existsSync(t.marker), false, `round ${round}: marker left`);
    const log = t.log();
    assert.equal(log.filter((l) => l.endsWith(' 1')).length, log.filter((l) => l.endsWith(' 0')).length, log.join(','));
    // never unmuted while another still holds: every "0" is followed by no "1" without a prior "0" (strict alternation)
    log.forEach((l, i) => assert.equal(l, i % 2 ? '1 0' : '1 1', log.join(',')));
  }
});

test('the exit hook releases a hold even if the lock cannot be taken in time (runs unlocked)', () => {
  const t = setup();
  const m = t.mk(); m.engage();
  assert.deepEqual(t.muted(), ['1']);
  m.restoreAll();
  assert.deepEqual(t.muted(), []);
});

test('a lock that stays held past the wait is ignored: the hold is still released (queued path and exit path)', async () => {
  const t = setup();
  const lock = `${t.marker}.lock`, stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const hold = () => { spawnSync('mkdir', [lock]); writeFileSync(join(lock, 'owner'), JSON.stringify({ token: 'other', pid: process.pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] })); };
  const m = createMuter(t.cmd, t.marker, 300); m.engage();
  assert.deepEqual(t.muted(), ['1']);
  hold(); m.restore();
  for (let i = 0; i < 40 && t.muted().length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(t.muted(), []); // gave up waiting after 300 ms and unmuted anyway
  assert.equal(existsSync(lock), true); // the foreign lock is not ours to delete
  const m2 = createMuter(t.cmd, t.marker, 300); m2.engage(); // lock still foreign: queued, then unlocked after the wait
  for (let i = 0; i < 40 && !t.muted().length; i++) await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now(); m2.restoreAll();
  assert.ok(Date.now() - t0 >= 250 && Date.now() - t0 < 2_000);
  assert.deepEqual(t.muted(), []);
  spawnSync('rm', ['-rf', lock]);
});

test('JARVIS_VOICE_MUTE_OUTPUT=0 never mutes but still releases a stuck mute at startup', async () => {
  const t = setup(); t.flag('mute.1');
  const xdg = join(t.dir, 'xdg'); spawnSync('mkdir', ['-p', join(xdg, 'jarvis')]);
  writeFileSync(join(xdg, 'jarvis', 'voice-muted'), JSON.stringify({ sink: '1', name: 'sink1', holders: [{ id: 'x', pid: deadPid(), start: '1' }] }));
  const e2e = join(import.meta.dirname, '..', 'e2e');
  const src = `import { initVoice } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'voice.ts'))}; const v = await initVoice(); console.log(v ? 'on' : 'off'); process.exit(0);`;
  const r = spawnSync(process.execPath, ['-e', src, '--input-type=module'], { encoding: 'utf8', env: { ...process.env, XDG_DATA_HOME: xdg, JARVIS_VOICE: '1', JARVIS_VOICE_CMD: `${process.execPath} ${join(e2e, 'fake-voice.ts')}`, JARVIS_VOICE_CAPTURE_CMD: `${process.execPath} ${join(e2e, 'fake-capture.ts')}`, JARVIS_VOICE_MUTE_OUTPUT: '0', JARVIS_VOICE_MUTE_CMD: t.cmd.join(' ') } });
  assert.equal(r.stdout.trim(), 'on', r.stderr);
  assert.deepEqual(t.muted(), []);
  assert.equal(existsSync(join(xdg, 'jarvis', 'voice-muted')), false);
});
