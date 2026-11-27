// The Telegram bridge against a fake Telegram HTTP server and a fake Jarvis (plus one run against the real server with the fake SDK). Never the real Telegram API, never a real token.
import { test as base } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configFromEnv, lock, describePair, redact, split, mdToHtml, wellFormed, startBridge as start, pair, type Cfg } from '../src/telegram-bridge.ts';

const TOKEN = '123456:FAKE-token_for-tests';
const USER = 111, CHAT = -100222;
const tmp = mkdtempSync(join(tmpdir(), 'jarvis-telegram-test-'));
const until = async (f: () => boolean, ms = 20_000) => { for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(f(), 'condition not reached'); };

// Everything a test starts is stopped when it ends, also when it fails or hangs: a bridge or server left behind would keep the whole test process alive, and a hang would block the run instead of failing.
const bridges: { stop(): Promise<void> }[] = [], servers: Server[] = [], extras: (() => void)[] = [];
const listen = (s: Server) => { servers.push(s); return new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as any).port))); };
const startBridge = async (cfg: Cfg) => { const b = await start(cfg); bridges.push(b); return b; };
async function cleanup() {
  for (const f of extras.splice(0)) f();
  await Promise.allSettled(bridges.splice(0).map((b) => b.stop()));
  for (const s of servers.splice(0)) { s.closeAllConnections(); s.close(); }
}
const test = (name: string, fn: () => unknown, ms = 90_000) => base(name, async () => {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([Promise.resolve().then(fn), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`test timed out after ${ms} ms`)), ms); })]); } finally { clearTimeout(timer); await cleanup(); }
});
const body = async (req: any) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };

type Call = { method: string; params: any; at: number };
function fakeTelegram(opts: { forum?: boolean } = {}) {
  const calls: Call[] = [];
  const updates: any[] = [];
  const failNext: { code: number; retry?: number; description?: string; migrate?: number; method?: string; delayMs?: number; drop?: boolean }[] = [];
  let thread = 100, paths: string[] = [];
  const reject = { html: false }; // answer 400 to every HTML message
  const slow: Record<string, number> = {}; // method -> ms to wait before answering
  const server = createServer(async (req, res) => {
    paths.push(req.url!);
    const method = req.url!.split('/').pop()!;
    const params = await body(req);
    calls.push({ method, params, at: Date.now() });
    const reply = (o: object) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (slow[method]) await new Promise((r) => setTimeout(r, slow[method]));
    if (failNext.length && (failNext[0].method ?? 'sendMessage') === method) {
      const f = failNext.shift()!;
      if (f.drop) return void req.socket.destroy(); // a network error: no HTTP answer
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      return reply({ ok: false, error_code: f.code, description: f.description ?? 'Too Many Requests', parameters: f.retry ? { retry_after: f.retry } : f.migrate ? { migrate_to_chat_id: f.migrate } : undefined });
    }
    if (reject.html && params.parse_mode === 'HTML') return reply({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag" });
    if (method === 'getUpdates') {
      await new Promise((r) => setTimeout(r, 30));
      const off = params.offset ?? 0;
      return reply({ ok: true, result: updates.filter((u) => u.update_id >= off) });
    }
    if (method === 'getChat') return reply({ ok: true, result: { id: CHAT, is_forum: opts.forum ?? true } });
    if (method === 'createForumTopic') return reply({ ok: true, result: { message_thread_id: ++thread, name: params.name } });
    reply({ ok: true, result: { message_id: 1 } });
  });
  const msgs = (th?: number) => calls.filter((c) => c.method === 'sendMessage' && (th === undefined || c.params.message_thread_id === th)).map((c) => c.params.text as string);
  const msg = (text: string, o: any = {}) => ({ update_id: updates.length + 1, message: { message_id: updates.length + 1, text, chat: { id: CHAT }, from: { id: USER }, ...o } });
  return { server, calls, updates, failNext, slow, reject, msgs, msg, paths: () => paths };
}

function fakeJarvis(wss: { id: string; name: string }[], archived: { id: string }[] = []) {
  const says: { body: any; origin?: string; type?: string }[] = [];
  const streams = new Map<string, ServerResponse[]>();
  let connects = 0, lists = 0;
  let gate: Promise<void> = Promise.resolve();
  const flags = { failSay: false };
  let clock = 1;
  const history = new Map<string, object[]>(); // what the real server replays before `ready`; events carry `at` like the real ones
  const hist = (ws: string) => history.get(ws) ?? (history.set(ws, [{ type: 'text', agentId: 'arbiter', text: `OLD ${ws}`, at: clock++ }]), history.get(ws)!);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/workspaces') return lists++, void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ workspaces: wss, archived }));
    if (url.pathname === '/events') {
      connects++;
      const ws = url.searchParams.get('ws')!;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ping\n\n'); // keepalive comment
      for (const e of hist(ws)) res.write(`data: ${JSON.stringify(e)}\n\n`); // replay of history
      res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`);
      streams.set(ws, [...(streams.get(ws) ?? []), res]);
      return;
    }
    if (url.pathname === '/say') { says.push({ body: await body(req), origin: req.headers.origin, type: req.headers['content-type'] }); await gate; return void res.writeHead(flags.failSay ? 500 : 204).end(); }
    res.writeHead(404).end();
  });
  // `archived` goes to live streams only, like the real server
  const emit = (ws: string, e: object, at = clock++) => { const ev = { ...e, at }; if ((e as any).type !== 'archived') hist(ws).push(ev); streams.get(ws)?.forEach((r) => r.write(`data: ${JSON.stringify(ev)}\n\n`)); };
  const text = (ws: string, t: string, agentId = 'arbiter', at?: number) => emit(ws, { type: 'text', agentId, text: t }, at);
  const drop = (ws: string) => { streams.get(ws)?.forEach((r) => r.destroy()); streams.delete(ws); };
  const hold = () => { let open!: () => void; gate = new Promise<void>((r) => { open = r; }); return open; };
  const ping = (ws: string) => streams.get(ws)?.forEach((r) => r.write(': ping\n\n'));
  return { server, says, emit, text, drop, hold, ping, history, lists: () => lists, connects: () => connects, set failSay(v: boolean) { flags.failSay = v; } };
}

async function setup(wss = [{ id: 'w1', name: 'One' }, { id: 'w2', name: 'Two' }], o: { forum?: boolean; state?: string; archived?: { id: string }[] } = {}) {
  const t = fakeTelegram({ forum: o.forum }), j = fakeJarvis(wss, o.archived);
  const [tp, jp] = [await listen(t.server), await listen(j.server)];
  const stateFile = o.state ?? join(mkdtempSync(join(tmp, 's-')), 'state.json');
  const cfg: Cfg = { token: TOKEN, user: USER, chat: CHAT, jarvis: `http://127.0.0.1:${jp}`, api: `http://127.0.0.1:${tp}`, stateFile, debounceMs: 50, syncMs: 100, gapMs: 0, backfill: 0 };
  const open = [t.server, j.server];
  const end = async () => { open.forEach((s) => { s.closeAllConnections(); s.close(); }); };
  return { t, j, cfg, end };
}
const topicOf = (t: ReturnType<typeof fakeTelegram>, name: string) => t.calls.find((c) => c.method === 'createForumTopic' && c.params.name === name);

test('config fails closed without user or chat; --pair only needs the token', () => {
  assert.throws(() => configFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-1' }), /TELEGRAM_ALLOWED_USER/);
  assert.throws(() => configFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER: '1' }), /TELEGRAM_CHAT_ID/);
  assert.throws(() => configFromEnv({ TELEGRAM_ALLOWED_USER: '1', TELEGRAM_CHAT_ID: '-1' }), /TELEGRAM_BOT_TOKEN/);
  assert.throws(() => configFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER: 'abc', TELEGRAM_CHAT_ID: '-1' }), /TELEGRAM_ALLOWED_USER/);
  assert.equal(configFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN }, true).user, 0);
  assert.equal(configFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER: '1', TELEGRAM_CHAT_ID: '-1' }).jarvis, 'http://127.0.0.1:7777');
});

test('startBridge refuses a config without ids and a chat that is not a forum', async () => {
  const s = await setup(undefined, { forum: false });
  await assert.rejects(startBridge({ ...s.cfg, user: 0 }), /required/);
  await assert.rejects(startBridge(s.cfg), /forum/);
  assert.equal(s.t.calls.filter((c) => c.method === 'getUpdates').length, 0);
  await s.end();
});

