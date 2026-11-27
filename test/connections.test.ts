import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionsFile, createConnection, updateConnection, deleteConnection, setDefaultConnection, listConnections, normalizeBaseUrl, resolveConnection, connectionEnv, withConnection, connectionKey, testConnection, readStore } from '../src/connections.ts';

const KEY = 'sk-secret-1234567890abcd';
function home() { const d = mkdtempSync(join(tmpdir(), 'jarvis-conn-test-')); process.env.XDG_CONFIG_HOME = d; return d; }
const input = { name: 'Company', baseUrl: 'https://llm.example.com/v1/', apiKey: KEY, modelHaiku: 'h', modelSonnet: 's', modelOpus: 'o' };

test('the file is written with mode 0600 in a private directory, and the list never carries the key', () => {
  const d = home();
  try {
    const c = createConnection(input);
    assert.equal(statSync(connectionsFile()).mode & 0o777, 0o600);
    assert.equal(statSync(join(d, 'jarvis')).mode & 0o777, 0o700);
    const l = JSON.stringify(listConnections());
    assert.ok(!l.includes(KEY) && !l.includes('apiKey'));
    assert.deepEqual([c.hasKey, c.keyTail, c.baseUrl], [true, 'abcd', 'https://llm.example.com']);
    updateConnection(c.id, { ...input, name: 'Renamed', apiKey: '' });
    assert.equal(statSync(connectionsFile()).mode & 0o777, 0o600);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('an update with an empty key keeps the stored one, a new key replaces it; a short key shows no tail', () => {
  const d = home();
  try {
    const c = createConnection(input);
    updateConnection(c.id, { ...input, apiKey: '' });
    assert.equal(readStore().connections[0].apiKey, KEY);
    const u = updateConnection(c.id, { ...input, apiKey: 'short' });
    assert.equal(readStore().connections[0].apiKey, 'short');
    assert.equal(u.keyTail, undefined);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('base URL: trailing slash and pasted /v1 are stripped; other schemes and junk are refused', () => {
  assert.equal(normalizeBaseUrl(' http://localhost:4000/ '), 'http://localhost:4000');
  assert.equal(normalizeBaseUrl('https://x.org/proxy/v1'), 'https://x.org/proxy');
  assert.equal(normalizeBaseUrl('https://x.org/v1/'), 'https://x.org');
  for (const bad of ['', 'ftp://x', 'x.org', 'http://', 42]) assert.throws(() => normalizeBaseUrl(bad));
});

test('default and delete: a used connection is refused, deleting the default resets it, an unknown workspace id falls back to the default', () => {
  const d = home();
  try {
    const a = createConnection(input), b = createConnection({ ...input, name: 'B' });
    setDefaultConnection(a.id);
    assert.equal(resolveConnection(undefined)?.id, a.id);
    assert.equal(resolveConnection(b.id)?.id, b.id);
    assert.equal(resolveConnection('gone')?.id, a.id);
    assert.throws(() => deleteConnection(a.id, 2), /2 workspaces use/);
    deleteConnection(a.id, 0);
    assert.equal(listConnections().default, null);
    assert.equal(resolveConnection(undefined), undefined);
    assert.throws(() => setDefaultConnection('nope'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the file is read at every call, not cached', () => {
  const d = home();
  try {
    const c = createConnection(input);
    assert.equal(resolveConnection(c.id)?.apiKey, KEY);
    updateConnection(c.id, { ...input, apiKey: 'another-key-value-1' });
    assert.equal(resolveConnection(c.id)?.apiKey, 'another-key-value-1');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('env: the gateway variables go to env and settings.env over the user settings; the user key and helper are dropped; no connection changes nothing', () => {
  const d = home();
  try {
    const c = resolveConnection(createConnection(input).id)!;
    const e = connectionEnv(c);
    assert.deepEqual(e, { ANTHROPIC_BASE_URL: 'https://llm.example.com', ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h', ANTHROPIC_DEFAULT_SONNET_MODEL: 's', ANTHROPIC_DEFAULT_OPUS_MODEL: 'o', ENABLE_TOOL_SEARCH: 'true' });
    const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'user', ANTHROPIC_BASE_URL: 'http://old' };
    const settings = { apiKeyHelper: 'helper.sh', model: 'x', env: { ANTHROPIC_BASE_URL: 'http://dummy', ANTHROPIC_API_KEY: 'u2', KEEP: '1' } };
    const r = withConnection(base, settings, c);
    assert.equal(r.env.ANTHROPIC_BASE_URL, 'https://llm.example.com');
    assert.equal(r.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(r.settings.env!.ANTHROPIC_API_KEY, undefined);
    assert.equal(r.env.PATH, '/bin');
    assert.deepEqual(r.settings.env, { KEEP: '1', ...e });
    assert.equal(r.settings.apiKeyHelper, undefined);
    assert.equal(r.settings.model, 'x');
    const same = withConnection(base, settings, undefined);
    assert.equal(same.env, base); assert.equal(same.settings, settings);
    const bare = connectionEnv({ ...c, apiKey: '', modelHaiku: '', modelSonnet: '', modelOpus: '' });
    assert.deepEqual(Object.keys(bare), ['ANTHROPIC_BASE_URL', 'ENABLE_TOOL_SEARCH']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('test request: 1 token to /v1/messages for every configured alias model and a bearer key; the result and errors never hold the key', async () => {
  const d = home();
  const seen: any[] = [];
  let mode: 'ok' | 'leak' = 'ok';
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (x) => (b += x)).on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
      if (mode === 'ok') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'haiku-real', content: [] }));
      else res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `bad key ${KEY}` } }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    const c = createConnection({ ...input, baseUrl: `http://127.0.0.1:${(srv.address() as any).port}/v1` });
    const ok = await testConnection({ id: c.id, baseUrl: c.baseUrl, modelHaiku: c.modelHaiku, modelSonnet: c.modelSonnet, modelOpus: c.modelOpus });
    assert.deepEqual(ok, { ok: true, results: ['h', 's', 'o'].map((model, i) => ({ alias: ['haiku', 'sonnet', 'opus'][i], model, ok: true, status: 200, answered: 'haiku-real' })) });
    assert.deepEqual(seen.map((x) => x.body.model).sort(), ['h', 'o', 's']);
    assert.deepEqual([seen[0].url, seen[0].auth, seen[0].body.max_tokens], ['/v1/messages', `Bearer ${KEY}`, 1]);
    // unsaved form values: the stored key is reused for an empty key field, nothing is written
    const before = readFileSync(connectionsFile(), 'utf8');
    seen.length = 0;
    const form = await testConnection({ id: c.id, baseUrl: c.baseUrl, apiKey: '', modelHaiku: 'only-this' });
    assert.deepEqual(form.results.map((r) => r.model), ['only-this']);
    assert.equal(seen[0].auth, `Bearer ${KEY}`);
    await assert.rejects(testConnection({ baseUrl: c.baseUrl, apiKey: '' }), /API key is empty/);
    assert.equal(readFileSync(connectionsFile(), 'utf8'), before);
    assert.equal(listConnections().connections.length, 1);
    mode = 'leak';
    const bad = await testConnection({ id: c.id, baseUrl: c.baseUrl, modelHaiku: c.modelHaiku, modelSonnet: c.modelSonnet, modelOpus: c.modelOpus });
    assert.equal(bad.ok, false); assert.equal(bad.results.length, 3); assert.ok(bad.results.every((r) => r.status === 401));
    assert.ok(!JSON.stringify(bad).includes(KEY) && bad.results[0].error!.includes('***'));
    srv.close();
    const down = await testConnection({ id: c.id, baseUrl: c.baseUrl, modelHaiku: c.modelHaiku, modelSonnet: c.modelSonnet, modelOpus: c.modelOpus });
    assert.equal(down.ok, false); assert.ok(!JSON.stringify(down).includes(KEY));
    assert.ok(!readFileSync(connectionsFile(), 'utf8').includes('undefined'));
  } finally { srv.close(); rmSync(d, { recursive: true, force: true }); }
});

test('withConnection: leftover login, token, model and cloud-backend variables in the env or the settings never reach a session', () => {
  const d = home();
  try {
    const c = resolveConnection(createConnection(input).id)!, e = connectionEnv(c);
    const leak = { ANTHROPIC_AUTH_TOKEN: 'old', ANTHROPIC_MODEL: 'old-model', ANTHROPIC_SMALL_FAST_MODEL: 'old', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1' };
    const r = withConnection({ PATH: '/bin', ...leak }, { env: { ...leak, KEEP: '1' } }, c);
    for (const k of Object.keys(leak)) { const want = (e as Record<string, string>)[k]; assert.equal(r.env[k], want, k); assert.equal((r.settings.env as Record<string, string>)[k], want, k); }
    assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, KEY);
    assert.deepEqual(r.settings.env, { KEEP: '1', ...e });
    // no connection: untouched
    const same = withConnection({ ...leak }, { env: { ...leak } }, undefined);
    assert.equal(same.env.ANTHROPIC_MODEL, 'old-model');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a gateway connection needs a key, and the base URL carries no user name or password', () => {
  const d = home();
  try {
    assert.throws(() => createConnection({ ...input, apiKey: '' }), /API key is empty/);
    assert.throws(() => createConnection({ ...input, baseUrl: 'https://user:pw@llm.example.com' }), /user name or password/);
    const c = createConnection(input);
    assert.throws(() => updateConnection(c.id, { ...input, baseUrl: 'https://u@llm.example.com' }), /user name or password/);
    // a stored connection without a key (hand edited) cannot be saved without one either
    writeFileSync(connectionsFile(), JSON.stringify({ default: null, connections: [{ id: 'x', name: 'X', baseUrl: 'http://h' }] }));
    assert.throws(() => updateConnection('x', { name: 'X', baseUrl: 'http://h' }), /API key is empty/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('connectionKey differs by connection and by endpoint; Anthropic login is empty', () => {
  const d = home();
  try {
    const c = createConnection(input), k1 = connectionKey(resolveConnection(c.id));
    assert.equal(connectionKey(undefined), '');
    updateConnection(c.id, { ...input, baseUrl: 'https://other.example.com' });
    assert.notEqual(connectionKey(resolveConnection(c.id)), k1);
    updateConnection(c.id, { ...input, apiKey: 'a-new-key-1234567' });
    assert.equal(connectionKey(resolveConnection(c.id)), connectionKey(resolveConnection(c.id)));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the test request reads at most a few KB of an error body', async () => {
  const d = home();
  const srv = createServer((_q, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); const t = setInterval(() => res.write('x'.repeat(8192)), 1); res.on('close', () => clearInterval(t)); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const c = createConnection({ ...input, baseUrl: `http://127.0.0.1:${(srv.address() as any).port}` });
    const r = await testConnection({ id: c.id, baseUrl: c.baseUrl, modelHaiku: c.modelHaiku, modelSonnet: c.modelSonnet, modelOpus: c.modelOpus });
    assert.equal(r.ok, false);
    assert.ok(r.results.every((x) => x.error!.length <= 300));
  } finally { srv.closeAllConnections(); srv.close(); rmSync(d, { recursive: true, force: true }); }
});
