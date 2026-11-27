import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobs, backoffMs, buildArgv, buildEnv, runProcess, parseOutput, jobSourceCheck, type Change, type Panel, type PanelStatus, type Row } from '../src/jobs.ts';
import { createRegistry, validateManifest, hashFolder } from '../src/job-sources.ts';

process.env.JARVIS_JOBS_MIN_POLL_S = '0.1';
before(() => { process.env.ANTHROPIC_API_KEY = 'sk-secret'; process.env.OTHER_SECRET = 'x'; process.env.PASSME = 'yes'; });
after(() => { delete process.env.ANTHROPIC_API_KEY; delete process.env.OTHER_SECRET; delete process.env.PASSME; });

// A job source whose answers come from a control file outside its folder (so the hash stays put) and that logs every call.
const SCRIPT = `
import { readFileSync, appendFileSync } from 'node:fs';
const ctl = JSON.parse(readFileSync(process.env.CTL, 'utf8'));
const a = process.argv.slice(2), fi = a.indexOf('--fields'), slow = fi >= 0;
const ids = a.filter((x, i) => !x.startsWith('--') && !(slow && i === fi + 1));
appendFileSync(process.env.LOG, JSON.stringify({ t: Date.now(), pid: process.pid, argv: a, env: Object.keys(process.env), cwd: process.cwd() }) + '\\n');
if (ctl.sleepMs) await new Promise((r) => setTimeout(r, ctl.sleepMs));
if (ctl.mode === 'badjson') { console.log('nope'); process.exit(0); }
if (ctl.mode === 'exit') { console.error('first\\nboom last line'); process.exit(3); }
if (ctl.mode === 'hang') { await new Promise(() => setInterval(() => {}, 1000)); }
if (ctl.mode === 'schema2') { console.log(JSON.stringify({ schema: 2, rows: [] })); process.exit(0); }
if (ctl.mode === 'toperror') { console.log(JSON.stringify({ schema: 1, error: 'login expired', errorKind: 'auth', rows: [] })); process.exit(0); }
const src = (slow ? ctl.slow : ctl.rows) ?? {};
const rows = ids.filter((id) => src[id]).map((id) => ({ id, ...src[id] }));
console.log(JSON.stringify({ schema: 1, rows: [...rows, ...(ctl.extra ?? [])] }));
`;

type Ctl = { mode?: string; sleepMs?: number; rows?: Record<string, object>; slow?: Record<string, object>; extra?: object[] };
function fixture(manifest: object = {}, o: { allowed?: string[]; now?: () => number } = {}) {
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-jobs-')));
  const ctlFile = join(r, 'ctl.json'), logFile = join(r, 'log.jsonl');
  const ctl = (c: Ctl) => writeFileSync(ctlFile, JSON.stringify(c));
  ctl({});
  const dir = join(r, 'jobsrc', 'fake');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, name: 'fake', description: 'fake', command: [process.execPath, 'fake.mjs'], pollS: 0.1, timeoutS: 5, env: { pass: ['PASSME'], set: { CTL: ctlFile, LOG: logFile } }, ...manifest }));
  writeFileSync(join(dir, 'fake.mjs'), SCRIPT);
  const registry = createRegistry({ data: join(r, 'data'), dir: join(r, 'jobsrc'), locations: () => ({ data: join(r, 'data'), notes: [join(r, 'notes')], projects: [] }) });
  const approve = () => registry.approve('fake', hashFolder(dir).sha256);
  approve();
  const panelCalls: Panel[] = [], removed: string[] = [], statuses: PanelStatus[] = [];
  let last: Panel | undefined;
  const handlers = new Map<string, (a: string, x: any) => unknown>();
  const panels = {
    setPanel: (p: Panel) => { panelCalls.push(p); last = p; },
    removePanel: (id: string) => { removed.push(id); last = undefined; },
    setPanelStatus: (s: PanelStatus) => { statuses.push(s); },
    onPanelAction: (id: string, h: (a: string, x: any) => unknown) => { handlers.set(id, h); },
    panels: () => (last ? [last] : []),
  };
  const changes: Change[][] = [], notices: string[] = [];
  const make = () => createJobs({ panels, registry, timers: false, now: o.now, allowed: o.allowed ? () => o.allowed! : undefined, onChanges: (c) => changes.push(c), onNotice: (n) => notices.push(n.kind) });
  const calls = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const rows = (): Row[] => ((last?.data as { rows: Row[] } | undefined)?.rows ?? []);
  return { r, dir, ctl, registry, approve, panelCalls, removed, statuses, handlers, changes, notices, make, calls, rows, panels, logFile, last: () => last };
}

