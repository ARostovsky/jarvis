import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync, rmSync, symlinkSync, utimesSync, lutimesSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startGuard, sweepTests, sweepClaude, removeAgentTmp, lowOn, crossing, slugOfCwd, warnText, isOwnName, ownSlugs, claudeRoots } from '../src/tmpguard.ts';

const root = mkdtempSync(join(tmpdir(), 'jarvis-tmp-guard-test-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
const DAY = 86_400_000;
const mk = (dir: string, name: string, ageMs = 0) => {
  const p = join(dir, name);
  mkdirSync(join(p, 'sub'), { recursive: true });
  writeFileSync(join(p, 'sub', 'f'), 'x');
  const t = (Date.now() - ageMs) / 1000;
  for (const x of [p, join(p, 'sub'), join(p, 'sub', 'f')]) utimesSync(x, t, t);
  return p;
};

const OWN = ['jarvis-tmp-e2e-aB3dE9', 'jarvis-tmp-test-aB3dE9', 'jarvis-notes-test-aB3dE9', 'jarvis-oi-wiring-test-aB3dE9', 'jarvis-jobs-aB3dE9', 'jarvis-layout-aB3dE9', 'jarvis-jobsrc-aB3dE9', 'jarvis-prov-aB3dE9', 'jv-cap-aB3dE9', 'jv-mute-aB3dE9', 'jarvis-e2e-repo-aB3dE9', 'jarvis-e2e-data-7846', 'jarvis-e2e-config-7846', 'jarvis-e2e-job-sources-9600'];
// What a user could name a folder: similar, but not what mkdtemp makes.
const USERS = ['jarvis-jobs', 'jarvis-jobs-old', 'jarvis-jobs-aB3dE9x', 'jarvis-jobs-report', 'jarvis-job-source-notes', 'jarvis-layout', 'jv-cap', 'jv-capture-2024', 'jarvis-e2e-data-backup', 'jarvis-notes', 'jarvis-tmp-', 'jarvis-index-1-2', 'jarvis'];

test('sweepTests removes old dirs with exactly our names only', () => {
  const d = join(root, 'a'); mkdirSync(d);
  const old = OWN.map((x) => mk(d, x, 2 * DAY));
  const fresh = mk(d, 'jarvis-e2e-data-1', 1000);
  const foreign = [...USERS, 'pytest-of-me', 'precheck', 'claude-1002'].map((x) => mk(d, x, 9 * DAY));
  const gone = sweepTests(d, { maxAgeMs: DAY });
  assert.equal(gone.length, OWN.length);
  for (const p of old) assert.ok(!existsSync(p), p);
  for (const p of [fresh, ...foreign]) assert.ok(existsSync(p), p);
});

test('isOwnName', () => {
  for (const n of OWN) assert.ok(isOwnName(n), n);
  for (const n of USERS) assert.ok(!isOwnName(n), n);
});

test('sweepTests leaves a symlink alone and a missing dir is no error', () => {
  const d = join(root, 'b'); mkdirSync(d);
  const target = mk(root, 'target', 9 * DAY);
  symlinkSync(target, join(d, "jarvis-e2e-link"));
  assert.deepEqual(sweepTests(d, { maxAgeMs: 0 }), []);
  assert.ok(existsSync(target));
  assert.deepEqual(sweepTests(join(root, 'nope')), []);
});

test('sweep age is the newest mtime inside: a fresh deep file keeps the dir, a fully old dir goes', () => {
  const d = join(root, 'age'); mkdirSync(d);
  const deep = mk(d, 'jarvis-tmp-e2e-aB3dE9', 9 * DAY);
  mkdirSync(join(deep, 'sub', 'x', 'y'), { recursive: true });
  writeFileSync(join(deep, 'sub', 'x', 'y', 'fresh'), 'x'); // new file: age the dirs above it back
  const t = (Date.now() - 9 * DAY) / 1000;
  for (const x of [deep, join(deep, 'sub'), join(deep, 'sub', 'x'), join(deep, 'sub', 'x', 'y')]) utimesSync(x, t, t);
  const old = mk(d, 'jarvis-tmp-e2e-bC4eF0', 9 * DAY);
  assert.deepEqual(sweepTests(d, { maxAgeMs: DAY }), ['jarvis-tmp-e2e-bC4eF0']);
  assert.ok(existsSync(deep) && !existsSync(old));
});

test('sweep age does not follow a symlink inside to a fresh file outside', () => {
  const d = join(root, 'age2'); mkdirSync(d);
  const outside = join(root, 'fresh-outside'); writeFileSync(outside, 'x');
  const old = mk(d, 'jarvis-tmp-e2e-aB3dE9', 9 * DAY);
  symlinkSync(outside, join(old, 'sub', 'link'));
  const t = (Date.now() - 9 * DAY) / 1000;
  utimesSync(join(old, 'sub'), t, t);
  lutimesSync(join(old, 'sub', 'link'), t, t);
  assert.deepEqual(sweepTests(d, { maxAgeMs: DAY }), ['jarvis-tmp-e2e-aB3dE9']);
  assert.ok(existsSync(outside));
});

test('sweep keeps a dir it cannot read completely', { skip: process.getuid?.() === 0 }, () => {
  const d = join(root, 'age3'); mkdirSync(d);
  const p = mk(d, 'jarvis-tmp-e2e-aB3dE9', 9 * DAY);
  chmodSync(join(p, 'sub'), 0);
  try { assert.deepEqual(sweepTests(d, { maxAgeMs: DAY }), []); assert.ok(existsSync(p)); }
  finally { chmodSync(join(p, 'sub'), 0o700); }
});

const DATA_ROOT = '/data/jarvis';
test('sweepClaude: own slug with dir boundary, old, not live', () => {
  const d = join(root, 'c'); mkdirSync(d);
  const own = ownSlugs(DATA_ROOT);
  const oldStopped = mk(d, `${own[0]}a-arbiter`, 8 * DAY);
  const oldTree = mk(d, `${own[1]}b.1`, 8 * DAY);
  const oldLive = mk(d, `${own[0]}live-arbiter`, 8 * DAY);
  const young = mk(d, `${own[0]}c-arbiter`, DAY);
  const foreign = ['-home-me-project', '-data-jarvis-old-workspaces-x-arbiter', '-data-jarvis-bak-worktrees-x', '-data-jarvis-notes-x'].map((n) => mk(d, n, 30 * DAY));
  const gone = sweepClaude([d], own, new Set([`${own[0]}live-arbiter`]), { maxAgeMs: 7 * DAY });
  assert.deepEqual(gone.sort(), [`${own[0]}a-arbiter`, `${own[1]}b.1`].sort());
  assert.ok(!existsSync(oldStopped) && !existsSync(oldTree));
  for (const p of [oldLive, young, ...foreign]) assert.ok(existsSync(p), p);
});

test('removeAgentTmp: only exclusive roots, never while a running agent shares the cwd', () => {
  const excl = join(root, 'e1'), shared = join(root, 'e2'); mkdirSync(excl); mkdirSync(shared);
  const cwd = '/home/me/project'; // a non-git agent works in the user's own folder
  const inExcl = mk(excl, slugOfCwd(cwd)), inShared = mk(shared, slugOfCwd(cwd));
  const roots = [{ dir: excl, exclusive: true }, { dir: shared, exclusive: false }];
  removeAgentTmp(cwd, [cwd], roots);
  assert.ok(existsSync(inExcl), 'a running agent (of any workspace) in the same cwd keeps it');
  removeAgentTmp(cwd, ['/other'], roots);
  assert.ok(!existsSync(inExcl));
  assert.ok(existsSync(inShared), 'the user\'s own claude dir under a shared root is never removed');
  removeAgentTmp(cwd, [], roots); // already gone: no error
});

test('claudeRoots: the plain temp dir is never exclusive, the default on-disk dir is', () => {
  const keep = { ...process.env };
  const tmp = join(root, 'cr-tmp'), cache = join(root, 'cr-cache'), uid = process.getuid!();
  mkdirSync(join(tmp, `claude-${uid}`), { recursive: true }); mkdirSync(join(cache, 'jarvis', 'claude-tmp', `claude-${uid}`), { recursive: true });
  delete process.env.JARVIS_CLAUDE_TMPDIR; delete process.env.CLAUDE_CODE_TMPDIR;
  Object.assign(process.env, { TMPDIR: tmp, XDG_CACHE_HOME: cache });
  try {
    const r = claudeRoots();
    assert.deepEqual(r.map((x) => x.exclusive), [true, false]);
    assert.ok(r[0].dir.startsWith(cache));
    process.env.CLAUDE_CODE_TMPDIR = tmp; // the user's own setting: shared with their sessions
    assert.ok(claudeRoots().every((x) => !x.exclusive));
  } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); for (const k of ['JARVIS_CLAUDE_TMPDIR', 'CLAUDE_CODE_TMPDIR']) if (!(k in keep)) delete process.env[k]; }
});

