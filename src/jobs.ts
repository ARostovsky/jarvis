// The `jobs` panel source: runs approved status providers, validates their output (an untrusted boundary), keeps the watch list in the panel's rows.
// No LLM, no agent, no import of agents.ts: the panel API is injected. Providers are read-only processes started with argv, never a shell.
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { idOk, limits, loadProvider, type Locations, type Manifest, type Registry } from './providers.ts';

// Panel API (contract 1), declared structurally so this module does not depend on src/panels.ts.
export type Panel = { panelId: string; kind: string; title: string; data: unknown; badge?: { text: string; level: 'active' | 'ok' | 'warn' | 'error' } };
export type PanelStatus = { panelId: string; at: number; ok: boolean; error?: string; detail?: unknown };
export type PanelsApi = {
  setPanel(p: Panel): void; removePanel(id: string): void; setPanelStatus(s: PanelStatus): void;
  onPanelAction(id: string, h: (action: string, args: any) => unknown | Promise<unknown>): void;
  panels(): Panel[];
};

export const STATES = ['queued', 'running', 'waiting', 'done', 'failed', 'stopped', 'unknown'] as const;
export type State = (typeof STATES)[number];
export const TERMINAL = new Set<string>(['done', 'failed', 'stopped']);
export type Row = {
  id: string; provider: string; label?: string; state: State; detail?: string; step?: string;
  progress?: { done: number; total?: number }; startedAt?: string; finishedAt?: string; link?: string;
  costUsd?: number; error?: string; stale?: string; pending?: boolean; changedAt?: string;
  asOf?: Record<string, string>; // ISO fetch time of each slow field
  watchLabel?: string; // the label given to watch_jobs; it wins over the provider's and survives a restart with the row
};
export type Change = { id: string; provider: string; label?: string; from: State; to: State; detail?: string; step?: string; error?: string; link?: string };
export type ProviderStatus = { provider: string; at: number; ok: boolean; error?: string; errorKind?: string };

const MAX_ROWS = 200, MAX_OUT = 2 * 1024 * 1024;
const BASE_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'TZ', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'NO_PROXY'];
const ROW_FIELDS = ['label', 'detail', 'step', 'progress', 'startedAt', 'finishedAt', 'link', 'costUsd', 'error'] as const;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// ---- argv and env (the same code runs the server's polls and `jarvis provider-check`) ----

// Base set + manifest `pass` + `set` (with {id} filled) + JARVIS_STATUS_SCHEMA. No other server env reaches the provider.
export function buildEnv(m: Manifest, id?: string, src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined && (BASE_ENV.includes(k) || k.startsWith('LC_'))) env[k] = v;
  for (const k of m.env.pass) if (src[k] !== undefined) env[k] = src[k]!;
  for (const [k, v] of Object.entries(m.env.set)) env[k] = id === undefined ? v : v.replaceAll('{id}', id);
  env.JARVIS_STATUS_SCHEMA = '1';
  return env;
}

// The argv of one call: relative entries that are files in the provider folder become absolute; {ids} expands to one entry per id;
// a slow run appends `--fields <keys>`.
export function buildArgv(folder: string, m: Manifest, ids: string[], fields?: string[]): string[] {
  const file = (e: string) => !isAbsolute(e) && !e.startsWith('-') && existsSync(join(folder, e)) && lstatSync(join(folder, e)).isFile() ? join(folder, e) : e;
  // file() sees the template entry only, so an id can never turn into a path of the provider folder.
  const argv = [...m.command.map(file), ...m.args.flatMap((a) => (a === '{ids}' ? ids : [file(a).replaceAll('{id}', ids[0] ?? '')]))];
  return fields?.length ? [...argv, '--fields', fields.join(',')] : argv;
}

// Calls to run for a mode: {ids} one call with every id, {id} one call per id.
export const callsFor = (m: Manifest, ids: string[]): string[][] => (m.mode === 'ids' ? [ids] : ids.map((i) => [i]));

// ---- one process ----
let running = 0;
const waiters: (() => void)[] = [];
// At most 4 provider processes at once, across all workspaces.
async function slot<T>(f: () => Promise<T>): Promise<T> {
  while (running >= 4) await new Promise<void>((r) => waiters.push(r));
  running++;
  try { return await f(); } finally { running--; waiters.shift()?.(); }
}

