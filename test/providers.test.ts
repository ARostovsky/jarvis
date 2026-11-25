import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, renameSync, readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFolder, validateManifest, checkLocations, loadProvider, createRegistry, idOk, limits, type Locations } from '../src/providers.ts';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-prov-')));
const manifest = (o: object = {}) => ({ schema: 1, name: 'demo', description: 'd', command: ['node', 's.mjs'], ...o });
function folder(root: string, name = 'demo', m: object = {}, script = 'console.log(1)') {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'manifest.json'), JSON.stringify({ ...manifest(), name, ...m }));
  writeFileSync(join(d, 's.mjs'), script);
  return d;
}
const fail = (f: () => unknown, re: RegExp) => assert.throws(f, re);

test('hash is stable and changes on any byte, rename or new file', () => {
  const d = folder(tmp());
  const h = hashFolder(d).sha256;
  assert.equal(hashFolder(d).sha256, h);
  writeFileSync(join(d, 's.mjs'), 'console.log(2)');
  const h2 = hashFolder(d).sha256;
  assert.notEqual(h2, h);
  writeFileSync(join(d, 'extra.txt'), '');
  const h3 = hashFolder(d).sha256;
  assert.notEqual(h3, h2);
  renameSync(join(d, 'extra.txt'), join(d, 'renamed.txt'));
  assert.notEqual(hashFolder(d).sha256, h3);
});

test('symlinks, banned folders, more than 50 files and more than 1 MB are refused', () => {
  const r = tmp(), d = folder(r);
  symlinkSync('/etc/hostname', join(d, 'link'));
  fail(() => hashFolder(d), /symlink/);
  const e = folder(r, 'e');
  mkdirSync(join(e, '.venv'));
  fail(() => hashFolder(e), /\.venv/);
  const n = folder(r, 'n');
  mkdirSync(join(n, 'node_modules'));
  fail(() => hashFolder(n), /node_modules/);
  const many = folder(r, 'many');
  for (let i = 0; i < 48; i++) writeFileSync(join(many, `f${i}`), '');
  assert.ok(hashFolder(many).sha256);
  writeFileSync(join(many, 'one-more'), '');
  fail(() => hashFolder(many), /50 files/);
  const big = folder(r, 'big');
  writeFileSync(join(big, 'blob'), Buffer.alloc(1024 * 1024 + 1));
  fail(() => hashFolder(big), /1 MB/);
  symlinkSync(folder(r, 'target'), join(r, 'linked'));
  fail(() => hashFolder(join(r, 'linked')), /symlink/);
});

test('manifest validation', () => {
  const v = (o: object) => validateManifest({ ...manifest(), ...o }, undefined);
  assert.equal(v({}).manifest.mode, 'ids');
  assert.equal(v({ args: ['--run={id}'] }).manifest.mode, 'id');
  fail(() => v({ name: 'Bad Name' }), /name/);
  fail(() => validateManifest(manifest(), 'other'), /folder name/);
  fail(() => v({ args: [] }), /exactly one/);
  fail(() => v({ args: ['{id}', '{ids}'] }), /exactly one/);
  fail(() => v({ args: ['x{ids}'] }), /whole/);
  fail(() => v({ kind: 'checklist' }), /kind/);
  assert.equal(v({ kind: 'jobs' }).manifest.kind, 'jobs');
  fail(() => v({ schema: 2 }), /schema/);
  fail(() => v({ command: ['claude', '-p'] }), /claude/);
  fail(() => v({ command: ['/usr/bin/claude-code'] }), /claude/);
  fail(() => v({ command: ['uv', 'run', 'claude'] }), /claude/);
  fail(() => v({ notify: 'loud' }), /notify/);
  fail(() => v({ env: { pass: ['ANTHROPIC_API_KEY'] } }), /not allowed/);
  fail(() => v({ slow_fields: { id: '30m' } }), /slow_fields/);
  assert.ok(v({ bogus: 1 }).warnings.some((w) => /bogus/.test(w)));
  const m = v({}).manifest;
  assert.deepEqual([m.pollS, m.timeoutS, m.maxIds, m.notify, m.cwd], [60, 60, 50, 'any', null]);
  assert.equal(v({ pollS: 1 }).manifest.pollS, 15);
  assert.equal(v({ pollS: 99999 }).manifest.pollS, 3600);
  assert.equal(v({ timeoutS: 1 }).manifest.timeoutS, 5);
});

