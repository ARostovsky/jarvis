import { query, tool, createSdkMcpServer, type SDKUserMessage, type Query, type Options, type EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
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
  model?: string; // alias (haiku | sonnet | opus); unset = model from settings
  effort?: EffortLevel; // unset = the default for its role
  runtimeModel?: string; // the model the SDK session actually reports, e.g. claude-opus-5-5[1m]
  repo?: string; // set when cwd is a git worktree of this repo
  sessionId?: string;
};

// One tab in the UI: its own arbiter, agents, board and event log.
export type WorkspaceMeta = { id: string; name: string; project?: string };

// All runtime data lives outside the repo, in the XDG data dir.
const DATA = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'jarvis');
const WORKTREES = join(DATA, 'worktrees');
const REGISTRY = join(DATA, 'workspaces.json');
const ARCHIVE = join(DATA, 'archive');
// Live-only events: replaying them after a restart would show stale typing or dead permission prompts.
const TRANSIENT = new Set(['delta', 'ask', 'answered']);

export const ARBITER = 'arbiter';
const REPORT_CAP = 2000;
// auto: a classifier approves safe calls and only escalates to the UI what it can't decide.
export const MODELS = ['haiku', 'sonnet', 'opus'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const DEFAULT_AGENT_MODEL = process.env.JARVIS_AGENT_MODEL ?? 'sonnet';
const ARBITER_MODEL = process.env.JARVIS_ARBITER_MODEL; // unset: model from settings
const DEFAULT_EFFORT = { arbiter: (process.env.JARVIS_ARBITER_EFFORT ?? 'medium') as EffortLevel, agent: (process.env.JARVIS_AGENT_EFFORT ?? 'medium') as EffortLevel };
const PERMISSION_MODE = (process.env.JARVIS_PERMISSION_MODE ?? 'auto') as Options['permissionMode'];
const MAX_DEPTH = 2; // arbiter = 0, its agents = 1, their sub-agents = 2
let seq = 0;

// Only what agents need from ~/.claude/settings.json: auth (apiKeyHelper, env such as a proxy URL) and model.
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
export const SETTINGS_MODEL: string | undefined = SETTINGS.model;

// Only the user plugins listed here are loaded into agents (all of them would ~5x the tokens per turn).
// Ids as in enabledPlugins; JARVIS_PLUGINS="" turns them off.
function userPlugins(): Options['plugins'] {
  const ids = (process.env.JARVIS_PLUGINS ?? 'caveman@caveman,ponytail@ponytail').split(',').map((x) => x.trim()).filter(Boolean);
  try {
    const installed = JSON.parse(readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins;
    return ids.flatMap((id) => (installed[id]?.[0]?.installPath ? [{ type: 'local' as const, path: installed[id][0].installPath }] : []));
  } catch {
    return [];
  }
}
const PLUGINS = userPlugins();

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

export class DirtyWorktree extends Error {}

const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

const BOARD_TOOLS = ['board_post', 'board_read'].map((t) => `mcp__jarvis__${t}`);
const TEAM_TOOLS = ['spawn_agent', 'send_to_agent', 'list_agents', 'read_agent', 'stop_agent'].map((t) => `mcp__jarvis__${t}`);

const ARBITER_PROMPT = `You are the arbiter. You do not write code yourself: you split the user's goal into tasks, spawn coding agents with spawn_agent, pass context between them with send_to_agent, and report back to the user.
Agents see only what you send them, so give self-contained instructions with paths and acceptance criteria.
When an agent finishes you get a message starting with "[agent <id> finished". Decide the next step: send follow-ups, pass its results to another agent, or summarize for the user.
For facts several agents need (interfaces, decisions, conventions) use board_post with the recipients instead of repeating them in every send_to_agent.
Pick each agent's model by difficulty with spawn_agent's model parameter: the cheapest one that can do the job well (haiku for mechanical work, sonnet for normal coding, opus only for hard reasoning).`;

const LEAD_PROMPT = `You can delegate with spawn_agent when your task splits into large independent parts that can run in parallel; sub-agents work in the same repository on their own branches. Do small or sequential work yourself. Pick sub-agent models by difficulty: haiku for mechanical work, sonnet for normal coding, opus only for hard reasoning. When a sub-agent finishes you get a message starting with "[agent <id> finished".`;

const BOARD_PROMPT = `There is a shared board with other agents. Notes addressed to you arrive at the top of your messages as "[board notes for you]"; board_read fetches new ones mid-task. Use board_post only for things another agent actually needs (an interface you defined, a decision, a blocker), addressed to those agents.`;

export type Workspace = ReturnType<typeof createWorkspace>;

export function createWorkspace(meta: WorkspaceMeta) {
  const dir = join(DATA, 'workspaces', meta.id);
  const LOG = join(dir, 'events.jsonl');
  // The SDK needs some cwd; the arbiter doesn't work on code, so it gets its own empty home.
  const ARBITER_HOME = join(dir, 'arbiter');

  // Every UI-visible change goes through here: spawned, removed, status, text, delta, tool, routed, board, board_seen, ask, answered, result, session.
  const bus = new EventEmitter();
  // shortcut: whole event log is kept in memory and replayed to each UI, rotate it once it grows past a few MB
  const history: string[] = [];
  let closed = false; // set once archived: late events from dying sessions must not write into the moved folder

  function emit(type: string, data: object) {
    if (closed) return;
    const event = { type, ...data };
    if (!TRANSIENT.has(type)) {
      const line = JSON.stringify(event);
      history.push(line);
      appendFileSync(LOG, line + '\n');
    }
    bus.emit('event', event);
  }

  const agents = new Map<string, Agent>();
  const sessions = new Map<string, { push: (text: string) => void; abort: AbortController; q: Query }>();
  const pendingAsks = new Map<string, { resolve: (allow: boolean) => void; event: object }>();

  // Shared board: notes addressed to specific agents (or "all"), delivered with their next message.
  type Note = { n: number; from: string; to: string[]; text: string };
  const board: Note[] = [];
  const boardSeen = new Map<string, number>(); // agent id -> last note number delivered to it

  const depth = (a: Agent): number => (a.parentId ? 1 + depth(agents.get(a.parentId)!) : 0);
  const children = (id: string) => [...agents.values()].filter((c) => c.parentId === id);

  function setStatus(a: Agent, status: Status) {
    if (a.status === status) return;
    a.status = status;
    emit('status', { agentId: a.id, status });
  }

  function answerAsk(reqId: string, allow: boolean) {
    pendingAsks.get(reqId)?.resolve(allow);
    pendingAsks.delete(reqId);
  }

  // What a freshly connected UI needs to rebuild the screen: the persisted log plus live asks.
  const snapshot = (): string[] => [...history, ...[...pendingAsks.values()].map((p) => JSON.stringify(p.event))];

  // For the tab bar: how much is going on in this workspace.
  const summary = () => {
    const all = [...agents.values()];
    const costUsd = all.reduce((sum, a) => sum + a.costUsd, 0);
    return { ...meta, running: all.filter((a) => a.status === 'running').length, waiting: pendingAsks.size, costUsd };
  };

  // Rebuild agents from the event log so a server restart keeps the graph, logs and SDK session ids.
  function restore() {
    mkdirSync(ARBITER_HOME, { recursive: true });
    if (!existsSync(LOG)) return;
    for (const line of readFileSync(LOG, 'utf8').split('\n')) {
      if (!line) continue;
      history.push(line);
      const e = JSON.parse(line);
      const a = agents.get(e.agentId);
      if (e.type === 'spawned') agents.set(e.agent.id, { ...e.agent });
      else if (e.type === 'removed') agents.delete(e.agentId);
      else if (e.type === 'board') board.push(e);
      else if (e.type === 'board_seen') boardSeen.set(e.agentId, e.n);
      else if (!a) continue;
      else if (e.type === 'status') a.status = e.status;
      else if (e.type === 'text') a.lastText = e.text;
      else if (e.type === 'result') a.costUsd = e.costUsd;
      else if (e.type === 'session') a.sessionId = e.sessionId;
      else if (e.type === 'config') Object.assign(a, { model: e.model, effort: e.effort, runtimeModel: e.model !== a.model ? undefined : a.runtimeModel });
      else if (e.type === 'runtime') a.runtimeModel = e.model;
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
        model: a.model ?? (a.id === ARBITER ? ARBITER_MODEL : undefined),
        effort: a.effort ?? (a.id === ARBITER ? DEFAULT_EFFORT.arbiter : DEFAULT_EFFORT.agent),
        plugins: PLUGINS,
        permissionMode: PERMISSION_MODE,
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
        ...agentOptions(a),
      },
    });
    const s = {
      push: (text: string) => {
        setStatus(a, 'running');
        box.push(text);
      },
      abort,
      q,
    };
    sessions.set(a.id, s);
    pump(a, q);
    return s;
  }

  async function pump(a: Agent, q: Query) {
    // total_cost_usd counts from the start of this SDK session; earlier sessions (before a resume) are in the base.
    const base = a.costUsd;
    try {
      for await (const m of q) {
        if (m.type === 'stream_event') {
          const ev = m.event;
          if (m.parent_tool_use_id === null && ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            emit('delta', { agentId: a.id, text: ev.delta.text });
          }
        } else if (m.type === 'system' && m.subtype === 'init') {
          if (m.session_id !== a.sessionId) {
            a.sessionId = m.session_id;
            emit('session', { agentId: a.id, sessionId: m.session_id });
          }
          if (m.model !== a.runtimeModel) {
            a.runtimeModel = m.model;
            emit('runtime', { agentId: a.id, model: m.model });
          }
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
          a.costUsd = base + m.total_cost_usd;
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
    deliver(parent, text);
  }

  const unread = (a: Agent) =>
    board.filter((x) => x.n > (boardSeen.get(a.id) ?? 0) && x.from !== a.id && (x.to.includes(a.id) || x.to.includes('all')));

  // Every message into a session carries the board notes this agent has not seen yet.
  function deliver(a: Agent, text: string) {
    const notes = unread(a);
    if (notes.length) {
      markSeen(a);
      text = `[board notes for you]\n${notes.map((x) => `- from ${x.from}: ${x.text}`).join('\n')}\n\n${text}`;
    }
    session(a).push(text);
  }

  function markSeen(a: Agent) {
    const n = board.at(-1)?.n ?? 0;
    if ((boardSeen.get(a.id) ?? 0) === n) return;
    boardSeen.set(a.id, n);
    emit('board_seen', { agentId: a.id, n });
  }

  // `to` takes agent ids or names (case-insensitive), or "all".
  function postNote(from: string, to: string[], text: string) {
    const ids = new Set<string>();
    for (const t of to) {
      if (t === 'all') { ids.add('all'); continue; }
      const hits = [...agents.values()].filter((a) => a.id === t || a.name.toLowerCase() === t.toLowerCase());
      if (!hits.length) throw new Error(`unknown recipient "${t}". Known: ${[...agents.values()].map((a) => `${a.id} (${a.name})`).join(', ')}`);
      hits.forEach((a) => ids.add(a.id));
    }
    const note = { n: (board.at(-1)?.n ?? 0) + 1, from, to: [...ids], text };
    board.push(note);
    emit('board', note);
    return note;
  }

  function spawnAgent(name: string, task: string, repo?: string, parentId = ARBITER, model = DEFAULT_AGENT_MODEL, effort?: EffortLevel): Agent {
    const parent = agents.get(parentId);
    if (!parent) throw new Error(`no agent ${parentId}`);
    if (depth(parent) >= MAX_DEPTH) throw new Error(`max depth ${MAX_DEPTH} reached`);
    // Time suffix keeps ids, worktree dirs and jarvis/<id> branches unique across server restarts.
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36).slice(-4)}${++seq}`;
    // Arbiter's agents default to the workspace project; sub-agents to their parent's checkout so they see its work.
    const wd = makeWorkdir(id, repo ?? (parentId === ARBITER ? meta.project : parent.repo ?? parent.cwd));
    const a: Agent = { id, name, task, ...wd, status: 'idle', lastText: '', costUsd: 0, parentId, model, effort };
    agents.set(id, a);
    emit('spawned', { agent: a });
    emit('routed', { from: parentId, to: id, text: task });
    deliver(a, task);
    return a;
  }

  // Stops the agent and deletes its workdir. Its jarvis/<id> branch is kept, so committed work survives.
  // A worktree with uncommitted changes needs an explicit choice: commit them to the branch, or discard them.
  function deleteAgent(id: string, dirty?: 'commit' | 'discard') {
    const a = agents.get(id);
    if (!a || id === ARBITER) throw new Error(`cannot delete ${id}`);
    if (children(id).length) throw new Error(`${id} has sub-agents, delete them first`);
    const git = (...args: string[]) => execFileSync('git', ['-C', a.cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
    const changes = a.repo ? git('status', '--porcelain').trim() : '';
    if (changes && !dirty) throw new DirtyWorktree(`${id} has uncommitted changes:\n${changes.split('\n').slice(0, 10).join('\n')}`);
    stopAgent(id);
    if (a.repo) {
      if (changes && dirty === 'commit') {
        git('add', '-A');
        git('commit', '-m', `jarvis: save uncommitted work of ${id} before delete`);
      }
      execFileSync('git', ['-C', a.repo, 'worktree', 'remove', ...(dirty === 'discard' ? ['--force'] : []), a.cwd], { stdio: 'pipe' });
    } else if (resolve(a.cwd) === join(WORKTREES, id)) {
      // Only its own dir: a sub-agent of a non-git parent works inside the parent's dir.
      rmSync(a.cwd, { recursive: true, force: true });
    }
    agents.delete(id);
    emit('removed', { agentId: id });
  }

  function sendToAgent(id: string, text: string, from = ARBITER) {
    const a = agents.get(id);
    if (!a) throw new Error(`no agent ${id}`);
    emit('routed', { from, to: id, text });
    deliver(a, text);
  }

  // Model and effort can change mid-conversation; a live session switches right away.
  function configure(id: string, cfg: { model?: string; effort?: EffortLevel }) {
    const a = agents.get(id);
    if (!a) throw new Error(`no agent ${id}`);
    if (cfg.model && !(MODELS as readonly string[]).includes(cfg.model)) throw new Error(`unknown model ${cfg.model}`);
    if (cfg.effort && !EFFORTS.includes(cfg.effort)) throw new Error(`unknown effort ${cfg.effort}`);
    Object.assign(a, { model: cfg.model ?? a.model, effort: cfg.effort ?? a.effort });
    if (cfg.model) a.runtimeModel = undefined; // stale until the session reports again
    emit('config', { agentId: id, model: a.model, effort: a.effort });
    const q = sessions.get(id)?.q;
    if (cfg.model) void q?.setModel(cfg.model);
    if (cfg.effort) void q?.applyFlagSettings({ effortLevel: cfg.effort });
  }

  function stopAgent(id: string) {
    const a = agents.get(id);
    if (!a) throw new Error(`no agent ${id}`);
    setStatus(a, 'stopped');
    sessions.get(id)?.abort.abort();
    // Its permission prompts die with the session.
    for (const [reqId, p] of pendingAsks) if ((p.event as { agentId: string }).agentId === id) { pendingAsks.delete(reqId); emit('answered', { reqId }); }
  }

  // Stops everything that is working, waiting or holding a session. Each resumes on its next message.
  const stopAll = () => [...agents.values()].filter((a) => a.status === 'running' || a.status === 'waiting' || sessions.has(a.id)).forEach((a) => stopAgent(a.id));

  const boardTools = (owner: string) => [
    tool('board_post', 'Post a note to the shared board for specific agents or "all": decisions, interfaces, findings others need. Recipients get it with their next message.', {
      to: z.array(z.string()).describe('agent ids or names, or ["all"]'),
      text: z.string(),
    }, async ({ to, text }) => ok(`posted #${postNote(owner, to, text).n}`)),
    tool('board_read', 'Read board notes addressed to you that you have not seen yet.', {}, async () => {
      const a = agents.get(owner)!, notes = unread(a);
      markSeen(a);
      return ok(notes.length ? notes.map((x) => `#${x.n} from ${x.from}: ${x.text}`).join('\n') : 'no new notes');
    }),
  ];

  // The arbiter manages every agent; a lead agent only manages its own sub-agents; everyone gets the board.
  function jarvisTools(owner: string, team: boolean) {
    const mine = (id: string) => {
      if (owner !== ARBITER && agents.get(id)?.parentId !== owner) throw new Error(`${id} is not your sub-agent`);
      return id;
    };
    return createSdkMcpServer({
      name: 'jarvis',
      tools: [...boardTools(owner), ...(team ? [
        tool('spawn_agent', 'Start a new coding agent session. It runs in its own git worktree when repo is a git repo. You are notified automatically when it finishes a turn.', {
          name: z.string().describe('short role name, e.g. "tests" or "backend"'),
          task: z.string().describe('full self-contained instructions; the agent sees nothing else'),
          repo: z.string().optional().describe('absolute path to the repository to work on'),
          model: z.enum(MODELS).optional().describe(`model for this agent, default ${DEFAULT_AGENT_MODEL}. haiku: trivial or mechanical work (lookups, renames, formatting, simple shell). sonnet: regular coding, tests, refactors. opus: architecture, hard debugging, design, ambiguous problems.`),
          effort: z.enum(EFFORTS).optional().describe(`reasoning effort, default ${DEFAULT_EFFORT.agent}. low for mechanical work, high or xhigh only for genuinely hard problems.`),
        }, async ({ name, task, repo, model, effort }) => {
          const a = spawnAgent(name, task, repo, owner, model, effort);
          return ok({ id: a.id, cwd: a.cwd, model: a.model, effort: a.effort ?? DEFAULT_EFFORT.agent });
        }),
        tool('send_to_agent', 'Send a follow-up message or context to an existing agent. A stopped agent is resumed with its previous conversation.', {
          id: z.string(),
          message: z.string(),
        }, async ({ id, message }) => (sendToAgent(mine(id), message, owner), ok('sent'))),
        tool('list_agents', 'List agents you manage: id, status, task, cost and the start of the last message.', {}, async () =>
          ok((owner === ARBITER ? [...agents.values()] : children(owner)).map(({ lastText, ...a }) => ({ ...a, lastText: lastText.slice(0, 300) })))),
        tool('read_agent', 'Full last message of an agent.', { id: z.string() }, async ({ id }) => ok(agents.get(mine(id))?.lastText ?? 'no such agent')),
        tool('stop_agent', 'Stop an agent session. Its worktree is kept.', { id: z.string() }, async ({ id }) => (stopAgent(mine(id)), ok('stopped'))),
      ] : [])],
    });
  }

  function agentOptions(a: Agent): Options {
    const team = a.id === ARBITER || depth(a) < MAX_DEPTH;
    const project = meta.project ? `\nThis workspace is about the project at ${meta.project}; spawn_agent uses it as repo unless you pass another.` : '';
    const prompt = a.id === ARBITER ? ARBITER_PROMPT + project : team ? `${LEAD_PROMPT}\n${BOARD_PROMPT}` : BOARD_PROMPT;
    return {
      mcpServers: { jarvis: jarvisTools(a.id, team) },
      allowedTools: team ? [...BOARD_TOOLS, ...TEAM_TOOLS] : BOARD_TOOLS,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: prompt },
    };
  }

  // ---- archive support ----
  const PARKED = join(dir, 'parked-workdirs'); // plain (non-git) agent workdirs travel with the archive
  const ownPlainDir = (a: Agent) => !a.repo && resolve(a.cwd) === join(WORKTREES, a.id);
  const workers = () => [...agents.values()].filter((a) => a.id !== ARBITER);

  const busy = () => [...agents.values()].filter((a) => a.status === 'running' || a.status === 'waiting').map((a) => a.id);

  const dirty = () =>
    workers()
      .filter((a) => a.repo && existsSync(a.cwd))
      .map((a) => ({ id: a.id, changes: execFileSync('git', ['-C', a.cwd, 'status', '--porcelain'], { encoding: 'utf8' }).trim() }))
      .filter((d) => d.changes);

  // Leaves nothing behind that isn't recoverable: dirty worktrees are committed to their own branch first,
  // clean ones are removed (the jarvis/<id> branch keeps everything), plain workdirs move into the archive.
  function detach(commit: boolean) {
    const d = dirty();
    if (d.length && !commit) throw new DirtyWorktree(d.map((x) => `${x.id}:\n${x.changes.split('\n').slice(0, 5).join('\n')}`).join('\n\n'));
    for (const x of d) {
      execFileSync('git', ['-C', agents.get(x.id)!.cwd, 'add', '-A']);
      execFileSync('git', ['-C', agents.get(x.id)!.cwd, 'commit', '-m', `jarvis: save uncommitted work of ${x.id} before archiving workspace`]);
    }
    closed = true;
    for (const s of sessions.values()) s.abort.abort();
    try {
      for (const a of workers()) {
        if (a.repo && existsSync(a.cwd)) execFileSync('git', ['-C', a.repo, 'worktree', 'remove', a.cwd], { stdio: 'pipe' });
        else if (ownPlainDir(a) && existsSync(a.cwd)) {
          mkdirSync(PARKED, { recursive: true });
          renameSync(a.cwd, join(PARKED, a.id));
        }
      }
    } catch (e) {
      // Half-detached: put back what was already moved so the workspace stays usable, then report.
      closed = false;
      reattach();
      throw new Error(`archive aborted, workspace left as it was: ${(e as Error).message}`);
    }
  }

  // Puts workdirs back after a restore: worktrees from their branches, plain dirs from the archive.
  function reattach() {
    for (const a of workers()) {
      if (existsSync(a.cwd)) continue;
      if (a.repo) execFileSync('git', ['-C', a.repo, 'worktree', 'add', a.cwd, `jarvis/${a.id}`], { stdio: 'pipe' });
      else if (ownPlainDir(a) && existsSync(join(PARKED, a.id))) {
        mkdirSync(WORKTREES, { recursive: true });
        renameSync(join(PARKED, a.id), a.cwd);
      }
    }
    if (existsSync(PARKED) && !readdirSync(PARKED).length) rmSync(PARKED, { recursive: true });
  }

  restore();
  if (agents.get(ARBITER)?.cwd !== ARBITER_HOME) {
    // SDK sessions are stored per folder, so a moved arbiter starts a fresh conversation.
    const a: Agent = { id: ARBITER, name: 'Arbiter', task: '', cwd: ARBITER_HOME, status: 'idle', lastText: '', costUsd: 0 };
    agents.set(a.id, a);
    emit('spawned', { agent: a });
  }

  return {
    meta,
    dir,
    bus,
    busy,
    dirty,
    detach,
    reattach,
    snapshot,
    summary,
    answerAsk,
    sendToAgent,
    stopAgent,
    deleteAgent,
    stopAll,
    configure,
    postNote,
    tellArbiter: (text: string) => sendToAgent(ARBITER, text, 'user'),
  };
}