test('split cuts at line breaks, never above 4096, loses no text', () => {
  const line = 'x'.repeat(99);
  const text = Array.from({ length: 120 }, () => line).join('\n');
  const parts = split(text);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 4096));
  assert.ok(parts.slice(0, -1).every((p) => p.endsWith(line)));
  assert.equal(parts.join('\n'), text);
  const blob = split('y'.repeat(9000));
  assert.deepEqual(blob.map((p) => p.length), [4096, 4096, 808]);
  assert.deepEqual(split('   \n'), []);
});

test('redact removes the token and bot URLs', () => {
  assert.equal(redact(`fetch https://api.telegram.org/bot${TOKEN}/getUpdates failed ${TOKEN}`, TOKEN), 'fetch https://api.telegram.org/bot<token>/getUpdates failed <token>');
  assert.ok(!redact('/bot999:other/x', TOKEN).includes('999'));
});

test('topics are created per workspace, persisted and reused after a restart; with backfill 0 the history is not forwarded; text goes to the right thread', async () => {
  const s = await setup();
  const b = await startBridge(s.cfg);
  await until(() => s.j.connects() >= 2 && s.t.calls.filter((c) => c.method === 'createForumTopic').length === 2);
  assert.equal(s.t.calls.find((c) => c.method === 'createForumTopic')!.params.chat_id, CHAT);
  const [t1, t2] = [101, 102];
  s.j.text('w1', 'hello one');
  s.j.text('w2', 'hello two');
  s.j.text('w1', 'agent text', 'a1'); // not the arbiter
  s.j.emit('w1', { type: 'result', agentId: 'arbiter', text: 'hello one' }); // duplicate of the last text
  s.j.emit('w1', { type: 'ask', reqId: 'r', agentId: 'a1', tool: 'Bash', input: {} });
  await until(() => s.t.msgs(t1).length === 1 && s.t.msgs(t2).length === 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(s.t.msgs(t1), ['hello one']);
  assert.deepEqual(s.t.msgs(t2), ['hello two']);
  assert.ok(!s.t.msgs().some((m) => m.startsWith('OLD')), 'replayed history is not forwarded');
  assert.equal(JSON.parse(readFileSync(s.cfg.stateFile, 'utf8')).topics.w2, t2);
  await b.stop();

  const calls = s.t.calls.filter((c) => c.method === 'createForumTopic').length;
  const b2 = await startBridge(s.cfg); // restart: map reused, no new topics
  await until(() => s.j.connects() >= 4);
  s.j.text('w2', 'after restart');
  await until(() => s.t.msgs(t2).length === 2);
  assert.equal(s.t.calls.filter((c) => c.method === 'createForumTopic').length, calls);
  assert.equal(s.t.msgs(t2)[1], 'after restart');
  await b2.stop();
  await s.end();
});

test('a workspace that appears later gets a topic; after an SSE reconnect the replayed history is not forwarded again', async () => {
  const wss = [{ id: 'w1', name: 'One' }];
  const s = await setup(wss);
  const b = await startBridge(s.cfg);
  await until(() => s.j.connects() === 1);
  wss.push({ id: 'w3', name: 'Three' });
  await until(() => !!topicOf(s.t, 'Three') && s.j.connects() === 2);
  s.j.drop('w1');
  await until(() => s.j.connects() === 3, 10_000);
  s.j.text('w1', 'live again');
  await until(() => s.t.msgs(101).length === 1);
  assert.deepEqual(s.t.msgs(101), ['live again']);
  await b.stop();
  await s.end();
});

test('bursts merge, agent-finished notices are dropped, long text is split and sent in order', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge(s.cfg);
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  s.j.text('w1', 'first');
  s.j.text('w1', 'second');
  s.j.emit('w1', { type: 'routed', from: 'a1', to: 'arbiter', text: '[agent a1 finished, status idle]\nlong report body' });
  s.j.text('w1', '[agent a1 finished, status idle]');
  s.j.emit('w1', { type: 'routed', from: 'a1', to: 'arbiter', text: '[agent a1 cost $5.00, over $4]\nnot forwarded' });
  await until(() => s.t.msgs(101).length === 1);
  assert.equal(s.t.msgs(101)[0], 'first\n\nsecond');
  s.j.text('w1', Array.from({ length: 100 }, (_, i) => `line ${i} ${'z'.repeat(90)}`).join('\n'));
  await until(() => s.t.msgs(101).length === 4);
  const parts = s.t.msgs(101).slice(1);
  assert.ok(parts.every((p) => p.length <= 4096));
  assert.ok(parts.join('\n').includes('line 99 '));
  assert.ok(s.t.calls.filter((c) => c.method === 'sendMessage').every((c) => c.params.parse_mode === 'HTML'));
  await b.stop();
  await s.end();
});

test('a 429 waits retry_after and sends the same text again', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge(s.cfg);
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  s.t.failNext.push({ code: 429, retry: 1 });
  const t0 = Date.now();
  s.j.text('w1', 'throttled');
  await until(() => s.t.msgs(101).length === 2);
  assert.deepEqual(s.t.msgs(101), ['throttled', 'throttled']);
  assert.ok(Date.now() - t0 >= 1000);
  await b.stop();
  await s.end();
});

test('inbound: only the allowed user in the allowed chat reaches /say, routed by thread id', async () => {
  const s = await setup();
  const b = await startBridge(s.cfg);
  await until(() => s.j.connects() === 2 && !!topicOf(s.t, 'Two'));
  const u = s.t.updates, m = s.t.msg;
  u.push(m('wrong user', { message_thread_id: 101, from: { id: 999 } }));
  u.push(m('wrong chat', { message_thread_id: 101, chat: { id: -5 } }));
  u.push(m('anonymous admin', { message_thread_id: 101, sender_chat: { id: CHAT } }));
  u.push(m('unknown topic', { message_thread_id: 555 }));
  u.push(m('no topic'));
  u.push(m('to one', { message_thread_id: 101 }));
  u.push(m('to two', { message_thread_id: 102 }));
  await until(() => s.j.says.length === 2);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(s.j.says.map((x) => x.body), [{ ws: 'w1', text: 'to one' }, { ws: 'w2', text: 'to two' }]);
  assert.ok(s.j.says.every((x) => x.origin === s.cfg.jarvis && x.type === 'application/json'));
  assert.deepEqual(s.t.msgs(), [], 'nothing answered to a dropped message');
  const polls = s.t.calls.filter((c) => c.method === 'getUpdates');
  assert.ok(polls.every((c) => c.params.timeout === 50 && JSON.stringify(c.params.allowed_updates) === '["message"]'));

  u.push(m('/help'));
  await until(() => s.t.msgs().length === 1);
  assert.match(s.t.msgs()[0], /One\n• Two/);
  assert.equal(s.t.calls.find((c) => c.method === 'sendMessage')!.params.message_thread_id, undefined);
  assert.equal(JSON.parse(readFileSync(s.cfg.stateFile, 'utf8')).offset, u.length + 1, 'offset persisted');
  await b.stop();
  await s.end();
});

test('👀 reaction after a successful /say with the ids of the message; none when /say fails or the message is dropped', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge(s.cfg);
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  const reactions = () => s.t.calls.filter((c) => c.method === 'setMessageReaction');
  s.t.updates.push(s.t.msg('wrong user', { message_thread_id: 101, from: { id: 999 } }));
  s.t.updates.push(s.t.msg('hi', { message_thread_id: 101, message_id: 77 }));
  await until(() => reactions().length === 1);
  assert.deepEqual(reactions()[0].params, { chat_id: CHAT, message_id: 77, reaction: [{ type: 'emoji', emoji: '👀' }] });
  assert.deepEqual(s.t.msgs(), [], 'the reaction is not a message');

  const open = s.j.hold(); // /say still pending: no reaction yet
  s.t.updates.push(s.t.msg('slow', { message_thread_id: 101, message_id: 78 }));
  await until(() => s.j.says.length === 2);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(reactions().length, 1);
  open();
  await until(() => reactions().length === 2);

  s.j.failSay = true;
  s.t.updates.push(s.t.msg('refused', { message_thread_id: 101, message_id: 79 }));
  await until(() => s.t.msgs(101).includes('Jarvis did not take the message.'));
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(reactions().map((c) => c.params.message_id), [77, 78]);
  await b.stop();
  await s.end();
});