test('backoff is 1x, 2x, 4x of pollS, at most 5 minutes', () => {
  assert.deepEqual([0, 1, 2, 3, 9].map((n) => backoffMs(60, n)), [60_000, 120_000, 240_000, 240_000, 240_000]);
  assert.deepEqual([0, 1, 2, 3].map((n) => backoffMs(100, n)), [100_000, 200_000, 300_000, 300_000]);
  assert.equal(backoffMs(900, 2), 900_000);
});

test('a bad poll fails: bad JSON, non-zero exit with the last stderr line, schema 2, job source error', async () => {
  const f = fixture(), j = f.make();
  f.ctl({ rows: { a: { state: 'running' } } });
  await j.watch('fake', ['a']);
  assert.equal(f.rows()[0].state, 'running');
  for (const [mode, re] of [['badjson', /not a JSON object/], ['exit', /^boom last line$/], ['schema2', /job source speaks schema 2, Jarvis knows 1/], ['toperror', /login expired/]] as const) {
    f.ctl({ mode });
    await j.refresh();
    const s = f.statuses.at(-1)!;
    assert.equal(s.ok, false, mode);
    assert.match(s.error!, re, mode);
    assert.equal(f.rows()[0].state, 'running', 'a failed poll keeps the last rows');
  }
  assert.equal((f.statuses.at(-1)!.detail as any[])[0].errorKind, 'auth');
});

test('a timeout kills the child and fails the poll', async () => {
  const f = fixture({ timeoutS: 0.4 }), j = f.make();
  f.ctl({ mode: 'hang' });
  await j.watch('fake', ['a']);
  assert.match(f.statuses.at(-1)!.error!, /timed out/);
  await new Promise((r) => setTimeout(r, 100));
  const pid = f.calls()[0].pid;
  assert.throws(() => process.kill(pid, 0), 'child is gone');
});

test('validation: unknown fields ignored, stray ids and bad links dropped, unknown state, caps', () => {
  const m = validateManifest({ schema: 1, name: 'fake', description: 'd', command: ['x'] }).manifest;
  const out = (rows: object[], extra: object = {}) => JSON.stringify({ schema: 1, rows, ...extra });
  const p = parseOutput(out([
    { id: 'a', state: 'bogus', label: 'L'.repeat(500), detail: 'D'.repeat(500), link: 'javascript:alert(1)', zzz: 1, progress: { done: 3, total: 7 }, costUsd: 5 },
    { id: 'stray', state: 'running' },
    { id: 'b', state: 'done', link: 'https://x.test/run/1', progress: { done: -1 }, startedAt: 'not a date', error: 'e\u0007\u001b[31mred' },
  ]), ['a', 'b'], 'fast', m);
  assert.ok(p.ok);
  if (!p.ok) return;
  const a = p.rows.get('a')!, b = p.rows.get('b')!;
  assert.equal(a.state, 'unknown');
  assert.equal(a.label!.length, 200);
  assert.equal(a.detail!.length, 300);
  assert.equal(a.link, undefined);
  assert.deepEqual(a.progress, { done: 3, total: 7 });
  assert.equal((a as any).zzz, undefined);
  assert.equal(p.rows.has('stray'), false);
  assert.equal(b.link, 'https://x.test/run/1');
  assert.equal(b.progress, undefined);
  assert.equal(b.startedAt, undefined);
  assert.equal(b.error, 'e [31mred');
  assert.ok(p.warnings.some((w) => /not asked for/.test(w)) && p.warnings.some((w) => /bad link/.test(w)));
  const ids = Array.from({ length: 300 }, (_, i) => `i${i}`);
  const big = parseOutput(out(ids.map((id) => ({ id, state: 'done' }))), ids, 'fast', m);
  assert.ok(big.ok && big.rows.size === 200);
  assert.equal(parseOutput(out([], { schema: 3 }), [], 'fast', m).ok, false);
  assert.equal(parseOutput('[1]', [], 'fast', m).ok, false);
  const nf = parseOutput(out([{ id: 'a', state: 'done', costUsd: Infinity }]), ['a'], 'fast', m);
  assert.ok(nf.ok && nf.rows.get('a')!.costUsd === undefined);
});

