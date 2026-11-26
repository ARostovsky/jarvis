// Read-only serving of local files that chat messages mention (GET /local-file): browsers refuse file:// links from an http page. POST /local-file/open hands the same files to the system viewer.
// Everything not explicitly allowed is "undefined" (the server answers 404, so nothing leaks about what exists).
import { realpathSync, statSync, readFileSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, sep, extname, isAbsolute } from 'node:path';

const home = homedir();
export const DEFAULT_ROOTS = ['/tmp', ...['Pictures', 'Downloads', 'Documents', '.local/share/jarvis', 'IdeaProjects'].map((d) => join(home, d))];
// Active types: the system viewer would run their scripts as a file:// page, so they are only shown in the browser tab (html as text, svg sandboxed), never handed to xdg-open.
const VIEW_ONLY = new Set(['.html', '.htm', '.xhtml', '.svg']);
export const MAX_BYTES = 20 * 1024 * 1024;
const TEXT = 'text/plain; charset=utf-8';
const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': TEXT, '.md': TEXT, '.log': TEXT, '.json': TEXT, ...Object.fromEntries(['.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.yml', '.yaml', '.toml', '.py'].map((e) => [e, TEXT])) };
// Source files are served as text/plain (nosniff), never as the type the browser would run.
const SECRET = /secret|passw|credential|token|private|id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p12|pfx|kdbx)$|^\.env/i;

// JARVIS_FILE_ROOTS (colon-separated) replaces the default list. Read per call so tests can set it.
const roots = () => (process.env.JARVIS_FILE_ROOTS?.split(':').filter(Boolean) ?? DEFAULT_ROOTS).flatMap((r) => { try { return [realpathSync(r)]; } catch { return []; } });

// The one policy for serving and opening: the real path and its type, or undefined.
function allowed(path: string): { real: string; type: string; dev: number; ino: number } | undefined {
  if (!path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) return;
  const type = TYPES[extname(path).toLowerCase()];
  if (!type) return;
  try {
    const real = realpathSync(path); // resolves symlinks: a link out of a root fails the root check below
    const root = roots().find((r) => real.startsWith(r === '/' ? r : r + sep));
    if (!root) return;
    // Any dot or secret-looking segment below the root denies (.git, .ssh, .env, ...); the root itself may live in a dot folder.
    if (real.slice(root.length).split(sep).some((s) => s.startsWith('.') || SECRET.test(s))) return;
    const st = statSync(real);
    if (!st.isFile() || st.size > MAX_BYTES) return;
    const realType = TYPES[extname(real).toLowerCase()]; // a link named x.png to x.sh must not pass
    if (realType !== type) return;
    return { real, type, dev: st.dev, ino: st.ino };
  } catch { return; }
}

// Resolves a path a chat message mentions, relative to the first base (repo, notes, agent worktrees: the caller orders them) that holds an allowed regular file there.
// A trailing :line or :line:col is dropped. No tree search: a bare "foo.ts" only matches at the top of a base. Returns the real path, or undefined.
export function resolveRelative(rel: string, bases: string[]): string | undefined {
  const r = rel.replace(/:\d+(?::\d+)?$/, '');
  if (!r || isAbsolute(r) || r.includes('\0') || r.split('/').includes('..')) return;
  for (const base of bases) {
    try {
      const b = realpathSync(base);
      const a = allowed(join(b, r));
      if (a && a.real.startsWith(b + sep)) return a.real; // a link inside the base that leads out of it does not count
    } catch {}
  }
}

export function localFile(path: string): { type: string; data: Buffer; csp?: string } | undefined {
  const a = allowed(path);
  if (!a) return;
  let fd: number | undefined;
  try {
    fd = openSync(a.real, constants.O_RDONLY | constants.O_NOFOLLOW); // a swap to a link after the check fails here
    const st = fstatSync(fd); // and a swap to another file fails here
    if (!st.isFile() || st.dev !== a.dev || st.ino !== a.ino || st.size > MAX_BYTES) return;
    return { type: a.type, data: readFileSync(fd), csp: a.type === 'image/svg+xml' ? 'sandbox' : undefined };
  } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
}

// Light rate limit for opens: at most 10 per 10 s.
const opens: number[] = [];
export function openAllowed(now = Date.now()): boolean {
  while (opens.length && now - opens[0] > 10_000) opens.shift();
  if (opens.length >= 10) return false;
  opens.push(now);
  return true;
}

// Opens an allowed file in the system's default program. JARVIS_OPEN_CMD overrides the command (tests use a stub). No shell: the real path is one argument.
// Returns 'denied' (policy says no), 'view-only' (allowed, but not for the system viewer), an error object, or undefined on success.
export async function openLocal(path: string): Promise<'denied' | 'view-only' | { error: string } | undefined> {
  const a = allowed(path);
  if (!a) return 'denied';
  if (VIEW_ONLY.has(extname(a.real).toLowerCase())) return 'view-only';
  const cmd = process.env.JARVIS_OPEN_CMD || (process.platform === 'darwin' ? 'open' : 'xdg-open');
  return new Promise((done) => {
    const c = spawn(cmd, [a.real], { detached: true, stdio: 'ignore' });
    c.once('error', () => done({ error: `could not start ${cmd}` }));
    c.once('spawn', () => { c.unref(); done(undefined); });
  });
}