test('a failing setMessageReaction is logged once per kind and does not break forwarding or stopping', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
  try {
    const b = await startBridge(s.cfg);
    await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
    const rc = () => s.t.calls.filter((c) => c.method === 'setMessageReaction').length;
    for (let i = 0; i < 3; i++) s.t.failNext.push({ method: 'setMessageReaction', code: 400, description: `Bad Request: REACTION_INVALID bot${TOKEN}` });
    for (const id of [1, 2, 3]) s.t.updates.push(s.t.msg(`m${id}`, { message_thread_id: 101, message_id: id }));
    await until(() => rc() === 3);
    s.t.failNext.push({ method: 'setMessageReaction', code: 429, retry: 1 });
    s.t.updates.push(s.t.msg('m4', { message_thread_id: 101, message_id: 4 }));
    await until(() => rc() === 4);
    assert.equal(s.j.says.length, 4, 'every message reached Jarvis');
    await until(() => logs.filter((l) => l.startsWith('reaction failed')).length === 2);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(logs.filter((l) => l.startsWith('reaction failed')).length, 2, 'one line per kind: 400 and 429');
    assert.ok(!logs.some((l) => l.includes(TOKEN)));
    s.j.text('w1', 'still forwarded');
    await until(() => s.t.msgs(101).includes('still forwarded'));
    s.t.failNext.push({ method: 'setMessageReaction', code: 0, drop: true, delayMs: 0 });
    s.t.updates.push(s.t.msg('m5', { message_thread_id: 101, message_id: 5 }));
    await until(() => rc() === 5);
    await b.stop(); // returns: nothing keeps the process alive
  } finally { console.error = orig; }
  await s.end();
});

test('errors never show the token', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
  try {
    const b = await startBridge({ ...s.cfg, api: `http://127.0.0.1:1` }).catch((e) => e);
    logs.push(String((b as Error).message));
    const ok = await startBridge(s.cfg);
    await until(() => !!topicOf(s.t, 'One'));
    s.t.failNext.push({ code: 400, description: `Bad Request: bot${TOKEN} is odd` });
    s.j.text('w1', 'x');
    await until(() => logs.some((l) => l.includes('send failed')));
    await ok.stop();
  } finally { console.error = orig; }
  assert.ok(logs.length >= 2);
  assert.ok(!logs.join('\n').includes(TOKEN) && !logs.join('\n').includes('FAKE-token'), logs.join('\n'));
  await s.end();
});

test('--pair returns the ids of the message, asks getChat about Topics and sends nothing', async () => {
  const s = await setup();
  s.t.updates.push(s.t.msg('hi', { chat: { id: -77 }, from: { id: 42 } }));
  assert.deepEqual(await pair({ ...s.cfg, user: 0, chat: 0 }), { chat: -77, type: undefined, title: undefined, from: 42, username: undefined, firstName: undefined, senderChat: false, forum: true });
  assert.deepEqual(s.t.calls.map((c) => c.method), ['getUpdates', 'getChat']);
  assert.deepEqual(s.t.calls[1].params, { chat_id: -77 });
  await s.end();
});

test('--pair takes the newest message and prefers a supergroup over the dead id of the basic group it came from', async () => {
  const s = await setup();
  const u = s.t.updates, m = s.t.msg;
  u.push(m('before Topics', { chat: { id: -1001, type: 'group', title: 'G' }, from: { id: 42 } }));
  u.push(m('after Topics', { chat: { id: -1009100222, type: 'supergroup', title: 'G' }, from: { id: 42 } }));
  u.push(m('in a private chat', { chat: { id: 42, type: 'private' }, from: { id: 42 } }));
  assert.equal((await pair({ ...s.cfg, user: 0, chat: 0 })).chat, -1009100222);
  u.length = 0;
  u.push(m('old', { chat: { id: -1001, type: 'group' }, from: { id: 42 } }));
  u.push(m('newer', { chat: { id: -1002, type: 'group' }, from: { id: 42 } }));
  assert.equal((await pair({ ...s.cfg, user: 0, chat: 0 })).chat, -1002, 'without a supergroup the newest one');
  await s.end();
});

test('--pair warns when the chat is no supergroup or has no Topics; a failed getChat leaves it unchecked', async () => {
  const s = await setup(undefined, { forum: false });
  s.t.updates.push(s.t.msg('hi', { chat: { id: -1009100222, type: 'supergroup' }, from: { id: 42 } }));
  const p = await pair({ ...s.cfg, user: 0, chat: 0 });
  assert.equal(p.forum, false);
  assert.match(describePair(p), /Topics is off/);
  assert.match(describePair({ chat: -1001, type: 'group', from: 42 }), /not a supergroup/);
  s.t.failNext.push({ method: 'getChat', code: 400, description: 'Bad Request: chat not found' });
  assert.equal((await pair({ ...s.cfg, user: 0, chat: 0 })).forum, undefined);
  await s.end();
});

test('a chat id that was migrated to a supergroup stops the start with a clear message and no token', async () => {
  const s = await setup();
  s.t.failNext.push({ method: 'getChat', code: 400, description: `Bad Request: group chat was upgraded to a supergroup chat bot${TOKEN}`, migrate: -1009100222 });
  const err = await startBridge(s.cfg).then(() => new Error('started'), (e) => e as Error);
  assert.match(err.message, /upgraded to a supergroup.*--pair/);
  assert.ok(!err.message.includes(TOKEN) && !err.message.includes('1009100222'));
  assert.equal(s.t.calls.filter((c) => c.method === 'getUpdates').length, 0);
  assert.ok(!existsSync(`${s.cfg.stateFile}.lock`), 'lock released');
  await s.end();
});

test('real server with the fake SDK: the arbiter text of a workspace arrives in its topic; a Telegram message reaches the arbiter', async () => {
  const probe = createServer(); const port = await listen(probe); probe.close();
  const data = mkdtempSync(join(tmp, 'data-'));
  const server = spawn(process.execPath, ['src/server.ts'], { env: { ...process.env, PORT: String(port), XDG_DATA_HOME: data, JARVIS_FAKE_SDK: resolve('e2e/fake-sdk.ts'), JARVIS_ENV_FILE: '/dev/null', JARVIS_TMPGUARD: '0', JARVIS_HEALTH_PROBE: '0', JARVIS_PLAYWRIGHT: '0', JARVIS_STATUS_URL: 'http://127.0.0.1:1/', JARVIS_PROVIDERS_DIR: join(data, 'providers') }, stdio: 'ignore' });
  extras.push(() => server.kill());
  const origin = `http://127.0.0.1:${port}`;
  const post = (p: string, b: object) => fetch(origin + p, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(b) });
  try {
    for (let i = 0; i < 300; i++) { if (await fetch(origin + '/workspaces').then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 100)); }
    const ws: any = await (await post('/workspaces', { name: 'Live one' })).json();
    const t = fakeTelegram();
    const tp = await listen(t.server);
    const cfg: Cfg = { token: TOKEN, user: USER, chat: CHAT, jarvis: origin, api: `http://127.0.0.1:${tp}`, stateFile: join(tmp, 'real-state.json'), debounceMs: 50, syncMs: 100, gapMs: 0, backfill: 0 };
    const b = await startBridge(cfg);
    await until(() => !!topicOf(t, 'Live one'));
    await new Promise((r) => setTimeout(r, 300)); // reader is past `ready`
    t.updates.push(t.msg('say from telegram', { message_thread_id: 101 }));
    await until(() => t.msgs(101).length >= 1, 15_000);
    assert.ok(t.msgs(101).join('\n').includes('from telegram')); // the fake SDK runs the message as a script: `say X` says X
    await b.stop();
    t.server.closeAllConnections(); t.server.close();
    assert.ok(ws.id);
  } finally { server.kill(); }
});

test('config: Jarvis must be loopback, Telegram https unless loopback', () => {
  const base = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER: '1', TELEGRAM_CHAT_ID: '-1' };
  for (const u of ['http://192.168.1.5:7777', 'http://example.com', 'ftp://127.0.0.1', 'nonsense']) assert.throws(() => configFromEnv({ ...base, JARVIS_URL: u }), /JARVIS_URL/, u);
  for (const u of ['http://localhost:7777/', 'http://[::1]:7777', 'http://127.0.0.1:1']) assert.ok(configFromEnv({ ...base, JARVIS_URL: u }).jarvis);
  assert.throws(() => configFromEnv({ ...base, TELEGRAM_API_BASE: 'http://api.example.com' }), /https/);
  assert.equal(configFromEnv({ ...base, TELEGRAM_API_BASE: 'https://x.example/' }).api, 'https://x.example');
  assert.equal(configFromEnv({ ...base, TELEGRAM_API_BASE: 'http://127.0.0.1:9' }).api, 'http://127.0.0.1:9');
});