export type Ran = { ok: true; stdout: string } | { ok: false; error: string };
export function runProcess(argv: string[], o: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<Ran> {
  return slot(() => new Promise<Ran>((done) => {
    let out = '', err = '', over = false, timedOut = false, finished = false, timer: ReturnType<typeof setTimeout> | undefined;
    const fin = (r: Ran) => { if (!finished) { finished = true; clearTimeout(timer); done(r); } };
    let child;
    try {
      if (!statSync(o.cwd).isDirectory()) throw new Error(`cwd ${o.cwd} is not a folder`);
      child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) { return fin({ ok: false, error: (e as Error).message }); }
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } };
    timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
    child.stdout.on('data', (d) => { out += d; if (out.length > MAX_OUT) { over = true; kill(); } });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => fin({ ok: false, error: e.message.slice(0, 300) }));
    child.on('close', (code, sig) => {
      const line = err.split('\n').map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 300);
      if (timedOut) return fin({ ok: false, error: `timed out after ${o.timeoutMs / 1000}s` });
      if (over) return fin({ ok: false, error: 'output larger than 2 MB' });
      if (code !== 0) return fin({ ok: false, error: line ?? `exit ${code ?? sig}` });
      fin({ ok: true, stdout: out });
    });
  }));
}

// ---- output validation (schema v1) ----
const clean = (v: unknown, cap: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, cap);
  return s || undefined;
};
const iso = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : undefined);
const link = (v: unknown): string | undefined => {
  if (typeof v !== 'string' || v.length > 500 || /[\u0000- \u007f]/.test(v)) return undefined;
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:' ? v : undefined; } catch { return undefined; }
};
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

export type Parsed = { ok: true; checked: string; rows: Map<string, Partial<Row> & { id: string; state?: State }>; warnings: string[] } | { ok: false; error: string; errorKind?: string };

// `asked` are the ids of this call. mode 'fast' drops the manifest's slow fields; mode 'slow' keeps only id and the asked `fields` (row field names).
export function parseOutput(stdout: string, asked: string[], mode: 'fast' | 'slow', m: Manifest, fields: string[] = []): Parsed {
  let j: unknown;
  try { j = JSON.parse(stdout); } catch { return { ok: false, error: 'output is not a JSON object' }; }
  if (!isObj(j)) return { ok: false, error: 'output is not a JSON object' };
  if (typeof j.schema !== 'number' || !Number.isInteger(j.schema) || j.schema < 1) return { ok: false, error: 'output has no schema number' };
  if (j.schema > 1) return { ok: false, error: `provider speaks schema ${j.schema}, Jarvis knows 1` };
  if (typeof j.error === 'string' && j.error) return { ok: false, error: clean(j.error, 300) ?? 'provider error', errorKind: ['auth', 'network', 'other'].includes(j.errorKind as string) ? (j.errorKind as string) : undefined };
  if (!Array.isArray(j.rows)) return { ok: false, error: 'output has no rows list' };
  const warnings: string[] = [], rows = new Map<string, any>(), ask = new Set(asked);
  const slow = new Set(m.slow.map((s) => s.field));
  const keep = (f: string) => (mode === 'slow' ? fields.includes(f) : !slow.has(f));
  const warn = (w: string) => { if (!warnings.includes(w)) warnings.push(w); };
  if (j.rows.length > MAX_ROWS) warn(`more than ${MAX_ROWS} rows, the rest are dropped`);
  for (const raw of j.rows.slice(0, MAX_ROWS)) {
    if (!isObj(raw) || typeof raw.id !== 'string') { warn('a row without a string id was dropped'); continue; }
    if (!ask.has(raw.id)) { warn(`row with id "${raw.id.slice(0, 40)}" was not asked for and was dropped`); continue; }
    if (rows.has(raw.id)) { warn(`duplicate row for id "${raw.id.slice(0, 40)}" dropped`); continue; }
    const r: any = { id: raw.id };
    const put = (f: string, v: unknown) => {
      if (v === undefined || v === null) return;
      if (!keep(f)) return warn(`field "${f}" is not part of ${mode === 'slow' ? 'this slow run' : 'the fast run'} and was dropped`);
      r[f] = v;
    };
    for (const k of Object.keys(raw)) if (k !== 'id' && k !== 'state' && !(ROW_FIELDS as readonly string[]).includes(k)) warn(`unknown field "${k}" ignored`);
    if (mode === 'fast') {
      if (typeof raw.state === 'string' && (STATES as readonly string[]).includes(raw.state)) r.state = raw.state;
      else { r.state = 'unknown'; warn(`row has an unknown or missing state, shown as "unknown"`); }
    }
    put('label', clean(raw.label, 200)); put('detail', clean(raw.detail, 300)); put('step', clean(raw.step, 200)); put('error', clean(raw.error, 300));
    put('startedAt', iso(raw.startedAt)); put('finishedAt', iso(raw.finishedAt));
    if (raw.link != null) { const l = link(raw.link); if (l) put('link', l); else warn('a bad link (not http or https) was dropped'); }
    if (raw.costUsd != null) { const c = count(raw.costUsd); if (c !== undefined) put('costUsd', c); else warn('a bad costUsd was dropped'); }
    if (isObj(raw.progress)) {
      const done = count(raw.progress.done), total = count(raw.progress.total);
      if (done !== undefined && (raw.progress.total == null || total !== undefined)) put('progress', total === undefined ? { done } : { done, total });
      else warn('a bad progress was dropped');
    }
    rows.set(raw.id, r);
  }
  return { ok: true, checked: iso(j.checked) ?? new Date().toISOString(), rows, warnings };
}

