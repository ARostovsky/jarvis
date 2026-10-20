import { query, tool, createSdkMcpServer, type SDKUserMessage, type Query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export type Status = 'running' | 'idle' | 'waiting' | 'error' | 'stopped';

export type Agent = {
  id: string;
  name: string;
  task: string;
  cwd: string;
  status: Status;
  lastText: string;
  costUsd: number;
  parentId?: string; // undefined only for the arbiter
  repo?: string; // set when cwd is a git worktree of this repo
  sessionId?: string;
};

// Every UI-visible change goes through here: spawned, removed, status, text, delta, tool, routed, ask, answered, result, session.
export const bus = new EventEmitter();

const ROOT = resolve(import.meta.dirname, '..');
const WORKTREES = join(ROOT, 'worktrees');
const STATE = join(ROOT, 'state');
const LOG = join(STATE, 'events.jsonl');
// Live-only events: replaying them after a restart would show stale typing or dead permission prompts.
const TRANSIENT = new Set(['delta', 'ask', 'answered']);
// shortcut: whole event log is kept in memory and replayed to each UI, rotate it once it grows past a few MB
const history: string[] = [];

function emit(type: string, data: object) {
  const event = { type, ...data };
  if (!TRANSIENT.has(type)) {
    const line = JSON.stringify(event);
    history.push(line);
    appendFileSync(LOG, line + '\n');
  }
  bus.emit('event', event);
}

export const agents = new Map<string, Agent>();
const sessions = new Map<string, { push: (text: string) => void; abort: AbortController }>();
const pendingAsks = new Map<string, { resolve: (allow: boolean) => void; event: object }>();

export const ARBITER = 'arbiter';
const REPORT_CAP = 2000;
const MAX_DEPTH = 2; // arbiter = 0, its agents = 1, their sub-agents = 2
let seq = 0;

// Only what agents need from ~/.claude/settings.json: an auth proxy and model.
// Loading full user settings drags in all plugins and hooks: ~5x the tokens per turn.
function userSettings() {
  try {
    const { apiKeyHelper, env, model } = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    return { apiKeyHelper, env, model };
  } catch {
    return {};
  }
}
const SETTINGS = userSettings();

const depth = (a: Agent): number => (a.parentId ? 1 + depth(agents.get(a.parentId)!) : 0);
const children = (id: string) => [...agents.values()].filter((c) => c.parentId === id);

function inbox() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  return {
    push(text: string) {
      queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
    },
  };
}

function setStatus(a: Agent, status: Status) {
  if (a.status === status) return;
  a.status = status;
  emit('status', { agentId: a.id, status });
}

export function answerAsk(reqId: string, allow: boolean) {
  pendingAsks.get(reqId)?.resolve(allow);
  pendingAsks.delete(reqId);
}

// What a freshly connected UI needs to rebuild the screen: the persisted log plus live asks.
export function snapshot(): string[] {
  return [...history, ...[...pendingAsks.values()].map((p) => JSON.stringify(p.event))];
}

// Rebuild agents from the event log so a server restart keeps the graph, logs and SDK session ids.
function restore() {
  mkdirSync(STATE, { recursive: true });
  if (!existsSync(LOG)) return;
  for (const line of readFileSync(LOG, 'utf8').split('\n')) {
    if (!line) continue;
    history.push(line);
    const e = JSON.parse(line);
    const a = agents.get(e.agentId);
    if (e.type === 'spawned') agents.set(e.agent.id, { ...e.agent });
    else if (e.type === 'removed') agents.delete(e.agentId);
    else if (!a) continue;
    else if (e.type === 'status') a.status = e.status;
    else if (e.type === 'text') a.lastText = e.text;
    else if (e.type === 'result') a.costUsd = e.costUsd;
    else if (e.type === 'session') a.sessionId = e.sessionId;
  }
  // Their processes died with the old server; they resume on the next message.
  for (const a of agents.values()) if (a.status !== 'stopped') setStatus(a, 'idle');
}