test('split never cuts a surrogate pair; redact with an empty token leaves the text', () => {
  const text = 'a'.repeat(4095) + '\u{1F600}'.repeat(3);
  const parts = split(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every((p) => !/[\ud800-\udbff]$/.test(p) && !/^[\udc00-\udfff]/.test(p) && p.length <= 4096));
  assert.equal(redact('keep this /bot123:abc/x', ''), 'keep this /bot<token>/x');
});

test('the offset is saved before an update is handled', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge(s.cfg);
  await until(() => !!topicOf(s.t, 'One'));
  const open = s.j.hold();
  s.t.updates.push(s.t.msg('slow', { message_thread_id: 101 }));
  await until(() => s.j.says.length === 1); // /say is pending, the handler has not finished
  assert.equal(JSON.parse(readFileSync(s.cfg.stateFile, 'utf8')).offset, 2);
  open();
  await b.stop();
  await s.end();
});

test('a second bridge on the same state file refuses to start; a stale lock is taken over', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge(s.cfg);
  await assert.rejects(startBridge(s.cfg), /another telegram bridge is running/);
  await b.stop();
  assert.ok(!existsSync(`${s.cfg.stateFile}.lock`), 'lock removed on stop');
  const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
  writeFileSync(`${s.cfg.stateFile}.lock`, String(dead));
  const b2 = await startBridge(s.cfg);
  assert.equal(readFileSync(`${s.cfg.stateFile}.lock`, 'utf8'), String(process.pid));
  await b2.stop();
  await s.end();
});

test('a bad token (401) ends the bridge at once', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  s.t.failNext.push({ code: 401, method: 'getUpdates', description: 'nope' });
  const b = await startBridge(s.cfg);
  await assert.rejects(b.done, /getUpdates: 401/);
  assert.ok(!existsSync(`${s.cfg.stateFile}.lock`));
  await s.end();
});

test('409 from getUpdates is retried for a while (the old poll of a restarted bridge), and ends the bridge when it stays', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  for (let i = 0; i < 4; i++) s.t.failNext.push({ code: 409, method: 'getUpdates', description: 'Conflict: terminated by other getUpdates request' });
  const b = await startBridge({ ...s.cfg, conflictMs: 4500 });
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  s.t.updates.push(s.t.msg('after the conflict', { message_thread_id: 101 }));
  await until(() => s.j.says.length === 1); // polling went on after four 409s
  await b.stop();

  const s2 = await setup([{ id: 'w1', name: 'One' }]);
  for (let i = 0; i < 100; i++) s2.t.failNext.push({ code: 409, method: 'getUpdates', description: 'Conflict' });
  const b2 = await startBridge({ ...s2.cfg, conflictMs: 300 });
  await assert.rejects(b2.done, /getUpdates: 409 Conflict \(for more than 0 s: another program polls this bot/);
  assert.ok(!existsSync(`${s2.cfg.stateFile}.lock`));
  await s.end(); await s2.end();
});

test('one failing workspace does not stop the topics of the others; 429 on createForumTopic waits retry_after', async () => {
  const s = await setup();
  s.t.failNext.push({ code: 400, method: 'createForumTopic', description: 'Bad Request: nope' });
  const b = await startBridge(s.cfg);
  await until(() => !!topicOf(s.t, 'Two'));
  assert.equal(s.t.calls.filter((c) => c.method === 'createForumTopic')[1].params.name, 'Two', 'second workspace was tried in the same pass');
  await until(() => s.t.calls.filter((c) => c.method === 'createForumTopic' && c.params.name === 'One').length === 2); // retried by the next pass
  await b.stop();
  const s2 = await setup([{ id: 'w1', name: 'One' }]);
  s2.t.failNext.push({ code: 429, retry: 1, method: 'createForumTopic' });
  const t0 = Date.now();
  const b2 = await startBridge(s2.cfg);
  await until(() => s2.t.calls.filter((c) => c.method === 'createForumTopic').length === 2);
  assert.ok(Date.now() - t0 >= 1000);
  await b2.stop();
  await s.end(); await s2.end();
});

test('a send that keeps failing is logged as failed; keepalive comments are skipped', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
  try {
    const b = await startBridge({ ...s.cfg, retryTotalMs: 2500 });
    await until(() => !!topicOf(s.t, 'One') && s.j.connects() === 1);
    s.j.ping('w1');
    for (let i = 0; i < 5; i++) s.t.failNext.push({ code: 429, retry: 1 });
    s.j.text('w1', 'never arrives');
    await until(() => logs.some((l) => l.includes('send failed: sendMessage: 429')), 15_000);
    assert.equal(s.t.msgs(101).length, 3, 'the retry time ran out');
    s.t.failNext.length = 0;
    s.j.text('w1', 'arrives');
    await until(() => s.t.msgs(101).length === 4);
    assert.equal(s.t.msgs(101)[3], 'arrives');
    await b.stop();
  } finally { console.error = orig; }
  await s.end();
});

test('forwarded and via-bot messages are dropped', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge(s.cfg);
  await until(() => !!topicOf(s.t, 'One'));
  const m = s.t.msg;
  s.t.updates.push(m('fwd', { message_thread_id: 101, forward_origin: { type: 'user' }, forward_date: 1 }));
  s.t.updates.push(m('bot', { message_thread_id: 101, via_bot: { id: 5 } }));
  s.t.updates.push(m('mine', { message_thread_id: 101 }));
  await until(() => s.j.says.length === 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(s.j.says.map((x) => x.body.text), ['mine']);
  await b.stop();
  await s.end();
});

test('--pair shows who wrote and warns about an anonymous admin or a private chat', () => {
  const group = describePair({ chat: -5, type: 'supergroup', title: 'Jarvis', from: 7, username: 'al', firstName: 'Al', senderChat: false, forum: true });
  assert.match(group, /chat id: -5 \(supergroup, "Jarvis"\)/);
  assert.match(group, /sender id: 7 \(Al @al\)/);
  assert.ok(!group.includes('WARNING'));
  assert.match(describePair({ chat: -5, type: 'supergroup', from: 136817688, senderChat: true }), /anonymous admin/);
  assert.match(describePair({ chat: 7, type: 'private', from: 7 }), /not the group/);
});

const lines = (t: ReturnType<typeof fakeTelegram>, th = 101) => t.msgs(th).flatMap((m) => m.split('\n\n'));
const stateOf = (cfg: Cfg) => JSON.parse(readFileSync(cfg.stateFile, 'utf8'));

test('a restart forwards only what happened while the bridge was down, once; a reconnect repeats nothing', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge(s.cfg);
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  s.j.text('w1', 'one');
  s.j.text('w1', 'two');
  await until(() => s.t.msgs(101).length === 1);
  await b.stop();
  s.j.text('w1', 'missed a');
  s.j.text('w1', 'missed b');
  const b2 = await startBridge(s.cfg);
  await until(() => s.t.msgs(101).length === 2);
  assert.deepEqual(lines(s.t), ['one', 'two', 'missed a', 'missed b']);
  s.j.drop('w1'); // reconnect: the whole history is replayed again
  await until(() => s.j.connects() === 3, 10_000);
  s.j.text('w1', 'after reconnect');
  await until(() => s.t.msgs(101).length === 3);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(lines(s.t), ['one', 'two', 'missed a', 'missed b', 'after reconnect']);
  await b2.stop();
  await s.end();
});

test('events that share one millisecond are neither repeated nor lost', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge(s.cfg);
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  s.j.text('w1', 'a', 'arbiter', 500);
  s.j.text('w1', 'b', 'arbiter', 500);
  await until(() => s.t.msgs(101).length === 1);
  await b.stop();
  s.j.text('w1', 'c', 'arbiter', 500); // written while down, same `at` as the two done
  s.j.text('w1', 'd', 'arbiter', 501);
  const b2 = await startBridge(s.cfg);
  await until(() => s.t.msgs(101).length === 2);
  assert.deepEqual(lines(s.t), ['a', 'b', 'c', 'd']);
  await b2.stop();
  await s.end();
});