// One validated run of a provider for `ids`: all calls ({id} mode: one per id), in the fast or slow mode.
export type RunResult = { ok: boolean; rows: Map<string, any>; failed: Map<string, { error: string; errorKind?: string }>; warnings: string[] };
export async function runProvider(folder: string, m: Manifest, ids: string[], mode: 'fast' | 'slow'): Promise<RunResult> {
  const fields = mode === 'slow' ? m.slow.map((s) => s.key) : undefined;
  const rowFields = mode === 'slow' ? m.slow.map((s) => s.field) : [];
  const cwd = m.cwd === null ? folder : resolve(folder, m.cwd);
  const res: RunResult = { ok: true, rows: new Map(), failed: new Map(), warnings: [] };
  await Promise.all(callsFor(m, ids).map(async (chunk) => {
    const ran = await runProcess(buildArgv(folder, m, chunk, fields), { cwd, env: buildEnv(m, m.mode === 'id' ? chunk[0] : undefined), timeoutMs: m.timeoutS * 1000 });
    const p: Parsed = ran.ok ? parseOutput(ran.stdout, chunk, mode, m, rowFields) : { ok: false, error: ran.error };
    if (!p.ok) { res.ok = false; for (const id of chunk) res.failed.set(id, { error: p.error, errorKind: p.errorKind }); return; }
    for (const [id, r] of p.rows) res.rows.set(id, r);
    for (const w of p.warnings) if (!res.warnings.includes(w)) res.warnings.push(w);
  }));
  return res;
}

// ---- the poller ----
// Delay after `failures` failed polls in a row: 1x, 2x, 4x of pollS, at most 5 minutes (or pollS when that is longer).
export const backoffMs = (pollS: number, failures: number) => Math.min(pollS * 1000 * [1, 2, 4][Math.min(failures, 2)], Math.max(300_000, pollS * 1000));

type Entry = { provider: string; label?: string };
type PState = { nextFast: number; failures: number; nextSlow: number[]; slowFailures: number; busy: boolean; repoll?: boolean; down?: number; downNoticed?: boolean; changedNoticed?: boolean; last?: ProviderStatus; slowLast?: ProviderStatus };

export type JobsOpts = {
  panels: PanelsApi; registry: Registry;
  allowed?: () => string[] | undefined;                      // providers enabled for this workspace; undefined = all approved
  onChanges?: (changes: Change[]) => void;                   // one call per poll round, already filtered by each provider's `notify`
  onNotice?: (n: { kind: 'changed' | 'unreachable'; provider: string; text: string }) => void;
  now?: () => number; timers?: boolean; unreachableMs?: number;
};

