// Web UI server: SSE stream of bus events + JSON POST commands. Loopback only.
import './local-env.ts';
import { resolveFlag } from './env-flag.ts';
import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { localFile, openLocal, openAllowed, resolveRelative } from './local-file.ts';
import { listConnections, createConnection, updateConnection, setDefaultConnection, testConnection } from './connections.ts';
import { startGuard } from './tmpguard.ts';
import { startTelegram } from './telegram-autostart.ts';
import { health, current as healthNow, maybeProbe } from './health.ts';
import { SETTINGS_MODEL, workspaces, loadWorkspaces, addWorkspace, renameWorkspace, reorderWorkspaces, setWorkspaceNotes, setWorkspaceConnection, removeConnection, changingConnections, archiveWorkspace, archivePreview, restoreWorkspace, listJobSources, listJobSourceFiles, getJobSourceDetails, getJobSourceScreenshot, approveJobSource, rejectJobSource, setWorkspaceJobSources, normPath, listArchived, recentFolders, projectNotes, archivedInfo, deleteArchived, DirtyWorktree, ARBITER_MODEL, type Workspace, type AskReply } from './agents.ts';

const PORT = Number(process.env.PORT ?? 7777);
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
// GETs that read local data (files, screenshots): a foreign page can embed them as <img>/<iframe> and learn from onload/size what exists. Only our own page may read them.
function ownPage(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const from = req.headers.origin ?? req.headers.referer; // no fetch metadata (old clients, tests): a sent Origin/Referer must be ours
  return !from || ORIGINS.has(from.replace(/^(https?:\/\/[^/]+).*$/, '$1'));
}
// Voice input is opt-in: voice.ts is not even loaded unless JARVIS_VOICE is on. The /voice routes and `voice` in /workspaces appear once its preflight passed (after listen, so a slow preflight never delays the start).
let voice: { maxS: number } | undefined;
const PAGE = resolve(import.meta.dirname, '..', 'public', 'index.html');

async function body(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const chunk of req) s += chunk;
  try { return JSON.parse(s || '{}'); } catch { throw new Error('invalid JSON'); } // the parser's own message quotes part of the body, which is never logged
}

function ws(id: unknown): Workspace {
  const w = workspaces.get(String(id));
  if (!w) throw new Error(`no workspace ${id}`);
  return w;
}

// AskUserQuestion reply from the UI: keep only the known string fields.
const obj = (v: unknown): object => (v && typeof v === 'object' ? v : {});
const strings = (v: unknown, keys?: string[]): Record<string, string> =>
  Object.fromEntries(Object.entries(obj(v)).filter(([k, x]) => x != null && (!keys || keys.includes(k))).map(([k, x]) => [k, String(x)]));
const replyOf = (b: any): AskReply | undefined =>
  b.answers ? { answers: strings(b.answers), annotations: Object.fromEntries(Object.entries(obj(b.annotations)).map(([q, x]) => [q, strings(x, ['preview', 'notes'])])) } : undefined;

