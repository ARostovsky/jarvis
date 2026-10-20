// Web UI server: SSE stream of bus events + JSON POST commands. Loopback only.
import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SETTINGS_MODEL, workspaces, loadWorkspaces, addWorkspace, renameWorkspace, archiveWorkspace, restoreWorkspace, listArchived, archivedInfo, deleteArchived, DirtyWorktree, type Workspace } from './agents.ts';

const PORT = Number(process.env.PORT ?? 7777);
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const PAGE = resolve(import.meta.dirname, '..', 'public', 'index.html');

async function body(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return JSON.parse(s || '{}');
}

function ws(id: unknown): Workspace {
  const w = workspaces.get(String(id));
  if (!w) throw new Error(`no workspace ${id}`);
  return w;
}

// Each returns a JSON-able value or nothing (204).
const commands: Record<string, (b: any) => unknown> = {
  '/workspaces': (b) => addWorkspace(String(b.name || 'Untitled'), b.project ? String(b.project) : undefined, { model: b.model || undefined, effort: b.effort || undefined }).meta,
  '/workspaces/rename': (b) => renameWorkspace(String(b.ws), String(b.name ?? '')),
  '/workspaces/archive': (b) => archiveWorkspace(String(b.ws), b.commit === true),
  '/workspaces/restore': (b) => restoreWorkspace(String(b.id)),
  '/workspaces/archived/info': (b) => archivedInfo(String(b.id)),
  '/workspaces/archived/delete': (b) => deleteArchived(String(b.id), String(b.name ?? '')),
  '/say': (b) => ws(b.ws).tellArbiter(String(b.text)),
  '/answer': (b) => ws(b.ws).answerAsk(String(b.reqId), Boolean(b.allow)),
  '/send': (b) => ws(b.ws).sendToAgent(String(b.id), String(b.text), 'user'),
  '/stop': (b) => ws(b.ws).stopAgent(String(b.id)),
  '/stopall': (b) => ws(b.ws).stopAll(),
  '/config': (b) => ws(b.ws).configure(String(b.id), { model: b.model ? String(b.model) : undefined, effort: b.effort || undefined }),
  '/delete': (b) => ws(b.ws).deleteAgent(String(b.id), b.dirty === 'commit' || b.dirty === 'discard' ? b.dirty : undefined),
  '/board': (b) => void ws(b.ws).postNote('user', Array.isArray(b.to) ? b.to.map(String) : ['all'], String(b.text)),
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(PAGE));
  } else if (req.method === 'GET' && url.pathname === '/workspaces') {
    const body = { workspaces: [...workspaces.values()].map((w) => w.summary()), archived: listArchived(), settingsModel: SETTINGS_MODEL };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  } else if (req.method === 'GET' && url.pathname === '/events') {
    const w = workspaces.get(url.searchParams.get('ws') ?? '');
    if (!w) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (e: object) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    for (const line of w.snapshot()) res.write(`data: ${line}\n\n`);
    send({ type: 'ready' }); // end of replay: UI animates only events after this
    w.bus.on('event', send);
    req.on('close', () => w.bus.off('event', send));
  } else if (req.method === 'POST' && commands[url.pathname]) {
    // Any website can POST to localhost; agents run tools, so only accept our own page.
    if (!ORIGINS.has(req.headers.origin ?? '') || req.headers['content-type'] !== 'application/json') {
      res.writeHead(403).end();
      return;
    }
    try {
      const out = commands[url.pathname](await body(req));
      if (out === undefined) res.writeHead(204).end();
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(e instanceof DirtyWorktree ? 409 : 400).end((e as Error).message);
    }
  } else {
    res.writeHead(404).end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`jarvis UI: http://127.0.0.1:${PORT}`));

loadWorkspaces();