export function createJobs(o: JobsOpts) {
  const now = o.now ?? Date.now;
  const on = () => process.env.JARVIS_JOBS !== '0';
  const rows = new Map<string, Row>();        // key provider\0id
  const st = new Map<string, PState>();
  const key = (p: string, id: string) => `${p}\0${id}`;
  let timer: ReturnType<typeof setTimeout> | undefined, started = false, lastJson = '';
  const state = (p: string): PState => st.get(p) ?? (st.set(p, { nextFast: 0, failures: 0, nextSlow: [], slowFailures: 0, busy: false }), st.get(p)!);

  // Watch list from the panel's last data.rows (the panel event is the only persisted record).
  function load() {
    rows.clear();
    const p = o.panels.panels().find((x) => x.panelId === 'jobs');
    const list = isObj(p?.data) && Array.isArray(p.data.rows) ? p.data.rows : [];
    for (const r of list.slice(0, MAX_ROWS)) if (isObj(r) && typeof r.id === 'string' && typeof r.provider === 'string' && (STATES as readonly string[]).includes(r.state as string)) rows.set(key(r.provider, r.id), r as unknown as Row);
    lastJson = JSON.stringify([...rows.values()]);
  }

  function badge(): Panel['badge'] {
    const all = [...rows.values()];
    const n = (f: (r: Row) => boolean) => all.filter(f).length;
    const failed = n((r) => r.state === 'failed'), stale = n((r) => !!r.stale), waiting = n((r) => r.state === 'waiting'), active = n((r) => r.state === 'running' || r.state === 'queued');
    if (failed) return { text: `✕${failed}`, level: 'error' };
    if (stale) return { text: '⚠', level: 'warn' };
    if (waiting) return { text: `◐${waiting}`, level: 'warn' };
    if (active) return { text: `▶${active}`, level: 'active' };
    return undefined; // all finished: no badge, a tab must not say "all fine"
  }
  // setPanel only when the rows really changed; time passing is no change.
  function publish() {
    if (!rows.size) { if (lastJson !== '[]') { lastJson = '[]'; o.panels.removePanel('jobs'); } return; }
    const list = [...rows.values()], json = JSON.stringify(list);
    if (json === lastJson) return;
    lastJson = json;
    o.panels.setPanel({ panelId: 'jobs', kind: 'jobs', title: 'Jobs', data: { rows: list }, badge: badge() });
  }
  function status() {
    const detail = [...st.entries()].filter(([p]) => [...rows.values()].some((r) => r.provider === p)).map(([, s]) => s.last).filter(Boolean) as ProviderStatus[];
    const bad = detail.find((d) => !d.ok);
    o.panels.setPanelStatus({ panelId: 'jobs', at: now(), ok: !bad, error: bad?.error, detail });
  }

  const idsOf = (p: string) => [...rows.values()].filter((r) => r.provider === p).map((r) => r.id);
  // Finished rows are not polled again.
  const pollIds = (p: string) => [...rows.values()].filter((r) => r.provider === p && !TERMINAL.has(r.state)).map((r) => r.id);
  const providers = () => [...new Set([...rows.values()].map((r) => r.provider))];
  // Providers with a row to poll: a provider with only finished rows needs no run, no hash, no timer.
  const pollable = () => providers().filter((p) => pollIds(p).length);
  const allowedNow = (p: string) => { const a = o.allowed?.(); return !a || a.includes(p); };

  // Marks every row of a provider that cannot run (disabled, changed, not approved).
  function markStale(p: string, why: string | undefined) {
    for (const r of rows.values()) if (r.provider === p) { if (why) r.stale = why; else delete r.stale; }
  }

  // One round for a provider: fast run, then the slow run when due. Appends state changes to `changes`.
  async function pollOne(p: string, changes: Change[]) {
    await pollOnce(p, changes);
    // A watch() during the poll asked for a poll that sees its new rows.
    for (const s = state(p); s.repoll && !s.busy;) { s.repoll = false; await pollOnce(p, changes); }
  }
  async function pollOnce(p: string, changes: Change[]) {
    const s = state(p);
    if (s.busy) return;
    s.busy = true;
    try {
      let loaded;
      try {
        if (!allowedNow(p)) throw new Error('provider is disabled for this workspace');
        loaded = o.registry.use(p);
        if (s.changedNoticed) s.changedNoticed = false;
        markStale(p, undefined);
      } catch (e) {
        const msg = (e as Error).message;
        markStale(p, msg);
        s.last = { provider: p, at: now(), ok: false, error: msg };
        s.nextFast = now() + backoffMs(60, s.failures++);
        if (/files changed/.test(msg) && !s.changedNoticed) { s.changedNoticed = true; o.onNotice?.({ kind: 'changed', provider: p, text: `provider ${p}: files changed since approval; its jobs are stale until the user approves again` }); }
        return;
      }
      const m = loaded.manifest, ids = pollIds(p);
      if (!ids.length) { s.nextFast = now() + m.pollS * 1000; return; }
      const fast = await runProvider(loaded.folder, m, ids, 'fast');
      const t = now(), at = new Date(t).toISOString();
      for (const id of ids) {
        const r = rows.get(key(p, id)), got = fast.rows.get(id);
        if (!r || !got) continue;
        const next: Row = { id, provider: p, state: got.state };
        for (const f of ROW_FIELDS) if (got[f] !== undefined) (next as any)[f] = got[f];
        // The watch label wins over the source's label.
        if (r.watchLabel) next.label = next.watchLabel = r.watchLabel;
        // Slow values and their fetch times survive a fast run.
        for (const sf of m.slow) if (r.asOf?.[sf.field] && (r as any)[sf.field] !== undefined) { (next as any)[sf.field] = (r as any)[sf.field]; (next.asOf ??= {})[sf.field] = r.asOf[sf.field]; }
        next.changedAt = r.changedAt ?? at;
        if (r.state !== next.state) {
          next.changedAt = at;
          if (!r.pending) { // the first state of a new watch is no change
            const c: Change = { id, provider: p, label: next.label, from: r.state, to: next.state, detail: next.detail, step: next.step, error: next.error, link: next.link };
            const n = m.notify;
            if (n === 'any' || (n === 'terminal' && TERMINAL.has(next.state)) || (n === 'failed' && next.state === 'failed')) changes.push(c);
          }
        }
        rows.set(key(p, id), next);
      }
      if (fast.ok) { s.failures = 0; s.nextFast = t + m.pollS * 1000; s.down = undefined; s.downNoticed = false; }
      else {
        s.failures++; s.nextFast = t + backoffMs(m.pollS, s.failures - 1);
        s.down ??= t;
        if (!s.downNoticed && t - s.down >= (o.unreachableMs ?? 30 * 60_000) && [...rows.values()].some((r) => r.provider === p && !TERMINAL.has(r.state))) {
          s.downNoticed = true; o.onNotice?.({ kind: 'unreachable', provider: p, text: `provider ${p} has been unreachable for ${Math.round((t - s.down) / 60000)} min while its jobs run` });
        }
      }
      const first = [...fast.failed.values()][0];
      s.last = { provider: p, at: t, ok: fast.ok, error: first?.error, errorKind: first?.errorKind };

      if (fast.ok || fast.rows.size) await slowRun(p, loaded, ids);
    } finally { s.busy = false; }
  }

  // `ids` were taken before the fast run, so rows that just finished still get their slow values.
  async function slowRun(p: string, loaded: ReturnType<typeof loadProvider>, ids: string[]) {
    const m = loaded.manifest, s = state(p);
    if (!m.slow.length) return;
    const t = now();
    const dueFields = m.slow.filter((_, i) => (s.nextSlow[i] ?? 0) <= t);
    if (!dueFields.length) return;
    if (!ids.length) return;
    // Fields due now share one run, with the keys of the fields that are due.
    const sub: Manifest = { ...m, slow: dueFields };
    const res = await runProvider(loaded.folder, sub, ids, 'slow');
    const at = new Date(now()).toISOString();
    for (const [id, got] of res.rows) {
      const r = rows.get(key(p, id));
      if (!r) continue;
      for (const f of dueFields) if (got[f.field] !== undefined) { (r as any)[f.field] = got[f.field]; (r.asOf ??= {})[f.field] = at; }
    }
    m.slow.forEach((f, i) => { if (dueFields.includes(f)) s.nextSlow[i] = now() + (res.ok ? f.everyS * 1000 : Math.min(f.everyS * 1000, backoffMs(m.pollS, ++s.slowFailures))); });
    if (res.ok) { s.slowFailures = 0; if (s.last?.error?.startsWith('slow run: ')) s.last = { provider: p, at: now(), ok: true }; }
    else {
      const f = [...res.failed.values()][0];
      s.last = { provider: p, at: now(), ok: false, error: `slow run: ${f?.error ?? 'failed'}`, errorKind: f?.errorKind };
    }
  }

  async function round(ps: string[]) {
    if (!on()) return;
    const changes: Change[] = [];
    await Promise.all(ps.map((p) => pollOne(p, changes).catch((e) => {
      const s = state(p), error = (e as Error).message;
      s.last = { provider: p, at: now(), ok: false, error };
      s.nextFast = now() + backoffMs(60, s.failures++);
    })));
    publish(); status();
    if (changes.length) o.onChanges?.(changes);
  }

  // Runs every provider whose next poll is due at `t`. Called by the timer; tests call it with a fake clock.
  const tick = async (t = now()) => { if (!on()) return; await round(pollable().filter((p) => (state(p).nextFast <= t))); };
  function arm() {
    if (!started || o.timers === false || timer || !on()) return;
    const due = pollable();
    if (!due.length) return;
    const next = Math.min(...due.map((p) => state(p).nextFast), now() + 5000);
    timer = setTimeout(async () => { timer = undefined; try { await tick(); } catch {} finally { arm(); } }, Math.max(50, Math.min(next - now(), 5000)));
    timer.unref();
  }

  function addRows(provider: string, ids: string[], given: Record<string, string> = {}) {
    for (const id of ids) {
      const l = clean(given[id], 200);
      const old = rows.get(key(provider, id));
      if (old) { if (l) old.label = old.watchLabel = l; continue; }
      rows.set(key(provider, id), { id, provider, state: 'unknown', pending: true, ...(l ? { label: l, watchLabel: l } : {}) });
    }
  }

  load();
  if (on()) {
    o.panels.onPanelAction('jobs', async (action: string, args: any) => {
      if (action === 'unwatch') {
        const ids = Array.isArray(args?.ids) ? args.ids : [args?.id];
        const provider = typeof args?.provider === 'string' ? args.provider : undefined;
        return { removed: ids.reduce((n: number, id: unknown) => n + unwatch(String(id ?? ''), provider).removed, 0) };
      }
      if (action === 'clear') return clear({ keepCurrent: args?.keepCurrent !== false, ids: Array.isArray(args?.ids) ? args.ids : undefined });
      if (action === 'refresh') return refresh();
      throw Object.assign(new Error(`unknown jobs action "${action}"`), { status: 400 });
    });
  }

  function unwatch(id: string, provider?: string) {
    const gone = [...rows.values()].filter((r) => r.id === id && (!provider || r.provider === provider));
    for (const r of gone) rows.delete(key(r.provider, r.id));
    publish(); status();
    return { removed: gone.length };
  }
  // Drops the given ids; with keepCurrent drops every finished row (done, failed, stopped) and keeps queued, running, waiting and unknown ones.
  function clear(a: { ids?: string[]; keepCurrent?: boolean } = {}) {
    const ids = new Set(a.ids ?? []);
    let n = 0;
    for (const [k, r] of [...rows]) if (ids.has(r.id) || (a.keepCurrent && TERMINAL.has(r.state))) { rows.delete(k); n++; }
    publish(); status();
    return { removed: n };
  }
  // Adds ids to the watch list and polls now. Throws a one-line Error when the provider or an id is refused.
  async function watch(provider: string, ids: string[], labels?: Record<string, string>) {
    if (!on()) throw new Error('jobs are turned off (JARVIS_JOBS=0)');
    if (!allowedNow(provider)) throw new Error(`provider ${provider} is not enabled for this workspace`);
    const loaded = o.registry.use(provider); // refuses unapproved, changed and invalid providers
    const m = loaded.manifest;
    if (!Array.isArray(ids) || !ids.length) throw new Error('no ids given');
    const bad = ids.filter((i) => !idOk(m, i));
    if (bad.length) throw new Error(`id not accepted by provider ${provider}: ${JSON.stringify(String(bad[0]).slice(0, 60))}`);
    const fresh = [...new Set(ids)].filter((i) => !rows.has(key(provider, i)));
    if (idsOf(provider).length + fresh.length > m.maxIds) throw new Error(`provider ${provider} allows at most ${m.maxIds} ids per workspace`);
    addRows(provider, [...new Set(ids)], labels);
    const s = state(provider); s.nextSlow = []; s.nextFast = 0; if (s.busy) s.repoll = true;
    publish();
    started = true;
    await round([provider]);
    arm();
    return { added: fresh.length, rows: [...rows.values()].filter((r) => r.provider === provider && ids.includes(r.id)) };
  }
  const refresh = async () => { await round(providers()); return { rows: rows.size }; };

  return {
    watch, clear, unwatch, refresh, tick, load,
    start() { started = true; if (on()) { for (const p of pollable()) state(p).nextFast = 0; void round(pollable()).catch(() => {}).finally(arm); } },
    stop() { started = false; if (timer) clearTimeout(timer); timer = undefined; },
    // jobs_status: from server memory, runs nothing.
    jobs: () => ({ rows: [...rows.values()], status: [...st.values()].map((s) => s.last).filter(Boolean) as ProviderStatus[] }),
  };
}
export type Jobs = ReturnType<typeof createJobs>;