test('slow_fields are clamped to 15..60 minutes, default 30m, cost means costUsd', () => {
  const save = process.env.JARVIS_JOBS_MIN_POLL_S;
  delete process.env.JARVIS_JOBS_MIN_POLL_S;
  try {
    const s = validateManifest(manifest({ slow_fields: { cost: '1m', step: '3h', label: null, detail: true, link: '20m' } })).manifest.slow;
    const by = Object.fromEntries(s.map((x) => [x.key, x.everyS]));
    assert.deepEqual(by, { cost: 900, step: 3600, label: 1800, detail: 1800, link: 1200 });
    assert.equal(s.find((x) => x.key === 'cost')!.field, 'costUsd');
    assert.equal(validateManifest(manifest()).manifest.slow.length, 0);
    fail(() => validateManifest(manifest({ slow_fields: { cost: 'soon' } })), /slow_fields/);
    process.env.JARVIS_JOBS_MIN_POLL_S = '0.5';
    assert.equal(limits().minSlowS, 0.5);
  } finally { if (save === undefined) delete process.env.JARVIS_JOBS_MIN_POLL_S; else process.env.JARVIS_JOBS_MIN_POLL_S = save; }
});

test('idPattern can only narrow the default', () => {
  const m = (p: string) => validateManifest(manifest({ idPattern: p })).manifest;
  const wide = m('.*');
  for (const bad of ['-x', 'a b', '', 'a\tb', 'a\nb', ' a', 'a'.repeat(201)]) assert.equal(idOk(wide, bad), false, JSON.stringify(bad));
  assert.equal(idOk(wide, 'run-1'), true);
  const narrow = m('^[0-9]+$');
  assert.equal(idOk(narrow, '123'), true);
  assert.equal(idOk(narrow, 'abc'), false);
  fail(() => m('('), /regular expression/);
  assert.equal(idOk(wide, 5), false);
});

const locs = (r: string): Locations => ({ data: join(r, 'data'), notes: [join(r, 'notes')], projects: [join(r, 'proj')] });
function setupLocs() {
  const r = tmp();
  for (const d of ['data/worktrees/ws', 'notes/sub', 'proj/sub', 'ok']) mkdirSync(join(r, d), { recursive: true });
  return r;
}

test('location rules after realpath, also through a symlinked parent', () => {
  const r = setupLocs(), loc = locs(r);
  const mf = (o: object = {}) => validateManifest(manifest(o)).manifest;
  assert.deepEqual(checkLocations(folder(join(r, 'ok')), mf(), loc), []);
  fail(() => checkLocations(folder(join(r, 'notes', 'sub')), mf(), loc), /notes folder/);
  fail(() => checkLocations(folder(join(r, 'proj', 'sub')), mf(), loc), /project folder/);
  fail(() => checkLocations(folder(join(r, 'data', 'worktrees', 'ws')), mf(), loc), /worktree/);
  symlinkSync(join(r, 'notes', 'sub'), join(r, 'ok', 'via'));
  fail(() => checkLocations(join(r, 'ok', 'via', 'demo'), mf(), loc), /notes folder/);
  const d = folder(join(r, 'ok'), 'cw');
  fail(() => checkLocations(d, mf({ cwd: join(r, 'notes') }), loc), /cwd/);
  fail(() => checkLocations(d, mf({ cwd: join(r, 'data', 'worktrees', 'ws') }), loc), /cwd/);
  fail(() => checkLocations(d, mf({ cwd: join(r, 'data') }), loc), /cwd/);
  fail(() => checkLocations(d, mf({ cwd: join(r, 'ok', 'via') }), loc), /cwd/);
  const w = checkLocations(d, mf({ cwd: join(r, 'proj', 'sub') }), loc);
  assert.equal(w.length, 1);
  assert.match(w[0], /agents may edit/);
  fail(() => checkLocations(d, mf({ command: [join(r, 'notes', 'sub', 'x.sh')] }), loc), /command/);
  fail(() => checkLocations(d, mf({ command: ['../x.sh'] }), loc), /leaves the provider folder/);
});

