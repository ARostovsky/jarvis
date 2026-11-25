import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JARVIS_STATUS_URL = 'http://127.0.0.1:1/'; // the module polls on import
process.env.JARVIS_HEALTH_PROBE_TIMEOUT_MS = '100';
const H = await import('../src/health.ts');
const { derive, classify, combine, localLevel, recordOutcome, maybeProbe, setProbe, resetOutcome, health } = H;

test('error types: auth, network and 5xx are red, rate limit yellow, the rest ignored', () => {
  for (const e of ['authentication_failed', 'API Error: 401 Unauthorized', 'oauth_org_not_allowed', 'Claude Code returned an error result: Invalid API key · Fix external API key']) assert.equal(classify(e), 'auth');
  for (const e of ['server_error', 'overloaded', 'API Error: 529', 'API Error: 503 upstream']) assert.equal(classify(e), 'server');
  for (const e of ['rate_limit', 'API Error: 429']) assert.equal(classify(e), 'rate');
  for (const e of ['fetch failed ECONNREFUSED', 'API Error: Connection error.', 'ETIMEDOUT: probe timed out', 'API Error: Request timed out.']) assert.equal(classify(e), 'network');
  for (const e of ['invalid_request', 'unknown', 'error_during_execution', 'billing_error', 'aborted by user', 'read 5000 lines, 401 files', 'exit code 403', undefined]) assert.equal(classify(e), undefined);
});

test('level: the local outcome decides, the status page can only worsen it', () => {
  const at = Date.now();
  const ok = { ok: true, at, latencyMs: 1 }, red = { ok: false, kind: 'auth', at, latencyMs: 1 } as const;
  assert.equal(localLevel({ ok: false, kind: 'rate', at, latencyMs: 1 }), 'minor');
  assert.equal(localLevel({ ok: false, kind: 'slow', at, latencyMs: 1 }), 'minor');
  for (const s of ['ok', 'minor', 'major', 'unknown'] as const) assert.equal(combine(undefined, s), 'unknown'); // no local outcome: never green
  assert.equal(combine(ok, 'unknown'), 'ok');
  assert.equal(combine(ok, 'ok'), 'ok');
  assert.equal(combine(ok, 'minor'), 'minor');
  assert.equal(combine(ok, 'critical'), 'critical');
  assert.equal(combine(red, 'ok'), 'major'); // a local failure is never overridden by a green status page
});

test('recordOutcome: success green, classified errors move the dot, ignored errors and nothing else do not', () => {
  resetOutcome();
  recordOutcome(undefined, 100);
  assert.equal(H.current.level, 'ok');
  const at = H.current.local!.at;
  recordOutcome('error_during_execution', 0, at + 1);
  recordOutcome('billing_error', 0, at + 2);
  assert.deepEqual(H.current.local, { ok: true, kind: undefined, at, latencyMs: 100 }); // unchanged
  recordOutcome(undefined, 31_000);
  assert.equal(H.current.level, 'minor');
  assert.equal(H.current.local!.kind, 'slow');
  recordOutcome('authentication_failed', 5);
  assert.equal(H.current.level, 'major');
  recordOutcome(undefined, 5);
  assert.equal(H.current.level, 'ok');
});

test('maybeProbe: needs a client, never overlaps, waits for a fresh outcome and for lastProbeAt', async () => {
  resetOutcome();
  let runs = 0, release = () => {};
  setProbe(() => (runs++, new Promise<void>((r) => (release = r))));
  await maybeProbe();
  assert.equal(runs, 0, 'no client connected');
  const client = () => {};
  health.on('change', client);
  const first = maybeProbe();
  await maybeProbe();
  assert.equal(runs, 1, 'a running probe is not started twice');
  release(); await first; // the probe records nothing (an ignored error): only lastProbeAt spaces the next one
  await maybeProbe();
  assert.equal(runs, 1, 'a probe that left no outcome is not repeated at once');
  resetOutcome();
  recordOutcome(undefined, 1);
  await maybeProbe();
  assert.equal(runs, 1, 'a fresh real outcome needs no probe');
  resetOutcome();
  setProbe(() => new Promise(() => {})); // hangs: the timeout records a network failure and frees the slot
  await maybeProbe();
  assert.equal(H.current.local?.kind, 'network');
  resetOutcome();
  setProbe(async () => { runs++; });
  await maybeProbe();
  assert.equal(runs, 2, 'the slot is free again');
  health.off('change', client);
});

test('maybeProbe: a timed-out or older probe never overwrites a newer outcome', async () => {
  resetOutcome();
  recordOutcome('authentication_failed', 0, 2000);
  recordOutcome(undefined, 1, 1000); // started before the red outcome: dropped
  assert.equal(H.current.level, 'major');
  recordOutcome(undefined, 1, 3000);
  assert.equal(H.current.level, 'ok');
  resetOutcome();
  const client = () => {};
  health.on('change', client);
  let aborted = false;
  setProbe(async (ac) => { await new Promise((r) => ac.signal.addEventListener('abort', r)); aborted = true; }); // ends cleanly once aborted
  await maybeProbe();
  assert.ok(aborted);
  assert.equal(H.current.local?.kind, 'network', 'the timeout is the outcome, not a late success');
  health.off('change', client);
});

test('status page: only the Claude API and Claude Code components set the level, the page-wide indicator does not', () => {
  const page = (indicator: string, comps: Record<string, string>, incidents: string[] = []) => ({
    status: { indicator, description: `desc ${indicator}` },
    components: Object.entries(comps).map(([name, status]) => ({ name, status })),
    incidents: incidents.map((name) => ({ name })),
  });
  const ok = { 'Claude API (api.anthropic.com)': 'operational', 'Claude Code': 'operational', 'claude.ai': 'operational' };
  const wide = derive(page('minor', { ...ok, 'claude.ai': 'degraded_performance' }, ['M365 add-in missing']));
  assert.equal(wide.level, 'ok');
  assert.deepEqual(wide.incidents, ['M365 add-in missing']); // still shown, never colored
  assert.equal(derive(page('critical', ok)).level, 'ok');
  assert.equal(derive(page('none', { ...ok, 'Claude API (api.anthropic.com)': 'degraded_performance' })).level, 'minor');
  assert.equal(derive(page('none', { ...ok, 'Claude Code': 'partial_outage' })).level, 'major');
  assert.equal(derive(page('none', { ...ok, 'Claude API': 'major_outage', 'Claude Code': 'degraded_performance' })).level, 'critical');
  assert.equal(derive(page('minor', { 'claude.ai': 'operational', 'Claude Platform': 'operational' })).level, 'minor'); // neither component found: the page-wide indicator
  assert.equal(derive(page('none', {})).level, 'ok');
  assert.throws(() => derive({ status: {} }));
});
