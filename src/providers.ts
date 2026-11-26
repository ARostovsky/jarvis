// Status providers: manifest validation, folder hashing and file rules, location rules, registry with staging and hash-pinned approval.
// Pure Node, no SDK and no import of agents.ts. The server runs only approved, unchanged provider code (invariant 11).
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, openSync, readSync, closeSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
// The default id rule. A manifest can only narrow it: both patterns must match.
export const DEFAULT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@#=+-]{0,199}$/;
export const NOTIFY = ['any', 'terminal', 'failed', 'none'] as const;
export const MAX_FILES = 50;
export const MAX_BYTES = 1024 * 1024;
const BANNED_DIRS = new Set(['.venv', 'node_modules', '__pycache__']);
// Row fields a slow_fields entry may name (`cost` means `costUsd`); never the identity or the state.
export const SLOW_FIELD_NAMES: Record<string, string> = { cost: 'costUsd', costUsd: 'costUsd', label: 'label', detail: 'detail', step: 'step', progress: 'progress', startedAt: 'startedAt', finishedAt: 'finishedAt', link: 'link', error: 'error' };

export type SlowField = { key: string; field: string; everyS: number };
export type Manifest = {
  schema: 1; name: string; kind: 'jobs'; description: string;
  command: string[]; args: string[]; mode: 'id' | 'ids'; cwd: string | null;
  pollS: number; timeoutS: number; slow: SlowField[];
  idPattern: string; maxIds: number;
  env: { pass: string[]; set: Record<string, string> };
  needs: string[]; notify: (typeof NOTIFY)[number];
  screenshot?: string;
};
// Where providers must not live or run: notes folders, project folders, and Jarvis's own data.
export type Locations = { data: string; notes: string[]; projects: string[] };
export type FileInfo = { path: string; size: number; sha256: string };
export type Loaded = { folder: string; manifest: Manifest; sha256: string; files: FileInfo[]; warnings: string[] };
export type Approval = { sha256: string; approvedAt: string; files: FileInfo[] };
export type ProviderInfo = { name: string; state: 'approved' | 'unapproved' | 'changed' | 'invalid'; folder: string; manifest?: Manifest; sha256?: string; error?: string; warnings?: string[] };

export const providersDir = () => process.env.JARVIS_PROVIDERS_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'jarvis', 'status-providers');
// The tests lower the minimum poll and slow interval with JARVIS_JOBS_MIN_POLL_S.
export function limits() {
  const t = Number(process.env.JARVIS_JOBS_MIN_POLL_S);
  const test = Number.isFinite(t) && t > 0;
  return { minPollS: test ? t : 15, minSlowS: test ? t : 900, maxSlowS: 3600, minTimeoutS: test ? Math.min(5, t) : 5 };
}

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
// Streamed, for a file that is not read whole into memory.
function shaFile(p: string): string {
  const h = createHash('sha256'), buf = Buffer.alloc(65536), fd = openSync(p, 'r');
  try { for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { closeSync(fd); }
  return h.digest('hex');
}
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown, what: string, max: number, len: number): string[] => {
  if (!Array.isArray(v) || v.length > max || v.some((s) => typeof s !== 'string' || !s || s.length > len || s.includes('\0'))) throw new Error(`manifest: ${what} must be a list of at most ${max} non-empty strings`);
  return v as string[];
};

// '30m', '90s', '1h' or null/true (the default 30m), clamped to the slow-field range.
function slowSeconds(v: unknown, key: string): number {
  const L = limits();
  if (v === null || v === true) return clamp(1800, L.minSlowS, L.maxSlowS);
  const m = typeof v === 'string' ? /^(\d+(?:\.\d+)?)([smh])$/.exec(v) : null;
  if (!m) throw new Error(`manifest: slow_fields.${key} must be like "30m" (15m to 60m), null or true`);
  return clamp(Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] as 's' | 'm' | 'h'], L.minSlowS, L.maxSlowS);
}