test('{ids} makes one call; {id} one call per id, at most 4 at once', async () => {
  const one = fixture(), j1 = one.make();
  one.ctl({ rows: { a: { state: 'running' }, b: { state: 'running' }, c: { state: 'done' } } });
  await j1.watch('fake', ['a', 'b', 'c']);
  assert.equal(one.calls().length, 1);
  assert.deepEqual(one.calls()[0].argv, ['a', 'b', 'c']);
  const many = fixture({ args: ['--run={id}'], pollS: 5 }), j2 = many.make();
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  many.ctl({ sleepMs: 250, rows: Object.fromEntries(ids.map((i) => [i, { state: 'running' }])) });
  await j2.watch('fake', ids);
  const calls = many.calls();
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map((c) => c.argv[0]).sort(), ids.map((i) => `--run=${i}`));
  // `--run=a` is not an id flag for the script: its rows are looked up by ids it never sees, so assert only the call shape.
  const overlap = Math.max(...calls.map((c) => calls.filter((o) => o.t <= c.t && c.t < o.t + 250).length));
  assert.ok(overlap <= 4, `parallel calls ${overlap}`);
});

test('env holds only the base set plus pass, set and JARVIS_STATUS_SCHEMA', async () => {
  const f = fixture({ env: { pass: ['PASSME'], set: { CTL: 'x', LOG: 'y', RUN_URL: 'https://d/{id}' } } });
  const env = buildEnv(validateManifest({ schema: 1, name: 'fake', description: 'd', command: ['x'], args: ['{id}'], env: { pass: ['PASSME'], set: { RUN_URL: 'https://d/{id}' } } }).manifest, 'r1');
  assert.equal(env.RUN_URL, 'https://d/r1');
  assert.equal(env.JARVIS_STATUS_SCHEMA, '1');
  assert.equal(env.PASSME, 'yes');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  void f;
  const g = fixture(), j = g.make();
  g.ctl({ rows: { a: { state: 'running' } } });
  await j.watch('fake', ['a']);
  const seen = g.calls()[0].env as string[];
  assert.ok(seen.includes('PASSME') && seen.includes('JARVIS_STATUS_SCHEMA') && seen.includes('CTL') && seen.includes('PATH'));
  assert.ok(!seen.includes('ANTHROPIC_API_KEY') && !seen.includes('OTHER_SECRET'), 'no other server env');
  assert.equal(g.calls()[0].cwd, g.dir);
});

