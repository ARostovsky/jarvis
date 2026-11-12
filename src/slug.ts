// The journal key of a workspace is its name's slug plus the unique suffix of its id (`<slug>-<suffix>`): the slug follows a rename, the id and its suffix never change.
export const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ws';
export const idSuffix = (id: string) => id.slice(id.lastIndexOf('-'));
// The slug is capped so a long name cannot make a file name too long for the file system.
export const journalKey = (m: { id: string; name: string }) => (slugOf(m.name).slice(0, 40).replace(/-$/, '') || 'ws') + idSuffix(m.id);
// A 4-char id suffix from the clock that is not in `taken` (it repeats every ~28 minutes, and journals are matched to workspaces by it).
export function uniqueSuffix(taken: Set<string>, now = Date.now(), random = Math.random) {
  let s = now.toString(36).slice(-4);
  while (taken.has(s)) s = random().toString(36).slice(2, 6).padEnd(4, '0');
  return s;
}