// Validates manifest.json content. `folderName`, when given, must equal `name`. Throws a one-line Error.
export function validateManifest(raw: unknown, folderName?: string): { manifest: Manifest; warnings: string[] } {
  if (!isObj(raw)) throw new Error('manifest: not a JSON object');
  const L = limits(), warnings: string[] = [];
  if (raw.schema !== 1) throw new Error(`manifest: schema must be 1 (got ${JSON.stringify(raw.schema)})`);
  const name = raw.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('manifest: name must match ^[a-z0-9][a-z0-9-]{0,39}$');
  if (folderName !== undefined && name !== folderName) throw new Error(`manifest: name "${name}" must equal the folder name "${folderName}"`);
  const kind = raw.kind ?? 'jobs';
  if (kind !== 'jobs') throw new Error(`manifest: kind "${String(kind)}" is not supported (only "jobs")`);
  const description = raw.description;
  if (typeof description !== 'string' || !description.trim() || description.length > 300 || /[\r\n]/.test(description)) throw new Error('manifest: description must be one non-empty line, at most 300 chars');
  const command = strList(raw.command, 'command', 40, 300);
  const args = raw.args === undefined ? ['{ids}'] : strList(raw.args, 'args', 40, 300);
  // Exactly one id placeholder; {ids} is a whole entry (one argv entry per id), {id} may sit inside an entry.
  const withIds = args.filter((a) => a.includes('{ids}')), withId = args.filter((a) => a.replace(/\{ids\}/g, '').includes('{id}'));
  if (withIds.length + withId.length !== 1) throw new Error('manifest: args must hold exactly one of {id} or {ids}, once');
  if (withIds.length && withIds[0] !== '{ids}') throw new Error('manifest: {ids} must be a whole args entry');
  if (command.some((c) => c.includes('{id'))) throw new Error('manifest: command must not hold {id} or {ids}');
  if (/^claude/.test(basename(command[0]))) throw new Error('manifest: the command may not be a claude binary (providers are deterministic, no LLM)');
  if (command.some((c) => basename(c) === 'claude')) throw new Error('manifest: the command may not run claude (providers are deterministic, no LLM)');
  let cwd: string | null = null;
  if (raw.cwd !== undefined && raw.cwd !== null) {
    if (typeof raw.cwd !== 'string' || !raw.cwd || raw.cwd.includes('\0')) throw new Error('manifest: cwd must be a path string or null');
    cwd = raw.cwd;
  }
  const num = (v: unknown, def: number, what: string) => {
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`manifest: ${what} must be a number`);
    return v;
  };
  const pollS = clamp(num(raw.pollS, 60, 'pollS'), L.minPollS, 3600);
  const timeoutS = clamp(num(raw.timeoutS, 60, 'timeoutS'), L.minTimeoutS, 300);
  const maxIds = Math.floor(clamp(num(raw.maxIds, 50, 'maxIds'), 1, 200));
  const slow: SlowField[] = [];
  if (raw.slow_fields !== undefined && raw.slow_fields !== null) {
    if (!isObj(raw.slow_fields)) throw new Error('manifest: slow_fields must be an object');
    for (const [key, v] of Object.entries(raw.slow_fields)) {
      const field = SLOW_FIELD_NAMES[key];
      if (!field) throw new Error(`manifest: slow_fields.${key} is not a row field that can be slow (${Object.keys(SLOW_FIELD_NAMES).join(', ')})`);
      slow.push({ key, field, everyS: slowSeconds(v, key) });
    }
  }
  let idPattern = DEFAULT_ID_RE.source;
  if (raw.idPattern !== undefined) {
    if (typeof raw.idPattern !== 'string' || raw.idPattern.length > 300) throw new Error('manifest: idPattern must be a regular expression string');
    try { new RegExp(raw.idPattern); } catch { throw new Error('manifest: idPattern is not a valid regular expression'); }
    idPattern = raw.idPattern;
  }
  const env = raw.env === undefined ? {} : raw.env;
  if (!isObj(env)) throw new Error('manifest: env must be an object');
  const envName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  const pass = env.pass === undefined ? [] : strList(env.pass, 'env.pass', 30, 64);
  for (const n of pass) if (!envName.test(n) || /^(ANTHROPIC_|CLAUDE)/i.test(n)) throw new Error(`manifest: env.pass "${n}" is not allowed`);
  const set: Record<string, string> = {};
  if (env.set !== undefined) {
    if (!isObj(env.set)) throw new Error('manifest: env.set must be an object');
    for (const [k, v] of Object.entries(env.set)) {
      if (!envName.test(k) || /^(ANTHROPIC_|CLAUDE)/i.test(k) || /^(PATH|PYTHONPATH|PYTHONHOME|NODE_OPTIONS|NODE_PATH|PERL5LIB|RUBYLIB|BASH_ENV|LD_AUDIT|LD_PRELOAD|LD_LIBRARY_PATH)$/.test(k) || /^(LD_|DYLD_)/.test(k) || typeof v !== 'string' || v.length > 500 || v.includes('\0')) throw new Error(`manifest: env.set.${k} is not allowed`);
      set[k] = v;
    }
  }
  const needs = raw.needs === undefined ? [] : strList(raw.needs, 'needs', 10, 200);
  const notify = raw.notify ?? 'any';
  if (!NOTIFY.includes(notify as never)) throw new Error(`manifest: notify must be one of ${NOTIFY.join(', ')}`);
  const known = new Set(['schema', 'name', 'kind', 'description', 'command', 'args', 'cwd', 'pollS', 'timeoutS', 'slow_fields', 'idPattern', 'maxIds', 'env', 'needs', 'notify', 'screenshot']);
  for (const k of Object.keys(raw)) if (!known.has(k)) warnings.push(`manifest: unknown field "${k}" ignored`);
  const manifest: Manifest = { schema: 1, name, kind: 'jobs', description: description.trim(), command, args, mode: withIds.length ? 'ids' : 'id', cwd, pollS, timeoutS, slow, idPattern, maxIds, env: { pass, set }, needs, notify: notify as Manifest['notify'] };
  // An invalid screenshot never invalidates the provider: it is dropped with a warning.
  if (raw.screenshot !== undefined) {
    const s = screenshotRel(raw.screenshot);
    if ('rel' in s) manifest.screenshot = s.rel; else warnings.push(`manifest: screenshot ignored (${s.warn})`);
  }
  return { manifest, warnings };
}