test('setPanel only on changed rows; first state is no change; changes batch per poll', async () => {
  const f = fixture(), j = f.make();
  f.ctl({ rows: { a: { state: 'running', step: 's1' }, b: { state: 'running' } } });
  await j.watch('fake', ['a', 'b']);
  const n = f.panelCalls.length;
  assert.deepEqual(f.changes, [], 'the first state of a new watch is no change');
  await j.refresh(); await j.refresh();
  assert.equal(f.panelCalls.length, n, 'identical rows: no setPanel');
  f.ctl({ rows: { a: { state: 'failed', error: 'x' }, b: { state: 'done' } } });
  await j.refresh();
  assert.equal(f.panelCalls.length, n + 1);
  assert.equal(f.changes.length, 1, 'two jobs changing in one poll give one batch');
  assert.deepEqual((f.changes[0] as Change[]).map((c: Change) => [c.id, c.from, c.to]).sort(), [['a', 'running', 'failed'], ['b', 'running', 'done']]);
  assert.equal(f.last()!.badge!.text, '✕1');
});

test('notify filters the batch', async () => {
  for (const [notify, expect] of [['any', 3], ['terminal', 1], ['failed', 0], ['none', 0]] as const) {
    const f = fixture({ notify }), j = f.make();
    f.ctl({ rows: { a: { state: 'queued' }, b: { state: 'running' }, c: { state: 'running' } } });
    await j.watch('fake', ['a', 'b', 'c']);
    f.ctl({ rows: { a: { state: 'running' }, b: { state: 'waiting' }, c: { state: 'done' } } });
    await j.refresh();
    assert.equal(f.changes.flat().length, expect, notify);
  }
  const f = fixture({ notify: 'failed' }), j = f.make();
  f.ctl({ rows: { a: { state: 'running' }, b: { state: 'running' } } });
  await j.watch('fake', ['a', 'b']);
  f.ctl({ rows: { a: { state: 'failed' }, b: { state: 'done' } } });
  await j.refresh();
  assert.deepEqual(f.changes.flat().map((c) => c.id), ['a']);
});

test('the watch list is rebuilt from the panel last data.rows', async () => {
  const f = fixture(), j = f.make();
  f.ctl({ rows: { a: { state: 'running' }, b: { state: 'done' } } });
  await j.watch('fake', ['a', 'b'], { a: 'Alpha' });
  assert.equal(f.rows()[0].label, 'Alpha');
  const j2 = f.make(); // same panel state, as after a restart
  assert.deepEqual(j2.jobs().rows.map((r) => r.id), ['a', 'b']);
  const before = f.calls().length;
  await j2.tick(Date.now() + 1);
  assert.equal(f.calls().length, before + 1, 'the restored list is polled');
  assert.equal(f.changes.length, 0);
});

test('a changed job source is stopped by the hash check before the run; one notice', async () => {
  const f = fixture(), j = f.make();
  f.ctl({ rows: { a: { state: 'running' } } });
  await j.watch('fake', ['a']);
  const n = f.calls().length;
  writeFileSync(join(f.dir, 'fake.mjs'), SCRIPT + '\n// edited');
  await j.refresh(); await j.refresh();
  assert.equal(f.calls().length, n, 'not run');
  assert.match(f.rows()[0].stale!, /files changed/);
  assert.deepEqual(f.notices, ['changed']);
  assert.equal(f.last()!.badge!.text, '⚠');
  await assert.rejects(() => j.watch('fake', ['z']), /files changed/);
  f.approve();
  await j.refresh();
  assert.equal(f.rows()[0].stale, undefined);
  assert.equal(f.calls().length, n + 1);
});