// ---- workspace registry: the list of tabs, persisted in workspaces.json ----

export const workspaces = new Map<string, Workspace>();

function saveRegistry() {
  writeFileSync(REGISTRY, JSON.stringify([...workspaces.values()].map((w) => w.meta), null, 2));
}

export function addWorkspace(name: string, project?: string, arbiter: { model?: string; effort?: EffortLevel } = {}): Workspace {
  if (project && !existsSync(project)) throw new Error(`project folder does not exist: ${project}`);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ws';
  const meta: WorkspaceMeta = { id: `${slug}-${Date.now().toString(36).slice(-4)}`, name, ...(project ? { project: resolve(project) } : {}) };
  const w = createWorkspace(meta);
  if (arbiter.model || arbiter.effort) w.configure(ARBITER, arbiter);
  workspaces.set(meta.id, w);
  saveRegistry();
  return w;
}

export function renameWorkspace(id: string, name: string) {
  const w = workspaces.get(id);
  if (!w) throw new Error(`no workspace ${id}`);
  if (!name.trim()) throw new Error('name is empty');
  w.meta.name = name.trim();
  saveRegistry();
}

// Archiving never deletes: see detach(). The folder moves to archive/<id> and can be restored.
export function archiveWorkspace(id: string, commit = false) {
  const w = workspaces.get(id);
  if (!w) throw new Error(`no workspace ${id}`);
  const busy = w.busy();
  if (busy.length) throw new Error(`agents are still working or waiting for you: ${busy.join(', ')}. Stop them first.`);
  w.detach(commit);
  mkdirSync(ARCHIVE, { recursive: true });
  writeFileSync(join(w.dir, 'meta.json'), JSON.stringify({ ...w.meta, archivedAt: new Date().toISOString() }, null, 2));
  renameSync(w.dir, join(ARCHIVE, id));
  workspaces.delete(id);
  if (!workspaces.size) addWorkspace('Main');
  saveRegistry();
}

