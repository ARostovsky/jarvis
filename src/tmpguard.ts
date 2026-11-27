// Keeps the temp volume from filling up. /tmp is a tmpfs with a fixed inode count: when test runs and agent sessions leave files behind, it runs out of inodes while the space is nearly empty, and then no agent Bash call and no terminal can create a file.
// Three parts: cleanup of Jarvis-owned leftovers (sweep), cleanup of one agent's command-output dir (removeAgentTmp), and a low-resource check with a warning (lowOn, crossing, topConsumers).
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, rmSync, statfsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Only names that match exactly what our tests create are ours: mkdtemp prefix + 6 random characters (or the fixed per-port names of the old e2e setup). A user's dir that merely starts alike is never touched.
// 'jarvis-prov-' is the old name of 'jarvis-jobsrc-': leftovers of older runs are still swept.
const TEST_PREFIXES = ['jarvis-tmp-e2e-', 'jarvis-tmp-test-', 'jarvis-tmp-guard-test-', 'jarvis-notes-test-', 'jarvis-oi-wiring-test-', 'jarvis-jobs-', 'jarvis-jobs-wiring-test-', 'jarvis-argv-', 'jarvis-layout-', 'jarvis-jobsrc-', 'jarvis-prov-', 'jarvis-e2e-folders-', 'jv-cap-', 'jv-mute-', 'jv-dump-', 'jv-victim-'];
// The random part must hold a capital or digit: a plain lower-case word such as `backup` is not taken for one (costs 0.5% of our own dirs, which then wait for the next run's root).
const RAND = '(?=[a-z]*[A-Z0-9])[A-Za-z0-9]{6}';
const OWN_NAME = new RegExp(`^(?:(?:${TEST_PREFIXES.join('|')})${RAND}|jarvis-e2e-[a-z0-9]+-${RAND}|jarvis-e2e-(?:data|job-sources)-\\d+)$`);
export const isOwnName = (n: string) => OWN_NAME.test(n);
const HOUR = 3_600_000;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
export const TEST_MAX_AGE_MS = () => num(process.env.JARVIS_TMP_MAX_AGE_H, 24) * HOUR; // test and e2e leftovers
export const CLAUDE_MAX_AGE_MS = () => num(process.env.JARVIS_CLAUDE_TMP_MAX_AGE_H, 168) * HOUR; // per-agent dirs of stopped agents
export const MIN_FREE_PCT = () => num(process.env.JARVIS_TMP_MIN_FREE_PCT, 10);

// Where agent sessions keep their command output: an on-disk dir, so a full /tmp tmpfs cannot stop them. JARVIS_CLAUDE_TMPDIR=off keeps the claude default (/tmp/claude-<uid>).
export function claudeTmpDir(): string | undefined {
  const v = process.env.JARVIS_CLAUDE_TMPDIR;
  if (v === 'off') return undefined;
  return v || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'jarvis', 'claude-tmp');
}

// The claude CLI names an agent's dir after its cwd: every character that is not a letter or digit becomes '-'.
export const slugOfCwd = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

export type Root = { dir: string; exclusive: boolean };
// Where per-agent dirs are. Measured with a real session: the CLI creates <CLAUDE_CODE_TMPDIR>/claude-<uid>/<slug of cwd>. The server's own env has no CLAUDE_CODE_TMPDIR unless the user set one: only the session env gets Jarvis's.
// exclusive: a dir only Jarvis sessions write to (the default on-disk dir). Every other root (plain /tmp, a dir the user chose) can hold the user's own Claude Code sessions, so there only the sweep may remove, and only Jarvis's own slugs.
export function claudeRoots(): Root[] {
  const uid = process.getuid?.();
  const own = claudeTmpDir();
  const exclusive = !process.env.JARVIS_CLAUDE_TMPDIR && !process.env.CLAUDE_CODE_TMPDIR;
  const all: Root[] = [
    ...(own ? [{ dir: join(own, `claude-${uid}`), exclusive }] : []),
    ...(process.env.CLAUDE_CODE_TMPDIR ? [{ dir: join(process.env.CLAUDE_CODE_TMPDIR, `claude-${uid}`), exclusive: false }] : []),
    { dir: join(tmpdir(), `claude-${uid}`), exclusive: false },
  ];
  return all.filter((r, i) => all.findIndex((x) => x.dir === r.dir) === i && existsSync(r.dir));
}