test('watch refuses unapproved, disabled and invalid ids; clear and unwatch', async () => {
  const f = fixture({ maxIds: 2, idPattern: '^[a-z]+$' }, { allowed: ['other'] }), j = f.make();
  await assert.rejects(() => j.watch('fake', ['a']), /not enabled for this workspace/);
  const g = fixture({ maxIds: 2, idPattern: '^[a-z]+$' }), k = g.make();
  g.ctl({ rows: { a: { state: 'done' }, b: { state: 'running' }, c: { state: 'waiting' } } });
  await assert.rejects(() => k.watch('nope', ['a']), /unknown job source/);
  await assert.rejects(() => k.watch('fake', ['-a']), /id not accepted/);
  await assert.rejects(() => k.watch('fake', ['A1']), /id not accepted/);
  await assert.rejects(() => k.watch('fake', ['a', 'b', 'c']), /at most 2/);
  await assert.rejects(() => k.watch('fake', []), /no ids/);
  assert.equal(g.calls().length, 0, 'refused watches run nothing');
  await k.watch('fake', ['a', 'b']);
  assert.deepEqual(k.clear({ keepCurrent: true }), { removed: 1 });
  assert.deepEqual(g.rows().map((r) => r.id), ['b']);
  assert.deepEqual(k.clear({ ids: ['b'] }), { removed: 1 });
  assert.deepEqual(g.removed, ['jobs']);
  const h = fixture(), m = h.make();
  h.ctl({ rows: { a: { state: 'running' } } });
  await m.watch('fake', ['a']);
  await h.handlers.get('jobs')!('unwatch', { id: 'a' });
  assert.equal(h.rows().length, 0);
  await assert.rejects(async () => h.handlers.get('jobs')!('nope', {}), { status: 400 });
});

test('clear with keepCurrent keeps queued, running and waiting', async () => {
  const f = fixture(), j = f.make();
  f.ctl({ rows: { q: { state: 'queued' }, r: { state: 'running' }, w: { state: 'waiting' }, d: { state: 'done' }, x: { state: 'failed' }, s: { state: 'stopped' } } });
  await j.watch('fake', ['q', 'r', 'w', 'd', 'x', 's']);
  j.clear({ keepCurrent: true });
  assert.deepEqual(f.rows().map((r) => r.id).sort(), ['q', 'r', 'w']);
});

test('JARVIS_JOBS=0 spawns nothing', async () => {
  const f = fixture();
  process.env.JARVIS_JOBS = '0';
  try {
    const j = f.make();
    assert.equal(f.handlers.size, 0);
    await assert.rejects(() => j.watch('fake', ['a']), /turned off/);
    await j.tick(Date.now() + 1); await j.refresh();
    j.start(); j.stop();
    assert.equal(f.calls().length, 0);
    assert.equal(f.panelCalls.length, 0);
  } finally { delete process.env.JARVIS_JOBS; }
});

test('slow fields: own cadence with --fields, fast run never asks, merged by id with fetch time', async () => {
  let t = Date.parse('2026-11-25T14:00:00Z');
  const f = fixture({ slow_fields: { cost: '1s' }, pollS: 0.1 }, { now: () => t }), j = f.make();
  f.ctl({ rows: { a: { state: 'running', costUsd: 99 } }, slow: { a: { costUsd: 12.4, state: 'done' } } });
  await j.watch('fake', ['a']);
  const argvs = () => f.calls().map((c) => c.argv as string[]);
  assert.deepEqual(argvs(), [['a'], ['a', '--fields', 'cost']]);
  assert.equal(f.rows()[0].costUsd, 12.4, 'the fast run dropped its own costUsd, the slow value is merged');
  assert.equal(f.rows()[0].state, 'running', 'the slow run never changes the state');
  assert.equal(f.rows()[0].asOf!.costUsd, '2026-11-25T14:00:00.000Z');
  t += 300; // a fast poll is due, the slow one is not
  await j.tick(t);
  assert.equal(argvs().length, 3);
  assert.deepEqual(argvs()[2], ['a']);
  assert.equal(f.rows()[0].asOf!.costUsd, '2026-11-25T14:00:00.000Z', 'the fetch time survives fast runs');
  t += 1500;
  f.ctl({ rows: { a: { state: 'running' } }, slow: { a: { costUsd: 13.5 } } });
  await j.tick(t);
  assert.deepEqual(argvs().slice(3), [['a'], ['a', '--fields', 'cost']]);
  assert.equal(f.rows()[0].costUsd, 13.5);
  assert.equal(f.rows()[0].asOf!.costUsd, new Date(t).toISOString());
});