test('slugOfCwd matches the claude dir naming', () => {
  assert.equal(slugOfCwd('/home/hatari/.local/share/jarvis/workspaces/cv-upd-89m7/arbiter'), '-home-hatari--local-share-jarvis-workspaces-cv-upd-89m7-arbiter');
});

test('lowOn: below the percent of free inodes or space', () => {
  const v = { files: 1000, ffree: 500, blocks: 1000, bavail: 500, bsize: 4096 };
  assert.deepEqual(lowOn(v, 10), { inodes: false, space: false });
  assert.deepEqual(lowOn({ ...v, ffree: 99 }, 10), { inodes: true, space: false });
  assert.deepEqual(lowOn({ ...v, ffree: 100 }, 10), { inodes: false, space: false }); // exactly 10% is not below
  assert.deepEqual(lowOn({ ...v, bavail: 50 }, 10), { inodes: false, space: true });
  assert.deepEqual(lowOn({ ...v, files: 0, ffree: 0 }, 10), { inodes: false, space: false }); // no inode count
});

test('lowOn hysteresis: a low resource re-arms only above threshold + 5 points', () => {
  const at = (pct: number) => ({ files: 1000, ffree: pct * 10, blocks: 1000, bavail: 500, bsize: 1 });
  const lo = { inodes: true, space: false };
  assert.equal(lowOn(at(12), 10, lo).inodes, true, '12% is above 10 but not above 15: still low');
  assert.equal(lowOn(at(15), 10, lo).inodes, false);
  assert.equal(lowOn(at(12), 10).inodes, false, 'not low before: 12% is fine');
  assert.equal(lowOn(at(9), 10).inodes, true);
  const ok = { inodes: false, space: false };
  let prev = ok, warns = 0;
  for (const pct of [9, 11, 9, 12, 9, 16, 9]) { const now = lowOn(at(pct), 10, prev); if (crossing(prev, now).inodes) warns++; prev = now; }
  assert.equal(warns, 2, 'dips around the line warn once; after a real recovery (16%) a new dip warns again');
});

