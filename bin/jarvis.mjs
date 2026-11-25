#!/usr/bin/env node
// jarvis [start|stop|restart|status|logs|provider-check]: runs the server in the background and opens the UI.
import { spawn, execFileSync } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.PORT ?? 7777);
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = join(dirname(realpathSync(process.argv[1])), '..');
const DATA = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'jarvis');
const PID = join(DATA, 'server.pid');
const LOG = join(DATA, 'server.log');

const up = () => fetch(`${URL}/workspaces`).then((r) => r.ok, () => false);
const pid = () => { try { return Number(readFileSync(PID, 'utf8')); } catch { return 0; } };

async function start() {
  if (!(await up())) {
    mkdirSync(DATA, { recursive: true });
    const out = openSync(LOG, 'a');
    // Detached with its own log, so it outlives this terminal.
    const child = spawn(process.execPath, [join(ROOT, 'src', 'server.ts')], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: process.env });
    child.unref();
    writeFileSync(PID, String(child.pid));
    for (let i = 0; i < 50 && !(await up()); i++) await sleep(200);
    if (!(await up())) return console.error(`server did not start, see ${LOG}`), process.exit(1);
  }
  console.log(`jarvis: ${URL}`);
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [URL], { detached: true, stdio: 'ignore' }).unref();
}

async function stop() {
  const p = pid();
  if (p) { try { process.kill(p); } catch {} }
  rmSync(PID, { force: true });
  for (let i = 0; i < 25 && (await up()); i++) await sleep(200);
  console.log((await up()) ? `still running on ${PORT} (not started by jarvis?)` : 'stopped');
}

const cmd = process.argv[2] ?? 'start';
if (cmd === 'start') await start();
else if (cmd === 'stop') await stop();
else if (cmd === 'restart') { await stop(); await start(); }
else if (cmd === 'status') console.log((await up()) ? `running: ${URL} (pid ${pid() || '?'})` : 'stopped');
else if (cmd === 'logs') execFileSync('tail', ['-n', '50', '-f', LOG], { stdio: 'inherit' });
else if (cmd === 'provider-check') {
  // Validates a status-provider folder and runs it as the server would; needs no server. Exit 1 on any failure.
  const [folder, ...ids] = process.argv.slice(3);
  if (!folder) { console.error('usage: jarvis provider-check <folder> <id> [<id> ...]'); process.exit(2); }
  const { providerCheck } = await import(join(ROOT, 'src', 'jobs.ts'));
  const { ok, text } = await providerCheck(folder, ids);
  console.log(text);
  process.exit(ok ? 0 : 1);
} else console.log('usage: jarvis [start|stop|restart|status|logs|provider-check <folder> <id>...]');