// The slugs of Jarvis's own agent dirs: workspaces/<id>/arbiter and worktrees/<id> under the data dir, matched with the dir boundary (so jarvis-old or jarvis.bak never match).
export const dataDir = () => join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'jarvis');
export const ownSlugs = (data = dataDir()) => ['workspaces', 'worktrees'].map((d) => `${slugOfCwd(join(data, d))}-`);

type Opts = { now?: number; maxAgeMs?: number };
const MAX_WALK = 200_000;
// Age is the newest mtime of the dir and of everything inside it (lstat, symlinks are never followed), so a run that only writes deep inside keeps its dir. The walk stops at the first entry newer than the cutoff, and a dir that is too big or cannot be read completely is kept: a half-seen tree is never removed.
const stale = (p: string, now: number, maxAgeMs: number) => {
  try {
    const top = lstatSync(p);
    if (!top.isDirectory() || top.uid !== process.getuid?.()) return false;
    const stack = [p];
    let seen = 0;
    for (let d = stack.pop(); d !== undefined; d = stack.pop()) {
      const s = d === p ? top : lstatSync(d);
      if (now - s.mtimeMs <= maxAgeMs || ++seen > MAX_WALK) return false;
      if (!s.isDirectory()) continue;
      for (const n of readdirSync(d)) stack.push(join(d, n));
    }
    return true;
  } catch { return false; } // gone meanwhile, or unreadable
};

// Removes our own leftovers (by prefix) older than maxAgeMs (newest mtime inside, see stale).
export function sweepTests(dir = tmpdir(), { now = Date.now(), maxAgeMs = TEST_MAX_AGE_MS() }: Opts = {}): string[] {
  const gone: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return gone; }
  for (const n of names) {
    const p = join(dir, n);
    if (!isOwnName(n) || !stale(p, now, maxAgeMs)) continue;
    try { rmSync(p, { recursive: true, force: true }); gone.push(n); } catch {}
  }
  return gone;
}

// Removes per-agent dirs of agents that are not running: the name must start with one of ownSlugs and must not be a live agent's slug, and the dir must be stale.
export function sweepClaude(roots: string[], ownSlugsList: string[], live: Set<string>, { now = Date.now(), maxAgeMs = CLAUDE_MAX_AGE_MS() }: Opts = {}): string[] {
  const gone: string[] = [];
  for (const dir of roots) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!ownSlugsList.some((o) => n.startsWith(o)) || live.has(n) || !stale(join(dir, n), now, maxAgeMs)) continue;
      try { rmSync(join(dir, n), { recursive: true, force: true }); gone.push(n); } catch {}
    }
  }
  return gone;
}

// An agent that stopped or was removed: drop its dir at once, but only in exclusive roots (see claudeRoots) and never while any running agent of the server shares the cwd (a sub-agent of a non-git parent works in the parent's dir, and an agent of another workspace may use the same folder).
export function removeAgentTmp(cwd: string, liveCwds: Iterable<string>, roots: Root[] = claudeRoots()): void {
  const slug = slugOfCwd(cwd);
  if ([...liveCwds].some((c) => slugOfCwd(c) === slug)) return;
  for (const r of roots) if (r.exclusive) rmSync(join(r.dir, slug), { recursive: true, force: true });
}

export type Vol = { files: number; ffree: number; blocks: number; bavail: number; bsize: number };
export const volOf = (dir = tmpdir()): Vol => { const s = statfsSync(dir); return { files: s.files, ffree: s.ffree, blocks: s.blocks, bavail: s.bavail, bsize: s.bsize }; };
// Which resource is below minPct percent free. A volume that reports no inode count (files 0, e.g. some network mounts) is never low on inodes.
export function lowOn(v: Vol, minPct = MIN_FREE_PCT(), prev = { inodes: false, space: false }): { inodes: boolean; space: boolean } {
  // Hysteresis: a resource that was low stays low until it is HYST points above the threshold, so a volume hovering at the line warns once, not on every dip.
  const low = (free: number, total: number, was: boolean) => total > 0 && (free / total) * 100 < minPct + (was ? HYST : 0);
  return { inodes: low(v.ffree, v.files, prev.inodes), space: low(v.bavail, v.blocks, prev.space) };
}
const HYST = 5;
// Warn once per crossing: true only on the step from not low to low. After a recovery a new crossing warns again.
export function crossing(prev: { inodes: boolean; space: boolean }, now: { inodes: boolean; space: boolean }) {
  return { inodes: now.inodes && !prev.inodes, space: now.space && !prev.space };
}