// Each returns a JSON-able value or nothing (204).
const commands: Record<string, (b: any) => unknown | Promise<unknown>> = {
  '/workspaces': (b) => addWorkspace(String(b.name || 'Untitled'), b.project ? String(b.project) : undefined, { model: b.model || undefined, effort: b.effort || undefined }, b.notes ? String(b.notes) : undefined, undefined, b.connectionId ? String(b.connectionId) : undefined).meta,
  '/workspaces/rename': (b) => renameWorkspace(String(b.ws), String(b.name ?? '')),
  '/workspaces/reorder': (b) => reorderWorkspaces(Array.isArray(b.ids) ? b.ids.map(String) : []),
  '/workspaces/notes': (b) => setWorkspaceNotes(String(b.ws), b.notes ? String(b.notes) : undefined),
  '/workspaces/job-sources': (b) => setWorkspaceJobSources(String(b.ws), b.jobSources),
  '/workspaces/connection': (b) => setWorkspaceConnection(String(b.ws), b.connectionId ? String(b.connectionId) : undefined),
  '/connections/create': (b) => createConnection(b),
  '/connections/update': (b) => changingConnections(() => updateConnection(String(b.id), b)),
  '/connections/delete': (b) => removeConnection(String(b.id)),
  '/connections/default': (b) => changingConnections(() => setDefaultConnection(b.id ? String(b.id) : null)),
  '/connections/test': (b) => testConnection(String(b.id)),
  '/workspaces/archive': (b) => archiveWorkspace(String(b.ws), b.commit === true),
  '/workspaces/archive/preview': (b) => archivePreview(String(b.ws)),
  '/workspaces/restore': (b) => restoreWorkspace(String(b.id)),
  '/workspaces/archived/info': (b) => archivedInfo(String(b.id)),
  '/workspaces/archived/delete': (b) => deleteArchived(String(b.id), String(b.name ?? '')),
  // Relative chat paths to absolute ones (null = no match), for the links; the policy is the one of /local-file. At most 50 per call.
  '/local-file/resolve': (b) => { const bases = ws(b.ws).fileBases(); return Object.fromEntries((Array.isArray(b.paths) ? b.paths.slice(0, 50) : []).map((p: unknown) => [String(p), resolveRelative(String(p), bases) ?? null])); },
  '/say': (b) => ws(b.ws).tellArbiter(String(b.text)),
  '/answer': (b) => ws(b.ws).answerAsk(String(b.reqId), Boolean(b.allow), replyOf(b)),
  '/send': (b) => ws(b.ws).sendToAgent(String(b.id), String(b.text), 'user'),
  '/stop': (b) => ws(b.ws).stopAgent(String(b.id)),
  '/compact': (b) => ws(b.ws).compactAgent(String(b.id)),
  '/reset': (b) => ws(b.ws).resetArbiterNow(),
  '/stopall': (b) => ws(b.ws).stopAll(),
  '/config': (b) => ws(b.ws).configure(String(b.id), { model: b.model ? String(b.model) : undefined, effort: b.effort || undefined }),
  '/delete': (b) => ws(b.ws).deleteAgent(String(b.id), b.dirty === 'commit' || b.dirty === 'discard' ? b.dirty : undefined),
  '/job-sources/approve': (b) => approveJobSource(String(b.name), String(b.hash)),
  '/job-sources/reject': (b) => rejectJobSource(String(b.name), String(b.hash), b.reason ? String(b.reason) : undefined),
  '/panels/action': ({ ws: id, panelId, action, ...args }) => ws(id).panels.runAction(String(panelId), String(action), args),
  '/board': (b) => void ws(b.ws).postNote('user', Array.isArray(b.to) ? b.to.map(String) : ['all'], String(b.text)),
};

