// Anthropic service health from the public Statuspage, polled once for all browsers.
import { EventEmitter } from 'node:events';

export type Level = 'ok' | 'minor' | 'major' | 'critical' | 'unknown';
export type Health = { level: Level; description: string; incidents: string[]; checked: number };

const URL_ = process.env.JARVIS_STATUS_URL || 'https://status.claude.com/api/v2/summary.json';
const POLL_MS = Number(process.env.JARVIS_STATUS_POLL_MS) || 60_000; // the env var is for tests

const RANK: Level[] = ['ok', 'minor', 'major', 'critical'];
const INDICATOR: Record<string, Level> = { none: 'ok', minor: 'minor', major: 'major', critical: 'critical' };
const COMPONENT: Record<string, Level> = { operational: 'ok', under_maintenance: 'ok', degraded_performance: 'minor', partial_outage: 'major', major_outage: 'critical' };

export const health = new EventEmitter();
export let current: Health = { level: 'unknown', description: 'Status unknown', incidents: [], checked: Date.now() };
let etag: string | undefined;
let last: any; // last parsed body, reused on 304

function derive(j: any): Health {
  const overall = INDICATOR[j?.status?.indicator];
  if (!overall) throw new Error('bad status JSON');
  const api = (j.components ?? []).find((c: any) => String(c?.name).startsWith('Claude API'));
  const apiLevel = COMPONENT[api?.status];
  const level = apiLevel && RANK.indexOf(apiLevel) > RANK.indexOf(overall) ? apiLevel : overall;
  const incidents = (j.incidents ?? []).map((i: any) => String(i?.name)).filter(Boolean);
  return { level, description: String(j.status.description ?? ''), incidents, checked: Date.now() };
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
  current = next;
  health.emit('change', current); // every poll, so the tooltip's checked time stays fresh
}

poll();
setInterval(poll, POLL_MS).unref();