export function listArchived(): (WorkspaceMeta & { archivedAt: string })[] {
  if (!existsSync(ARCHIVE)) return [];
  return readdirSync(ARCHIVE)
    .filter((d) => existsSync(join(ARCHIVE, d, 'meta.json')))
    .map((d) => JSON.parse(readFileSync(join(ARCHIVE, d, 'meta.json'), 'utf8')))
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

// What a permanent delete of an archived workspace would remove (parked workdirs) and keep (agent branches).
export function archivedInfo(id: string) {
  const dir = join(ARCHIVE, id);
  if (!existsSync(join(dir, 'meta.json'))) throw new Error(`no archived workspace ${id}`);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const agents = new Map<string, Agent>();
  for (const line of readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line);
    if (e.type === 'spawned') agents.set(e.agent.id, e.agent);
    else if (e.type === 'removed') agents.delete(e.agentId);
  }
  const parkedDir = join(dir, 'parked-workdirs');
  const parked = existsSync(parkedDir) ? readdirSync(parkedDir) : [];
  const branches = [...agents.values()].filter((a) => a.repo).map((a) => `${a.repo}: jarvis/${a.id}`);
  return { ...meta, agents: agents.size - 1, parked, branches };
}

// Permanent. The caller must repeat the workspace name. Agent branches in your repos are left alone.
export function deleteArchived(id: string, confirmName: string) {
  const info = archivedInfo(id);
  if (confirmName !== info.name) throw new Error('the name does not match, nothing deleted');
  rmSync(join(ARCHIVE, id), { recursive: true });
}

export function restoreWorkspace(id: string) {
  const from = join(ARCHIVE, id);
  if (!existsSync(join(from, 'meta.json')) || workspaces.has(id)) throw new Error(`cannot restore ${id}`);
  const { archivedAt, ...meta } = JSON.parse(readFileSync(join(from, 'meta.json'), 'utf8'));
  mkdirSync(join(DATA, 'workspaces'), { recursive: true });
  renameSync(from, join(DATA, 'workspaces', id));
  rmSync(join(DATA, 'workspaces', id, 'meta.json'));
  const w = createWorkspace(meta);
  w.reattach();
  workspaces.set(id, w);
  saveRegistry();
  return meta as WorkspaceMeta;
}

export function loadWorkspaces() {
  mkdirSync(DATA, { recursive: true });
  const metas: WorkspaceMeta[] = existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, 'utf8')) : [];
  for (const m of metas) workspaces.set(m.id, createWorkspace(m));
  if (!workspaces.size) addWorkspace('Main');
}
