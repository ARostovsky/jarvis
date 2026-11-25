// Read side of provider approval: the provider list for the UI and the file texts of an approval card. No SDK, no workspaces.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashFolder, NAME_RE, type Registry } from './providers.ts';

export const HASH_RE = /^[0-9a-f]{64}$/;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const STATUS = { approved: 'approved', unapproved: 'not-approved', changed: 'changed', invalid: 'invalid' } as const;

export function providerList(reg: Registry) {
  const ap = reg.approvals();
  return reg.list().map((i) => ({
    name: i.name, kind: i.manifest?.kind ?? 'jobs', description: i.manifest?.description, status: STATUS[i.state], hash: i.sha256,
    approvedAt: ap[i.name]?.approvedAt, pollS: i.manifest?.pollS, needs: i.manifest?.needs ?? [], idPattern: i.manifest?.idPattern, error: i.error, warnings: i.warnings,
  }));
}

// Texts for the card: the staged copy of that hash, or the installed folder when it has exactly that hash. 409 when neither matches.
// At most 400 lines and 64 KB per file; `truncated` says so. A file with a NUL byte is not shown.
export function providerFiles(reg: Registry, name: string, hash: string) {
  if (!NAME_RE.test(name) || !HASH_RE.test(hash)) throw fail(400, 'bad name or hash');
  const dirs = [reg.stagingDir(name, hash), join(reg.dir, name)];
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