// The screenshot is only displayed, never run: png, webp or jpg, at most 1 MB, a plain file inside the provider folder.
export const SHOT_TYPES: Record<string, string> = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
// Syntax only (no disk): a relative path without `..`, with an image extension.
export function screenshotRel(v: unknown): { rel: string } | { warn: string } {
  if (typeof v !== 'string' || !v || v.length > 200 || v.includes('\0') || v.includes('\\')) return { warn: 'must be a relative path string' };
  if (isAbsolute(v) || /^[A-Za-z]:/.test(v)) return { warn: 'must not be an absolute path' };
  const segs = v.split('/');
  if (segs.some((x) => !x || x === '.' || x === '..')) return { warn: 'must stay inside the provider folder (no "..", "." or empty parts)' };
  if (!SHOT_TYPES[segs[segs.length - 1].split('.').pop()!.toLowerCase()] || !segs[segs.length - 1].includes('.')) return { warn: 'must be a .png, .webp or .jpg file' };
  return { rel: segs.join('/') };
}
// Full check on disk for the manifest field `screenshot` of a folder. `abs` is only set for a valid file.
export function checkScreenshot(dir: string, raw: unknown): { rel: string; abs: string; type: string; size: number } | { warn: string; exclude?: string } | null {
  if (!isObj(raw) || raw.screenshot === undefined) return null;
  const s = screenshotRel(raw.screenshot);
  if ('warn' in s) return s;
  try {
    let abs = dir;
    const segs = s.rel.split('/');
    for (const [i, seg] of segs.entries()) {
      abs = join(abs, seg);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) return { warn: 'is or passes a symlink (not allowed)' };
      if (i === segs.length - 1) {
        if (!st.isFile()) return { warn: 'is not a plain file' };
        if (st.size > MAX_BYTES) return { warn: 'is larger than 1 MB', exclude: s.rel }; // too big to show, and must not make the folder invalid
        const type = SHOT_TYPES[seg.split('.').pop()!.toLowerCase()];
        const head = Buffer.alloc(12), fd = openSync(abs, 'r');
        try { readSync(fd, head, 0, 12, 0); } finally { closeSync(fd); }
        if (!MAGIC[type](head)) return { warn: 'content does not match its extension' };
        // A file the program runs or reads as an argument must stay in the hash.
        if (isObj(raw) && [...(Array.isArray(raw.command) ? raw.command : []), ...(Array.isArray(raw.args) ? raw.args : [])].some((e) => typeof e === 'string' && !isAbsolute(e) && resolve(dir, e) === resolve(abs))) return { warn: 'is used by command or args (not allowed)' };
        return { rel: s.rel, abs, type, size: st.size };
      }
      if (!st.isDirectory()) return { warn: 'is not inside a folder' };
    }
  } catch { return { warn: 'file not found' }; }
  return { warn: 'file not found' };
}
// manifest.json as hashed: without the `screenshot` member (the picture file itself is hashed). Text without that member is hashed as is.
function manifestForHash(text: string): string {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return text; }
  if (!isObj(o) || !('screenshot' in o)) return text;
  const { screenshot: _s, ...rest } = o, want = JSON.stringify(rest);
  const member = '"screenshot"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"';
  for (const re of [new RegExp(`\\s*,\\s*${member}`), new RegExp(`${member}\\s*,\\s*`), new RegExp(member)]) {
    const t = text.replace(re, '');
    try { if (JSON.stringify(JSON.parse(t)) === want) return t; } catch {}
  }
  return want;
}

