// The server's git in an agent worktree must never run code the agent planted by replacing the worktree's .git file with its own repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-worktree-test-'));
const data = join(tmp, 'data', 'jarvis');
process.env.XDG_DATA_HOME = join(tmp, 'data'); // read when agents.ts loads
process.env.GIT_CONFIG_GLOBAL = '/dev/null'; // no user hooks or signing
const { loadWorkspaces, workspaces, archiveWorkspace, restoreWorkspace, archivedInfo, workCommit, DirtyWorktree } = await import('../src/agents.ts');

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
const marker = join(tmp, 'fired');
const payload = join(tmp, 'payload.sh');
writeFileSync(payload, `#!/bin/sh\ntouch ${marker}\ncat\n`);
chmodSync(payload, 0o755);

const repo = join(tmp, 'repo');
mkdirSync(repo);
git(repo, 'init', '-q');
git(repo, 'config', 'user.name', 'T');
git(repo, 'config', 'user.email', 't@t');
writeFileSync(join(repo, 'f'), 'v1\n');
git(repo, 'add', 'f');
git(repo, 'commit', '-qm', 'init');

// Agents as the event log knows them, with worktrees made the way makeWorkdir() makes them; no session is ever started.
const seeded: Record<string, string[]> = { one: ['planted'], two: ['plain', 'parked'], three: ['nested'], four: ['merged', 'kept'], five: ['busy'], six: ['a1', 'dir-p1', 'x1', 'dir-x2', 'b2'], seven: ['c1', 'c2', 'c3'], eight: ['g1', 'g2'], nine: ['g3', 'g4'], ten: ['g5', 'dir-g6'], eleven: ['g7', 'g8'], twelve: ['g9'], thirteen: ['h1'], fourteen: ['h3'], fifteen: ['h4'], sixteen: ['h5'], seventeen: ['h6'] };
mkdirSync(data, { recursive: true });
writeFileSync(join(data, 'workspaces.json'), JSON.stringify(Object.keys(seeded).map((id) => ({ id, name: id }))));
for (const [ws, ids] of Object.entries(seeded)) {
  mkdirSync(join(data, 'workspaces', ws), { recursive: true });
  const lines = ids.map((id) => {
    const cwd = join(data, 'worktrees', id);
    const plain = id.startsWith('dir-'); // a plain workdir, no repo
    if (plain) mkdirSync(cwd, { recursive: true });
    else git(repo, 'worktree', 'add', '-q', '-b', `jarvis/${id}`, cwd);
    writeFileSync(join(cwd, 'f'), `${id}\n`);
    return JSON.stringify({ type: 'spawned', agent: { id, name: id, task: '', cwd, ...(plain ? {} : { repo }), status: 'idle', lastText: '', costUsd: 0, parentId: 'arbiter' } });
  });
  writeFileSync(join(data, 'workspaces', ws, 'events.jsonl'), lines.join('\n') + '\n');
}
// An archive that crashed after parking h6's .env, before its worktree was removed.
const crashed = join(data, 'workspaces', 'seventeen', 'parked-ignored');
mkdirSync(join(crashed, 'h6'), { recursive: true });
writeFileSync(join(crashed, 'h6', '.env'), 'h6 secret\n');
writeFileSync(join(crashed, 'h6.json'), JSON.stringify(['.env']));
loadWorkspaces();
const wt = (id: string) => join(data, 'worktrees', id);
const registered = (path: string) => git(repo, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${path}`);

test('a repo planted over a worktree .git is never used by spawn, delete or archive', () => {
  const cwd = wt('planted');
  rmSync(join(cwd, '.git'));
  git(cwd, 'init', '-q');
  writeFileSync(join(cwd, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(join(cwd, '.git', 'hooks', 'pre-commit'), 0o755);
  git(cwd, 'config', 'core.fsmonitor', payload);
  git(cwd, 'config', 'filter.x.clean', payload);
  writeFileSync(join(cwd, '.gitattributes'), '* filter=x\n');

  const work = workCommit({ id: 'planted', name: '', task: '', cwd, repo, status: 'idle', lastText: '', costUsd: 0 });
  assert.equal(git(repo, 'show', `${work}:f`), 'planted');
  assert.ok(!existsSync(marker), 'planted code ran in workCommit');

  // The commit lands on the agent's branch; git worktree remove then refuses the replaced .git, so nothing is deleted.
  assert.throws(() => workspaces.get('one')!.deleteAgent('planted', 'commit'), /validation failed/);
  assert.ok(!existsSync(marker), 'planted code ran in deleteAgent');
  assert.equal(git(repo, 'show', 'jarvis/planted:f'), 'planted');

  writeFileSync(join(cwd, 'f'), 'again\n');
  assert.throws(() => archiveWorkspace('one', true), /archive aborted/);
  assert.ok(!existsSync(marker), 'planted code ran in archive');
  assert.equal(git(repo, 'show', 'jarvis/planted:f'), 'again');
});

test('a nested repo the agent committed into its worktree is not looked into', () => {
  const cwd = wt('nested'), sub = join(cwd, 'sub');
  mkdirSync(sub);
  git(sub, 'init', '-q');
  writeFileSync(join(sub, 'g'), 'x');
  git(sub, 'add', 'g');
  git(sub, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'x');
  git(cwd, 'add', 'sub', 'f');
  git(cwd, 'commit', '-qm', 'gitlink');
  git(sub, 'config', 'core.fsmonitor', payload);
  writeFileSync(join(sub, 'g'), 'y');
  writeFileSync(join(cwd, 'f'), 'nested2\n');

  const agent = { id: 'nested', name: '', task: '', cwd, repo, status: 'idle' as const, lastText: '', costUsd: 0 };
  assert.equal(git(repo, 'show', `${workCommit(agent)}:f`), 'nested2');
  // git worktree remove refuses a worktree with submodules, so the nested repo stays.
  assert.throws(() => workspaces.get('three')!.deleteAgent('nested', 'commit'), /submodules/);
  assert.ok(!existsSync(marker), 'nested repo config ran');
  assert.equal(git(repo, 'show', 'jarvis/nested:f'), 'nested2');
});

test('an untouched worktree still commits its work on delete and archive, and comes back on restore', () => {
  workspaces.get('two')!.deleteAgent('plain', 'commit');
  assert.ok(!existsSync(wt('plain')));
  assert.equal(git(repo, 'show', 'jarvis/plain:f'), 'plain');

  archiveWorkspace('two', true);
  assert.ok(!existsSync(wt('parked')));
  assert.equal(git(repo, 'show', 'jarvis/parked:f'), 'parked');
  restoreWorkspace('two');
  assert.equal(readFileSync(join(wt('parked'), 'f'), 'utf8'), 'parked\n');
  workspaces.get('two')!.deleteAgent('parked');
  assert.ok(!existsSync(wt('parked')));
});

test('an agent branch merged and deleted after archiving does not block restore', () => {
  archiveWorkspace('four', true);
  git(repo, 'branch', '-D', 'jarvis/merged');
  // A stale registration of kept's own path is dropped; a missing worktree of another path is left alone.
  git(repo, 'worktree', 'add', '-q', wt('kept'), 'jarvis/kept');
  rmSync(wt('kept'), { recursive: true });
  const foreign = join(tmp, 'foreign');
  git(repo, 'worktree', 'add', '-q', '-b', 'foreign', foreign);
  rmSync(foreign, { recursive: true });
  restoreWorkspace('four');
  const w = workspaces.get('four')!;
  assert.ok(!existsSync(wt('merged')));
  assert.equal(readFileSync(join(wt('kept'), 'f'), 'utf8'), 'kept\n');
  assert.ok(registered(foreign));
  assert.throws(() => w.sendToAgent('merged', 'hi', 'user'), /merged has no workdir/);
  assert.throws(() => w.compactAgent('merged'), /merged has no workdir/);
  w.deleteAgent('merged'); // no workdir left: deleting must still work
  rmSync(wt('kept'), { recursive: true }); // deleted by hand, still registered
  w.deleteAgent('kept');
  assert.ok(!registered(wt('kept')));
  assert.ok(registered(foreign));
});

test('a branch checked out elsewhere fails the restore loudly and keeps it in the archive', () => {
  archiveWorkspace('five', true);
  const elsewhere = join(tmp, 'elsewhere');
  git(repo, 'worktree', 'add', '-q', elsewhere, 'jarvis/busy');
  assert.throws(() => restoreWorkspace('five'), /already used by worktree/);
  assert.ok(existsSync(join(data, 'archive', 'five', 'meta.json')));
  assert.ok(!workspaces.has('five'));
  // Deleted by hand, still registered: Jarvis does not prune worktrees it does not own, so git's error stays.
  rmSync(elsewhere, { recursive: true });
  assert.throws(() => restoreWorkspace('five'), /already used by worktree/);
  assert.ok(registered(elsewhere));
  git(repo, 'worktree', 'remove', elsewhere); // the user's fix
  restoreWorkspace('five');
  assert.equal(readFileSync(join(wt('busy'), 'f'), 'utf8'), 'busy\n');
});

test('a restore that fails leaves the workspace in the archive', () => {
  const from = join(data, 'archive', 'broken');
  mkdirSync(join(from, 'events.jsonl'), { recursive: true }); // a log that cannot be read makes createWorkspace throw
  writeFileSync(join(from, 'meta.json'), JSON.stringify({ id: 'broken', name: 'broken', archivedAt: '' }));
  assert.throws(() => restoreWorkspace('broken'));
  assert.ok(existsSync(join(from, 'meta.json')));
  assert.ok(!workspaces.has('broken'));
});

test('a restore that fails partway puts back into the archive what it had already restored', () => {
  archiveWorkspace('six', true);
  const from = join(data, 'archive', 'six');
  const elsewhere = join(tmp, 'elsewhere-b2');
  git(repo, 'worktree', 'add', '-q', elsewhere, 'jarvis/b2');
  // Workdirs already there before the restore are not its to take back: a clean worktree with an ignored file, a plain dir with user files.
  git(repo, 'worktree', 'add', '-q', wt('x1'), 'jarvis/x1');
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.env\n');
  writeFileSync(join(wt('x1'), '.env'), 'secret\n');
  mkdirSync(wt('dir-x2'));
  writeFileSync(join(wt('dir-x2'), 'mine'), 'user file\n');
  const untouched = () => {
    assert.equal(readFileSync(join(wt('x1'), '.env'), 'utf8'), 'secret\n');
    assert.ok(registered(wt('x1')));
    assert.equal(readFileSync(join(wt('dir-x2'), 'mine'), 'utf8'), 'user file\n');
  };
  assert.throws(() => restoreWorkspace('six'), /b2: .*already used by worktree/s);
  assert.ok(existsSync(join(from, 'meta.json')));
  assert.ok(!existsSync(wt('a1')) && !registered(wt('a1')));
  assert.ok(!existsSync(wt('dir-p1')));
  assert.equal(readFileSync(join(from, 'parked-workdirs', 'dir-p1', 'f'), 'utf8'), 'dir-p1\n');
  untouched();
  git(repo, 'worktree', 'remove', elsewhere);
  restoreWorkspace('six');
  assert.equal(readFileSync(join(wt('a1'), 'f'), 'utf8'), 'a1\n');
  assert.equal(readFileSync(join(wt('dir-p1'), 'f'), 'utf8'), 'dir-p1\n');
  assert.equal(readFileSync(join(wt('b2'), 'f'), 'utf8'), 'b2\n');
  untouched();
});

test('an aborted archive puts back the workdirs after one that cannot be put back', () => {
  // c1 leaves its branch free for a checkout elsewhere, so it cannot be put back; c3 has a replaced .git, so archiving stops there.
  git(wt('c1'), 'checkout', '-q', '-f', '--detach');
  const elsewhere = join(tmp, 'elsewhere-c1');
  git(repo, 'worktree', 'add', '-q', elsewhere, 'jarvis/c1');
  rmSync(join(wt('c3'), '.git'));
  git(wt('c3'), 'init', '-q');
  assert.throws(() => archiveWorkspace('seven', true), /archive aborted .*validation failed.*c1: .*already used by worktree/s);
  assert.ok(workspaces.has('seven'));
  assert.ok(!existsSync(wt('c1')));
  assert.equal(readFileSync(join(wt('c2'), 'f'), 'utf8'), 'c2\n');
  assert.ok(registered(wt('c2')));
});

// Files git ignores: git worktree remove deletes them without asking, and a commit leaves them out.
const ignore = () => writeFileSync(join(repo, '.git', 'info', 'exclude'), '.env\nnode_modules/\n*.log\n');
const secrets = (id: string) => {
  writeFileSync(join(wt(id), '.env'), `${id} secret\n`);
  mkdirSync(join(wt(id), 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(wt(id), 'node_modules', 'pkg', 'index.js'), 'x\n');
  mkdirSync(join(wt(id), 'scratch', 'deep'), { recursive: true }); // an untracked dir holding only ignored files
  writeFileSync(join(wt(id), 'scratch', 'deep', 'run.log'), 'log\n');
};
const hasSecrets = (dir: string, id: string) => {
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), `${id} secret\n`);
  assert.equal(readFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'x\n');
  assert.equal(readFileSync(join(dir, 'scratch', 'deep', 'run.log'), 'utf8'), 'log\n');
};

test('files git ignores move with the archive and come back on restore', () => {
  ignore();
  secrets('g1');
  archiveWorkspace('eight', true);
  const parked = join(data, 'archive', 'eight', 'parked-ignored');
  assert.ok(!existsSync(wt('g1')));
  hasSecrets(join(parked, 'g1'), 'g1');
  assert.ok(!existsSync(join(parked, 'g2.json')), 'g2 has no ignored files');
  assert.deepEqual(archivedInfo('eight').ignored, ['g1: .env, node_modules, scratch/deep/run.log']);
  restoreWorkspace('eight');
  hasSecrets(wt('g1'), 'g1');
  assert.ok(!existsSync(join(data, 'workspaces', 'eight', 'parked-ignored')));
});

test('a restore that fails partway parks again the ignored files it had put back', () => {
  ignore();
  secrets('g3');
  archiveWorkspace('nine', true);
  const elsewhere = join(tmp, 'elsewhere-g4');
  git(repo, 'worktree', 'add', '-q', elsewhere, 'jarvis/g4');
  assert.throws(() => restoreWorkspace('nine'), /g4: .*already used by worktree/s);
  assert.ok(!existsSync(wt('g3')) && !registered(wt('g3')));
  hasSecrets(join(data, 'archive', 'nine', 'parked-ignored', 'g3'), 'g3');
  git(repo, 'worktree', 'remove', elsewhere);
  restoreWorkspace('nine');
  hasSecrets(wt('g3'), 'g3');
});

test('an aborted archive puts the ignored files back into the workdirs', () => {
  // g7 is parked and removed; g8 is parked too, but its replaced .git makes git worktree remove refuse it.
  ignore();
  secrets('g7');
  secrets('g8');
  rmSync(join(wt('g8'), '.git'));
  git(wt('g8'), 'init', '-q');
  assert.throws(() => archiveWorkspace('eleven', true), /archive aborted.*validation failed/s);
  hasSecrets(wt('g7'), 'g7');
  hasSecrets(wt('g8'), 'g8');
  assert.ok(!existsSync(join(data, 'workspaces', 'eleven', 'parked-ignored')));
});

test('deleting an agent asks first when files would go that no commit keeps', () => {
  ignore();
  const w = workspaces.get('ten')!;
  git(wt('g5'), 'checkout', '--', 'f'); // only ignored files are left
  writeFileSync(join(wt('g5'), '.env'), 'secret\n');
  const head = git(repo, 'rev-parse', 'jarvis/g5');
  assert.throws(() => w.deleteAgent('g5'), (e: Error) => e instanceof DirtyWorktree && !e.canCommit && /ignored by git.*\n\.env$/s.test(e.message) && !/uncommitted/.test(e.message));
  w.deleteAgent('g5', 'commit'); // nothing to commit: no commit, no error
  assert.ok(!existsSync(wt('g5')));
  assert.equal(git(repo, 'rev-parse', 'jarvis/g5'), head);

  assert.throws(() => w.deleteAgent('dir-g6'), (e: Error) => e instanceof DirtyWorktree && /not in git.*\nf$/s.test(e.message));
  assert.throws(() => w.deleteAgent('dir-g6', 'commit'), (e: Error) => !(e instanceof DirtyWorktree) && /no branch to commit/.test(e.message));
  assert.ok(existsSync(join(wt('dir-g6'), 'f')));
  w.deleteAgent('dir-g6', 'discard');
  assert.ok(!existsSync(wt('dir-g6')));
});

test('an agent without a workdir still asks before its parked ignored files go', () => {
  ignore();
  git(wt('g9'), 'checkout', '--', 'f');
  writeFileSync(join(wt('g9'), '.env'), 'secret\n');
  archiveWorkspace('twelve');
  git(repo, 'branch', '-D', 'jarvis/g9'); // merged and deleted
  restoreWorkspace('twelve');
  const w = workspaces.get('twelve')!;
  const parked = join(data, 'workspaces', 'twelve', 'parked-ignored', 'g9', '.env');
  assert.equal(readFileSync(parked, 'utf8'), 'secret\n');
  assert.throws(() => w.deleteAgent('g9'), (e: Error) => e instanceof DirtyWorktree && !e.canCommit && /parked by an archive.*\n\.env$/s.test(e.message) && !/with the workdir/.test(e.message));
  w.deleteAgent('g9', 'discard');
  assert.ok(!existsSync(parked));
  assert.ok(!existsSync(join(data, 'workspaces', 'twelve', 'parked-ignored', 'g9.json')));
});

// Commits `make` on an agent branch that is not checked out, through a throwaway worktree.
function onBranch(id: string, make: (dir: string) => void) {
  const dir = join(tmp, `branch-${id}`);
  git(repo, 'worktree', 'add', '-q', dir, `jarvis/${id}`);
  make(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'later');
  git(repo, 'worktree', 'remove', dir);
}

test('status.showUntrackedFiles=no hides nothing from delete and archive', () => {
  ignore();
  git(repo, 'config', 'status.showUntrackedFiles', 'no');
  try {
    writeFileSync(join(wt('h1'), 'new.txt'), 'untracked\n');
    writeFileSync(join(wt('h1'), '.env'), 'secret\n');
    assert.throws(() => workspaces.get('thirteen')!.deleteAgent('h1'), (e: Error) => e instanceof DirtyWorktree && e.canCommit && /\?\? new\.txt/.test(e.message) && /\n\.env$/.test(e.message));
    archiveWorkspace('thirteen', true);
    assert.equal(git(repo, 'show', 'jarvis/h1:new.txt'), 'untracked');
    restoreWorkspace('thirteen');
    assert.equal(readFileSync(join(wt('h1'), '.env'), 'utf8'), 'secret\n');
  } finally {
    git(repo, 'config', '--unset', 'status.showUntrackedFiles');
  }
});

test('the from path of a staged rename is not read as an ignored entry', () => {
  ignore();
  const cwd = wt('h3');
  writeFileSync(join(cwd, '!! odd'), 'x\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'odd');
  git(cwd, 'mv', '!! odd', 'renamed');
  assert.throws(() => workspaces.get('fourteen')!.deleteAgent('h3'), (e: Error) => e instanceof DirtyWorktree && /renamed/.test(e.message) && !/ignored by git/.test(e.message));
});

test('an ignored file whose path the branch now has stays parked, and delete names and removes it', () => {
  ignore();
  git(wt('h4'), 'checkout', '--', 'f');
  mkdirSync(join(wt('h4'), 'out'));
  writeFileSync(join(wt('h4'), 'out', 'run.log'), 'log\n');
  writeFileSync(join(wt('h4'), '.env'), 'secret\n');
  archiveWorkspace('fifteen');
  onBranch('h4', (dir) => writeFileSync(join(dir, 'out'), 'now a file\n')); // out/run.log cannot go back: ENOTDIR
  restoreWorkspace('fifteen');
  const parked = join(data, 'workspaces', 'fifteen', 'parked-ignored');
  assert.equal(readFileSync(join(wt('h4'), '.env'), 'utf8'), 'secret\n');
  assert.equal(readFileSync(join(parked, 'h4', 'out', 'run.log'), 'utf8'), 'log\n');
  assert.deepEqual(JSON.parse(readFileSync(join(parked, 'h4.json'), 'utf8')), ['out/run.log']);
  const w = workspaces.get('fifteen')!;
  assert.throws(() => w.deleteAgent('h4'), (e: Error) => e instanceof DirtyWorktree && !e.canCommit && /with the workdir:\n\.env\n\n.*parked by an archive.*\nout\/run\.log$/s.test(e.message));
  w.deleteAgent('h4', 'discard');
  assert.ok(!existsSync(wt('h4')));
  assert.ok(!existsSync(join(parked, 'h4')) && !existsSync(join(parked, 'h4.json')));
});

test('a parked file never lands outside the workdir', () => {
  ignore();
  git(wt('h5'), 'checkout', '--', 'f');
  mkdirSync(join(wt('h5'), 'cache'));
  writeFileSync(join(wt('h5'), 'cache', 'x.log'), 'log\n');
  archiveWorkspace('sixteen');
  const outside = join(tmp, 'outside');
  mkdirSync(outside);
  onBranch('h5', (dir) => symlinkSync(outside, join(dir, 'cache'))); // the branch now has cache -> a dir elsewhere
  const parked = join(data, 'archive', 'sixteen', 'parked-ignored');
  writeFileSync(join(parked, 'escape'), 'x\n');
  writeFileSync(join(parked, 'h5', 'abs'), 'x\n');
  writeFileSync(join(parked, 'h5.json'), JSON.stringify(['cache/x.log', '../escape', '/abs']));
  restoreWorkspace('sixteen');
  assert.ok(!existsSync(join(outside, 'x.log')));
  assert.ok(!existsSync(join(data, 'worktrees', 'escape')));
  const back = join(data, 'workspaces', 'sixteen', 'parked-ignored');
  assert.equal(readFileSync(join(back, 'h5', 'cache', 'x.log'), 'utf8'), 'log\n');
  assert.deepEqual(JSON.parse(readFileSync(join(back, 'h5.json'), 'utf8')), ['cache/x.log', '../escape', '/abs']);
  assert.ok(!existsSync('/abs'));
});

test('files parked by an archive that crashed go back when the workspace loads', () => {
  assert.equal(readFileSync(join(wt('h6'), '.env'), 'utf8'), 'h6 secret\n');
  assert.ok(!existsSync(crashed));
  ignore();
  archiveWorkspace('seventeen', true); // no "already parked"
  assert.equal(readFileSync(join(data, 'archive', 'seventeen', 'parked-ignored', 'h6', '.env'), 'utf8'), 'h6 secret\n');
});
