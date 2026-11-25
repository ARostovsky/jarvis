// Open items source: reads <notes>/workspaces/<id>/open-items.md into the `open-items` checklist panel. Read-only: the arbiter edits the file, the panel only shows it. No SDK, no jobs or providers; the panels API is injected so tests need no server.
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseOpenItems, workspaceDir, type OpenItem } from './notes-layout.ts';

// Structural copies of the panels seam types (src/panels.ts owns the real ones).
type Panel = { panelId: string; kind: string; title: string; data: unknown };
type PanelStatus = { panelId: string; at: number; ok: boolean; error?: string; detail?: unknown };
export type PanelsApi = {
  setPanel(p: Panel): unknown;
  removePanel(id: string): unknown;
  setPanelStatus(s: PanelStatus): unknown;
};

export const OPEN_ITEMS_PANEL_ID = 'open-items';
export const openItemsFile = (m: { id: string; notes: string }) => join(workspaceDir(m), 'open-items.md');

export type PanelItem = { key: string; text: string; date: string; you: boolean; kind: 'open' | 'parked' | 'done'; reason?: string; check?: string };
export const MAX_ITEMS = 200, MAX_TEXT = 200;
const MAX_FILE = 1_000_000, RETRY_MS = 5000;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
// Control characters become spaces; format characters (bidi overrides, zero width) are dropped.
const strip = (s: string) => s.replace(/\p{Cf}/gu, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
const REASON = /^(.*\S)\s+\((waiting on user|not verified)\)$/;

// The line text of a parsed item.
const lineOf = (i: OpenItem) =>
  i.kind === 'done' ? `- [x] ${i.text} verified ${i.date}: ${i.check}` : `- [${i.kind === 'parked' ? '~' : ' '}] ${i.date} ${i.you ? '(you) ' : ''}${i.text}`;
// Item identity: a short hash of the normalized line (a fixed size however long the line is). Identical lines count once.
export const lineKey = (line: string) => createHash('sha256').update(norm(line)).digest('hex').slice(0, 16);
export const keyOf = (i: OpenItem) => lineKey(lineOf(i));

// Panel data from file text: caps, control characters stripped, duplicates once, sorted (open or parked "(you)" first, other open or parked in file order, then done).
export function buildData(text: string): { items: PanelItem[]; invalid: number; truncated: number } {
  const { items: parsed, invalid } = parseOpenItems(text);
  const seen = new Set<string>(), items: PanelItem[] = [];
  let truncated = 0;
  for (const p of parsed) {
    const key = keyOf(p);
    if (seen.has(key)) continue;
    seen.add(key);
    if (items.length >= MAX_ITEMS) { truncated++; continue; }
    const it: PanelItem = { key, text: strip(p.text).slice(0, MAX_TEXT), date: p.date, you: p.you, kind: p.kind };
    if (p.kind === 'parked') {
      const m = REASON.exec(it.text);
      if (m) { it.text = m[1]; it.reason = m[2]; }
    }
    if (p.check !== undefined) it.check = strip(p.check).slice(0, MAX_TEXT);
    items.push(it);
  }
  const rank = (i: PanelItem) => (i.kind === 'done' ? 2 : i.you ? 0 : 1);
  return { items: items.map((it, n) => [it, n] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]), invalid: invalid.length, truncated };
}

// Reads a plain small file without following a symlink; undefined when missing, throws on other errors.
function read(p: string): string | undefined {
  let fd: number;
  try { fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('open-items.md is not a plain file');
    if (st.size > MAX_FILE) throw new Error('open-items.md is larger than 1 MB');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

export type OpenItemsSource = {
  start(): void; // first read and start the watcher
  refresh(): void; // re-read the file now (GET /panels, startup); calls setPanel only on a real change
  stop(): void;
};

export function createOpenItems(o: { panels: PanelsApi; file: string; debounceMs?: number }): OpenItemsSource {
  const { panels, file } = o, debounceMs = o.debounceMs ?? 300;
  let shown: string | undefined; // JSON of what the panel shows; undefined = panel absent (or not yet known)
  let known = false; // false until the first refresh: a restored panel is removed even if we never showed one
  let statusKey: string | undefined; // undefined: the first refresh always emits a status
  let watcher: FSWatcher | undefined, timer: NodeJS.Timeout | undefined, retry: NodeJS.Timeout | undefined, running = false;

  const status = (s: { ok: boolean; error?: string; detail?: unknown }) => {
    const k = JSON.stringify(s);
    if (k === statusKey) return;
    statusKey = k;
    panels.setPanelStatus({ panelId: OPEN_ITEMS_PANEL_ID, at: Date.now(), ...s });
  };
  // Watch the folder, not the file (a rewrite may replace the inode). While no watcher runs (folder missing at start, folder removed, watcher error) a slow timer retries.
  function watchDir() {
    if (watcher || !running) return;
    clearTimeout(retry);
    const dir = dirname(file), name = basename(file);
    const drop = (w: FSWatcher) => {
      w.close();
      if (watcher === w) watcher = undefined;
      clearTimeout(timer);
      timer = setTimeout(refresh, debounceMs); // refresh starts a new watcher, or arms the retry
      timer.unref();
    };
    try {
      const w = watch(dir, (ev, f) => {
        // Linux reports a removed watched folder as a lone 'rename' with the folder's own name; the watch is dead then.
        if (!existsSync(dir) || (ev === 'rename' && f === basename(dir))) return drop(w);
        if (f && f !== name) return;
        clearTimeout(timer);
        timer = setTimeout(refresh, debounceMs);
        timer.unref();
      });
      w.on('error', () => drop(w));
      w.unref();
      watcher = w;
    } catch {
      retry = setTimeout(refresh, RETRY_MS); // folder missing
      retry.unref();
    }
  }

  function refresh() {
    watchDir();
    let text: string | undefined;
    try { text = read(file); } catch (e) { status({ ok: false, error: (e as Error).message }); return; } // keep what is shown on a read error
    const d = text === undefined ? undefined : buildData(text);
    const detail = d && (d.invalid || d.truncated) ? { ...(d.invalid ? { invalid: d.invalid } : {}), ...(d.truncated ? { truncated: d.truncated } : {}) } : undefined;
    status({ ok: true, ...(detail ? { detail } : {}) });
    if (!d || !d.items.length) {
      if (!known || shown !== undefined) panels.removePanel(OPEN_ITEMS_PANEL_ID);
      shown = undefined; known = true;
      return;
    }
    const panel: Panel = { panelId: OPEN_ITEMS_PANEL_ID, kind: 'checklist', title: 'Open items', data: { items: d.items } };
    const k = JSON.stringify(panel);
    known = true;
    if (k === shown) return;
    shown = k;
    panels.setPanel(panel);
  }

  function start() {
    running = true;
    refresh();
  }
  function stop() {
    running = false;
    clearTimeout(timer);
    clearTimeout(retry);
    watcher?.close();
    watcher = undefined;
  }
  return { start, refresh, stop };
}
