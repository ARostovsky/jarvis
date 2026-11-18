import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, createWs, open, uniq, tmp, say, events, DATA } from './helpers.ts';

test('spawn_agent starts an agent in a worktree of the project and its report reaches Jarvis', async ({ page }) => {
  const repo = tmp('repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const name = uniq('spawn');
  const id = await createWs(page, name, { project: repo });
  await open(page, name);
  // The helper runs on the fake SDK too: its task is a script.
  expect((await say(page, id, 'tool mcp__jarvis__spawn_agent {"name":"helper","task":"write out.txt from helper\\nsay helper done"}')).ok()).toBe(true);
  await expect(page.locator('#nodes .node', { hasText: 'helper' })).toBeVisible();

  const agent = events(id).find((e) => e.type === 'spawned' && e.agent.name === 'helper').agent;
  expect(agent.cwd).toBe(join(DATA, 'worktrees', agent.id));
  expect(agent.repo).toBe(repo);
  expect(g('worktree', 'list')).toContain(`${agent.cwd} `);
  expect(g('rev-parse', '--abbrev-ref', `jarvis/${agent.id}`)).toBe(`jarvis/${agent.id}`);
  await expect.poll(() => existsSync(join(agent.cwd, 'out.txt'))).toBe(true);
  expect(readFileSync(join(agent.cwd, 'out.txt'), 'utf8')).toBe('from helper');

  // The report is delivered to Jarvis, which runs a turn on it.
  const report = `[agent ${agent.id} finished, status idle]\nhelper done`;
  await expect.poll(() => events(id).some((e) => e.type === 'routed' && e.from === agent.id && e.to === 'arbiter' && e.text === report)).toBe(true);
  await expect.poll(() => events(id).filter((e) => e.type === 'result' && e.agentId === 'arbiter').length).toBe(2);
  await expect(page.locator('#log .report')).toHaveText(`⇐ ${agent.id}: ${report}`); // in the DOM, hidden by the default VIEW
  await expect(page.locator('#nodes .node', { hasText: 'helper' })).toHaveClass(/\bidle\b/);
});

test('a report to a parent without a workdir goes to the nearest ancestor that has one', async ({ page }) => {
  const repo = tmp('repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const id = await createWs(page, uniq('orphan'), { project: repo });
  const leadTask = `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'child', task: 'sleep 3000\nsay child done' })}\nsay lead done`;
  expect((await say(page, id, `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'lead', task: leadTask, lead: true })}`)).ok()).toBe(true);
  const spawned = (name: string) => events(id).find((e) => e.type === 'spawned' && e.agent.name === name)?.agent;
  await expect.poll(() => spawned('child')).toBeTruthy();
  const lead = spawned('lead'), child = spawned('child');
  await expect.poll(() => events(id).some((e) => e.type === 'result' && e.agentId === lead.id)).toBe(true); // its report waits for the child
  rmSync(lead.cwd, { recursive: true }); // as after a restore whose branch was gone
  const report = `[agent ${child.id} finished, status idle]\nchild done`;
  await expect.poll(() => events(id).some((e) => e.type === 'routed' && e.from === child.id && e.to === 'arbiter' && e.text === report), { timeout: 10_000 }).toBe(true);
  expect(events(id).some((e) => e.type === 'routed' && e.from === child.id && e.to === lead.id)).toBe(false);
});

test('a parent is told when its agent passes the context or cost limit', async ({ page }) => {
  const repo = tmp('repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const id = await createWs(page, uniq('alert'), { project: repo });
  const task = 'usage 250000\ncost 11\nsay big done';
  expect((await say(page, id, `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'big', task })}`)).ok()).toBe(true);
  const routed = () => events(id).filter((e) => e.type === 'routed' && e.to === 'arbiter').map((e) => e.text as string);
  await expect.poll(() => routed().some((t) => /^\[agent \S+ context 250k tokens, over 200k\]/.test(t))).toBe(true);
  await expect.poll(() => routed().some((t) => /^\[agent \S+ cost \$11\.00, over \$10\]/.test(t))).toBe(true);
  expect(routed().filter((t) => /context 250k/.test(t))).toHaveLength(1); // once per session
});

test('an agent has no spawn tool and no sub-agent text unless the arbiter passes lead=true', async ({ page }) => {
  const repo = tmp('repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const id = await createWs(page, uniq('leadflag'), { project: repo });
  const task = 'option allowedTools\noption disallowedTools\noption systemPrompt';
  await say(page, id, `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'plain', task })}`);
  await say(page, id, `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'boss', task, lead: true })}`);
  const texts = (name: string) => {
    const a = events(id).find((e) => e.type === 'spawned' && e.agent.name === name)?.agent;
    return events(id).filter((e) => e.type === 'text' && e.agentId === a?.id).map((e) => e.text as string).join('\n');
  };
  await expect.poll(() => /systemPrompt=/.test(texts('plain')) && /systemPrompt=/.test(texts('boss'))).toBe(true);
  expect(texts('plain')).not.toContain('spawn_agent');
  expect(texts('plain')).not.toContain('sub-agent');
  expect(texts('plain')).toContain('disallowedTools=undefined'); // nothing to forbid without a spawn tool
  expect(texts('boss')).toContain('mcp__jarvis__spawn_agent');
  expect(texts('boss')).toContain('disallowedTools=["Agent","Task"]');
  expect(texts('boss')).toContain('delegate with spawn_agent');
});

test('a lead stays running and does not report while its sub-agent works; it reports after the turn that follows the child result', async ({ page }) => {
  const repo = tmp('repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const id = await createWs(page, uniq('defer'), { project: repo });
  const leadTask = `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'kid', task: 'sleep 2500\nsay kid done' })}\nsay lead waiting`;
  await say(page, id, `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'boss', task: leadTask, lead: true })}`);
  const spawned = (name: string) => events(id).find((e) => e.type === 'spawned' && e.agent.name === name)?.agent;
  await expect.poll(() => spawned('kid')).toBeTruthy();
  const boss = spawned('boss'), kid = spawned('kid');
  const leadResults = () => events(id).filter((e) => e.type === 'result' && e.agentId === boss.id).length;
  await expect.poll(leadResults).toBe(1);
  // Its turn ended, but the child still works: no report, status running.
  expect(events(id).some((e) => e.type === 'routed' && e.from === boss.id && e.to === 'arbiter')).toBe(false);
  expect(events(id).some((e) => e.type === 'status' && e.agentId === boss.id && e.status === 'idle')).toBe(false);
  expect(await listed(page, id, boss.id)).toBe('running');
  await expect.poll(() => events(id).some((e) => e.type === 'routed' && e.from === kid.id && e.to === boss.id), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => events(id).some((e) => e.type === 'routed' && e.from === boss.id && e.to === 'arbiter' && e.text.startsWith(`[agent ${boss.id} finished, status idle]`)), { timeout: 10_000 }).toBe(true);
  expect(leadResults()).toBe(2);
  expect(events(id).filter((e) => e.type === 'routed' && e.from === boss.id && e.to === 'arbiter')).toHaveLength(1);
});

// Spawns the lead `boss` on a fresh repo; its task spawns one sub-agent per entry of kids, then ends its turn.
async function bossWith(page: any, kids: { name: string; task: string }[], extra = '') {
  const repo = tmp('repo');
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const id = await createWs(page, uniq('held'), { project: repo });
  const leadTask = kids.map((k) => `tool mcp__jarvis__spawn_agent ${JSON.stringify(k)}`).join('\n') + `\nsay lead waiting${extra}`;
  await say(page, id, `tool mcp__jarvis__spawn_agent ${JSON.stringify({ name: 'boss', task: leadTask, lead: true })}`);
  const spawned = (name: string) => events(id).find((e) => e.type === 'spawned' && e.agent.name === name)?.agent;
  await expect.poll(() => kids.every((k) => spawned(k.name))).toBe(true);
  const boss = spawned('boss');
  await expect.poll(() => events(id).filter((e) => e.type === 'result' && e.agentId === boss.id).length).toBe(1);
  const toArbiter = () => events(id).filter((e) => e.type === 'routed' && e.from === boss.id && e.to === 'arbiter');
  const lastStatus = (agentId: string) => events(id).filter((e) => e.type === 'status' && e.agentId === agentId).at(-1)?.status;
  return { id, boss, kid: (n: string) => spawned(n), toArbiter, lastStatus, leadResults: () => events(id).filter((e) => e.type === 'result' && e.agentId === boss.id).length };
}

test('a held lead is released when its only sub-agent is stopped', async ({ page }) => {
  const t = await bossWith(page, [{ name: 'kid', task: 'sleep 30000' }]);
  expect(t.lastStatus(t.boss.id)).toBe('running');
  await say(page, t.id, `tool mcp__jarvis__stop_agent ${JSON.stringify({ id: t.kid('kid').id })}`);
  await expect.poll(() => t.lastStatus(t.boss.id)).toBe('idle');
  await expect.poll(() => t.toArbiter().length).toBe(1);
});

test('a held lead is released when its sub-agent fails', async ({ page }) => {
  const t = await bossWith(page, [{ name: 'kid', task: 'sleep 1500\nfail error_max_turns' }]);
  await expect.poll(() => t.toArbiter().length, { timeout: 10_000 }).toBe(1);
  expect(t.lastStatus(t.boss.id)).toBe('idle');
  expect(t.leadResults()).toBe(2);
});

test('two sub-agents finishing close together wake the lead once and it reports once', async ({ page }) => {
  const t = await bossWith(page, [{ name: 'k1', task: 'sleep 1500\nsay one done' }, { name: 'k2', task: 'sleep 1700\nsay two done' }]);
  await expect.poll(() => t.toArbiter().length, { timeout: 10_000 }).toBe(1);
  await expect.poll(t.leadResults).toBe(2);
  expect(events(t.id).filter((e) => e.type === 'status' && e.agentId === t.boss.id && e.status === 'idle')).toHaveLength(1);
  await expect.poll(() => events(t.id).filter((e) => e.type === 'routed' && e.to === 'arbiter' && e.from === t.boss.id).length).toBe(1);
  expect(events(t.id).filter((e) => e.type === 'result' && e.agentId === t.boss.id)).toHaveLength(2);
});

test('a held lead that is stopped stays stopped, and resumes with a report of its own', async ({ page }) => {
  const t = await bossWith(page, [{ name: 'kid', task: 'sleep 30000' }]);
  await say(page, t.id, `tool mcp__jarvis__stop_agent ${JSON.stringify({ id: t.boss.id })}`);
  await expect.poll(() => t.lastStatus(t.boss.id)).toBe('stopped');
  await say(page, t.id, `tool mcp__jarvis__stop_agent ${JSON.stringify({ id: t.kid('kid').id })}`);
  expect(t.lastStatus(t.boss.id)).toBe('stopped'); // no false "finished idle"
  expect(t.toArbiter()).toHaveLength(0);
  await say(page, t.id, `tool mcp__jarvis__send_to_agent ${JSON.stringify({ id: t.boss.id, message: 'say resumed' })}`);
  await expect.poll(() => t.toArbiter().some((e) => e.text.includes('resumed'))).toBe(true);
  expect(t.lastStatus(t.boss.id)).toBe('idle');
});

test('the arbiter is never held: it is idle while its agent works', async ({ page }) => {
  const t = await bossWith(page, [{ name: 'kid', task: 'sleep 30000' }]);
  expect(t.lastStatus('arbiter')).toBe('idle');
});

// What list_agents (the tool the arbiter sees) reports as an agent's status.
async function listed(page: any, ws: string, id: string) {
  const texts = () => events(ws).filter((e) => e.type === 'text' && e.agentId === 'arbiter').map((e) => e.text as string);
  const before = texts().length;
  await say(page, ws, 'tool mcp__jarvis__list_agents {}', 'result');
  await expect.poll(() => texts().length).toBeGreaterThan(before);
  return (JSON.parse(texts().at(-1)!) as { id: string; status: string }[]).find((a) => a.id === id)?.status;
}

test('a message to a held lead carries the queued child result, and no result is lost', async ({ page }) => {
  const t = await bossWith(page, [{ name: 'k1', task: 'sleep 1000\nsay one done' }, { name: 'k2', task: 'sleep 30000' }]);
  await expect.poll(() => events(t.id).some((e) => e.type === 'routed' && e.from === t.kid('k1').id && e.to === t.boss.id), { timeout: 10_000 }).toBe(true);
  expect(t.lastStatus(t.boss.id)).toBe('running'); // k2 still works: k1's result is queued, not delivered
  expect(t.leadResults()).toBe(1);
  await say(page, t.id, `tool mcp__jarvis__send_to_agent ${JSON.stringify({ id: t.boss.id, message: 'echo' })}`);
  await expect.poll(() => events(t.id).some((e) => e.type === 'text' && e.agentId === t.boss.id && e.text.includes(`[agent ${t.kid('k1').id} finished, status idle]`))).toBe(true);
  await expect.poll(t.leadResults).toBe(2);
  // k2 ends during no turn of the lead: it is released and nothing queued is left to leak into a later wake.
  await say(page, t.id, `tool mcp__jarvis__stop_agent ${JSON.stringify({ id: t.kid('k2').id })}`);
  await expect.poll(() => t.toArbiter().length).toBe(1);
  expect(t.lastStatus(t.boss.id)).toBe('idle');
  expect(t.leadResults()).toBe(2);
});