test('crossing warns only on the step into low', () => {
  const ok = { inodes: false, space: false }, lo = { inodes: true, space: false };
  assert.deepEqual(crossing(ok, lo), { inodes: true, space: false });
  assert.deepEqual(crossing(lo, lo), { inodes: false, space: false });
  assert.deepEqual(crossing(lo, ok), { inodes: false, space: false });
  assert.deepEqual(crossing(ok, { inodes: true, space: true }), { inodes: true, space: true });
});

test('warnText names the resource and the consumers', () => {
  const t = warnText({ inodes: true, space: false }, { files: 1000, ffree: 50, blocks: 1, bavail: 1, bsize: 1 }, '/tmp/x (900)');
  assert.match(t, /50 of 1000 inodes free/);
  assert.match(t, /\/tmp\/x \(900\)/);
});

test('startGuard sweeps, and posts exactly one warning per crossing', async () => {
  const tmp = join(root, 'guard-tmp'), data = join(root, 'guard-data');
  mkdirSync(tmp); mkdirSync(data);
  const keep = { ...process.env };
  Object.assign(process.env, { TMPDIR: tmp, XDG_DATA_HOME: data, JARVIS_TMP_MAX_AGE_H: '1', JARVIS_CLAUDE_TMP_MAX_AGE_H: '1', JARVIS_TMP_CHECK_MS: '30', JARVIS_TMP_SWEEP_MS: '30', JARVIS_TMP_MIN_FREE_PCT: '101' });
  delete process.env.JARVIS_TMPGUARD; // npm test sets it to 0
  const slug = ownSlugs(join(data, 'jarvis'))[0];
  const claudeDir = join(tmp, `claude-${process.getuid!()}`); mkdirSync(claudeDir); // the layout a real session makes
  const oldTest = mk(tmp, 'jarvis-e2e-data-1', 2 * 3_600_000);
  const oldAgent = mk(claudeDir, `${slug}a-arbiter`, 2 * 3_600_000);
  const liveAgent = mk(claudeDir, `${slug}b-arbiter`, 2 * 3_600_000);
  const notices: string[] = [];
  const stop = startGuard(() => [{ liveCwds: () => [join(data, 'jarvis', 'workspaces', 'b', 'arbiter')], notice: (t: string) => void notices.push(t) }], () => {});
  try {
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!existsSync(oldTest) && !existsSync(oldAgent), 'sweep removed old leftovers');
    assert.ok(existsSync(liveAgent), 'live agent dir kept');
    assert.equal(notices.length, 1, 'many checks while low: one warning');
    assert.match(notices[0], /nearly full/);
    process.env.JARVIS_TMP_MIN_FREE_PCT = '0'; // recovered
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(notices.length, 1);
    process.env.JARVIS_TMP_MIN_FREE_PCT = '101'; // a new crossing
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(notices.length, 2, 'one more warning after recovery and a new crossing');
  } finally {
    stop();
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
});

test('a failing volume check is logged once, not every tick', async () => {
  const keep = { ...process.env };
  Object.assign(process.env, { TMPDIR: join(root, 'does-not-exist'), JARVIS_TMP_CHECK_MS: '20', JARVIS_TMP_SWEEP_MS: '3600000' });
  delete process.env.JARVIS_TMPGUARD;
  const logs: string[] = [];
  const stop = startGuard(() => [], (m) => void logs.push(m));
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(logs.filter((m) => m.startsWith('tmp check failed')).length, 1);
  } finally {
    stop();
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
});
