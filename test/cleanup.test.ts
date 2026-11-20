// Automatic cleanup of agent worktrees and branches: only what loses nothing is removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-cleanup-test-'));
const data = join(tmp, 'data', 'jarvis');
process.env.XDG_DATA_HOME = join(tmp, 'data'); // read when agents.ts loads
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
const { loadWorkspaces, workspaces } = await import('../src/agents.ts');

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
const repo = join(tmp, 'repo');
mkdirSync(repo);
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.name', 'T');
git(repo, 'config', 'user.email', 't@t');
writeFileSync(join(repo, 'f'), 'v1\n');
git(repo, 'add', 'f');
git(repo, 'commit', '-qm', 'init');

const ids = ['merged', 'rebased', 'empty', 'unmerged', 'dirty', 'nmlink', 'nmdir', 'nmplus'];
const wt = (id: string) => join(data, 'worktrees', id);
const branches = () => git(repo, 'branch', '--list', 'jarvis/*', '--format=%(refname:short)').split('\n');
const commit = (id: string, file: string) => {
  writeFileSync(join(wt(id), file), `${id}\n`);
  git(wt(id), 'add', file);
  git(wt(id), 'commit', '-qm', id);
};
for (const id of ids) git(repo, 'worktree', 'add', '-q', '-b', `jarvis/${id}`, wt(id));

commit('merged', 'merged.txt');
git(repo, 'merge', '-q', '--ff-only', 'jarvis/merged');
// Rebase-merge: main gets the same change as a new commit, so the branch is not an ancestor.
commit('rebased', 'rebased.txt');
git(repo, 'cherry-pick', 'jarvis/rebased');
commit('unmerged', 'unmerged.txt');
writeFileSync(join(wt('dirty'), 'f'), 'edited\n'); // no commits of its own, but an uncommitted edit
// Branches with no commits of their own: empty, nmlink, nmdir, nmplus.
const target = join(tmp, 'shared-node_modules');
mkdirSync(target);
writeFileSync(join(target, 'pkg.js'), 'x');
symlinkSync(target, join(wt('nmlink'), 'node_modules'));
mkdirSync(join(wt('nmdir'), 'node_modules'));
writeFileSync(join(wt('nmdir'), 'node_modules', 'pkg.js'), 'x');
symlinkSync(target, join(wt('nmplus'), 'node_modules'));
writeFileSync(join(wt('nmplus'), 'other.txt'), 'untracked\n');

mkdirSync(join(data, 'workspaces', 'ws'), { recursive: true });
writeFileSync(join(data, 'workspaces.json'), JSON.stringify([{ id: 'ws', name: 'ws' }]));
writeFileSync(join(data, 'workspaces', 'ws', 'events.jsonl'), ids.map((id) =>
  JSON.stringify({ type: 'spawned', agent: { id, name: id, task: '', cwd: wt(id), repo, status: 'idle', lastText: '', costUsd: 0, parentId: 'arbiter' } })).join('\n') + '\n');
loadWorkspaces();

const kept = workspaces.get('ws')!.cleanup();
const left = branches();

test('merged, rebase-merged and empty branches go with their worktrees', () => {
  for (const id of ['merged', 'rebased', 'empty']) {
    assert.ok(!existsSync(wt(id)), `${id} worktree`);
    assert.ok(!left.includes(`jarvis/${id}`), `${id} branch`);
  }
});

test('an unmerged branch and a dirty worktree stay, and are reported', () => {
  for (const id of ['unmerged', 'dirty', 'nmplus']) assert.ok(existsSync(wt(id)), `${id} worktree`);
  for (const id of ['unmerged', 'dirty', 'nmplus']) assert.ok(left.includes(`jarvis/${id}`), `${id} branch`);
  assert.equal(git(wt('dirty'), 'status', '--porcelain'), 'M f'); // work intact (git() trims the leading space)
  assert.ok(kept.some((k) => k.includes('dirty') && k.includes('uncommitted')));
  assert.equal(kept.length, 3);
  assert.ok(kept.some((k) => k.includes('unmerged') && k.includes('not on main')));
});

test('a node_modules symlink or dir alone does not block removal, and the symlink target survives', () => {
  for (const id of ['nmlink', 'nmdir']) {
    assert.ok(!existsSync(wt(id)), `${id} worktree`);
    assert.ok(!left.includes(`jarvis/${id}`), `${id} branch`);
  }
  assert.equal(execFileSync('cat', [join(target, 'pkg.js')], { encoding: 'utf8' }), 'x');
  assert.ok(existsSync(join(wt('nmplus'), 'node_modules')), 'another untracked file keeps the whole worktree');
});

test('the main checkout and other branches are untouched', () => {
  assert.ok(branches().length >= 3);
  assert.ok(git(repo, 'branch', '--list', 'main').includes('main'));
});