test('args entries follow the same location rules as command', () => {
  const r = setupLocs(), loc = locs(r), d = folder(join(r, 'ok'), 'ar');
  const mf = (args: string[]) => validateManifest(manifest({ args })).manifest;
  fail(() => checkLocations(d, mf([join(r, 'notes', 'sub', 'x.py'), '{ids}']), loc), /args entry/);
  fail(() => checkLocations(d, mf([join(r, 'proj', 'sub', 'x.py'), '{ids}']), loc), /args entry/);
  fail(() => checkLocations(d, mf(['../../notes/x.py', '{ids}']), loc), /args entry "..\/..\/notes\/x.py" leaves/);
  assert.deepEqual(checkLocations(d, mf(['--flag', 'sub/x.py', '{ids}']), loc), []);
});

test('an --opt=/abs/path arg follows the location rules for its path', () => {
  const r = setupLocs(), loc = locs(r), d = folder(join(r, 'ok'), 'eq');
  const mf = (args: string[]) => validateManifest(manifest({ args })).manifest;
  fail(() => checkLocations(d, mf([`--script=${join(r, 'notes', 'sub', 'x.py')}`, '{ids}']), loc), /args entry/);
  assert.deepEqual(checkLocations(d, mf(['--mode=fast', `--out=${join(r, 'ok', 'o')}`, '{ids}']), loc), []);
});

test('env.set absolute paths follow the location rules', () => {
  const r = setupLocs(), loc = locs(r), d = folder(join(r, 'ok'), 'es');
  const mf = (set: Record<string, string>) => validateManifest(manifest({ env: { set } })).manifest;
  fail(() => checkLocations(d, mf({ ZENML_PYTHON: join(r, 'proj', 'sub', '.venv', 'bin', 'python') }), loc), /env\.set\.ZENML_PYTHON .*compute the path inside the script/);
  fail(() => checkLocations(d, mf({ X: join(r, 'proj', 'sub', 'run-{id}') }), loc), /env\.set\.X/);
  fail(() => checkLocations(d, mf({ X: join(r, 'data', 'worktrees', 'ws', 'p') }), loc), /env\.set\.X/);
  fail(() => checkLocations(d, mf({ X: join(r, 'notes', 'sub', 'p') }), loc), /env\.set\.X/);
  assert.deepEqual(checkLocations(d, mf({ A: join(r, 'ok', 'python'), B: 'https://example.com/x', C: 'fast', D: '~/proj/x', E: join(r, 'ok', 'run-{id}') }), loc), []);
});

test('env.set refuses PATH, interpreter and loader variables', () => {
  for (const k of ['PATH', 'PYTHONPATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_PATH', 'PYTHONHOME', 'PERL5LIB', 'RUBYLIB', 'BASH_ENV', 'LD_AUDIT', 'LD_ANYTHING', 'DYLD_INSERT_LIBRARIES']) fail(() => validateManifest(manifest({ env: { set: { [k]: 'x' } } })), /not allowed/);
  validateManifest(manifest({ env: { set: { MY_PATH: 'x' } } }));
});

test('a refused draft leaves an already staged copy in place', () => {
  const r = tmp(), reg = createRegistry({ data: join(r, 'data'), dir: join(r, 'prov'), locations: () => locs(r) });
  const d = folder(r, 'demo');
  const l = reg.stage(d);
  assert.throws(() => reg.stage(d, () => { throw new Error('nope'); }), /nope/);
  assert.ok(existsSync(l.stagingDir));
});

function reg(r: string, onStep?: (s: string) => void) {
  return createRegistry({ data: join(r, 'data'), dir: join(r, 'prov'), locations: () => locs(r), onStep: onStep as never });
}