test('a job source without the field gives no value and no asOf', async () => {
  const f = fixture({ slow_fields: { cost: '1s' } }), j = f.make();
  f.ctl({ rows: { a: { state: 'running' } }, slow: { a: {} } });
  await j.watch('fake', ['a']);
  assert.equal('costUsd' in f.rows()[0], false);
  assert.equal(f.rows()[0].asOf, undefined);
  f.ctl({ rows: { a: { state: 'running' } }, slow: { a: { costUsd: null } } });
  await j.refresh();
  assert.equal(f.rows()[0].asOf, undefined);
  const g = fixture(), k = g.make(); // no slow_fields: never a slow run
  g.ctl({ rows: { a: { state: 'running' } } });
  await k.watch('fake', ['a']); await k.refresh();
  assert.ok(g.calls().every((c) => !c.argv.includes('--fields')));
});

test('unreachable for 30 minutes while jobs run sends one notice', async () => {
  let t = Date.parse('2026-11-25T14:00:00Z');
  const f = fixture({}, { now: () => t });
  const j = f.make();
  f.ctl({ rows: { a: { state: 'running' } } });
  await j.watch('fake', ['a']);
  f.ctl({ mode: 'exit' });
  for (let i = 0; i < 40; i++) { t += 60_000; await j.tick(t); }
  assert.deepEqual(f.notices, ['unreachable']);
});

test('job-source-check validates, runs fast and slow, and reports rows, warnings and the hash', async () => {
  const f = fixture({ slow_fields: { cost: '1s' } });
  f.ctl({ rows: { a: { state: 'running', junk: 1 } }, slow: { a: { costUsd: 2 } }, extra: [{ id: 'stray', state: 'done' }] });
  const rep = await jobSourceCheck(f.dir, ['a']);
  assert.ok(rep.ok, rep.text);
  assert.match(rep.text, new RegExp(hashFolder(f.dir).sha256));
  assert.match(rep.text, /"costUsd":2/);
  assert.match(rep.text, /unknown field "junk"/);
  assert.match(rep.text, /not asked for/);
  assert.match(rep.text, /slow run: ok \(--fields cost\)/);
  f.ctl({ mode: 'exit' });
  const bad = await jobSourceCheck(f.dir, ['a']);
  assert.equal(bad.ok, false);
  assert.match(bad.text, /boom last line/);
  assert.equal((await jobSourceCheck(f.dir, ['-x'])).ok, false);
  assert.equal((await jobSourceCheck(join(f.r, 'nothing'), ['a'])).ok, false);
});