// An id is valid when the default rule and the manifest rule both match: the manifest can only narrow.
export function idOk(m: Pick<Manifest, 'idPattern'>, id: unknown): id is string {
  return typeof id === 'string' && DEFAULT_ID_RE.test(id) && new RegExp(m.idPattern).test(id);
}

// Sorted `path NUL size NUL sha256(file)` over every file; only plain files and folders, within the size limits.
export function hashFolder(dir: string): { sha256: string; files: FileInfo[] } {
  const files: FileInfo[] = [];
  let total = 0, mtext: string | undefined, skip: string | undefined;
  try {
    const raw = JSON.parse(mtext = readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const c = checkScreenshot(dir, raw);
    if (c && 'exclude' in c) skip = c.exclude;
  } catch {}
  const walk = (abs: string, rel: string) => {
    for (const e of readdirSync(abs).sort()) {
      const p = join(abs, e), r = rel ? `${rel}/${e}` : e, st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`provider folder: ${r} is a symlink (not allowed)`);
      if (st.isDirectory()) {
        if (BANNED_DIRS.has(e)) throw new Error(`provider folder: ${r} is not allowed (dependencies come from a tool cache, e.g. uv run --with)`);
        walk(p, r);
      } else if (st.isFile()) {
        // The screenshot file stays in the hash (approved code may read it), but an oversize one only needs hashing, not the 1 MB folder limit.
        if (r === skip) { files.push({ path: r, size: st.size, sha256: shaFile(p) }); continue; }
        if (files.length >= MAX_FILES) throw new Error(`provider folder: more than ${MAX_FILES} files`);
        total += st.size;
        if (total > MAX_BYTES) throw new Error('provider folder: more than 1 MB');
        if (r === 'manifest.json' && mtext !== undefined) { const t = manifestForHash(mtext); files.push({ path: r, size: Buffer.byteLength(t), sha256: sha(t) }); } else files.push({ path: r, size: st.size, sha256: sha(readFileSync(p)) });
      } else throw new Error(`provider folder: ${r} is not a plain file`);
    }
  };
  if (lstatSync(dir).isSymbolicLink()) throw new Error('provider folder: the folder itself is a symlink (not allowed)');
  walk(dir, '');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { sha256: sha(files.map((f) => `${f.path}\0${f.size}\0${f.sha256}`).join('\n')), files };
}

// realpath of the deepest existing ancestor plus the rest, so a path that does not exist yet still resolves through symlinked parents.
function real(p: string): string {
  const abs = resolve(p), rest: string[] = [];
  for (let cur = abs; ; cur = dirname(cur)) {
    try { return join(realpathSync(cur), ...rest.reverse()); } catch { rest.push(basename(cur)); }
    if (dirname(cur) === cur) return abs;
  }
}
export const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const insideAny = (child: string, parents: string[]) => parents.some((p) => inside(child, real(p)));

// Entries of command and args that name a file in the provider folder (relative, existing), resolved to absolute paths.
export function folderFiles(folder: string, m: Pick<Manifest, 'command' | 'args'>): string[] {
  return [...m.command, ...m.args].filter((e) => !isAbsolute(e) && !e.startsWith('-') && existsSync(join(folder, e)) && lstatSync(join(folder, e)).isFile()).map((e) => join(folder, e));
}