test('the first run forwards the last N events: N, 0 and all', async () => {
  for (const [backfill, expected] of [[2, ['e3', 'e4']], [0, []], [Infinity, ['OLD w1', 'e1', 'e2', 'e3', 'e4']]] as [number, string[]][]) {
    const s = await setup([{ id: 'w1', name: 'One' }]);
    for (const t of ['e1', 'e2', 'e3', 'e4']) s.j.text('w1', t);
    const b = await startBridge({ ...s.cfg, backfill });
    await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
    s.j.text('w1', 'live');
    await until(() => lines(s.t).includes('live'));
    assert.deepEqual(lines(s.t).filter((l) => l !== 'live'), expected, `backfill ${backfill}`);
    await b.stop();
    await s.end();
  }
});

test('TELEGRAM_BACKFILL: default 10, a number, 0 or all; garbage is rejected', () => {
  const base = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER: '1', TELEGRAM_CHAT_ID: '-1' };
  assert.equal(configFromEnv(base).backfill, 10);
  assert.equal(configFromEnv(base).gapMs, 3000, 'Telegram allows about 20 messages a minute in a group');
  assert.equal(configFromEnv({ ...base, TELEGRAM_BACKFILL: '3' }).backfill, 3);
  assert.equal(configFromEnv({ ...base, TELEGRAM_BACKFILL: '0' }).backfill, 0);
  assert.equal(configFromEnv({ ...base, TELEGRAM_BACKFILL: 'all' }).backfill, Infinity);
  for (const v of ['-1', 'ten', '1.5', '99999999', '1e3']) assert.throws(() => configFromEnv({ ...base, TELEGRAM_BACKFILL: v }), /TELEGRAM_BACKFILL/, v);
});

test('the cursor is saved before the text is queued', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge({ ...s.cfg, debounceMs: 60_000 }); // the text stays queued
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  s.j.text('w1', 'not sent yet', 'arbiter', 900);
  await until(() => stateOf(s.cfg).cursors.w1?.at === 900);
  assert.equal(s.t.msgs(101).length, 0);
  await b.stop();
  await s.end();
});

test('stop sends the text that still waits for its debounce, and gives up after the drain time', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge({ ...s.cfg, debounceMs: 60_000 });
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  s.j.text('w1', 'last words');
  await until(() => stateOf(s.cfg).cursors.w1?.skip === 1 && JSON.stringify(stateOf(s.cfg).cursors.w1).includes('"at"') && stateOf(s.cfg).cursors.w1.at > 1);
  assert.equal(s.t.msgs(101).length, 0);
  await b.stop();
  assert.deepEqual(s.t.msgs(101), ['last words']);

  const s2 = await setup([{ id: 'w1', name: 'One' }]);
  const b2 = await startBridge({ ...s2.cfg, debounceMs: 60_000, drainMs: 300 });
  await until(() => s2.j.connects() === 1 && !!topicOf(s2.t, 'One'));
  s2.t.failNext.push({ code: 429, retry: 30 }); // Telegram asks for 30 s
  s2.j.text('w1', 'never sent');
  await until(() => stateOf(s2.cfg).cursors.w1?.at > 1);
  const t0 = Date.now();
  await b2.stop();
  assert.ok(Date.now() - t0 < 3000, 'stop did not wait for retry_after');
  await s.end(); await s2.end();
});

test('a failing chunk for an old topic does not drop the topic that replaced it', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge(s.cfg);
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  s.t.failNext.push({ code: 400, description: 'Bad Request: message thread not found' }); // first piece: topic gone
  s.t.failNext.push({ code: 400, description: 'Bad Request: message thread not found', delayMs: 500 }); // second piece fails late, after the sync made topic 102
  s.j.text('w1', `${'a'.repeat(3000)}\n${'b'.repeat(3000)}`);
  await until(() => s.t.calls.filter((c) => c.method === 'createForumTopic').length === 2);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(stateOf(s.cfg).topics.w1, 102);
  assert.equal(s.t.calls.filter((c) => c.method === 'createForumTopic').length, 2);
  await b.stop();
  await s.end();
});

test('a workspace that stays away for several syncs loses its topic and cursor; one missing answer does not', async () => {
  const wss = [{ id: 'w1', name: 'One' }, { id: 'w2', name: 'Two' }];
  const s = await setup(wss);
  const b = await startBridge({ ...s.cfg, syncMs: 200 });
  await until(() => s.j.connects() === 2 && !!topicOf(s.t, 'Two'));
  s.j.text('w2', 'hi');
  await until(() => stateOf(s.cfg).cursors.w2?.at > 1);
  wss.pop();
  await new Promise((r) => setTimeout(r, 250)); // one sync without Two
  wss.push({ id: 'w2', name: 'Two' });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(stateOf(s.cfg).topics.w2, 102, 'kept');
  assert.equal(s.t.calls.filter((c) => c.method === 'createForumTopic' && c.params.name === 'Two').length, 1);
  wss.pop();
  await until(() => stateOf(s.cfg).topics.w2 === undefined);
  const st = stateOf(s.cfg);
  assert.ok(st.topics.w1 && !st.cursors.w2);
  s.t.updates.push(s.t.msg('/help'));
  const help = () => s.t.calls.filter((c) => c.method === 'sendMessage' && c.params.message_thread_id === undefined).map((c) => c.params.text as string);
  await until(() => help().length === 1);
  assert.match(help()[0], /• One/);
  assert.ok(!help()[0].includes('Two'));
  await b.stop();
  await s.end();
});

test('the cursor never moves back: an older live event is dropped', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge(s.cfg);
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  s.j.text('w1', 'now', 'arbiter', 1000);
  await until(() => s.t.msgs(101).length === 1);
  s.j.text('w1', 'from the past', 'arbiter', 400);
  s.j.text('w1', 'next', 'arbiter', 1001);
  await until(() => s.t.msgs(101).length === 2);
  assert.deepEqual(lines(s.t), ['now', 'next']);
  assert.equal(stateOf(s.cfg).cursors.w1.at, 1001);
  await b.stop();
  await s.end();
});

test('the state file is private', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge(s.cfg);
  await until(() => !!topicOf(s.t, 'One'));
  assert.equal(statSync(s.cfg.stateFile).mode & 0o777, 0o600);
  await b.stop();
  await s.end();
});

test('what the user typed is not forwarded; a Telegram message goes straight to /say, past a busy send queue', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge({ ...s.cfg, gapMs: 3000 });
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  s.j.emit('w1', { type: 'routed', from: 'user', to: 'arbiter', text: 'typed in the web' });
  s.j.emit('w1', { type: 'routed', from: 'user', to: 'arbiter', text: '[agent a1 finished, typed by a user]' });
  s.j.text('w1', 'answer');
  await until(() => s.t.msgs(101).length === 1);
  s.j.text('w1', 'waits for the 3 s gap');
  await new Promise((r) => setTimeout(r, 200));
  s.t.updates.push(s.t.msg('typed in telegram', { message_thread_id: 101 }));
  await until(() => s.j.says.length === 1, 1000);
  assert.deepEqual(s.t.msgs(101), ['answer']);
  assert.ok(!JSON.stringify(s.t.calls).includes('typed in'), 'no user line reaches Telegram');
  assert.ok(!('said' in stateOf(s.cfg)));
  await b.stop();
  await s.end();
});

test('sends are gapMs apart', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge({ ...s.cfg, gapMs: 400 });
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  s.j.text('w1', ['a', 'b', 'c'].map((c) => c.repeat(3000)).join('\n'));
  await until(() => s.t.msgs(101).length === 3);
  const at = s.t.calls.filter((c) => c.method === 'sendMessage').map((c) => c.at);
  assert.ok(at[1] - at[0] >= 380 && at[2] - at[1] >= 380, `gaps ${at[1] - at[0]}, ${at[2] - at[1]}`);
  await b.stop();
  await s.end();
});

const threads = (t: ReturnType<typeof fakeTelegram>) => t.calls.filter((c) => c.method === 'sendMessage').map((c) => c.params.message_thread_id as number);
const big = (n: number) => Array.from({ length: n }, (_, i) => String(i).repeat(3000));

