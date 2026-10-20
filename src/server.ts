// Web UI server: SSE stream of bus events + JSON POST commands. Loopback only.
import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bus, startArbiter, tellArbiter, answerAsk, sendToAgent, stopAgent, deleteAgent, postNote, snapshot, DirtyWorktree } from './agents.ts';

const PORT = Number(process.env.PORT ?? 7777);
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const PAGE = resolve(import.meta.dirname, '..', 'public', 'index.html');

async function body(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return JSON.parse(s || '{}');
}

const commands: Record<string, (b: any) => void> = {
  '/say': (b) => tellArbiter(String(b.text)),
  '/answer': (b) => answerAsk(String(b.reqId), Boolean(b.allow)),
  '/send': (b) => sendToAgent(String(b.id), String(b.text), 'user'),
  '/stop': (b) => stopAgent(String(b.id)),
  '/delete': (b) => deleteAgent(String(b.id), b.dirty === 'commit' || b.dirty === 'discard' ? b.dirty : undefined),
  '/board': (b) => void postNote('user', Array.isArray(b.to) ? b.to.map(String) : ['all'], String(b.text)),
};

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(PAGE));
  } else if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (e: object) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    for (const line of snapshot()) res.write(`data: ${line}\n\n`);
    send({ type: 'ready' }); // end of replay: UI animates only events after this
    bus.on('event', send);
    req.on('close', () => bus.off('event', send));
  } else if (req.method === 'POST' && commands[req.url ?? '']) {
    // Any website can POST to localhost; agents run tools, so only accept our own page.
    if (!ORIGINS.has(req.headers.origin ?? '') || req.headers['content-type'] !== 'application/json') {
      res.writeHead(403).end();
      return;
    }
    try {
      commands[req.url!](await body(req));
      res.writeHead(204).end();
    } catch (e) {
      res.writeHead(e instanceof DirtyWorktree ? 409 : 400).end((e as Error).message);
    }
  } else {
    res.writeHead(404).end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`jarvis UI: http://127.0.0.1:${PORT}`));

startArbiter(process.argv[2]);
