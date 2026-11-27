// Connections: how agents reach an LLM. Built-in "Anthropic login" (no connection) or a gateway (LiteLLM and similar) with a base URL, key and model aliases.
// Stored in $XDG_CONFIG_HOME/jarvis/connections.json (mode 0600), read at every call, never cached. The API key never leaves this module except in the env of a session and the test request.
// Pure Node: no SDK and no import of agents.ts.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Connection = { id: string; name: string; baseUrl: string; apiKey: string; modelHaiku: string; modelSonnet: string; modelOpus: string };
export type Store = { default: string | null; connections: Connection[] };
export type PublicConnection = Omit<Connection, 'apiKey'> & { hasKey: boolean; keyTail?: string; isDefault: boolean };
export type ConnectionInput = Partial<Omit<Connection, 'id'>>;

export const connectionsFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'jarvis', 'connections.json');

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function readStore(): Store {
  try {
    const j = JSON.parse(readFileSync(connectionsFile(), 'utf8'));
    const connections: Connection[] = (Array.isArray(j.connections) ? j.connections : []).filter((c: any) => c && typeof c.id === 'string' && typeof c.baseUrl === 'string').map((c: any) => ({
      id: c.id, name: str(c.name) || c.id, baseUrl: c.baseUrl, apiKey: typeof c.apiKey === 'string' ? c.apiKey : '', modelHaiku: str(c.modelHaiku), modelSonnet: str(c.modelSonnet), modelOpus: str(c.modelOpus),
    }));
    return { default: typeof j.default === 'string' && connections.some((c) => c.id === j.default) ? j.default : null, connections };
  } catch { return { default: null, connections: [] }; }
}

// Temp file + rename, mode 0600 from the first byte; the directory is created private.
function writeStore(s: Store) {
  const file = connectionsFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// The proxy root: no trailing slash and no pasted /v1 (Claude Code adds /v1/messages itself). Only http(s) is accepted.
export function normalizeBaseUrl(v: unknown): string {
  let u = str(v);
  if (!/^https?:\/\/[^\s/]+/i.test(u)) throw new Error('base URL must start with http:// or https://');
  let url: URL;
  try { url = new URL(u); } catch { throw new Error('base URL is not a valid URL'); }
  if (url.username || url.password) throw new Error('base URL must not contain a user name or password: use the API key field');
  u = u.replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
  return u;
}

export const publicView = (c: Connection, def: string | null): PublicConnection => {
  const { apiKey, ...rest } = c;
  return { ...rest, hasKey: !!apiKey, ...(apiKey.length >= 12 ? { keyTail: apiKey.slice(-4) } : {}), isDefault: c.id === def };
};

export const listConnections = () => { const s = readStore(); return { default: s.default, connections: s.connections.map((c) => publicView(c, s.default)) }; };

const fields = (i: ConnectionInput) => ({ name: str(i.name), modelHaiku: str(i.modelHaiku), modelSonnet: str(i.modelSonnet), modelOpus: str(i.modelOpus) });

export function createConnection(i: ConnectionInput): PublicConnection {
  const s = readStore(), f = fields(i);
  if (!f.name) throw new Error('name is empty');
  if (!str(i.apiKey)) throw new Error('API key is empty');
  const c: Connection = { id: `c-${randomBytes(4).toString('hex')}`, ...f, baseUrl: normalizeBaseUrl(i.baseUrl), apiKey: str(i.apiKey) };
  s.connections.push(c);
  writeStore(s);
  return publicView(c, s.default);
}

// An empty or missing apiKey keeps the stored one; other fields are replaced.
export function updateConnection(id: string, i: ConnectionInput): PublicConnection {
  const s = readStore(), c = s.connections.find((x) => x.id === id);
  if (!c) throw new Error(`no connection ${id}`);
  const f = fields(i);
  if (!f.name) throw new Error('name is empty');
  if (!c.apiKey && !str(i.apiKey)) throw new Error('API key is empty');
  Object.assign(c, f, { baseUrl: normalizeBaseUrl(i.baseUrl), ...(str(i.apiKey) ? { apiKey: str(i.apiKey) } : {}) });
  writeStore(s);
  return publicView(c, s.default);
}

// Refused while a workspace names this connection (the caller passes how many); deleting the default makes Anthropic login the default again.
export function deleteConnection(id: string, usedBy: number) {
  const s = readStore();
  if (!s.connections.some((c) => c.id === id)) throw new Error(`no connection ${id}`);
  if (usedBy) throw new Error(`${usedBy} workspace${usedBy > 1 ? 's use' : ' uses'} this connection: switch ${usedBy > 1 ? 'them' : 'it'} to another connection first`);
  s.connections = s.connections.filter((c) => c.id !== id);
  if (s.default === id) s.default = null;
  writeStore(s);
}

export function setDefaultConnection(id: string | null) {
  const s = readStore();
  if (id !== null && !s.connections.some((c) => c.id === id)) throw new Error(`no connection ${id}`);
  s.default = id;
  writeStore(s);
}

// What a session was started under: the resume id of one connection must never be sent to another endpoint. '' = Anthropic login.
export const connectionKey = (c?: Connection) => (c ? `${c.id}|${c.baseUrl}` : '');

export const hasConnection = (id: string) => readStore().connections.some((c) => c.id === id);

// The connection a workspace uses: its own id, else the global default. An unknown id (deleted by hand, restored archive) counts as no choice. undefined = Anthropic login.
export function resolveConnection(id?: string | null): Connection | undefined {
  const s = readStore();
  return s.connections.find((c) => c.id === (s.connections.some((x) => x.id === id) ? id : s.default));
}

export const connectionEnv = (c: Connection): Record<string, string> => ({
  ANTHROPIC_BASE_URL: c.baseUrl,
  ...(c.apiKey ? { ANTHROPIC_AUTH_TOKEN: c.apiKey } : {}),
  ...(c.modelHaiku ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: c.modelHaiku } : {}),
  ...(c.modelSonnet ? { ANTHROPIC_DEFAULT_SONNET_MODEL: c.modelSonnet } : {}),
  ...(c.modelOpus ? { ANTHROPIC_DEFAULT_OPUS_MODEL: c.modelOpus } : {}),
  ENABLE_TOOL_SEARCH: 'true',
});