test('registry: stage, approve installs the copy, change stops it, stale hash fails', () => {
  const r = setupLocs(), g = reg(r);
  const draft = folder(join(r, 'ok'));
  assert.deepEqual(g.list(), []);
  const s = g.stage(draft);
  assert.ok(existsSync(s.stagingDir));
  writeFileSync(join(draft, 's.mjs'), 'console.log("changed after staging")');
  fail(() => g.use('demo'), /unknown provider/);
  const rec = g.approve('demo', s.sha256);
  assert.equal(rec.sha256, s.sha256);
  assert.equal(readFileSync(join(r, 'prov', 'demo', 's.mjs'), 'utf8'), 'console.log(1)', 'the staged copy is installed, not the edited draft');
  assert.equal(g.info('demo').state, 'approved');
  assert.equal(g.use('demo').sha256, s.sha256);
  assert.ok(JSON.parse(readFileSync(join(r, 'data', 'providers.json'), 'utf8')).demo.files.length === 2);
  writeFileSync(join(r, 'prov', 'demo', 's.mjs'), 'tampered');
  assert.equal(g.info('demo').state, 'changed');
  fail(() => g.use('demo'), /files changed/);
  fail(() => g.approve('demo', s.sha256), /stale/);
  fail(() => g.approve('demo', 'f'.repeat(64)), /stale/);
});

test('registry: refuses a draft in a notes folder, approves a hand-placed folder by hash', () => {
  const r = setupLocs(), g = reg(r);
  fail(() => g.stage(folder(join(r, 'notes', 'sub'))), /notes folder/);
  const placed = folder(join(r, 'prov'));
  assert.equal(g.list()[0].state, 'unapproved');
  const h = hashFolder(placed).sha256;
  g.approve('demo', h);
  assert.equal(g.list()[0].state, 'approved');
  const bad = folder(join(r, 'prov'), 'badone', { kind: 'x' });
  assert.equal(g.list().find((x) => x.name === 'badone')!.state, 'invalid');
  void bad;
});

test('registry: a newer approval moves the old version to provider-old', () => {
  const r = setupLocs(), g = reg(r);
  const draft = folder(join(r, 'ok'));
  g.approve('demo', g.stage(draft).sha256);
  writeFileSync(join(draft, 's.mjs'), 'console.log("v2")');
  const s2 = g.stage(draft);
  g.approve('demo', s2.sha256);
  assert.equal(readFileSync(join(r, 'prov', 'demo', 's.mjs'), 'utf8'), 'console.log("v2")');
  const olds = readdirSync(join(r, 'data', 'provider-old'));
  assert.equal(olds.length, 1);
  assert.match(olds[0], /^demo-\d{4}-\d{2}-\d{2}$/);
  assert.equal(readFileSync(join(r, 'data', 'provider-old', olds[0], 's.mjs'), 'utf8'), 'console.log(1)');
  assert.deepEqual(readdirSync(join(r, 'prov')), ['demo']);
});

test('registry: a crash at any step leaves the old or the new version, never a mix', () => {
  for (const crashAt of ['copied', 'backed-up', 'moved-old', 'swapped', 'recorded']) {
    const r = setupLocs();
    const draft = folder(join(r, 'ok'));
    const g = reg(r);
    const v1 = g.stage(draft).sha256;
    g.approve('demo', v1);
    writeFileSync(join(draft, 's.mjs'), 'console.log("v2")');
    const v2 = g.stage(draft).sha256;
    const crashing = reg(r, (s) => { if (s === crashAt) throw new Error('crash'); });
    fail(() => crashing.approve('demo', v2), /crash/);
    const after = reg(r); // a restart recovers
    const h = hashFolder(join(r, 'prov', 'demo')).sha256;
    assert.ok(h === v1 || h === v2, `${crashAt}: installed folder is a whole old or new version`);
    assert.deepEqual(readdirSync(join(r, 'prov')), ['demo'], `${crashAt}: no leftovers`);
    // A folder that differs from its approval never runs.
    const ap = after.approvals().demo.sha256;
    assert.equal(after.info('demo').state, ap === h ? 'approved' : 'changed', crashAt);
  }
});

test('loadProvider reads manifest and hash; folder name must match', () => {
  const r = tmp(), d = folder(r);
  assert.equal(loadProvider(d).manifest.name, 'demo');
  fail(() => loadProvider(d, { name: 'other' }), /folder name/);
  writeFileSync(join(d, 'manifest.json'), '{nope');
  fail(() => loadProvider(d), /manifest\.json/);
});
