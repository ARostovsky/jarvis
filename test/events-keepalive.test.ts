// GET /events sends a `: ping` comment every 30 s (clients that read it with fetch drop a stream silent for 300 s) and stops the timer when the client leaves.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get, type IncomingMessage } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const probe = createServer();
const port = await new Promise<number>((r) => probe.listen(0, '127.0.0.1', () => r((probe.address() as any).port)));
probe.close();
const tmp = mkdtempSync(join(tmpdir(), 'jarvis-keepalive-test-'));
Object.assign(process.env, { PORT: String(port), XDG_DATA_HOME: join(tmp, 'data'), JARVIS_FAKE_SDK: resolve('e2e/fake-sdk.ts'), JARVIS_PLAYWRIGHT: '0', JARVIS_TMPGUARD: '0', JARVIS_HEALTH_PROBE: '0', JARVIS_STATUS_URL: 'http://127.0.0.1:1/', JARVIS_PROVIDERS_DIR: join(tmp, 'providers') });
process.env.JARVIS_ENV_FILE ??= '/dev/null';
delete process.env.JARVIS_VOICE;
const { addWorkspace } = await import('../src/agents.ts');
await import('../src/server.ts'); // listens on PORT at import
// server.ts listens at import and exports no handle to close, so the test file ends its own process.
after(() => { setTimeout(() => process.exit(0), 100); });
const until = async (f: () => boolean) => { for (let i = 0; i < 250 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(f(), 'condition not reached'); };

test('the events stream gets a ping comment every 30 s and the timer ends with the client', async () => {
  const ws = addWorkspace('keepalive');
  mock.timers.enable({ apis: ['setInterval'] }); // before the stream opens, so the handler's interval is the mocked one
  const cleared = mock.method(globalThis, 'clearInterval');
  try {
    let body = '';
    const res = await new Promise<IncomingMessage>((ok, bad) => get(`http://127.0.0.1:${port}/events?ws=${ws.meta.id}`, (r) => ok(r)).on('error', bad));
    res.setEncoding('utf8').on('data', (c) => { body += c; });
    await until(() => body.includes('"ready"')); // the handler has registered its interval
    assert.ok(!body.includes(': ping'));
    mock.timers.tick(30_000);
    await until(() => body.includes(': ping\n\n'));
    const before = cleared.mock.callCount();
    res.destroy();
    await until(() => cleared.mock.callCount() > before);
  } finally { cleared.mock.restore(); mock.timers.reset(); }
});