// Location rules (after realpath): folder, relative command files, absolute command entries and absolute env.set values outside notes, project folders, worktrees and workspaces;
// cwd outside notes, worktrees and $DATA. A cwd inside a project folder is allowed with a warning. Returns warnings; throws on a violation.
export function checkLocations(folder: string, m: Manifest, loc: Locations): string[] {
  const data = real(loc.data), warnings: string[] = [];
  const barred = [...loc.notes, ...loc.projects, join(data, 'worktrees'), join(data, 'workspaces')];
  const f = real(folder);
  if (insideAny(f, barred)) throw new Error(`provider folder ${f} is inside a notes folder, a project folder or a Jarvis worktree (agents may edit it)`);
  for (const [what, list] of [['command', m.command], ['args', m.args]] as const) for (let e of list) {
    if (what === 'args' && e.startsWith('-')) { e = e.slice(e.indexOf('=') + 1); if (e.startsWith('-') || !isAbsolute(e)) continue; } // --opt=/abs/path: check the path
    if (!isAbsolute(e)) {
      const p = real(join(f, e));
      if (e.includes('/') && !inside(p, f)) throw new Error(`${what} entry "${e}" leaves the provider folder`);
    } else if (insideAny(real(e), barred)) throw new Error(`${what} entry ${e} is inside a notes folder, a project folder or a Jarvis worktree`);
  }
  for (const [k, v] of Object.entries(m.env.set)) {
    const lit = v.split('{')[0]; // literal prefix before a {id} placeholder
    if (isAbsolute(lit) && insideAny(real(lit), barred)) throw new Error(`env.set.${k} ${v} is inside a notes folder, a project folder or a Jarvis worktree; compute the path inside the script, or use a location outside project folders and the Jarvis data folder`);
  }
  if (m.cwd !== null) {
    const c = real(isAbsolute(m.cwd) ? m.cwd : join(f, m.cwd));
    if (insideAny(c, loc.notes) || inside(c, join(data, 'worktrees')) || inside(c, data)) throw new Error(`cwd ${c} is a notes folder, a worktree or inside Jarvis's data folder`);
    if (insideAny(c, loc.projects)) warnings.push(`runs inside ${c}, which agents may edit`);
  }
  return warnings;
}

// Reads and validates a folder: manifest, hash and file rules, and (when `loc` is given) the location rules.
export function loadProvider(folder: string, opts: { loc?: Locations; name?: string } = {}): Loaded {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')); } catch (e) { throw new Error(`manifest.json: ${(e as Error).message}`); }
  const { manifest, warnings } = validateManifest(raw, opts.name);
  if (manifest.screenshot) {
    const c = checkScreenshot(folder, raw);
    if (c && 'warn' in c) { delete manifest.screenshot; warnings.push(`manifest: screenshot ignored (${c.warn})`); }
  }
  const { sha256, files } = hashFolder(folder);
  if (opts.loc) warnings.push(...checkLocations(folder, manifest, opts.loc));
  return { folder: real(folder), manifest, sha256, files, warnings };
}

const writeJson = (file: string, v: unknown) => {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  renameSync(tmp, file);
};

export type RegistryOpts = {
  data: string; dir?: string; locations: () => Locations;
  // Test hook: called between the steps of an install; throw to simulate a crash.
  onStep?: (step: 'copied' | 'backed-up' | 'moved-old' | 'swapped' | 'recorded') => void;
};