// The biggest consumers of inodes (or of space) directly under the dir, for the warning text. Slow on a big tmp (seconds), so only run when a crossing is found.
export function topConsumers(dir = tmpdir(), by: 'inodes' | 'space' = 'inodes', n = 5): Promise<string> {
  return new Promise((done) => {
    execFile('sh', ['-c', `du -s ${by === 'inodes' ? '--inodes' : '-k'} -- "$1"/* 2>/dev/null | sort -rn | head -${n}`, 'sh', dir], { timeout: 30_000, encoding: 'utf8' }, (_e, out) => {
      done(String(out ?? '').trim().split('\n').filter(Boolean).map((l) => { const [c, ...p] = l.split(/\s+/); return `${p.join(' ')} (${c}${by === 'inodes' ? '' : ' KB'})`; }).join(', '));
    });
  });
}

export const warnText = (low: { inodes: boolean; space: boolean }, v: Vol, top: string) =>
  `⚠ The temp volume ${tmpdir()} is nearly full: ${[low.inodes && `${v.ffree} of ${v.files} inodes free`, low.space && `${Math.round((v.bavail * v.bsize) / 1048576)} MB free`].filter(Boolean).join(', ')}. When it is full, agent commands fail. Biggest: ${top || 'unknown'}. Jarvis removes its own leftovers older than a day every 30 minutes; remove other files by hand.`;

type Ws = { liveCwds(): string[]; notice(text: string): void };
// Startup sweep, then every 30 minutes; the resource check every minute. JARVIS_TMPGUARD=0 turns it all off (e2e servers: they must not touch the real /tmp).
export function startGuard(workspaces: () => Iterable<Ws>, log: (m: string) => void = console.warn) {
  if (process.env.JARVIS_TMPGUARD === '0') return () => {};
  const failed = new Map<string, number>();
  const logOnce = (kind: string, m: string) => { if (Date.now() - (failed.get(kind) ?? 0) > HOUR) (failed.set(kind, Date.now()), log(m)); }; // a broken statfs would log every minute
  const sweep = () => {
    try {
      const live = new Set([...workspaces()].flatMap((w) => w.liveCwds().map(slugOfCwd)));
      const gone = [...sweepTests(), ...sweepClaude(claudeRoots().map((r) => r.dir), ownSlugs(), live)];
      if (gone.length) log(`tmp sweep: removed ${gone.length} old dirs`);
    } catch (e) { logOnce('sweep', `tmp sweep failed: ${(e as Error).message}`); }
  };
  let prev = { inodes: false, space: false };
  const watch = async () => {
    try {
      const v = volOf(), low = lowOn(v, MIN_FREE_PCT(), prev), c = crossing(prev, low);
      prev = low;
      if (!c.inodes && !c.space) return;
      sweep(); // free what is ours first, then tell the user what is left
      const w = volOf(), still = lowOn(w, MIN_FREE_PCT(), low);
      if (!still.inodes && !still.space) return;
      const text = warnText(still, w, await topConsumers(tmpdir(), still.inodes ? 'inodes' : 'space'));
      for (const x of workspaces()) x.notice(text);
    } catch (e) { logOnce('check', `tmp check failed: ${(e as Error).message}`); }
  };
  sweep();
  watch();
  const timers = [setInterval(sweep, Number(process.env.JARVIS_TMP_SWEEP_MS) || 30 * 60_000), setInterval(watch, Number(process.env.JARVIS_TMP_CHECK_MS) || 60_000)];
  for (const t of timers) t.unref();
  return () => timers.forEach(clearInterval); // tests
}