// w2 is not new: its history is done (topic 77), so only its live text goes through the queue.
const seedW2 = (s: Awaited<ReturnType<typeof setup>>) => {
  s.j.text('w2', 'old'); // the history of w2 ends at `at` 2
  writeFileSync(s.cfg.stateFile, JSON.stringify({ chat: CHAT, offset: 0, topics: { w2: 77 }, cursors: { w2: { at: 2, skip: 1 } } }));
};

test('live text goes before the backfill of another workspace', async () => {
  const s = await setup();
  seedW2(s);
  for (const t of big(4)) s.j.text('w1', t); // four chunks of backfill (the old line shares the first)
  const b = await startBridge({ ...s.cfg, gapMs: 300, backfill: Infinity });
  await until(() => threads(s.t).length === 1 && s.j.connects() === 2);
  s.j.text('w2', 'LIVE');
  await until(() => s.t.msgs(77).includes('LIVE'));
  assert.equal(threads(s.t).indexOf(77), 1, 'right after the chunk that was in flight');
  await until(() => s.t.msgs(101).length === 4, 10_000);
  await b.stop();
  await s.end();
});

test('live text of a noisy workspace does not starve another one', async () => {
  const s = await setup();
  const b = await startBridge({ ...s.cfg, gapMs: 200 });
  await until(() => s.j.connects() === 2 && !!topicOf(s.t, 'Two'));
  s.j.text('w1', big(4).join('\n')); // four chunks
  s.j.text('w2', 'short');
  await until(() => s.t.msgs(101).length === 4 && s.t.msgs(102).length === 1, 10_000);
  assert.ok(threads(s.t).indexOf(102) <= 2, threads(s.t).join());
  await b.stop();
  await s.end();
});

test('the backfills of two workspaces take turns', async () => {
  const s = await setup();
  for (const t of big(3)) { s.j.text('w1', t); s.j.text('w2', t); }
  const b = await startBridge({ ...s.cfg, gapMs: 200, backfill: Infinity });
  await until(() => s.t.msgs(101).length === 3 && s.t.msgs(102).length === 3, 10_000);
  assert.ok(threads(s.t).slice(0, 4).includes(102), threads(s.t).join());
  assert.ok(threads(s.t).slice(0, 6).filter((x) => x === 101).length <= 4);
  await b.stop();
  await s.end();
});

test('the lock file is read back after it was created: a lost race counts as taken', () => {
  const file = join(mkdtempSync(join(tmp, 'l-')), 'x.lock');
  assert.throws(() => lock(file, { afterCreate: () => writeFileSync(file, '1') }), /another telegram bridge took the lock/);
  const un = lock(`${file}2`);
  assert.ok(existsSync(`${file}2`));
  un();
  assert.ok(!existsSync(`${file}2`));
});

const sends = (t: ReturnType<typeof fakeTelegram>) => t.calls.filter((c) => c.method === 'sendMessage');
const parts = (n: number) => Array.from({ length: n }, (_, i) => String(i).repeat(3000)).join('\n'); // n parts of one message

test('a network error and a 5xx are retried with backoff, a 4xx is not', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge({ ...s.cfg, retryMs: 20 });
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  s.t.failNext.push({ code: 500, description: 'Internal Server Error' }, { code: 0, drop: true });
  s.j.text('w1', 'gets through');
  await until(() => sends(s.t).length === 3);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sends(s.t).length, 3, 'two failures and the send that worked');
  s.t.failNext.push({ code: 400, description: 'Bad Request: chat not found' });
  s.j.text('w1', 'refused');
  await until(() => sends(s.t).length === 4);
  s.j.text('w1', 'next');
  await until(() => sends(s.t).length === 5);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sends(s.t).length, 5, 'a 400 is not sent again');
  await b.stop();
  await s.end();
});

test('a send that keeps failing with 5xx is dropped after the retry time, with one log line', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
  try {
    const b = await startBridge({ ...s.cfg, retryMs: 10, retryTotalMs: 300 });
    await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
    for (let i = 0; i < 100; i++) s.t.failNext.push({ code: 502, description: 'Bad Gateway' });
    s.j.text('w1', 'lost');
    await until(() => logs.some((l) => l.includes('send failed: sendMessage: 502')));
    assert.ok(sends(s.t).length >= 3 && sends(s.t).length < 30, `${sends(s.t).length} tries`);
    s.t.failNext.length = 0;
    s.j.text('w1', 'after');
    await until(() => s.t.msgs(101).at(-1) === 'after');
    await b.stop();
  } finally { console.error = orig; }
  await s.end();
});

test('the gap also follows a send that failed', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge({ ...s.cfg, gapMs: 400 });
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  s.t.failNext.push({ code: 400, description: 'Bad Request: message is too long' });
  s.j.text('w1', parts(2)); // two parts, the first is refused
  await until(() => sends(s.t).length === 2);
  assert.ok(sends(s.t)[1].at - sends(s.t)[0].at >= 380, `gap ${sends(s.t)[1].at - sends(s.t)[0].at}`);
  await b.stop();
  await s.end();
});

test('a stop keeps the gap while it drains, and logs one line for what it had to drop', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge({ ...s.cfg, debounceMs: 60_000, gapMs: 400 });
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  s.j.text('w1', parts(3));
  await new Promise((r) => setTimeout(r, 200)); // the text is in its debounce
  await b.stop();
  const at = sends(s.t).map((c) => c.at);
  assert.equal(at.length, 3, 'drained');
  assert.ok(at[1] - at[0] >= 380 && at[2] - at[1] >= 380, 'gaps while draining');

  const s2 = await setup([{ id: 'w1', name: 'One' }]);
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
  try {
    const b2 = await startBridge({ ...s2.cfg, debounceMs: 60_000, gapMs: 400, drainMs: 250 });
    await until(() => s2.j.connects() === 1 && !!topicOf(s2.t, 'One'));
    s2.j.text('w1', parts(4));
    await new Promise((r) => setTimeout(r, 200));
    await b2.stop();
  } finally { console.error = orig; }
  assert.equal(sends(s2.t).length, 1);
  assert.deepEqual(logs.filter((l) => /not sent/.test(l)), ['3 queued message part(s) not sent: the bridge stopped']);
  assert.ok(!logs.some((l) => l.includes('send failed')));
});

test('a stale lock is taken over atomically: a copy that took it meanwhile keeps it', () => {
  const dir = mkdtempSync(join(tmp, 'l-'));
  const file = join(dir, 'y.lock');
  const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
  writeFileSync(file, String(dead));
  assert.throws(() => lock(file, { afterRead: () => writeFileSync(file, String(process.ppid)) }), /another telegram bridge took the lock/);
  assert.equal(readFileSync(file, 'utf8'), String(process.ppid), 'the live copy still holds the file');
  assert.deepEqual(readdirSync(dir), ['y.lock'], 'no file left behind');
  writeFileSync(file, String(dead));
  const un = lock(file);
  assert.equal(readFileSync(file, 'utf8'), String(process.pid));
  un();
});

test('while a workspace has backfill waiting, its live text queues behind it; other workspaces still go first', async () => {
  const s = await setup();
  seedW2(s);
  for (const t of big(3)) s.j.text('w1', t); // three chunks of backfill (the old line shares the first)
  const b = await startBridge({ ...s.cfg, gapMs: 300, backfill: Infinity });
  await until(() => s.j.connects() === 2 && s.t.msgs(101).length === 1);
  s.j.text('w1', 'LIVE');
  s.j.text('w2', 'LIVE2');
  await until(() => s.t.msgs(101).length === 4 && s.t.msgs(77).includes('LIVE2'), 10_000);
  assert.equal(s.t.msgs(101).at(-1), 'LIVE', 'after its own backfill');
  assert.equal(sends(s.t).findIndex((c) => c.params.text === 'LIVE2'), 1, 'before the rest of the backfill');
  await b.stop();
  await s.end();
});

test('a state file with fields the bridge does not know loads, and they are not written back', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  writeFileSync(s.cfg.stateFile, JSON.stringify({ chat: CHAT, offset: 5, topics: { w1: 101 }, cursors: {}, said: { w1: ['abc'] }, future: 1 }));
  const b = await startBridge(s.cfg);
  await until(() => s.j.connects() === 1 && !!stateOf(s.cfg).cursors.w1);
  assert.equal(s.t.calls.filter((c) => c.method === 'createForumTopic').length, 0, 'topic reused');
  const st = stateOf(s.cfg);
  assert.ok(st.offset >= 5 && st.topics.w1 === 101 && !('said' in st) && !('future' in st));
  await b.stop();
  await s.end();
});