// Voice errors carry their own status (409 busy, 500 no pw-record); anything else is a 400.
const statusOf = (e: unknown) => { const s = (e as any)?.status; return Number.isInteger(s) && s >= 400 && s < 600 ? s : 400; };

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  // DNS rebinding: a foreign site resolved to 127.0.0.1 sends its own name as Host, and could otherwise read /workspaces and /events.
  if (!ORIGINS.has(`http://${req.headers.host}`)) return void res.writeHead(403).end();
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(PAGE));
  } else if (req.method === 'GET' && url.pathname === '/workspaces') {
    const body = { workspaces: [...workspaces.values()].map((w) => w.summary()), archived: listArchived(), settingsModel: SETTINGS_MODEL, voice: !!voice, voiceAutosend: process.env.JARVIS_VOICE_AUTOSEND !== '0', voiceMaxS: voice?.maxS, arbiterModel: ARBITER_MODEL };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  } else if (req.method === 'GET' && url.pathname === '/connections') {
    if (!ownPage(req)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(listConnections()));
  } else if (req.method === 'GET' && url.pathname === '/panels') {
    const w = workspaces.get(url.searchParams.get('ws') ?? '');
    if (!w) return void res.writeHead(404).end();
    w.refreshOpenItems(); // re-read the file: the watcher may lag
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(w.panels.panels()));
  } else if (req.method === 'GET' && (url.pathname === '/job-sources' || url.pathname === '/job-sources/files' || url.pathname === '/job-sources/details')) {
    try {
      const out = url.pathname === '/job-sources' ? listJobSources() : url.pathname === '/job-sources/details' ? getJobSourceDetails(url.searchParams.get('name') ?? '') : listJobSourceFiles(url.searchParams.get('name') ?? '', url.searchParams.get('hash') ?? '');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) { res.writeHead(statusOf(e)).end((e as Error).message); }
  } else if (req.method === 'GET' && url.pathname === '/job-sources/screenshot') {
    if (!ownPage(req)) return void res.writeHead(404).end();
    try {
      const { type, data } = getJobSourceScreenshot(url.searchParams.get('name') ?? '');
      res.writeHead(200, { 'content-type': type, 'content-length': data.length, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'no-cache' }).end(data);
    } catch (e) { res.writeHead(statusOf(e)).end((e as Error).message); }
  } else if (req.method === 'GET' && url.pathname === '/local-file') {
    if (!ownPage(req)) return void res.writeHead(404).end();
    const f = localFile(url.searchParams.get('path') ?? '');
    if (!f) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': f.type, 'content-length': f.data.length, 'content-disposition': 'inline', 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache', ...(f.csp && { 'content-security-policy': f.csp }) }).end(f.data);
  } else if (url.pathname === '/local-file/open') {
    // Triggers a local action, so same-origin JSON POST only (a cross-site form cannot set this Origin or content type).
    if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end();
    if (!ORIGINS.has(req.headers.origin ?? '') || req.headers['content-type'] !== 'application/json') return void res.writeHead(403).end();
    if (!openAllowed()) return void res.writeHead(429).end();
    let path = '';
    try { path = String((await body(req)).path ?? ''); } catch { return void res.writeHead(400).end(); }
    const r = await openLocal(path);
    if (r === 'denied') return void res.writeHead(404).end();
    if (r === 'view-only') return void res.writeHead(415).end();
    if (r) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify(r));
    else res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  } else if (req.method === 'GET' && url.pathname === '/recent') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...recentFolders(), projectNotes: projectNotes(), ...(url.searchParams.has('project') ? { projectNote: projectNotes()[normPath(url.searchParams.get('project')!.trim())] ?? '' } : {}) }));
  } else if (req.method === 'GET' && url.pathname === '/health') {
    // Global (not per workspace) and never persisted: the current state, then each change.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = () => res.write(`data: ${JSON.stringify(healthNow)}\n\n`);
    send();
    health.on('change', send);
    maybeProbe(); // a client appeared: probe now if nothing ran lately, not at the next poll
    req.on('close', () => health.off('change', send));
  } else if (req.method === 'GET' && url.pathname === '/events') {
    const w = workspaces.get(url.searchParams.get('ws') ?? '');
    if (!w) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (e: object) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    for (const line of w.snapshot()) res.write(`data: ${line}\n\n`);
    send({ type: 'ready' }); // end of replay: UI animates only events after this
    w.bus.on('event', send);
    const ping = setInterval(() => res.write(': ping\n\n'), 30_000); // clients such as the Telegram bridge (fetch) drop a stream that is silent for 300 s
    req.on('close', () => { w.bus.off('event', send); clearInterval(ping); });
  } else if (req.method === 'POST' && commands[url.pathname]) {
    // Any website can POST to localhost; agents run tools, so only accept our own page.
    if (!ORIGINS.has(req.headers.origin ?? '') || req.headers['content-type'] !== 'application/json') {
      res.writeHead(403).end();
      return;
    }
    try {
      const out = await commands[url.pathname](await body(req));
      if (out === undefined) res.writeHead(204).end();
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) {
      // stderr goes to server.log; never the body, it may hold user content.
      console.error(`${new Date().toISOString()} ${req.method} ${url.pathname}: ${JSON.stringify((e as Error).message)}`);
      if (e instanceof DirtyWorktree) res.writeHead(409, { 'x-can-commit': String(e.canCommit) }).end(e.message);
      else res.writeHead(statusOf(e)).end((e as Error).message);
    }
  } else {
    res.writeHead(404).end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`jarvis UI: http://127.0.0.1:${PORT}`));

loadWorkspaces();
startGuard(() => workspaces.values());
if (resolveFlag('JARVIS_VOICE', 'cpu').enabled) {
  import('./voice.ts').then((m) => m.initVoice()).then((v) => {
    if (!v) return;
    // Same Origin and content-type checks as every POST (the commands table), level included: it renews the lease. One recording at a time; start returns an id that the other calls must pass.
    Object.assign(commands, {
      '/voice/start': async () => ({ id: await v.start() }),
      '/voice/stop': async (b: any) => ({ text: await v.stop(b.id) }),
      '/voice/cancel': (b: any) => v.cancel(b.id),
      '/voice/level': (b: any) => v.level(b.id),
    });
    voice = v;
  }, (e) => console.error(`voice disabled: ${(e as Error).message}`));
}
// Telegram bridge: opt-in like voice, on when JARVIS_TELEGRAM is set (shell or the Jarvis env file). It runs as a child process and dies with Jarvis; a failure is one log line.
if (resolveFlag('JARVIS_TELEGRAM').enabled) startTelegram();