// Env and settings for a session or probe. No connection: both unchanged. With one, the variables go into the process env and into settings.env
// (the CLI lets ~/.claude/settings.json env win over the process env); a user key helper is dropped too.
// Every variable that selects another login, endpoint, model or cloud backend. With a connection they are removed from both copies first, so a leftover can neither beat nor mix with the gateway.
const ownsAuth = (k: string) => k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CODE_OAUTH_TOKEN' || k.startsWith('CLAUDE_CODE_USE_');
const without = <T extends Record<string, string | undefined>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([k]) => !ownsAuth(k))) as T;
export function withConnection<S extends { env?: Record<string, string>; apiKeyHelper?: string }>(env: NodeJS.ProcessEnv, settings: S, c?: Connection): { env: NodeJS.ProcessEnv; settings: S } {
  if (!c) return { env, settings };
  const ce = connectionEnv(c);
  return { env: { ...without(env), ...ce }, settings: { ...settings, apiKeyHelper: undefined, env: { ...without(settings.env ?? {}), ...ce } } };
}

export const redact = (text: string, c: Connection) => (c.apiKey ? text.split(c.apiKey).join('***') : text).slice(0, 300);

// At most 4 KB of the body: a gateway must not make Jarvis read an endless answer.
async function readCapped(r: Response): Promise<string> {
  if (!r.body) return '';
  const dec = new TextDecoder(), rd = r.body.getReader();
  let t = '';
  try { while (t.length < 4096) { const { done, value } = await rd.read(); if (done) break; t += dec.decode(value, { stream: true }); } } catch {}
  rd.cancel().catch(() => {});
  return t;
}

// One 1-token request to <baseUrl>/v1/messages with the haiku alias. Returns only ok, status and the model the gateway answered with, or a short error.
export async function testConnection(id: string): Promise<{ ok: boolean; status?: number; model?: string; error?: string }> {
  const c = readStore().connections.find((x) => x.id === id);
  if (!c) throw new Error(`no connection ${id}`);
  try {
    const r = await fetch(`${c.baseUrl}/v1/messages`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
      body: JSON.stringify({ model: c.modelHaiku || 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
    });
    if (r.ok) { let j: any = {}; try { j = JSON.parse(await readCapped(r)); } catch {} return { ok: true, status: r.status, ...(typeof j.model === 'string' ? { model: redact(j.model, c) } : {}) }; }
    const t = (await readCapped(r)).slice(0, 4096);
    let msg = t; try { const j = JSON.parse(t); msg = j?.error?.message ?? j?.message ?? t; } catch {}
    return { ok: false, status: r.status, error: redact(String(msg).replace(/\s+/g, ' ').trim(), c) };
  } catch (e) { return { ok: false, error: redact((e as Error).message, c) }; }
}