const calls = (t: ReturnType<typeof fakeTelegram>, m: string) => t.calls.filter((c) => c.method === m);
const fail = (t: ReturnType<typeof fakeTelegram>, method: string, description = 'Bad Request: x') => t.failNext.push({ code: 400, method, description });

test('an archived event removes the topic at once, long before the next sync', async () => {
  const wss = [{ id: 'w1', name: 'One' }, { id: 'w2', name: 'Two' }];
  const archived: { id: string }[] = [];
  const s = await setup(wss, { archived });
  const b = await startBridge({ ...s.cfg, syncMs: 600_000 });
  await until(() => s.j.connects() === 2 && !!topicOf(s.t, 'Two'));
  wss.shift(); archived.push({ id: 'w1' });
  s.j.emit('w1', { type: 'archived' });
  await until(() => calls(s.t, 'deleteForumTopic').length === 1, 5000);
  assert.deepEqual(calls(s.t, 'deleteForumTopic')[0].params, { chat_id: CHAT, message_thread_id: 101 });
  await until(() => !stateOf(s.cfg).pending.w1 && stateOf(s.cfg).topics.w1 === undefined);
  assert.equal(stateOf(s.cfg).topics.w2, 102, 'the other topic stays');
  await b.stop();
  await s.end();
});

test('without an event the sync still removes the topic; delete falls back to close; a workspace without a topic makes no call', async () => {
  const wss = [{ id: 'w1', name: 'One' }, { id: 'w2', name: 'Two' }];
  const archived: { id: string }[] = [{ id: 'never-had-a-topic' }];
  const s = await setup(wss, { archived });
  const b = await startBridge(s.cfg);
  await until(() => !!topicOf(s.t, 'Two'));
  assert.equal(calls(s.t, 'deleteForumTopic').length, 0);
  fail(s.t, 'deleteForumTopic', 'Bad Request: not enough rights');
  wss.shift(); archived.push({ id: 'w1' });
  await until(() => calls(s.t, 'closeForumTopic').length === 1);
  assert.equal(calls(s.t, 'closeForumTopic')[0].params.message_thread_id, 101);
  await until(() => !stateOf(s.cfg).pending.w1);
  assert.equal(calls(s.t, 'deleteForumTopic').length, 1, 'only w1');
  await b.stop();
  await s.end();
});

test('a topic that cannot be removed stays pending in the state file, is retried after a restart and with backoff, and a gone topic ends it', async () => {
  const wss = [{ id: 'w1', name: 'One' }];
  const archived: { id: string }[] = [];
  const s = await setup(wss, { archived });
  const b = await startBridge(s.cfg);
  await until(() => !!topicOf(s.t, 'One'));
  fail(s.t, 'deleteForumTopic'); fail(s.t, 'closeForumTopic');
  wss.shift(); archived.push({ id: 'w1' });
  await until(() => stateOf(s.cfg).pending.w1?.tries === 1);
  assert.equal(stateOf(s.cfg).pending.w1.thread, 101);
  assert.equal(stateOf(s.cfg).topics.w1, undefined);
  await b.stop();
  const b2 = await startBridge({ ...s.cfg, syncMs: 50 });
  await until(() => !stateOf(s.cfg).pending.w1);
  assert.equal(calls(s.t, 'deleteForumTopic').length, 2);
  assert.equal(calls(s.t, 'closeForumTopic').length, 1);
  await b2.stop();
  // Telegram reports the topic gone: nothing more to do
  const s2 = await setup([{ id: 'w1', name: 'One' }], { archived: [{ id: 'w1' }], state: s.cfg.stateFile.replace('state.json', 'x.json') });
  writeFileSync(s2.cfg.stateFile, JSON.stringify({ chat: CHAT, offset: 0, topics: {}, cursors: {}, pending: { w1: { thread: 7, tries: 0, next: 0 } } }));
  fail(s2.t, 'deleteForumTopic', 'Bad Request: message thread not found');
  const b3 = await startBridge(s2.cfg);
  await until(() => !stateOf(s2.cfg).pending.w1);
  assert.equal(calls(s2.t, 'closeForumTopic').length, 0);
  await b3.stop();
  await s2.end();
  await s.end();
});

test('kicks during a running sync merge into one more run', async () => {
  const wss = [{ id: 'w1', name: 'One' }, { id: 'w2', name: 'Two' }];
  const archived: { id: string }[] = [];
  const s = await setup(wss, { archived });
  const b = await startBridge({ ...s.cfg, syncMs: 600_000 });
  await until(() => s.j.connects() === 2 && !!topicOf(s.t, 'Two') && s.j.lists() === 1);
  s.t.slow.deleteForumTopic = 500;
  wss.shift(); archived.push({ id: 'w1' });
  s.j.emit('w1', { type: 'archived' });
  await until(() => calls(s.t, 'deleteForumTopic').length === 1);
  for (let i = 0; i < 3; i++) s.j.emit('w2', { type: 'archived' }); // w1's reader is gone with its topic; w2's stream is the sync is still waiting for Telegram
  await until(() => s.j.lists() === 3);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(s.j.lists(), 3, 'three kicks, one more run');
  await b.stop();
  await s.end();
});

test('429 and a network error on delete are retried as a delete, never closed; a rights error closes', async () => {
  const wss = [{ id: 'w1', name: 'One' }];
  const archived: { id: string }[] = [];
  const s = await setup(wss, { archived });
  const b = await startBridge({ ...s.cfg, syncMs: 50 });
  await until(() => !!topicOf(s.t, 'One'));
  s.t.failNext.push({ code: 429, retry: 1, method: 'deleteForumTopic' }, { code: 0, drop: true, method: 'deleteForumTopic' });
  wss.shift(); archived.push({ id: 'w1' });
  await until(() => !stateOf(s.cfg).pending.w1 && stateOf(s.cfg).topics.w1 === undefined, 10_000);
  assert.equal(calls(s.t, 'deleteForumTopic').length, 3);
  assert.equal(calls(s.t, 'closeForumTopic').length, 0);
  await b.stop();
  await s.end();
});

test('an archived event for a workspace that is live again keeps its topic; a pending entry without a thread is dropped at load', async () => {
  const wss = [{ id: 'w1', name: 'One' }];
  const s = await setup(wss, { archived: [] });
  writeFileSync(s.cfg.stateFile, JSON.stringify({ chat: CHAT, offset: 0, topics: {}, cursors: {}, pending: { bad: { tries: 1 }, worse: 5 } }));
  const b = await startBridge({ ...s.cfg, syncMs: 600_000 });
  await until(() => !!topicOf(s.t, 'One') && s.j.lists() === 1);
  s.j.emit('w1', { type: 'archived' }); // archived, then restored before the sync ran: it is in the live list
  await until(() => s.j.lists() === 2);
  assert.equal(calls(s.t, 'deleteForumTopic').length, 0);
  assert.equal(stateOf(s.cfg).topics.w1, 101);
  assert.deepEqual(stateOf(s.cfg).pending, {});
  await b.stop();
  await s.end();
});

test('stopping the bridge during a delete logs nothing and does not close the topic', async () => {
  const wss = [{ id: 'w1', name: 'One' }];
  const archived: { id: string }[] = [];
  const s = await setup(wss, { archived });
  const b = await startBridge({ ...s.cfg, syncMs: 600_000 });
  await until(() => !!topicOf(s.t, 'One'));
  s.t.slow.deleteForumTopic = 2000;
  const errs: string[] = [], orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  try {
    wss.shift(); archived.push({ id: 'w1' });
    s.j.emit('w1', { type: 'archived' });
    await until(() => calls(s.t, 'deleteForumTopic').length === 1);
    await b.stop();
  } finally { console.error = orig; }
  assert.equal(calls(s.t, 'closeForumTopic').length, 0);
  assert.ok(!errs.some((e) => /topic of|delete topic/.test(e)), errs.join('\n'));
  assert.ok(stateOf(s.cfg).pending.w1, 'still pending for the next start');
  await s.end();
});

