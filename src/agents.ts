import { query, tool, createSdkMcpServer, type SDKUserMessage, type Query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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
};

// Every UI-visible change goes through here: spawned, status, text, tool, routed, ask, result.
export const bus = new EventEmitter();
const emit = (type: string, data: object) => bus.emit('event', { type, ...data });

export const agents = new Map<string, Agent>();
const sessions = new Map<string, { push: (text: string) => void; q: Query; abort: AbortController }>();
const pendingAsks = new Map<string, { resolve: (allow: boolean) => void; event: object }>();

const WORKTREES = resolve(import.meta.dirname, '..', 'worktrees');
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

// What a freshly connected UI needs to rebuild the screen.
export function snapshot() {
  return [
    ...[...agents.values()].map((agent) => ({ type: 'spawned', agent })),
    ...[...pendingAsks.values()].map((p) => p.event),
  ];
}

// Long-lived SDK session fed by an inbox, so the arbiter can keep sending messages to it.
function startSession(a: Agent, options: Parameters<typeof query>[0]['options']) {
  const box = inbox();
  const abort = new AbortController();
  const q = query({
    prompt: box,
    options: {
      cwd: a.cwd,
      settingSources: ['user'], // picks up the auth proxy (ANTHROPIC_BASE_URL + apiKeyHelper)
      permissionMode: 'acceptEdits',
      abortController: abort,
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
      ...options,
    },
  });
  sessions.set(a.id, {
    push: (text) => {
      setStatus(a, 'running');
      box.push(text);
    },
    q,
    abort,
  });
  pump(a, q);
}

async function pump(a: Agent, q: Query) {
  try {
    for await (const m of q) {
      if (m.type === 'assistant') {
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
  }
}

function report(from: string, text: string) {
  emit('routed', { from, to: ARBITER, text });
  sessions.get(ARBITER)?.push(text);
}

function makeWorkdir(id: string, repo?: string): string {
  mkdirSync(WORKTREES, { recursive: true });
  const dir = join(WORKTREES, id);
  if (repo && existsSync(join(repo, '.git'))) {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', `jarvis/${id}`, dir], { stdio: 'ignore' });
    return dir;
  }
  // shortcut: non-git repo is used in place (no isolation), add copy/sandbox if this bites
  if (repo) return resolve(repo);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function spawnAgent(name: string, task: string, repo?: string): Agent {
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${++seq}`;
  const a: Agent = { id, name, task, cwd: makeWorkdir(id, repo), status: 'idle', lastText: '', costUsd: 0 };
  agents.set(id, a);
  emit('spawned', { agent: a });
  startSession(a, {});
  emit('routed', { from: ARBITER, to: id, text: task });
  sessions.get(id)!.push(task);
  return a;
}

export function sendToAgent(id: string, text: string, from = ARBITER) {
  const s = sessions.get(id);
  if (!s) throw new Error(`no agent ${id}`);
  emit('routed', { from, to: id, text });
  s.push(text);
}

export function stopAgent(id: string) {
  const s = sessions.get(id);
  if (!s) throw new Error(`no agent ${id}`);
  setStatus(agents.get(id)!, 'stopped');
  s.abort.abort();
  sessions.delete(id);
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
    tool('send_to_agent', 'Send a follow-up message or context to an existing agent.', {
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

export function startArbiter(cwd = process.cwd()): Agent {
  const a: Agent = { id: ARBITER, name: 'Arbiter', task: '', cwd, status: 'idle', lastText: '', costUsd: 0 };
  agents.set(a.id, a);
  emit('spawned', { agent: a });
  startSession(a, {
    mcpServers: { jarvis: arbiterTools },
    allowedTools: ['mcp__jarvis__spawn_agent', 'mcp__jarvis__send_to_agent', 'mcp__jarvis__list_agents', 'mcp__jarvis__stop_agent'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: ARBITER_PROMPT },
  });
  return a;
}

export const tellArbiter = (text: string) => sendToAgent(ARBITER, text, 'user');