// ---- jarvis provider-check ----
export type CheckReport = { ok: boolean; text: string };
// Validates a folder and runs it exactly as the server would (argv, env, cwd, timeout), fast and (with slow_fields) slow. No approval, no location rules.
export async function providerCheck(folder: string, ids: string[], loc?: Locations): Promise<CheckReport> {
  const out: string[] = [];
  let ok = true;
  let l;
  try { l = loadProvider(folder, { loc }); } catch (e) { return { ok: false, text: `FAIL ${(e as Error).message}` }; }
  const m = l.manifest;
  out.push(`provider ${m.name} (${m.description})`, `folder ${l.folder}`, `hash ${l.sha256}`, `files ${l.files.map((f) => `${f.path} ${f.size}B`).join(', ')}`);
  const warnings = [...l.warnings];
  const badIds = ids.filter((i) => !idOk(m, i));
  if (!ids.length) { ok = false; out.push('FAIL give at least one id'); }
  if (badIds.length) { ok = false; out.push(`FAIL id not accepted by idPattern: ${badIds.map((i) => JSON.stringify(i)).join(', ')}`); }
  if (ids.length > m.maxIds) { ok = false; out.push(`FAIL ${ids.length} ids, maxIds is ${m.maxIds}`); }
  if (ok) {
    const merged = new Map<string, any>();
    for (const mode of m.slow.length ? (['fast', 'slow'] as const) : (['fast'] as const)) {
      const res = await runProvider(l.folder, m, ids, mode);
      out.push(`${mode} run: ${res.ok ? 'ok' : 'FAILED'}${mode === 'slow' ? ` (--fields ${m.slow.map((s) => s.key).join(',')})` : ''}`);
      if (!res.ok) { ok = false; for (const [id, f] of res.failed) out.push(`  ${id}: ${f.error}${f.errorKind ? ` [${f.errorKind}]` : ''}`); if (m.needs.length) out.push(`  needs: ${m.needs.join('; ')}`); }
      for (const [id, r] of res.rows) merged.set(id, { ...merged.get(id), ...r });
      warnings.push(...res.warnings);
      for (const id of ids) if (res.ok && !res.rows.has(id) && mode === 'fast') warnings.push(`no row for asked id "${id}"`);
    }
    out.push('rows', ...[...merged.values()].map((r) => `  ${JSON.stringify(r)}`));
  }
  if (warnings.length) out.push('warnings', ...[...new Set(warnings)].map((w) => `  ${w}`));
  out.push(ok ? 'OK' : 'FAIL');
  return { ok, text: out.join('\n') };
}
