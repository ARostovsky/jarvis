// The server's git in an agent worktree must never run code the agent planted by replacing the worktree's .git file with its own repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-worktree-test-'));
const data = join(tmp, 'data', 'jarvis');
process.env.XDG_DATA_HOME = join(tmp, 'data'); // read when agents.ts loads
process.env.GIT_CONFIG_GLOBAL = '/dev/null'; // no user hooks or signing
const { loadWorkspaces, workspaces, archiveWorkspace, restoreWorkspace, workCommit } = await import('../src/agents.ts');

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
const seeded: Record<string, string[]> = { one: ['planted'], two: ['plain', 'parked'], three: ['nested'] };
mkdirSync(data, { recursive: true });
writeFileSync(join(data, 'workspaces.json'), JSON.stringify(Object.keys(seeded).map((id) => ({ id, name: id }))));
for (const [ws, ids] of Object.entries(seeded)) {
  mkdirSync(join(data, 'workspaces', ws), { recursive: true });
  const lines = ids.map((id) => {
    const cwd = join(data, 'worktrees', id);
    git(repo, 'worktree', 'add', '-q', '-b', `jarvis/${id}`, cwd);
    writeFileSync(join(cwd, 'f'), `${id}\n`);
    return JSON.stringify({ type: 'spawned', agent: { id, name: id, task: '', cwd, repo, status: 'idle', lastText: '', costUsd: 0, parentId: 'arbiter' } });
  });
  writeFileSync(join(data, 'workspaces', ws, 'events.jsonl'), lines.join('\n') + '\n');
}
loadWorkspaces();
const wt = (id: string) => join(data, 'worktrees', id);

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