// Long-lived SDK session fed by an inbox. Started lazily, resuming the saved session id if there is one.
function session(a: Agent) {
  const existing = sessions.get(a.id);
  if (existing) return existing;
  const box = inbox();
  const abort = new AbortController();
  const q = query({
    prompt: box,
    options: {
      cwd: a.cwd,
      settingSources: ['project', 'local'], // repo CLAUDE.md and settings, but not user plugins/hooks
      settings: SETTINGS,
      permissionMode: 'acceptEdits',
      includePartialMessages: true,
      abortController: abort,
      resume: a.sessionId,
      canUseTool: (toolName, input) =>
        new Promise((done) => {
          const reqId = `${a.id}#${++seq}`;
          setStatus(a, 'waiting');
          const event = { type: 'ask', reqId, agentId: a.id, tool: toolName, input };
          pendingAsks.set(reqId, {
            resolve: (allow) => {
              setStatus(a, 'running');
              emit('answered', { reqId });
              done(allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'User denied' });
            },
            event,
          });
          bus.emit('event', event);
        }),
      ...(a.id === ARBITER ? arbiterOptions : depth(a) < MAX_DEPTH ? leadOptions(a.id) : {}),
    },
  });
  const s = {
    push: (text: string) => {
      setStatus(a, 'running');
      box.push(text);
    },
    abort,
  };
  sessions.set(a.id, s);
  pump(a, q);
  return s;
}

async function pump(a: Agent, q: Query) {
  try {
    for await (const m of q) {
      if (m.type === 'stream_event') {
        const ev = m.event;
        if (m.parent_tool_use_id === null && ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          emit('delta', { agentId: a.id, text: ev.delta.text });
        }
      } else if (m.type === 'system' && m.subtype === 'init' && m.session_id !== a.sessionId) {
        a.sessionId = m.session_id;
        emit('session', { agentId: a.id, sessionId: m.session_id });
      } else if (m.type === 'assistant') {
        for (const block of m.message.content) {
          if (block.type === 'text') {
            a.lastText = block.text;
            emit('text', { agentId: a.id, text: block.text });
          } else if (block.type === 'tool_use') {
            emit('tool', { agentId: a.id, name: block.name, input: block.input });
          }
        }
      } else if (m.type === 'result') {
        a.costUsd = m.total_cost_usd;
        const text = m.subtype === 'success' ? m.result : `error: ${m.subtype}`;
        setStatus(a, m.subtype === 'success' ? 'idle' : 'error');
        emit('result', { agentId: a.id, text, costUsd: a.costUsd });
        // Cap what lands in the parent's context; the full text stays available via read_agent.
        const brief = text.length > REPORT_CAP ? `${text.slice(0, REPORT_CAP)}\n… [truncated, ${text.length} chars total: read_agent("${a.id}") for all]` : text;
        if (a.parentId) report(a, `[agent ${a.id} finished, status ${a.status}]\n${brief}`);
      }
    }
    setStatus(a, 'stopped');
  } catch (e) {
    setStatus(a, a.status === 'stopped' ? 'stopped' : 'error');
    emit('text', { agentId: a.id, text: `session ended: ${(e as Error).message}` });
  } finally {
    sessions.delete(a.id);
  }
}

function report(a: Agent, text: string) {
  const parent = agents.get(a.parentId!);
  if (!parent || parent.status === 'stopped') return;
  emit('routed', { from: a.id, to: parent.id, text });
  session(parent).push(text);
}

function makeWorkdir(id: string, repo?: string): { cwd: string; repo?: string } {
  mkdirSync(WORKTREES, { recursive: true });
  const dir = join(WORKTREES, id);
  if (repo && existsSync(join(repo, '.git'))) {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', `jarvis/${id}`, dir], { stdio: 'pipe' });
    return { cwd: dir, repo: resolve(repo) };
  }
  // shortcut: non-git repo is used in place (no isolation), add copy/sandbox if this bites
  if (repo) return { cwd: resolve(repo) };
  mkdirSync(dir, { recursive: true });
  return { cwd: dir };
}

