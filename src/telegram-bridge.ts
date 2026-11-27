// Telegram bridge: a separate, dependency-free process that is a loopback client of Jarvis (POST /say, GET /events, GET /workspaces) and a long-polling Telegram bot. It opens no listener.
// The chat is a forum supergroup: one topic per workspace. Run it with `npm run telegram` (`--pair` prints the chat and sender ids once and exits).
import { dirname, join } from 'node:path';
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { localEnvFile, loadLocalEnv } from './local-env.ts';
import { dataDir } from './tmpguard.ts';

export type Cfg = {
  token: string; user: number; chat: number; jarvis: string; api: string; stateFile: string;
  debounceMs: number; syncMs: number; gapMs: number;
  retryMs?: number; // first wait before a send is retried after a network error or a 5xx, doubling (default 1 s)
  retryTotalMs?: number; // how long one message part is retried before it is dropped (default 60 s)
  drainMs?: number; // how long stop() waits for queued text to be sent (default 5 s)
  conflictMs?: number; // how long a 409 from getUpdates is retried before the bridge gives up (default 90 s)
};

const LIMIT = 4096; // Bot API: sendMessage text is 1-4096 characters

// The API URL holds the token: every message that leaves this process goes through here.
export const redact = (s: string, token: string) => (token ? s.split(token).join('<token>') : s).replace(/\/bot[^/\s"']*/g, '/bot<token>');

// Jarvis runs shell commands for whoever can reach it, and the token travels in the API URL: Jarvis must be on loopback, Telegram must be https (loopback only for a test double).
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
function baseUrl(name: string, value: string, mustBeLoopback: boolean): string {
  let u: URL;
  try { u = new URL(value); } catch { throw new Error(`${name} is not a URL`); }
  const loop = LOOPBACK.has(u.hostname);
  if (mustBeLoopback && !loop) throw new Error(`${name} must point to this machine (127.0.0.1, localhost or [::1])`);
  if (!mustBeLoopback && !loop && u.protocol !== 'https:') throw new Error(`${name} must be https`);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${name} must be http(s)`);
  return value.replace(/\/+$/, '');
}

// Fail closed: without both ids nothing is forwarded in either direction.
export function configFromEnv(env: NodeJS.ProcessEnv, pairing = false): Cfg {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const id = (k: string) => {
    const v = env[k];
    if (!v || !/^-?\d+$/.test(v.trim())) { if (pairing) return 0; throw new Error(`${k} is not set (a numeric id); run with --pair to find it`); }
    return Number(v);
  };
  return {
    token, user: id('TELEGRAM_ALLOWED_USER'), chat: id('TELEGRAM_CHAT_ID'),
    jarvis: baseUrl('JARVIS_URL', env.JARVIS_URL || 'http://127.0.0.1:7777', true),
    api: baseUrl('TELEGRAM_API_BASE', env.TELEGRAM_API_BASE || 'https://api.telegram.org', false), // TELEGRAM_API_BASE: tests only
    stateFile: env.TELEGRAM_STATE_FILE || join(dataDir(), 'telegram-bridge.json'),
    debounceMs: 1500, syncMs: 10_000, gapMs: 3000, // Telegram allows about 20 messages a minute in a group
  };
}

// Text of up to LIMIT characters per piece, cut at the last line break when there is one.
export function split(text: string, limit = LIMIT): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const nl = rest.lastIndexOf('\n', limit);
    let cut = nl > 0 ? nl : limit;
    if (cut === limit && /[\ud800-\udbff]/.test(rest[cut - 1])) cut--; // not inside a surrogate pair
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  out.push(rest);
  return out.filter((p) => p.trim());
}

// One bridge per state file: a second copy would poll the same bot (Telegram answers 409) and double every message. A lock of a dead pid is stale.
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
// hooks: tests only, to force the races.
export function lock(file: string, hooks: { afterCreate?: () => void; afterRead?: () => void } = {}): () => void {
  mkdirSync(dirname(file), { recursive: true });
  const taken = () => new Error(`another telegram bridge took the lock ${file}`);
  for (let i = 0; i < 3; i++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' });
      hooks.afterCreate?.();
      if (readFileSync(file, 'utf8') !== String(process.pid)) throw taken(); // a copy that treated our file as stale removed it
      return () => { try { if (readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = 0;
      try { pid = Number(readFileSync(file, 'utf8').trim()); } catch { continue; }
      if (pid && alive(pid)) throw new Error(`another telegram bridge is running (pid ${pid}); lock file ${file}`);
      hooks.afterRead?.();
      // Take the stale file away by renaming it (atomic), then look at what was moved: if a live copy took over in between, the file moved was its fresh lock, and it goes back.
      const moved = `${file}.${process.pid}.stale`;
      try { renameSync(file, moved); } catch { continue; } // someone else took it away first
      let now = 0;
      try { now = Number(readFileSync(moved, 'utf8').trim()); } catch { /* unreadable: stale */ }
      if (now && alive(now)) {
        try { linkSync(moved, file); } catch { /* another copy has made a new lock meanwhile */ }
        unlinkSync(moved);
        throw taken();
      }
      unlinkSync(moved);
    }
  }
  throw new Error(`cannot take the lock ${file}`);
}

class TgError extends Error {
  code: number;
  retryAfter: number;
  migrated = false; // the chat id is that of a group that was upgraded to a supergroup (a new id)
  constructor(message: string, code = 0, retryAfter = 0) { super(message); this.code = code; this.retryAfter = retryAfter; }
}

type State = { chat: number; offset: number; topics: Record<string, number> };
const ABSENT_SYNCS = 3;
// `done` settles when polling ends: it rejects for an error that cannot be retried (bad token, another bot instance or a webhook).
type Handle = { stop(): Promise<void>; done: Promise<void> };

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => {
  if (signal?.aborted) return r();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); r(); }
  signal?.addEventListener('abort', done);
});

export async function startBridge(cfg: Cfg): Promise<Handle> {
  if (!cfg.user || !cfg.chat) throw new Error('TELEGRAM_ALLOWED_USER and TELEGRAM_CHAT_ID are required');
  // `quit` ends polling, the SSE readers and the sync; `stop` also aborts a send in flight, and is used only after the queue had its time to drain.
  const quit = new AbortController();
  const stop = new AbortController();
  const log = (...a: unknown[]) => console.error(redact(a.map(String).join(' '), cfg.token));
  const origin = new URL(cfg.jarvis).origin;

  async function tg<T = any>(method: string, params: object = {}, timeoutMs = 30_000, signal = stop.signal): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${cfg.api}/bot${cfg.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
    } catch (e) { throw new TgError(`${method}: ${(e as Error).name === 'AbortError' || signal.aborted ? 'aborted' : 'network error'}`); }
    const j: any = await r.json().catch(() => ({}));
    if (!j.ok) {
      const err = new TgError(`${method}: ${j.error_code ?? r.status} ${j.description ?? ''}`, j.error_code ?? r.status, j.parameters?.retry_after ?? 0);
      err.migrated = j.parameters?.migrate_to_chat_id !== undefined || /upgraded to a supergroup/i.test(j.description ?? '');
      throw err;
    }
    return j.result;
  }

  async function jarvis<T = any>(path: string, body?: object): Promise<T | undefined> {
    const signal = AbortSignal.any([quit.signal, AbortSignal.timeout(10_000)]);
    const r = await fetch(cfg.jarvis + path, body === undefined ? { headers: { origin }, signal } : { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!r.ok) throw new Error(`jarvis ${path.split('?')[0]}: ${r.status}`);
    return r.status === 200 ? await r.json() as T : undefined;
  }

  // Topic map and update offset survive a restart.
  let state: State = { chat: cfg.chat, offset: 0, topics: {} };
  try { const s = JSON.parse(readFileSync(cfg.stateFile, 'utf8')); if (s.chat === cfg.chat) state = { chat: cfg.chat, offset: Number(s.offset) || 0, topics: s.topics ?? {} }; } catch { /* first run */ }
  const save = () => {
    try { mkdirSync(dirname(cfg.stateFile), { recursive: true }); const tmp = `${cfg.stateFile}.tmp`; writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, cfg.stateFile); } catch (e) { log('state not saved:', (e as Error).message); }
  };

  const unlock = lock(`${cfg.stateFile}.lock`);
  try {
    const chat = await tg('getChat', { chat_id: cfg.chat });
    if (!chat?.is_forum) throw new Error('TELEGRAM_CHAT_ID is not a forum supergroup (enable Topics in the group)');
  } catch (e) {
    unlock();
    if (e instanceof TgError && e.migrated) throw new Error('TELEGRAM_CHAT_ID is the id of a group that was upgraded to a supergroup (turning on Topics does this) and has a new id: run `npm run telegram -- --pair` again and set the new TELEGRAM_CHAT_ID');
    throw e;
  }

  // One queue for the whole group, one send per `gapMs` (Telegram allows about 20 messages a minute in a group). The workspaces take turns, so one noisy workspace cannot starve the others.
  type Item = { thread?: number; text: string; ws: string };
  const lane = new Map<string, Item[]>();
  let pumping: Promise<void> = Promise.resolve(), busy = false, last = 0; // last: end of the latest send attempt
  const pending = () => lane.size > 0;
  function next(): Item | undefined {
    const first = lane.entries().next().value;
    if (!first) return;
    const [ws, items] = first;
    const item = items.shift()!;
    lane.delete(ws);
    if (items.length) lane.set(ws, items); // the workspace goes to the back of the line
    return item;
  }
  // The gap is measured from the end of the last attempt, success or not. It uses the `stop` signal, so it holds while the queue drains after `quit`.
  function pump() {
    if (busy) return;
    busy = true;
    pumping = (async () => {
      let dropped = 0;
      while (pending()) {
        await sleep(Math.max(0, last + cfg.gapMs - Date.now()), stop.signal);
        if (stop.signal.aborted) { for (const q of lane.values()) dropped += q.length; lane.clear(); break; }
        const item = next();
        if (!item) break;
        try { await sendChunk(item); } catch (e) { if (stop.signal.aborted) dropped++; else log('send failed:', (e as Error).message); } finally { last = Date.now(); }
      }
      if (dropped) log(`${dropped} queued message part(s) not sent: the bridge stopped`); // one line, not one per part
      busy = false;
    })();
  }
  // 429 waits retry_after; a network error (no HTTP status) and a 5xx wait 1 s, 2 s, 4 s ... with some jitter; all stop after `retryTotalMs`.
  async function sendChunk({ thread, text, ws }: Item) {
    const t0 = Date.now();
    for (let tries = 0; ; tries++) {
      if (stop.signal.aborted) throw new TgError('sendMessage: stopped before it was sent');
      try { await tg('sendMessage', { chat_id: cfg.chat, text, ...(thread && { message_thread_id: thread }) }); return; } catch (e) {
        if (e instanceof TgError && ws && /thread not found/i.test(e.message)) { if (state.topics[ws] === thread) forget(ws); return; } // topic deleted: the next sync makes a new one; a late chunk for an older topic must not drop the new one
        const rate = e instanceof TgError && e.code === 429;
        const wait = rate ? (e.retryAfter || 1) * 1000 + 100 : Math.min((cfg.retryMs ?? 1000) * 2 ** tries, 15_000) * (0.8 + Math.random() * 0.4);
        if (!(e instanceof TgError && (rate || e.code === 0 || e.code >= 500)) || Date.now() - t0 + wait > (cfg.retryTotalMs ?? 60_000)) throw e; // the pump logs it as `send failed`
        await sleep(wait, stop.signal);
      }
    }
  }
  function send(thread: number | undefined, text: string, ws = '') {
    const q = lane.get(ws) ?? [];
    for (const p of split(text)) q.push({ thread, text: p, ws });
    if (q.length) { lane.set(ws, q); pump(); }
  }

  // Merge a burst of arbiter text and finished-lines of one workspace into one message.
  const bursts = new Map<string, { lines: string[]; timer: NodeJS.Timeout }>();
  function push(ws: string, line: string) {
    const b = bursts.get(ws) ?? { lines: [] as string[], timer: undefined as any };
    b.lines.push(line);
    clearTimeout(b.timer);
    b.timer = setTimeout(() => flush(ws), cfg.debounceMs);
    bursts.set(ws, b);
  }
  function flush(ws: string) {
    const b = bursts.get(ws);
    bursts.delete(ws);
    if (b) { clearTimeout(b.timer); if (state.topics[ws]) send(state.topics[ws], b.lines.join('\n\n'), ws); }
  }
  // `result.text` repeats the last arbiter `text` of the turn, so only `text` events are forwarded. `ask` prompts stay in the web UI.
  function onEvent(ws: string, e: any) {
    if (e.type === 'text' && e.agentId === 'arbiter' && typeof e.text === 'string') push(ws, e.text);
    else if (e.type === 'routed' && e.to === 'arbiter' && typeof e.text === 'string' && /^\[agent \S+ finished/.test(e.text)) push(ws, e.text.split('\n')[0].slice(0, 200));
  }

  // One SSE reader per workspace; everything up to `ready` is replay of history and is skipped.
  const readers = new Map<string, AbortController>();
  async function follow(ws: string, signal: AbortSignal) {
    let delay = 1000;
    while (!signal.aborted) {
      try {
        const r = await fetch(`${cfg.jarvis}/events?ws=${encodeURIComponent(ws)}`, { signal, headers: { origin } });
        if (r.status === 404) return;
        if (!r.ok || !r.body) throw new Error(`events ${r.status}`);
        let live = false, buf = '';
        for await (const chunk of r.body.pipeThrough(new TextDecoderStream())) {
          buf += chunk;
          for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
            let e: any;
            try { e = JSON.parse(data); } catch { continue; }
            if (e.type === 'ready') { live = true; delay = 1000; } else if (live) onEvent(ws, e);
          }
        }
      } catch (e) { if (signal.aborted) return; log(`events ${ws}:`, (e as Error).message); }
      await sleep(delay, signal);
      delay = Math.min(delay * 2, 30_000);
    }
  }
  const unfollow = (ws: string) => { readers.get(ws)?.abort(); readers.delete(ws); };
  function forget(ws: string) { unfollow(ws); delete state.topics[ws]; bursts.delete(ws); save(); }

  async function ensureTopic(w: { id: string; name: string }) {
    for (let tries = 0; !state.topics[w.id]; tries++) {
      try {
        const t = await tg('createForumTopic', { chat_id: cfg.chat, name: (w.name || w.id).slice(0, 128) });
        state.topics[w.id] = t.message_thread_id;
        save();
      } catch (e) {
        if (!(e instanceof TgError && e.code === 429 && tries < 2)) throw e;
        await sleep((e.retryAfter || 1) * 1000 + 100, quit.signal);
        if (quit.signal.aborted) throw e;
      }
    }
  }

  const absent = new Map<string, number>(); // consecutive syncs without the workspace
  // Workspaces to topics; a new workspace gets a topic.
  async function sync() {
    const list: { id: string; name: string }[] = (await jarvis('/workspaces'))?.workspaces ?? [];
    const ids = new Set(list.map((w) => w.id));
    for (const w of list) {
      if (quit.signal.aborted) return;
      try { await ensureTopic(w); } catch (e) { log(`topic for ${w.id}:`, (e as Error).message); continue; } // one failing workspace does not hold back the others
      if (!readers.has(w.id)) { const c = new AbortController(); readers.set(w.id, c); const sig = AbortSignal.any([quit.signal, c.signal]); void follow(w.id, sig).finally(() => { if (readers.get(w.id) === c) readers.delete(w.id); }); }
    }
    for (const ws of readers.keys()) if (!ids.has(ws)) unfollow(ws);
    // A workspace that stays away for several syncs in a row is gone (deleted or archived): its topic goes. One bad answer does not wipe the map.
    for (const ws of Object.keys(state.topics)) {
      if (ids.has(ws)) { absent.delete(ws); continue; }
      const n = (absent.get(ws) ?? 0) + 1;
      if (n >= ABSENT_SYNCS) { absent.delete(ws); forget(ws); } else absent.set(ws, n);
    }
  }
  const syncLoop = (async () => {
    while (!quit.signal.aborted) {
      try { await sync(); } catch (e) { log('sync:', (e as Error).message); }
      await sleep(cfg.syncMs, quit.signal);
    }
  })();

  // Only the one allowed user in the one allowed chat. Anything else, including anonymous admins (sender_chat), is dropped silently.
  function accept(m: any): boolean {
    // Forwarded and inline-bot messages carry text the user did not write.
    return !!m && !m.sender_chat && !m.forward_origin && !m.forward_date && !m.via_bot && m.from?.id === cfg.user && m.chat?.id === cfg.chat && typeof m.text === 'string';
  }
  // 👀 on the user's message: the bridge delivered it to Jarvis (not that the arbiter read or answered it). Best effort: one cheap call outside the send queue, in order, never awaited by the caller, dropped when too many wait or the bridge is stopping; one log line per kind of failure.
  let reacting: Promise<void> = Promise.resolve(), reactWaiting = 0;
  const reactFailed = new Set<string>();
  function react(messageId: unknown) {
    if (typeof messageId !== 'number' || reactWaiting >= 20 || quit.signal.aborted) return;
    reactWaiting++;
    reacting = reacting.then(async () => {
      try { await tg('setMessageReaction', { chat_id: cfg.chat, message_id: messageId, reaction: [{ type: 'emoji', emoji: '👀' }] }, 10_000, quit.signal); } catch (e) {
        const kind = e instanceof TgError ? String(e.code) : 'error';
        if (!quit.signal.aborted && !reactFailed.has(kind)) { reactFailed.add(kind); log('reaction failed:', (e as Error).message); }
      } finally { reactWaiting--; }
    });
  }
  async function onMessage(m: any) {
    if (!accept(m)) return;
    const thread: number | undefined = m.message_thread_id;
    if (!thread) {
      if (/^\/help(@\w+)?(\s|$)/.test(m.text)) {
        const fresh = (await jarvis('/workspaces').catch(() => undefined))?.workspaces as { id: string; name: string }[] | undefined;
        const names = new Map<string, string>((fresh ?? []).map((w) => [w.id, w.name]));
        const lines = Object.keys(state.topics).filter((ws) => !fresh || names.has(ws)).map((ws) => `- ${names.get(ws) ?? ws}`); // not the ones Jarvis no longer has
        send(undefined, `Write in a workspace topic to talk to its Jarvis.\nTopics:\n${lines.join('\n') || '(none yet)'}`);
      }
      return;
    }
    const ws = Object.keys(state.topics).find((k) => state.topics[k] === thread);
    if (!ws) return;
    try { await jarvis('/say', { ws, text: m.text }); } catch (e) { log('say failed:', (e as Error).message); send(thread, 'Jarvis did not take the message.'); return; }
    react(m.message_id);
  }

  let fatal: Error | undefined;
  let conflictSince: number | undefined, conflicts = 0;
  const pollLoop = (async () => {
    let delay = 1000;
    while (!quit.signal.aborted) {
      try {
        const ups: any[] = await tg('getUpdates', { offset: state.offset, timeout: 50, allowed_updates: ['message'] }, 65_000, quit.signal);
        delay = 1000; conflictSince = undefined; conflicts = 0;
        for (const u of ups) {
          state.offset = u.update_id + 1;
          save(); // before the work: a crash in the middle drops this update (at most once) instead of running it twice
          try { await onMessage(u.message); } catch (e) { log('update failed:', (e as Error).message); }
        }
      } catch (e) {
        if (quit.signal.aborted) break;
        log((e as Error).message);
        if (e instanceof TgError && e.code === 401) { fatal = e; quit.abort(); break; } // wrong token: retrying cannot help
        if (e instanceof TgError && e.code === 409) {
          // The lock rules out a second local copy, but after a quick restart Telegram still holds the old long poll for up to ~50 s. Retry for a while; a 409 that stays is another poller elsewhere or a webhook.
          const budget = cfg.conflictMs ?? 90_000;
          conflictSince ??= Date.now();
          if (Date.now() - conflictSince > budget) { fatal = new Error(`${e.message} (for more than ${Math.round(budget / 1000)} s: another program polls this bot, or a webhook is set)`); quit.abort(); break; }
          await sleep([budget / 45, budget / 18, budget / 9][Math.min(conflicts++, 2)], quit.signal); // 2 s, 5 s, then 10 s of the default budget
          continue;
        }
        if (e instanceof TgError && e.code === 429) delay = Math.max(delay, e.retryAfter * 1000);
        await sleep(delay, quit.signal);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  })();

  let closed: Promise<void> | undefined;
  const shutdown = () => closed ??= (async () => {
    quit.abort();
    await Promise.allSettled([pollLoop, syncLoop, reacting]);
    for (const ws of [...bursts.keys()]) flush(ws); // text still waiting for its debounce goes out now
    const t = setTimeout(() => stop.abort(), cfg.drainMs ?? 5000);
    await pumping; // the queue ends by itself when the stop signal aborts a send in flight
    clearTimeout(t);
    stop.abort();
    unlock();
  })();
  const done = pollLoop.then(shutdown).then(() => { if (fatal) throw fatal; });
  done.catch(() => {}); // the caller may not wait for it
  return { stop: shutdown, done };
}

export type Paired = { chat: number; type?: string; title?: string; from?: number; username?: string; firstName?: string; senderChat?: boolean; forum?: boolean };

// Waits for a message the bot sees and takes the newest one, a supergroup's first: a basic group that was upgraded to a supergroup (Topics does that) leaves older updates with its dead id. Forwards nothing and confirms no update.
export async function pair(cfg: Cfg): Promise<Paired> {
  for (;;) {
    const t0 = Date.now();
    const r = await fetch(`${cfg.api}/bot${cfg.token}/getUpdates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeout: 50, allowed_updates: ['message'] }), signal: AbortSignal.timeout(65_000) }).catch(() => undefined);
    const j: any = await r?.json().catch(() => undefined);
    if (j && j.ok === false) throw new Error(`getUpdates: ${j.error_code} ${j.description ?? ''}`);
    const msgs: any[] = (j?.result ?? []).map((u: any) => u.message).filter((m: any) => m?.chat);
    const m = msgs.findLast((x) => x.chat.type === 'supergroup') ?? msgs.at(-1);
    if (m) {
      let forum: boolean | undefined; // undefined: not checked or could not be
      if (m.chat.type !== 'private') {
        const c: any = await fetch(`${cfg.api}/bot${cfg.token}/getChat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: m.chat.id }), signal: AbortSignal.timeout(10_000) }).then((x) => x.json()).catch(() => undefined);
        if (c?.ok) forum = !!c.result?.is_forum;
      }
      return { chat: m.chat.id, type: m.chat.type, title: m.chat.title, from: m.from?.id, username: m.from?.username, firstName: m.from?.first_name, senderChat: !!m.sender_chat, forum };
    }
    if (Date.now() - t0 < 1000) await sleep(2000); // an error or a non-JSON answer must not become a hot loop
  }
}

export function describePair(p: Paired): string {
  const out = [`chat id: ${p.chat} (${p.type ?? '?'}${p.title ? `, "${p.title}"` : ''})`, `sender id: ${p.from} (${[p.firstName, p.username && `@${p.username}`].filter(Boolean).join(' ') || 'no name'})`];
  if (p.senderChat) out.push('WARNING: sent as a chat (anonymous admin); this is not your user id. Turn off "remain anonymous" and write again.');
  else if (p.type === 'private') out.push('WARNING: a private chat, not the group. Write in the group (any topic) and run --pair again.');
  if (p.type !== 'private' && p.type !== 'supergroup') out.push(`WARNING: this chat is a ${p.type ?? 'chat of unknown type'}, not a supergroup. Turn on Topics in the group settings (that makes it a supergroup with a new id), write again and run --pair again.`);
  else if (p.type === 'supergroup' && p.forum === false) out.push('WARNING: Topics is off in this group. Turn it on in the group settings, then run --pair again.');
  out.push('Set TELEGRAM_CHAT_ID and TELEGRAM_ALLOWED_USER to these.');
  return out.join('\n');
}

if (import.meta.main) {
  loadLocalEnv(process.env.TELEGRAM_ENV_FILE || join(dirname(localEnvFile()), 'telegram.env'));
  const fail = (e: unknown) => { console.error(redact((e as Error).message, process.env.TELEGRAM_BOT_TOKEN || '')); process.exit(1); };
  const pairing = process.argv.includes('--pair');
  try {
    const cfg = configFromEnv(process.env, pairing);
    if (pairing) {
      console.log('Write one message to the bot in the group...');
      console.log(describePair(await pair(cfg)));
    } else {
      const b = await startBridge(cfg);
      console.error(`telegram bridge up, Jarvis at ${cfg.jarvis}`);
      for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => void b.stop().then(() => process.exit(0)));
      await b.done;
    }
  } catch (e) { fail(e); }
}