test('no LLM or agent: the module imports no SDK, agents or claude', () => {
  const src = readFileSync(new URL('../src/jobs.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/job-sources.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /agent-sdk|from '\.\/agents|spawn\('claude/);
});

test('a cwd that is not a folder fails the poll instead of crashing', async () => {
  const f = fixture(), j = f.make();
  const r = await runProcess([process.execPath, '-e', '0'], { cwd: join(f.r, 'ctl.json'), env: {}, timeoutMs: 1000 });
  assert.deepEqual(r, { ok: false, error: `cwd ${join(f.r, 'ctl.json')} is not a folder` });
  const g = fixture({ cwd: join(f.r, 'ctl.json') }), jg = g.make();
  g.ctl({ rows: { a: { state: 'running' } } });
  await jg.watch('fake', ['a']);
  assert.equal(g.statuses.at(-1)!.ok, false);
  assert.match(g.statuses.at(-1)!.error!, /not a folder/);
  void j;
});

test('a job source that throws in a poll gives a failed status, not an unhandled rejection', async () => {
  const f = fixture(), j = f.make();
  f.ctl({ rows: { a: { state: 'running' } } });
  await j.watch('fake', ['a']);
  const use = f.registry.use;
  f.registry.use = () => { throw new Error('files changed'); }; // refused: stale path
  await j.refresh();
  f.registry.use = () => { throw new TypeError('boom'); };
  await j.refresh();
  assert.equal(f.statuses.at(-1)!.ok, false);
  f.registry.use = use;
});

test('an id that names a file of the job source folder stays an id in argv', () => {
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-argv-')));
  writeFileSync(join(r, 'x.py'), '');
  const m = validateManifest({ schema: 1, name: 'p', description: 'd', command: ['node', 'x.py'], args: ['x.py', '{ids}'] }).manifest;
  assert.deepEqual(buildArgv(r, m, ['x.py']), ['node', join(r, 'x.py'), join(r, 'x.py'), 'x.py']);
  const one = validateManifest({ schema: 1, name: 'p', description: 'd', command: ['node'], args: ['--run={id}'] }).manifest;
  assert.deepEqual(buildArgv(r, one, ['x.py']), ['node', '--run=x.py']);
});

test('watch labels survive a restart and are dropped by unwatch and clear', async () => {
  const f = fixture(), j = f.make();
  f.ctl({ rows: { a: { state: 'running' }, b: { state: 'done' } } });
  await j.watch('fake', ['a', 'b'], { a: 'Alpha', b: 'Beta' });
  const j2 = f.make(); // restart
  f.ctl({ rows: { a: { state: 'running', label: 'from job source' }, b: { state: 'running', label: 'from job source' } } });
  await j2.tick(Date.now() + 1);
  assert.equal(f.rows().find((r) => r.id === 'a')!.label, 'Alpha');
  j2.unwatch('a', 'fake');
  j2.clear({ ids: ['b'] });
  await j2.watch('fake', ['a', 'b']);
  assert.deepEqual(f.rows().map((r) => r.label), ['from job source', 'from job source']);
});

test('watch during a poll triggers one more poll right after it', async () => {
  const f = fixture({ pollS: 60 }), j = f.make();
  f.ctl({ sleepMs: 300, rows: { a: { state: 'running' }, b: { state: 'running' } } });
  const first = j.watch('fake', ['a']);
  await new Promise((r) => setTimeout(r, 100));
  await j.watch('fake', ['b']);
  await first;
  assert.equal(f.rows().find((r) => r.id === 'b')?.state, 'running');
  assert.deepEqual(f.calls().at(-1)!.argv, ['a', 'b']);
});

test('finished rows are not polled again', async () => {
  const f = fixture(), j = f.make();
  f.ctl({ rows: { a: { state: 'done' }, b: { state: 'running' } } });
  await j.watch('fake', ['a', 'b']);
  await j.tick(Date.now() + 1000);
  assert.deepEqual(f.calls().at(-1)!.argv, ['b']);
  f.ctl({ rows: { a: { state: 'done' }, b: { state: 'done' } } });
  await j.tick(Date.now() + 10_000);
  const n = f.calls().length;
  await j.tick(Date.now() + 20_000);
  assert.equal(f.calls().length, n, 'no call when every row is finished');
});

test('a job that finishes in the fast run still gets its slow values, and a finished job is no longer polled', async () => {
  let t = Date.parse('2026-11-25T14:00:00Z');
  const f = fixture({ slow_fields: { cost: '1s' }, pollS: 0.1 }, { now: () => t }), j = f.make();
  f.ctl({ rows: { a: { state: 'running' } }, slow: { a: { costUsd: 1 } } });
  await j.watch('fake', ['a']);
  t += 2000;
  f.ctl({ rows: { a: { state: 'done' } }, slow: { a: { costUsd: 7.5 } } });
  await j.tick(t);
  assert.equal(f.rows()[0].state, 'done');
  assert.equal(f.rows()[0].costUsd, 7.5, 'the slow run asked for the id that just finished');
  assert.deepEqual(f.calls().at(-1).argv, ['a', '--fields', 'cost']);
  const n = f.calls().length;
  t += 5000;
  await j.tick(t);
  assert.equal(f.calls().length, n, 'a job source with only finished rows is not run');
});
