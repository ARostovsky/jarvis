// Read side of job source approval: the job source list for the UI and the file texts of an approval card. No SDK, no workspaces.
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkScreenshot, hashFolder, MAX_BYTES, NAME_RE, type Registry } from './job-sources.ts';

export const HASH_RE = /^[0-9a-f]{64}$/;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const STATUS = { approved: 'approved', unapproved: 'not-approved', changed: 'changed', invalid: 'invalid' } as const;

export function jobSourceList(reg: Registry) {
  const ap = reg.approvals();
  return reg.list().map((i) => ({
    name: i.name, kind: i.manifest?.kind ?? 'jobs', description: i.manifest?.description, status: STATUS[i.state], hash: i.sha256,
    approvedAt: ap[i.name]?.approvedAt, pollS: i.manifest?.pollS, needs: i.manifest?.needs ?? [], idPattern: i.manifest?.idPattern, error: i.error, warnings: i.warnings, screenshot: !!i.manifest?.screenshot,
  }));
}

// Texts for the card: the staged copy of that hash, or the installed folder when it has exactly that hash. 409 when neither matches.
// At most 400 lines and 64 KB per file; `truncated` says so. A file with a NUL byte is not shown.
export function jobSourceFiles(reg: Registry, name: string, hash: string) {
  if (!NAME_RE.test(name) || !HASH_RE.test(hash)) throw fail(400, 'bad name or hash');
  const dirs = [reg.stagingDir(name, hash), reg.folderOf(name)];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    let h;
    try { h = hashFolder(d); } catch { continue; }
    if (h.sha256 !== hash) continue;
    return h.files.map((f) => {
      const buf = readFileSync(join(d, f.path));
      if (buf.includes(0)) return { ...f, binary: true };
      const lines = buf.toString('utf8').slice(0, 65536).split('\n');
      return { ...f, text: lines.slice(0, 400).join('\n'), truncated: buf.length > 65536 || lines.length > 400 };
    });
  }
  throw fail(409, 'stale: no copy matches that hash any more');
}

// Read-only details of one job source the registry already knows: manifest text with env values masked, the file names, approval state and both hashes.
// The name is looked up in the registry (never joined into a path from the request); only manifest.json is read, at most 64 KB.
export function jobSourceDetails(reg: Registry, name: string) {
  const i = reg.list().find((p) => p.name === name);
  if (!NAME_RE.test(name) || !i) throw fail(404, 'unknown job source');
  const ap = reg.approvals()[name];
  let manifestText: string | undefined, manifestError: string | undefined, files: string[] = [], screenshot: { path: string; type: string; size: number } | undefined;
  try {
    const buf = readFileSync(join(i.folder, 'manifest.json'));
    if (buf.length > 65536) throw new Error('manifest.json is larger than 64 KB');
    const m = JSON.parse(buf.toString('utf8'));
    const c = checkScreenshot(i.folder, m);
    if (c && 'rel' in c) screenshot = { path: c.rel, type: c.type, size: c.size };
    if (m?.env && typeof m.env === 'object') {
      const set = m.env.set;
      if (set && typeof set === 'object' && !Array.isArray(set)) m.env.set = Object.fromEntries(Object.keys(set).map((k) => [k, '••••']));
      else if (set !== undefined) m.env = '••••'; // not the documented shape: show nothing of it
    }
    manifestText = JSON.stringify(m, null, 2);
  } catch (e) { manifestError = (e as Error).message; }
  try { files = hashFolder(i.folder).files.map((f) => f.path); } catch {}
  return {
    name, folder: i.folder, status: STATUS[i.state], manifestText, manifestError, files,
    docs: files.filter((f) => /^(readme|skill)(\.[a-z]+)?$/i.test(f)),
    warnings: i.warnings, screenshot,
    currentHash: i.sha256, approvedHash: ap?.sha256, approvedAt: ap?.approvedAt, error: i.error,
  };
}

// The one validated screenshot file of a job source the registry knows, or a 404. Only displayed, never run. Same registry-only lookup as the details.
export function jobSourceScreenshot(reg: Registry, name: string): { type: string; data: Buffer } {
  const i = NAME_RE.test(name) ? reg.list().find((p) => p.name === name) : undefined;
  if (!i) throw fail(404, 'unknown job source');
  let c;
  try { c = checkScreenshot(i.folder, JSON.parse(readFileSync(join(i.folder, 'manifest.json'), 'utf8'))); } catch { c = null; }
  if (!c || !('abs' in c)) throw fail(404, 'no screenshot');
  // One open without following a symlink; size and type come from the fd, so a swap after the check cannot change what is read.
  let fd: number;
  try { fd = openSync(c.abs, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw fail(404, 'no screenshot'); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) throw fail(404, 'no screenshot');
    return { type: c.type, data: readFileSync(fd) };
  } finally { closeSync(fd); }
}