test('mdToHtml: escaping, code, emphasis, links, headings, lists, quotes, tables', () => {
  assert.equal(mdToHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  assert.equal(mdToHtml('**bold** *it* _it2_ ~~gone~~'), '<b>bold</b> <i>it</i> <i>it2</i> <s>gone</s>');
  assert.equal(mdToHtml('use `a<b` here'), 'use <code>a&lt;b</code> here');
  assert.equal(mdToHtml('```js\nlet a = \"**x**\" < 1;\n```'), '<pre><code class="language-js">let a = \"**x**\" &lt; 1;</code></pre>');
  assert.equal(mdToHtml('```\nplain\n```'), '<pre><code>plain</code></pre>');
  assert.equal(mdToHtml('`**not bold**` and `_x_`'), '<code>**not bold**</code> and <code>_x_</code>');
  assert.equal(mdToHtml('snake_case_word and my_var_name'), 'snake_case_word and my_var_name');
  assert.equal(mdToHtml('2 * 3 * 4 and a*b'), '2 * 3 * 4 and a*b');
  assert.equal(mdToHtml('[site](https://x.com/a?b=1&c="2")'), '<a href="https://x.com/a?b=1&amp;c=&quot;2&quot;">site</a>');
  assert.equal(mdToHtml('[bad](javascript:alert(1))'), '[bad](javascript:alert(1))');
  assert.equal(mdToHtml('[t](tg://user?id=1)'), '<a href="tg://user?id=1">t</a>');
  assert.equal(mdToHtml('see https://x.com/_a_b_ now'), 'see https://x.com/_a_b_ now');
  assert.equal(mdToHtml('# Title\n## **Sub** x'), '<b>Title</b>\n<b>Sub x</b>');
  assert.equal(mdToHtml('- one\n* two\n  - **three**'), '• one\n• two\n  • <b>three</b>');
  assert.equal(mdToHtml('> quoted <b>\n> more\nafter'), '<blockquote>quoted &lt;b&gt;\nmore</blockquote>\nafter');
  assert.equal(mdToHtml('| a | b |\n|---|---|\n| 1 | **2** |\nend'), '<pre>| a | b |\n|---|---|\n| 1 | **2** |</pre>\nend');
  // unbalanced markers stay literal
  assert.equal(mdToHtml('**open and *lone and ~~x and `tick and [t](u'), '**open and *lone and ~~x and `tick and [t](u');
  assert.equal(mdToHtml('```\nnever closed'), '```\nnever closed');
  assert.equal(mdToHtml('a\u0000b'), 'ab');
});

test('split keeps fenced code blocks whole per piece: the fence closes at a cut and reopens in the next piece', () => {
  const code = Array.from({ length: 40 }, (_, i) => `line ${i} ${'c'.repeat(50)}`).join('\n');
  const text = `intro\n\n\`\`\`py\n${code}\n\`\`\`\n\nafter`;
  const parts = split(text, 600);
  assert.ok(parts.length > 3 && parts.every((p) => p.length <= 600));
  for (const p of parts.slice(0, -1)) if (p.includes('\`\`\`py')) assert.ok(p.trimEnd().endsWith('\`\`\`'));
  const fences = (p: string) => p.split('\n').filter((l) => /^\s*\`\`\`/.test(l)).length;
  assert.ok(parts.every((p) => fences(p) % 2 === 0), 'every piece has balanced fences');
  assert.ok(parts[1].startsWith('\`\`\`py\n'));
  const lines = parts.flatMap((p) => p.split('\n')).filter((l) => /^line \d+ /.test(l));
  assert.equal(lines.length, 40, 'no code line lost or repeated');
});

test('messages go out as HTML, a long message stays under 4096 after conversion, a rejected markup is resent as plain Markdown', async () => {
  const s = await setup([{ id: 'w1', name: 'One' }]);
  const b = await startBridge(s.cfg);
  await until(() => s.j.connects() === 1 && !!topicOf(s.t, 'One'));
  s.j.text('w1', '**hi** <b> & `x`');
  await until(() => s.t.msgs(101).length === 1);
  const first = s.t.calls.find((c) => c.method === 'sendMessage')!;
  assert.equal(first.params.parse_mode, 'HTML');
  assert.equal(first.params.text, '<b>hi</b> &lt;b&gt; &amp; <code>x</code>');
  await new Promise((r) => setTimeout(r, 100));
  s.j.text('w1', ['```', ...Array.from({ length: 300 }, () => `<<<&&& ${'<'.repeat(30)}`), '```'].join('\n'));
  await until(() => s.t.msgs(101).length >= 4);
  const sent = s.t.calls.filter((c) => c.method === 'sendMessage').slice(1);
  assert.ok(sent.every((c) => c.params.text.length <= 4096), 'every converted or plain part fits');
  s.t.reject.html = true;
  const n = s.t.msgs(101).length;
  s.j.text('w1', '**raw** md');
  await until(() => s.t.msgs(101).length === n + 2);
  const [bad, ok] = s.t.calls.filter((c) => c.method === 'sendMessage').slice(-2);
  assert.equal(bad.params.parse_mode, 'HTML');
  assert.equal(ok.params.parse_mode, undefined);
  assert.equal(ok.params.text, '**raw** md');
  await b.stop();
  await s.end();
});

test('split always ends: one very long line in a fence, fence-only pieces, tiny limits; every piece fits and no text is lost', () => {
  assert.deepEqual(split('a\n```\n' + 'x'.repeat(100) + '\n```', 50).every((p) => p.length <= 50), true);
  const repro = split('a\n```\n' + 'x'.repeat(100) + '\n```', 50);
  assert.equal(repro.join('').replace(/[`\n]/g, '').replace(/^a/, '').length, 100, 'all 100 x kept');
  const bits = ['x'.repeat(130), 'y', '', '```', '```js', 'text with words', '`', '\u{1F600}'.repeat(20), '```', '  ```  '];
  let seed = 7;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let k = 0; k < 400; k++) {
    const text = Array.from({ length: 1 + rnd(12) }, () => bits[rnd(bits.length)]).join('\n');
    const limit = 12 + rnd(120);
    const parts = split(text, limit);
    assert.ok(parts.every((p) => p.length <= limit), `limit ${limit}: ${JSON.stringify(text)}`);
    const real = (x: string) => x.replace(/[`\s]|js/g, '');
    assert.equal(parts.map(real).join(''), real(text), `no content lost: ${JSON.stringify(text)}`);
  }
  assert.ok(split('```\n```', 4).length <= 1);
  assert.deepEqual(split('```js\n```', 50), [], 'a fence with nothing in it sends nothing');
  assert.doesNotThrow(() => split('```js\n' + 'z'.repeat(40), 8)); // a limit too small to keep the fence
});

test('mdToHtml: nesting, flanking, tables, bare URLs and fences', () => {
  assert.equal(mdToHtml('***x***'), '<b><i>x</i></b>');
  assert.equal(mdToHtml('**bold *it***'), '<b>bold <i>it</i></b>');
  for (const t of ['**a *b** c*', '*a **b* c**', '**a _b** c_', '~~a **b~~ c**', '***a** b*', '__a *b__ c*'])
    assert.ok(wellFormed(mdToHtml(t)), `well nested: ${t} -> ${mdToHtml(t)}`);
  assert.equal(mdToHtml('src/*.ts and test/*.ts'), 'src/*.ts and test/*.ts');
  assert.equal(mdToHtml('2**10 and 3**4'), '2**10 and 3**4');
  assert.equal(mdToHtml('(*it*) and "**b**".'), '(<i>it</i>) and "<b>b</b>".');
  assert.equal(mdToHtml('| a | `c` |\n|---|---|\n| `x` | _y_ |'), '<pre>| a | `c` |\n|---|---|\n| `x` | _y_ |</pre>');
  assert.equal(mdToHtml('**see https://x.com/a**'), '<b>see https://x.com/a</b>');
  assert.equal(mdToHtml('(see https://x.com/a_b). Then https://x.com/w_(v), ok'), '(see https://x.com/a_b). Then https://x.com/w_(v), ok');
  assert.equal(mdToHtml('```js\n```'), '');
  assert.equal(mdToHtml('a\n```js title\ncode\n```\nb'), 'a\n<pre><code class="language-js">code</code></pre>\nb');
  assert.equal(mdToHtml('```\n```js\nx\n```'), '<pre><code>```js\nx</code></pre>', 'an opener line inside a block is content');
  assert.equal(wellFormed('<b>x</i>'), false);
  assert.equal(wellFormed('<b>x</b> &lt; <code>a</code>'), true);
  assert.equal(wellFormed('a < b'), false);
});
