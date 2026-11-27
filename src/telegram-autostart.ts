// Optional: start the Telegram bridge (src/telegram-bridge.ts) as a child of the server. Never throws and never stops Jarvis: a bridge that cannot start costs one log line.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const LOCK_EXIT = 75; // exit code of the bridge when another copy holds its lock (see telegram-bridge.ts)

const SETPRIV = process.platform === 'linux' && existsSync('/usr/bin/setpriv') ? ['/usr/bin/setpriv', '--pdeathsig', 'TERM'] : [];

// The bridge redacts its own output; it is passed on one line at a time. After `jarvis restart` the old bridge can still hold its lock while it drains (up to 5 s), so a lock exit is retried `retries` times, `retryMs` apart, before it is taken as a bridge that runs separately.
// `done` settles when no bridge is running any more and none will be started again.
export function startTelegram(opts: { cmd?: string[]; script?: string; env?: NodeJS.ProcessEnv; log?: (s: string) => void; retries?: number; retryMs?: number } = {}): { pid?: number; done: Promise<void> } {
  const log = opts.log ?? ((s: string) => console.log(s));
  const cmd = opts.cmd ?? [...SETPRIV, process.execPath, opts.script ?? resolve(import.meta.dirname, 'telegram-bridge.ts')];
  const env = { ...(opts.env ?? process.env) };
  env.JARVIS_URL ??= `http://127.0.0.1:${env.PORT ?? 7777}`; // the bridge talks to the Jarvis that started it
  const retries = opts.retries ?? 3, retryMs = opts.retryMs ?? 2000;
  let child: ChildProcess | undefined, quit = false, pid: number | undefined;
  const done = new Promise<void>((finish) => {
    const launch = (attempt: number) => {
      let last = '';
      try {
        const c = child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'ignore', 'pipe'], env });
        pid ??= c.pid;
        c.stderr!.setEncoding('utf8').on('data', (d: string) => {
          for (const l of d.split('\n').map((x) => x.trim()).filter(Boolean)) { last = l; if (code75(l)) continue; log(`telegram: ${l}`); }
        });
        c.on('error', (e) => { log(`telegram: not started: ${e.message.split('\n')[0]}`); finish(); });
        c.on('close', (code, sig) => {
          if (code === LOCK_EXIT && !quit) {
            if (attempt < retries) return void setTimeout(() => launch(attempt + 1), retryMs).unref();
            log('telegram: a bridge already runs separately, not starting another');
          } else if (code !== 0 || sig) log(`telegram: bridge stopped (${sig ?? `exit ${code}`})${last ? `: ${last}` : ''}; Jarvis keeps running`);
          finish();
        });
      } catch (e) {
        log(`telegram: not started: ${(e as Error).message.split('\n')[0]}`);
        finish();
      }
    };
    launch(0);
  });
  const end = () => { quit = true; child?.kill('SIGTERM'); };
  process.on('exit', end);
  for (const s of ['SIGTERM', 'SIGINT'] as const) process.once(s, () => { end(); process.kill(process.pid, s); }); // the default action runs once the handler is gone
  return { pid, done };
}
// The lock message of a retried start is noise: only the final verdict is logged.
const code75 = (l: string) => l.startsWith('another telegram bridge is running') || l.startsWith('another telegram bridge took the lock');
