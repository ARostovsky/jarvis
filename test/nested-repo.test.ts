// An agent spawned with another agent's worktree as repo must not depend on that worktree, which archive and delete remove first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-nested-repo-test-'));
const data = join(tmp, 'data', 'jarvis');
process.env.XDG_DATA_HOME = join(tmp, 'data'); // read when agents.ts loads
process.env.GIT_CONFIG_GLOBAL = '/dev/null'; // no user hooks or signing
process.env.JARVIS_FAKE_SDK = join(import.meta.dirname, '..', 'e2e', 'fake-sdk.ts');
process.env.JARVIS_PLUGINS = '';
const { loadWorkspaces, workspaces, archiveWorkspace, restoreWorkspace, archivedInfo } = await import('../src/agents.ts');

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
const repo = join(tmp, 'repo');
mkdirSync(repo);
git(repo, 'init', '-q');
git(repo, 'config', 'user.name', 'T');
git(repo, 'config', 'user.email', 't@t');
writeFileSync(join(repo, 'f'), 'v1\n');
git(repo, 'add', 'f');
git(repo, 'commit', '-qm', 'init');

const wt = (id: string) => join(data, 'worktrees', id);
const spawned = (id: string, repo: string) => JSON.stringify({ type: 'spawned', agent: { id, name: id, task: '', cwd: wt(id), repo, status: 'idle', lastText: '', costUsd: 0, parentId: 'arbiter' } });
// A lead with a commit of its own on its branch, as makeWorkdir() makes it.
const lead = (id: string, from = repo) => {
  git(from, 'worktree', 'add', '-q', '-b', `jarvis/${id}`, wt(id));
  writeFileSync(join(wt(id), 'f'), `${id}\n`);
  git(wt(id), 'commit', '-qam', id);
  return spawned(id, from);
};
// The workspace project is itself a linked worktree of repo.
const project = join(tmp, 'proj-feature');
git(repo, 'worktree', 'add', '-q', '-b', 'feature', project);
const registered = (path: string) => git(repo, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${path}`);

for (const ws of ['fresh', 'old', 'own', 'proj']) mkdirSync(join(data, 'workspaces', ws), { recursive: true });
writeFileSync(join(data, 'workspaces.json'), JSON.stringify(['fresh', 'old', 'own', 'proj'].map((id) => ({ id, name: id, ...(id === 'proj' ? { project } : {}) }))));
writeFileSync(join(data, 'workspaces', 'fresh', 'events.jsonl'), lead('lead') + '\n');
writeFileSync(join(data, 'workspaces', 'own', 'events.jsonl'), lead('own-lead') + '\n');
writeFileSync(join(data, 'workspaces', 'proj', 'events.jsonl'), lead('proj-lead', project) + '\n');
// A log written before spawn recorded the main working tree: the child's repo is the lead's worktree.
const oldLead = lead('old-lead');
git(wt('old-lead'), 'worktree', 'add', '-q', '-b', 'jarvis/old-child', wt('old-child'));
writeFileSync(join(data, 'workspaces', 'old', 'events.jsonl'), [oldLead, spawned('old-child', wt('old-lead'))].join('\n') + '\n');
loadWorkspaces();

// Archive, restore, then delete the lead before the child.
function roundTrip(ws: string, leadId: string, childId: string) {
  archiveWorkspace(ws);
  assert.ok(!existsSync(wt(leadId)) && !existsSync(wt(childId)));
  assert.deepEqual(archivedInfo(ws).branches, [`${repo}: jarvis/${leadId}`, `${repo}: jarvis/${childId}`]);
  restoreWorkspace(ws);
  assert.equal(readFileSync(join(wt(childId), 'f'), 'utf8'), `${leadId}\n`);
  const w = workspaces.get(ws)!;
  w.deleteAgent(leadId);
  w.deleteAgent(childId);
  assert.ok(!registered(wt(leadId)) && !registered(wt(childId)));
  assert.equal(git(repo, 'show', `jarvis/${childId}:f`), leadId); // branches stay
}

// The agent `from` spawns through its spawn_agent tool, once all of the workspace is idle again.
async function spawnVia(ws: string, from: string, repo: string) {
  const w = workspaces.get(ws)!;
  let child: any;
  const done = new Promise<void>((ok) =>
    w.bus.on('event', (e) => {
      if (e.type === 'spawned' && e.agent.id !== 'arbiter') child = e.agent;
      if (child && e.type === 'status' && e.agentId === child.id && e.status === 'idle') ok();
    }),
  );
  w.sendToAgent(from, `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'child', task: 'say hi', repo })}`, 'user');
  await done;
  while (w.busy().length) await new Promise((r) => setTimeout(r, 20));
  return child;
}

test('a child spawned with the lead worktree as repo starts from the lead branch and survives archive, restore and delete', async () => {
  const child = await spawnVia('fresh', 'arbiter', wt('lead'));
  assert.equal(child.repo, repo);
  roundTrip('fresh', 'lead', child.id);
});

test('a lead that passes its own worktree as repo gives the child its uncommitted work', async () => {
  writeFileSync(join(wt('own-lead'), 'f'), 'uncommitted\n');
  const child = await spawnVia('own', 'own-lead', wt('own-lead'));
  assert.equal(child.repo, repo);
  assert.equal(readFileSync(join(child.cwd, 'f'), 'utf8'), 'uncommitted\n');
});

test('a project that is a linked worktree stays the repo, and a child in it gets the lead uncommitted work', async () => {
  writeFileSync(join(wt('proj-lead'), 'f'), 'uncommitted\n');
  const child = await spawnVia('proj', 'proj-lead', project);
  assert.equal(child.repo, project);
  assert.equal(readFileSync(join(child.cwd, 'f'), 'utf8'), 'uncommitted\n');
});

test('an old log whose child repo is the lead worktree still archives, restores and deletes', () => {
  roundTrip('old', 'old-lead', 'old-child');
});