export function spawnAgent(name: string, task: string, repo?: string, parentId = ARBITER): Agent {
  const parent = agents.get(parentId);
  if (!parent) throw new Error(`no agent ${parentId}`);
  if (depth(parent) >= MAX_DEPTH) throw new Error(`max depth ${MAX_DEPTH} reached`);
  // Time suffix keeps ids, worktree dirs and jarvis/<id> branches unique across server restarts.
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36).slice(-4)}${++seq}`;
  // Sub-agents default to their parent's checkout so they see its work.
  const wd = makeWorkdir(id, repo ?? (parentId === ARBITER ? undefined : parent.repo ?? parent.cwd));
  const a: Agent = { id, name, task, ...wd, status: 'idle', lastText: '', costUsd: 0, parentId };
  agents.set(id, a);
  emit('spawned', { agent: a });
  emit('routed', { from: parentId, to: id, text: task });
  session(a).push(task);
  return a;
}

// Stops the agent and deletes its workdir. Its jarvis/<id> branch is kept, so committed work survives.
export function deleteAgent(id: string) {
  const a = agents.get(id);
  if (!a || id === ARBITER) throw new Error(`cannot delete ${id}`);
  if (children(id).length) throw new Error(`${id} has sub-agents, delete them first`);
  stopAgent(id);
  if (a.repo) {
    // No --force: git refuses when the worktree has uncommitted changes, which is what we want.
    execFileSync('git', ['-C', a.repo, 'worktree', 'remove', a.cwd], { stdio: 'pipe' });
  } else if (resolve(a.cwd) === join(WORKTREES, id)) {
    // Only its own dir: a sub-agent of a non-git parent works inside the parent's dir.
    rmSync(a.cwd, { recursive: true, force: true });
  }
  agents.delete(id);
  emit('removed', { agentId: id });
}

export function sendToAgent(id: string, text: string, from = ARBITER) {
  const a = agents.get(id);
  if (!a) throw new Error(`no agent ${id}`);
  emit('routed', { from, to: id, text });
  session(a).push(text);
}

export function stopAgent(id: string) {
  const a = agents.get(id);
  if (!a) throw new Error(`no agent ${id}`);
  setStatus(a, 'stopped');
  sessions.get(id)?.abort.abort();
}

const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

// The arbiter manages every agent; a lead agent only manages its own sub-agents.
function teamTools(owner: string) {
  const mine = (id: string) => {
    if (owner !== ARBITER && agents.get(id)?.parentId !== owner) throw new Error(`${id} is not your sub-agent`);
    return id;
  };
  return createSdkMcpServer({
    name: 'jarvis',
    tools: [
      tool('spawn_agent', 'Start a new coding agent session. It runs in its own git worktree when repo is a git repo. You are notified automatically when it finishes a turn.', {
        name: z.string().describe('short role name, e.g. "tests" or "backend"'),
        task: z.string().describe('full self-contained instructions; the agent sees nothing else'),
        repo: z.string().optional().describe('absolute path to the repository to work on'),
      }, async ({ name, task, repo }) => {
        const a = spawnAgent(name, task, repo, owner);
        return ok({ id: a.id, cwd: a.cwd });
      }),
      tool('send_to_agent', 'Send a follow-up message or context to an existing agent. A stopped agent is resumed with its previous conversation.', {
        id: z.string(),
        message: z.string(),
      }, async ({ id, message }) => (sendToAgent(mine(id), message, owner), ok('sent'))),
      tool('list_agents', 'List agents you manage: id, status, task, cost and the start of the last message.', {}, async () =>
        ok((owner === ARBITER ? [...agents.values()] : children(owner)).map(({ lastText, ...a }) => ({ ...a, lastText: lastText.slice(0, 300) })))),
      tool('read_agent', 'Full last message of an agent.', { id: z.string() }, async ({ id }) => ok(agents.get(mine(id))?.lastText ?? 'no such agent')),
      tool('stop_agent', 'Stop an agent session. Its worktree is kept.', { id: z.string() }, async ({ id }) => (stopAgent(mine(id)), ok('stopped'))),
    ],
  });
}
const TEAM_TOOLS = ['spawn_agent', 'send_to_agent', 'list_agents', 'read_agent', 'stop_agent'].map((t) => `mcp__jarvis__${t}`);

const ARBITER_PROMPT = `You are the arbiter. You do not write code yourself: you split the user's goal into tasks, spawn coding agents with spawn_agent, pass context between them with send_to_agent, and report back to the user.
Agents see only what you send them, so give self-contained instructions with paths and acceptance criteria.
When an agent finishes you get a message starting with "[agent <id> finished". Decide the next step: send follow-ups, pass its results to another agent, or summarize for the user.`;

const arbiterOptions: Options = {
  mcpServers: { jarvis: teamTools(ARBITER) },
  allowedTools: TEAM_TOOLS,
  systemPrompt: { type: 'preset', preset: 'claude_code', append: ARBITER_PROMPT },
};

const LEAD_PROMPT = `You can delegate with spawn_agent when your task splits into large independent parts that can run in parallel; sub-agents work in the same repository on their own branches. Do small or sequential work yourself. When a sub-agent finishes you get a message starting with "[agent <id> finished".`;

const leadOptions = (id: string): Options => ({
  mcpServers: { jarvis: teamTools(id) },
  allowedTools: TEAM_TOOLS,
  systemPrompt: { type: 'preset', preset: 'claude_code', append: LEAD_PROMPT },
});

export function startArbiter(cwd = process.cwd()) {
  restore();
  if (agents.has(ARBITER)) return;
  const a: Agent = { id: ARBITER, name: 'Arbiter', task: '', cwd, status: 'idle', lastText: '', costUsd: 0 };
  agents.set(a.id, a);
  emit('spawned', { agent: a });
}

export const tellArbiter = (text: string) => sendToAgent(ARBITER, text, 'user');
