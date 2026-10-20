#!/usr/bin/env node
// jarvis [start|stop|restart|status|logs]: runs the server in the background and opens the UI.
import { spawn, execFileSync } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

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
    for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 200));
    if (!(await up())) return console.error(`server did not start, see ${LOG}`), process.exit(1);
  }
  console.log(`jarvis: ${URL}`);
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [URL], { detached: true, stdio: 'ignore' }).unref();
}

async function stop() {
  const p = pid();
  if (p) { try { process.kill(p); } catch {} }
  rmSync(PID, { force: true });
  for (let i = 0; i < 25 && (await up()); i++) await new Promise((r) => setTimeout(r, 200));
  console.log((await up()) ? `still running on ${PORT} (not started by jarvis?)` : 'stopped');
}

const cmd = process.argv[2] ?? 'start';
if (cmd === 'start') await start();
else if (cmd === 'stop') await stop();
else if (cmd === 'restart') { await stop(); await start(); }
else if (cmd === 'status') console.log((await up()) ? `running: ${URL} (pid ${pid() || '?'})` : 'stopped');
else if (cmd === 'logs') execFileSync('tail', ['-n', '50', '-f', LOG], { stdio: 'inherit' });
else console.log('usage: jarvis [start|stop|restart|status|logs]');