export function createRegistry(o: RegistryOpts) {
  const dir = o.dir ?? providersDir();
  const file = join(o.data, 'providers.json'), staging = join(o.data, 'provider-staging'), old = join(o.data, 'provider-old');
  const step = o.onStep ?? (() => {});
  const approvals = (): Record<string, Approval> => {
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch { return {}; }
    try { const v = JSON.parse(text); if (isObj(v)) return v as Record<string, Approval>; } catch {}
    try { renameSync(file, `${file}.bad`); } catch {} // keep the unreadable file, never silently drop approvals
    return {};
  };

  // A crash during an install leaves `.prev-<name>` (the old version) with no live folder: put it back.
  function recover() {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      if (e.startsWith('.prev-')) {
        if (existsSync(join(dir, e.slice(6)))) rmSync(p, { recursive: true, force: true });
        else renameSync(p, join(dir, e.slice(6)));
      } else if (e.startsWith('.new-')) rmSync(p, { recursive: true, force: true });
    }
  }
  recover();

  function info(name: string): ProviderInfo {
    const folder = join(dir, name);
    try {
      const l = loadProvider(folder, { loc: o.locations(), name });
      const ap = approvals()[name];
      return { name, folder: l.folder, manifest: l.manifest, sha256: l.sha256, warnings: l.warnings, state: !ap ? 'unapproved' : ap.sha256 === l.sha256 ? 'approved' : 'changed' };
    } catch (e) {
      return { name, folder, state: 'invalid', error: (e as Error).message };
    }
  }
  const list = (): ProviderInfo[] => {
    let names: string[] = [];
    try { names = readdirSync(dir).filter((n) => NAME_RE.test(n) && lstatSync(join(dir, n)).isDirectory()); } catch {}
    return names.sort().map(info);
  };

  // The folder to run: only when approved and byte-identical to what was approved; otherwise throws with the reason.
  function use(name: string): Loaded {
    if (!NAME_RE.test(name) || !existsSync(join(dir, name))) throw new Error(`unknown provider "${name}"`);
    const i = info(name);
    if (i.state === 'invalid') throw new Error(`provider ${name} is invalid: ${i.error}`);
    if (i.state === 'unapproved') throw new Error(`provider ${name} is not approved`);
    if (i.state === 'changed') throw new Error('provider files changed, approve again');
    return loadProvider(i.folder, { loc: o.locations(), name });
  }

  // Copies a draft into staging (the user approves exactly this copy; `check` may throw to refuse it first). Refuses a draft in a notes folder. Runs nothing.
  function stage(src: string, check?: (l: Loaded) => void): Loaded & { stagingDir: string } {
    const s = real(src);
    if (!existsSync(s) || !lstatSync(s).isDirectory()) throw new Error(`${src} is not a folder`);
    if (insideAny(s, o.locations().notes)) throw new Error('the provider draft is inside a notes folder; build it elsewhere (agents may edit notes)');
    const l = loadProvider(s);
    check?.(l); // before staging is touched: a refused draft must not replace or delete a staged copy
    const stagingDir = join(staging, `${l.manifest.name}-${l.sha256.slice(0, 16)}`);
    mkdirSync(staging, { recursive: true });
    rmSync(stagingDir, { recursive: true, force: true });
    cpSync(s, stagingDir, { recursive: true });
    if (hashFolder(stagingDir).sha256 !== l.sha256) { rmSync(stagingDir, { recursive: true, force: true }); throw new Error('the draft changed while it was copied; try again'); }
    return { ...l, stagingDir };
  }
  const reject = (name: string, hash: string) => rmSync(join(staging, `${name}-${hash.slice(0, 16)}`), { recursive: true, force: true });

  // Installs the staged copy (or records a hand-placed folder) after re-hashing it; a stale hash fails. The old version goes to provider-old/.
  function approve(name: string, hash: string): Approval {
    if (!NAME_RE.test(name)) throw new Error(`unknown provider "${name}"`);
    const target = join(dir, name), staged = join(staging, `${name}-${hash.slice(0, 16)}`);
    let src: string;
    if (existsSync(staged)) {
      const h = hashFolder(staged);
      if (h.sha256 !== hash) throw new Error('stale: the staged copy no longer matches the hash that was shown');
      src = staged;
    } else if (existsSync(target) && hashFolder(target).sha256 === hash) src = target;
    else throw new Error('stale: nothing matches the hash that was shown; propose or place the provider again');
    const l = loadProvider(src, { name });
    mkdirSync(dir, { recursive: true });
    checkLocations(target, l.manifest, o.locations());
    if (src !== target) {
      const tmp = join(dir, `.new-${name}-${randomBytes(4).toString('hex')}`), prev = join(dir, `.prev-${name}`);
      cpSync(src, tmp, { recursive: true });
      step('copied');
      if (hashFolder(tmp).sha256 !== hash) { rmSync(tmp, { recursive: true, force: true }); throw new Error('stale: the copy does not match the hash'); }
      if (existsSync(target)) {
        mkdirSync(old, { recursive: true });
        const day = new Date().toISOString().slice(0, 10);
        let bak = join(old, `${name}-${day}`);
        for (let n = 2; existsSync(bak); n++) bak = join(old, `${name}-${day}-${n}`);
        cpSync(target, bak, { recursive: true });
        step('backed-up');
        rmSync(prev, { recursive: true, force: true });
        renameSync(target, prev);
        step('moved-old');
      }
      renameSync(tmp, target);
      step('swapped');
      rmSync(prev, { recursive: true, force: true });
      rmSync(staged, { recursive: true, force: true });
    }
    mkdirSync(o.data, { recursive: true });
    const rec: Approval = { sha256: hash, approvedAt: new Date().toISOString(), files: l.files };
    writeJson(file, { ...approvals(), [name]: rec });
    step('recorded');
    return rec;
  }

  const stagingDir = (name: string, hash: string) => join(staging, `${name}-${hash.slice(0, 16)}`);
  return { dir, list, info, use, stage, reject, approve, approvals, recover, stagingDir };
}
export type Registry = ReturnType<typeof createRegistry>;
