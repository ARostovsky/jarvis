// Health of the user's Claude access: the outcome of real agent runs (or a rare probe) plus the public Statuspage, polled once for all browsers.
import { EventEmitter } from 'node:events';

export type Level = 'ok' | 'minor' | 'major' | 'critical' | 'unknown';
export type Local = { ok: boolean; kind?: Kind; at: number; latencyMs: number };
// level: the local outcome and the status page combined; description, incidents, checked: the status page alone.
export type Health = { level: Level; description: string; incidents: string[]; checked: number; local?: Local };
export type Kind = 'auth' | 'network' | 'server' | 'rate' | 'slow';

const URL_ = process.env.JARVIS_STATUS_URL || 'https://status.claude.com/api/v2/summary.json';
const POLL_MS = Number(process.env.JARVIS_STATUS_POLL_MS) || 60_000; // the env var is for tests

const RANK: Level[] = ['ok', 'minor', 'major', 'critical'];
const INDICATOR: Record<string, Level> = { none: 'ok', minor: 'minor', major: 'major', critical: 'critical' };
const COMPONENT: Record<string, Level> = { operational: 'ok', under_maintenance: 'ok', degraded_performance: 'minor', partial_outage: 'major', major_outage: 'critical' };

export const health = new EventEmitter();
export let current: Health = { level: 'unknown', description: 'Status unknown', incidents: [], checked: Date.now() };
let status = current; // the status page alone
let local: Local | undefined;
const FRESH_MS = Number(process.env.JARVIS_HEALTH_FRESH_MS) || 600_000; // no probe while a real outcome is younger
const SLOW_MS = Number(process.env.JARVIS_HEALTH_SLOW_MS) || 30_000; // a model call whose first token takes longer than this is yellow
const PROBE_TIMEOUT_MS = Number(process.env.JARVIS_HEALTH_PROBE_TIMEOUT_MS) || 60_000;
let probe: ((abort: AbortController) => Promise<void>) | undefined, probing = false, lastProbeAt = 0;
export const setProbe = (f: (abort: AbortController) => Promise<void>) => { probe = f; };
export const resetOutcome = () => { local = undefined; lastProbeAt = 0; probing = false; }; // tests only
let etag: string | undefined;
let last: any; // last parsed body, reused on 304

// The level comes only from the components that carry the user's access (the page-wide indicator is only a fallback when none is found): an incident in claude.ai or an add-in must not turn the dot yellow.
const ACCESS = ['Claude API', 'Claude Code'];
export function derive(j: any): Health {
  if (!INDICATOR[j?.status?.indicator]) throw new Error('bad status JSON');
  let level: Level | undefined;
  for (const c of j.components ?? []) {
    if (!ACCESS.includes(String(c?.name).replace(/\s*\(.*\)\s*$/, '').trim())) continue; // "Claude API (api.anthropic.com)" -> "Claude API"
    const l = COMPONENT[c?.status];
    if (l && RANK.indexOf(l) > RANK.indexOf(level ?? 'ok')) level = l;
    else if (l) level ??= l;
  }
  level ??= INDICATOR[j.status.indicator]; // neither component found (renamed?): the page-wide indicator is better than silence
  const incidents = (j.incidents ?? []).map((i: any) => String(i?.name)).filter(Boolean);
  return { level: level!, description: String(j.status.description ?? ''), incidents, checked: Date.now() };
}

// Error type from the SDK's assistant-message error code, or from the text of an 'unknown' error and of exceptions ("API Error: 503 ...", "Connection error."). Anything else (bad prompt, billing, tool or agent failure, abort) is undefined: it says nothing about the API.
const CODE = '(?:status|API Error:?|HTTP)\\s*';
export function classify(err: string | undefined): Kind | undefined {
  if (!err) return undefined;
  if (new RegExp(`^(authentication_failed|oauth_org_not_allowed|account_on_hold|verification_required|cloud_credential_error)$|${CODE}(401|403)\\b|Invalid API key|Fix external API key`, 'i').test(err)) return 'auth';
  if (new RegExp(`^(server_error|overloaded)$|${CODE}5\\d\\d\\b|overloaded_error`, 'i').test(err)) return 'server';
  if (new RegExp(`^rate_limit$|${CODE}429\\b`, 'i').test(err)) return 'rate';
  if (/\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|fetch failed|Connection error|Request timed out|socket hang up/i.test(err)) return 'network';
  return undefined;
}

// Level of the local outcome: success ok, slow or rate limited minor, auth, network and server errors major.
export const localLevel = (l: Local): Level => (l.ok ? 'ok' : l.kind === 'rate' || l.kind === 'slow' ? 'minor' : 'major');
// The status page can only make the local level worse. With no local outcome the dot stays unknown: a green status page says nothing about this user's access.
export function combine(l: Local | undefined, s: Level): Level {
  if (!l) return 'unknown';
  const a = localLevel(l);
  return RANK.indexOf(s) > RANK.indexOf(a) ? s : a;
}

function publish() {
  current = { ...status, level: combine(local, status.level), local };
  health.emit('change', current);
}

// Called when a real agent turn or the probe ends. err: the SDK's error code or message, undefined on success. Unrelated errors are ignored.
export function recordOutcome(err: string | undefined, latencyMs: number, at = Date.now()) {
  if (local && at < local.at) return; // a probe that started before a newer outcome must not overwrite it
  const kind = err === undefined ? (latencyMs > SLOW_MS ? 'slow' : undefined) : classify(err);
  if (err !== undefined && !kind) return;
  local = { ok: err === undefined && kind !== 'slow', kind, at, latencyMs };
  publish();
}

// One cheap call when nothing real ran or was probed lately and a browser is watching. Called on each poll and when a client connects.
export async function maybeProbe() {
  if (!probe || process.env.JARVIS_HEALTH_PROBE === '0' || probing || !health.listenerCount('change') || Date.now() - Math.max(local?.at ?? 0, lastProbeAt) < FRESH_MS) return;
  probing = true;
  lastProbeAt = Date.now(); // an ignored error leaves local.at alone: this still spaces the next probe
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([probe(abort), new Promise<never>((_, no) => { timer = setTimeout(() => (abort.abort(), no(new Error('ETIMEDOUT: probe timed out'))), PROBE_TIMEOUT_MS); })]);
  } catch (e) { recordOutcome((e as Error).message, 0, lastProbeAt); } finally { clearTimeout(timer); probing = false; }
}

async function poll() {
  let next: Health;
  try {
    const r = await fetch(URL_, { signal: AbortSignal.timeout(10_000), redirect: 'follow', headers: etag && last ? { 'if-none-match': etag } : {} });
    if (r.status === 304 && last) next = derive(last);
    else if (!r.ok) throw new Error(`HTTP ${r.status}`);
    else { const j = await r.json(); next = derive(j); last = j; etag = r.headers.get('etag') ?? undefined; }
  } catch {
    next = { level: 'unknown', description: 'Status unavailable', incidents: [], checked: Date.now() };
  }
  status = next;
  publish(); // every poll, so the tooltip's checked time stays fresh
  maybeProbe();
}

poll();
setInterval(poll, POLL_MS).unref();
