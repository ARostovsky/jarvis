import { query, tool, createSdkMcpServer, type SDKUserMessage, type Query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Status = 'running' | 'idle' | 'waiting' | 'error' | 'stopped';

export type Agent = {
  id: string;
  name: string;
  task: string;
  cwd: string;
  status: Status;
  lastText: string;
  costUsd: number;
  sessionId?: string;
};

// Every UI-visible change goes through here: spawned, status, text, delta, tool, routed, ask, answered, result, session.
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
let seq = 0;

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
      settingSources: ['user'], // picks up the auth proxy (ANTHROPIC_BASE_URL + apiKeyHelper)
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
      ...(a.id === ARBITER ? arbiterOptions : {}),
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
        if (a.id !== ARBITER) report(a.id, `[agent ${a.id} finished, status ${a.status}]\n${text}`);
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

function report(from: string, text: string) {
  emit('routed', { from, to: ARBITER, text });
  session(agents.get(ARBITER)!).push(text);
}

function makeWorkdir(id: string, repo?: string): string {
  mkdirSync(WORKTREES, { recursive: true });
  const dir = join(WORKTREES, id);
  if (repo && existsSync(join(repo, '.git'))) {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', `jarvis/${id}`, dir], { stdio: 'pipe' });
    return dir;
  }
  // shortcut: non-git repo is used in place (no isolation), add copy/sandbox if this bites
  if (repo) return resolve(repo);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function spawnAgent(name: string, task: string, repo?: string): Agent {
  // Time suffix keeps ids, worktree dirs and jarvis/<id> branches unique across server restarts.
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36).slice(-4)}${++seq}`;
  const a: Agent = { id, name, task, cwd: makeWorkdir(id, repo), status: 'idle', lastText: '', costUsd: 0 };
  agents.set(id, a);
  emit('spawned', { agent: a });
  emit('routed', { from: ARBITER, to: id, text: task });
  session(a).push(task);
  return a;
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

const arbiterTools = createSdkMcpServer({
  name: 'jarvis',
  tools: [
    tool('spawn_agent', 'Start a new coding agent session. It runs in its own git worktree when repo is a git repo. You are notified automatically when it finishes a turn.', {
      name: z.string().describe('short role name, e.g. "tests" or "backend"'),
      task: z.string().describe('full self-contained instructions; the agent sees nothing else'),
      repo: z.string().optional().describe('absolute path to the repository to work on'),
    }, async ({ name, task, repo }) => {
      const a = spawnAgent(name, task, repo);
      return ok({ id: a.id, cwd: a.cwd });
    }),
    tool('send_to_agent', 'Send a follow-up message or context to an existing agent. A stopped agent is resumed with its previous conversation.', {
      id: z.string(),
      message: z.string(),
    }, async ({ id, message }) => (sendToAgent(id, message), ok('sent'))),
    tool('list_agents', 'List all agents with status and last message.', {}, async () => ok([...agents.values()])),
    tool('stop_agent', 'Stop an agent session. Its worktree is kept.', { id: z.string() }, async ({ id }) => (stopAgent(id), ok('stopped'))),
  ],
});

const ARBITER_PROMPT = `You are the arbiter. You do not write code yourself: you split the user's goal into tasks, spawn coding agents with spawn_agent, pass context between them with send_to_agent, and report back to the user.
Agents see only what you send them, so give self-contained instructions with paths and acceptance criteria.
When an agent finishes you get a message starting with "[agent <id> finished". Decide the next step: send follow-ups, pass its results to another agent, or summarize for the user.`;

const arbiterOptions: Options = {
  mcpServers: { jarvis: arbiterTools },
  allowedTools: ['mcp__jarvis__spawn_agent', 'mcp__jarvis__send_to_agent', 'mcp__jarvis__list_agents', 'mcp__jarvis__stop_agent'],
  systemPrompt: { type: 'preset', preset: 'claude_code', append: ARBITER_PROMPT },
};

export function startArbiter(cwd = process.cwd()) {
  restore();
  if (agents.has(ARBITER)) return;
  const a: Agent = { id: ARBITER, name: 'Arbiter', task: '', cwd, status: 'idle', lastText: '', costUsd: 0 };
  agents.set(a.id, a);
  emit('spawned', { agent: a });
}

export const tellArbiter = (text: string) => sendToAgent(ARBITER, text, 'user');
