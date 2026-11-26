// Per-workspace notes layout: <notes>/workspaces/<workspace-id>/{status.md,open-items.md}. Pure helpers (no SDK, no registry), so the prompts and the file format are unit-tested.
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync, constants } from 'node:fs';
import { join } from 'node:path';

type Meta = { id: string; name: string; notes?: string };

export const workspaceDir = (m: { id: string; notes: string }) => join(m.notes, 'workspaces', m.id);

// The one sentence that tells an arbiter how to write open items; the parser below reads exactly this.
export const OPEN_ITEMS_FORMAT = `Keep open items only in your open-items.md, one per line: '- [ ] <DD-MM-YYYY> <text>' open, '- [~] <DD-MM-YYYY> <text>' parked (end the text with "(waiting on user)" or "(not verified)"), '- [x] <text> verified <DD-MM-YYYY>: <what, by which check>' done and verified. Put the tag (you) right after the date, as in '- [ ] <DD-MM-YYYY> (you) <text>', only for an item that only the user can do or decide; never for routine work such as a push, an e2e run or a verification. Never write [x] without a real check. When the goal is done remove the [x] lines.`;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

const statusTemplate = (name: string, id: string) => `# Status: ${oneLine(name)}
Workspace id: ${id}. Only this workspace edits this file. Open items live in open-items.md.

Summary: (none yet; one line, what this workspace is doing now)

## Current state
(newest facts first; the state, not history; history goes to the journal)
`;

const openItemsTemplate = (name: string) => `# Open items: ${oneLine(name)}
<!-- One item per line, strict format, parsed by Jarvis. Only this workspace edits this file. Dates are DD-MM-YYYY. -->
<!-- - [ ] <DD-MM-YYYY> [(you)] <text>        open; the optional tag (you) marks what only the user can do or decide
     - [~] <DD-MM-YYYY> [(you)] <text>        parked: waiting on the user, or not verified; do not re-check or list unless the goal needs it
     - [x] <text> verified <DD-MM-YYYY>: <what, by which check>   done and verified -->
`;

// A planted symlink must not make the server write outside the notes folder.
function plainDir(p: string) {
  const st = lstatSync(p);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`notes: ${p} is not a plain folder`);
}

// Creates workspaces/<id>/ with its two files, create-only: an existing file is never touched, followed or overwritten.
// Returns the files this call created (empty when everything was there). No notes folder: nothing happens.
export function ensureWorkspaceNotes(meta: Meta): { created: string[] } {
  if (!meta.notes) return { created: [] };
  if (!/^[a-z0-9-]+$/.test(meta.id)) throw new Error(`notes: bad workspace id ${meta.id}`);
  const root = join(meta.notes, 'workspaces'), dir = workspaceDir({ id: meta.id, notes: meta.notes });
  mkdirSync(root, { recursive: true });
  plainDir(root);
  mkdirSync(dir, { recursive: true });
  plainDir(dir);
  mkdirSync(join(dir, 'journal'), { recursive: true });
  plainDir(join(dir, 'journal'));
  const created: string[] = [];
  for (const [file, text] of [['status.md', statusTemplate(meta.name, meta.id)], ['open-items.md', openItemsTemplate(meta.name)]]) {
    const p = join(dir, file);
    try {
      const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      try { writeSync(fd, text); } finally { closeSync(fd); }
      created.push(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  return { created };
}

// Restore from the archive: workspaces/_archive/<id> goes back to workspaces/<id>. An existing workspaces/<id> is never overwritten: both stay and a warning is logged.
export function restoreArchivedNotes(meta: Meta): 'moved' | 'collision' | 'none' {
  if (!meta.notes || !/^[a-z0-9-]+$/.test(meta.id)) return 'none';
  const root = join(meta.notes, 'workspaces'), from = join(root, '_archive', meta.id), to = join(root, meta.id);
  const st = lstatSync(from, { throwIfNoEntry: false });
  if (!st?.isDirectory()) return 'none'; // missing, a symlink or a file
  if (lstatSync(to, { throwIfNoEntry: false })) {
    console.warn(`notes: not restoring ${from}: ${to} exists`);
    return 'collision';
  }
  plainDir(root);
  plainDir(join(root, '_archive'));
  renameSync(from, to);
  return 'moved';
}

// Open and parked items in workspaces/<id>/open-items.md (0/0 when there is no file).
export function countOpenItems(meta: { id: string; notes: string }): { open: number; parked: number } {
  const items = parseOpenItems(readPlain(join(workspaceDir(meta), 'open-items.md')) ?? '').items;
  return { open: items.filter((i) => i.kind === 'open').length, parked: items.filter((i) => i.kind === 'parked').length };
}

// Archive: workspaces/<id> moves to workspaces/_archive/<id> (atomic rename). A missing source does nothing; an existing target is never overwritten: both stay, a warning is logged and 'collision' returned. Counts are taken before the move.
export function archiveNotes(meta: Meta): { result: 'moved' | 'collision' | 'none'; open: number; parked: number } {
  if (!meta.notes || !/^[a-z0-9-]+$/.test(meta.id)) return { result: 'none', open: 0, parked: 0 };
  const m = { id: meta.id, notes: meta.notes }, from = workspaceDir(m), root = join(meta.notes, 'workspaces'), arch = join(root, '_archive'), to = join(arch, meta.id);
  if (!lstatSync(from, { throwIfNoEntry: false })?.isDirectory()) return { result: 'none', open: 0, parked: 0 }; // missing, a symlink or a file
  const counts = countOpenItems(m);
  if (lstatSync(to, { throwIfNoEntry: false })) {
    console.warn(`notes: not archiving ${from}: ${to} exists`);
    return { result: 'collision', ...counts };
  }
  plainDir(root);
  mkdirSync(arch, { recursive: true });
  plainDir(arch);
  renameSync(from, to);
  return { result: 'moved', ...counts };
}

// One-shot, idempotent: archived workspaces (not in `active`) whose notes folder still sits in workspaces/<id>/ move to _archive. Returns what moved; one failure never stops the rest.
export function migrateArchivedNotes(archived: Meta[], active: (id: string) => boolean): Meta[] {
  const moved: Meta[] = [];
  for (const m of archived) {
    if (!m.notes || active(m.id)) continue;
    try { if (archiveNotes(m).result === 'moved') { moved.push(m); console.log(`notes: moved the folder of archived workspace ${m.id} to ${join(m.notes, 'workspaces', '_archive', m.id)}`); } } catch (e) { console.warn(`notes: cannot move the folder of archived workspace ${m.id}: ${(e as Error).message}`); }
  }
  return moved;
}

export type OpenItem = { kind: 'open' | 'parked' | 'done'; date: string; text: string; you: boolean; check?: string };
const DATE = '(\\d{2}-\\d{2}-\\d{4}|\\d{4}-\\d{2}-\\d{2})'; // DD-MM-YYYY as written by the prompts; YYYY-MM-DD tolerated
const OPEN_RE = new RegExp(`^- \\[( |~)\\] ${DATE} (\\(you\\) )?(?!\\(you\\)$)(\\S.*)$`);
const DONE_RE = new RegExp(`^- \\[[xX]\\] (\\S.*) verified ${DATE}: (\\S.*)$`); // greedy: the last " verified <date>:" splits the line

// A date as DD-MM-YYYY (what the prompts say) or YYYY-MM-DD, with a real day and month.
function validDate(d: string) {
  const [a, b, c] = d.split('-').map(Number);
  const [y, m, day] = d.indexOf('-') === 4 ? [a, b, c] : [c, b, a];
  const t = new Date(Date.UTC(y, m - 1, day));
  return y >= 1000 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day;
}
const COMMENT_LINES = 8; // an HTML comment hides lines only when it closes within this many lines and holds no item line at column 0

// Reads an open-items.md. Prose, headers, blanks and closed HTML comments are ignored; a line that looks like an item ("- [", also indented) but fits no format or has an impossible date is returned in `invalid`, never dropped.
export function parseOpenItems(text: string): { items: OpenItem[]; invalid: string[] } {
  const items: OpenItem[] = [], invalid: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('<!--') && !/^\s*- \[/.test(line) && !line.slice(line.indexOf('<!--')).includes('-->')) {
      let k = 1;
      while (k <= COMMENT_LINES && i + k < lines.length && !lines[i + k].startsWith('- [') && !lines[i + k].includes('-->')) k++;
      if (k <= COMMENT_LINES && i + k < lines.length && lines[i + k].includes('-->') && !lines[i + k].startsWith('- [')) { i += k; continue; }
    }
    if (!/^\s*- \[/.test(line)) continue;
    const o = OPEN_RE.exec(line), d = DONE_RE.exec(line);
    if (o && validDate(o[2])) items.push({ kind: o[1] === '~' ? 'parked' : 'open', date: o[2], text: o[4], you: !!o[3] });
    else if (d && validDate(d[2])) items.push({ kind: 'done', date: d[2], text: d[1], you: false, check: d[3] });
    else invalid.push(line);
  }
  return { items, invalid };
}

// Reads a plain small file without following a symlink (agents write these folders); undefined for anything else.
function readPlain(p: string): string | undefined {
  let fd: number;
  try { fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return undefined; }
  try {
    const st = fstatSync(fd);
    if (st.isFile() && st.size <= 1_000_000) return readFileSync(fd, 'utf8');
  } catch {} finally { closeSync(fd); }
}

const clean = (s: string) => oneLine(s).replace(/[[\]]/g, '');

// <notes>/workspaces/index.md: one line per workspace folder, generated by the server and never edited by arbiters. Written through a temp file and a rename; a failure is logged, never thrown.
export function writeIndex(notes: string, nameOf: (id: string) => string | undefined = () => undefined): string | undefined {
  const root = join(notes, 'workspaces'), tmp = join(root, `.index-${randomBytes(6).toString('hex')}.tmp`); // random and O_EXCL: a name an agent planted (a link to another file) is never opened
  try {
    plainDir(root);
    const lines: string[] = [];
    for (const e of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || !/^[a-z0-9-]+$/.test(e.name)) continue; // a symlink is not a directory here
      const dir = join(root, e.name);
      const summary = /^Summary:[ \t]*(\S.*)$/m.exec(readPlain(join(dir, 'status.md')) ?? '')?.[1];
      const open = parseOpenItems(readPlain(join(dir, 'open-items.md')) ?? '').items.filter((i) => i.kind !== 'done');
      lines.push(`- [${clean(nameOf(e.name) ?? e.name)}](${e.name}/status.md): ${summary && !summary.startsWith('(none yet') ? oneLine(summary) : '-'} (open: ${open.length}, you: ${open.filter((i) => i.you).length})`);
    }
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { writeSync(fd, `# Workspaces\nGenerated by Jarvis, do not edit.\n\n${lines.join('\n')}\n`); } finally { closeSync(fd); }
    const index = join(root, 'index.md');
    renameSync(tmp, index);
    return index;
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`notes: cannot write the workspace index in ${notes}: ${(e as Error).message}`);
  }
}

// Files every spawn or arbiter start reads must stay small. Warn only, never edit or truncate.
export const NOTES_SIZE_CAPS: Record<string, number> = { 'CLAUDE.md': 6 * 1024, 'README.md': 10 * 1024, 'access.md': 10 * 1024 };

export function notesSizeWarnings(notes: string): string[] {
  const out: string[] = [];
  for (const [f, cap] of Object.entries(NOTES_SIZE_CAPS)) {
    try {
      const st = lstatSync(join(notes, f));
      if (st.isFile() && st.size > cap) out.push(`${f} is ${Math.round(st.size / 1024)} KB, over ${cap / 1024} KB`);
    } catch {}
  }
  return out;
}

// The arbiter's notes paragraph. `wsDir` is its own folder under <notes>/workspaces.
export function arbiterNotesPrompt(meta: Meta & { notes: string }, wsDir: string) {
  const notes = meta.notes;
  const warn = notesSizeWarnings(notes);
  if (warn.length) console.warn(`notes: ${notes}: ${warn.join('; ')}`);
  return `\nPersistent project notes live at ${notes}; they outlive this workspace and are shared with other workspaces on the same project. Your own files are in ${wsDir}: status.md (the current state of this workspace; its first line after the title is 'Summary: <one line>'), open-items.md and, as your running log, journal/YYYY-MM-DD.md (one file per day, the date in YYYY-MM-DD): decisions, findings, what agents did, open threads. Only you write these three; older journals in ${notes}/journal/ are legacy, read them if needed and do not add to them. ${notes}/workspaces/index.md is generated by Jarvis (one line per workspace: summary and open item counts): read it to see what the other workspaces do, never edit it. Other workspaces have their own folders under ${notes}/workspaces/: read their status.md when their state matters (start from index.md), never edit their files. Do not add entries to ${notes}/status.md or ${notes}/open-items.md (legacy shared files). Project-wide facts go to README.md, CLAUDE.md and decisions.md; those are shared and may be edited at the same time by Jarvis in another workspace, so read a file again right before each edit, use small Edit changes, never a whole-file Write. At the start of a new goal, read README.md, CLAUDE.md, your status.md and your open-items.md if they exist. ${OPEN_ITEMS_FORMAT} Dates in status.md and open-items.md are DD-MM-YYYY; journal file names use YYYY-MM-DD. Date every open item. Write what the user did in the journal, in past tense with its source ('user said on <DD-MM-YYYY>: pushed'). Never keep it as an open item. Do not re-check a '[~]' item unless you list it. Never list a '[~]' item in an "Anything left?" answer, not even as "parked" or "waiting on you", and do not say that you left it out. List it only if the current goal cannot continue without it, or the user asks about it; 'waiting on user' alone does not count. Check it first when you list it. When you remove a '[x]' line, keep one dated journal line per removed item. At session start and after a reset, treat every '[ ]' item as not verified: keep its '[ ]' state, and verify it before you report or act on it. Never drop an item you did not verify, unless the user says it is done. When the user says an item is done ("I pushed"), in that same turn remove it from open-items.md and write one line in today's journal, ${wsDir}/journal/YYYY-MM-DD.md: 'user said on <DD-MM-YYYY>: pushed'. Do not re-check a verified fact that cannot change (a sha is in origin/main, a branch is deleted). Re-check a fact that can change (push state, worktrees, a running service) before you report it. Keep the notes current yourself: after an agent finishes something meaningful, or after a decision, a finding or a change of plan, update your status.md and the relevant files. Keep your status.md short: the current state, not history. If the folder has no README.md, create it (an index of the files). Never put secret values there. Tell agents the notes path when a task needs that context. When you create or edit ${notes}/CLAUDE.md, follow the claude-md-improver skill (its quality criteria and templates): concise, one line per concept, nothing stale or obvious. Keep that CLAUDE.md about the project and the user's working rules; do not record Jarvis's own mechanics there (journal files, git commits, edit rules). Its file search must run on ${notes}, not on your own folder. When a goal is done, check this session for learnings and edit ${notes}/CLAUDE.md the way /revise-claude-md does, applied directly without asking (git history is the safety net). Add a line only if it is durable, project-wide and prevents a mistake that would repeat (a working rule, gotcha, command or access quirk). First merge it into or replace an existing line. Never add one-off incident, run or PR details: they go to decisions.md or the journal. Keep CLAUDE.md small, about 40 lines or 6 KB; when it is over that, shorten or delete lines before you add one. Files read on every spawn or start must not grow: README.md and access.md stay under about 10 KB, decisions.md is append-only but nobody reads it in full. Update an existing entry first, add only what is durable, and never paste long notes into these files: long material goes to the journal or a dedicated file under ${notes}, linked by one line. When you spawn an agent, pass only the sections it needs by path and heading (for example 'read ${notes}/CLAUDE.md, section Voice'), never 'read all notes files' or the whole notes folder; you read README.md and CLAUDE.md at the start of a goal, an agent gets the excerpt or the section pointer only. Jarvis commits the folder to git after each of your turns; do not run git there. In a turn where you changed the notes, call notes_message once with a one-line description of the change for the reader of the history, not a description of the process.${warn.length ? ` Size warning: ${warn.join('; ')}. Shorten ${warn.length > 1 ? 'them' : 'it'} before you add anything.` : ''}`;
}

// The text that asks the arbiter to save its state before a context reset. `forced`: the user pressed RESET; otherwise the context passed the limit (`ctx` tokens).
export function saveTurnText(kind: 'forced' | 'auto', wsDir: string, ctx = 0) {
  const where = `${wsDir}/status.md, ${wsDir}/open-items.md and your journal in ${wsDir}/journal/`;
  return kind === 'forced'
    ? `[reset ordered by the user] The user explicitly ordered a reset of your context right now. Do not ask questions and do not argue. The server resets your context after this turn: a fresh session of this same workspace continues from a short summary of agents and state. Save everything important to ${where} now, because what is not saved there is lost. ${OPEN_ITEMS_FORMAT} Then reply in one or two lines. Do not start new work.`
    : `[context ${Math.round(ctx / 1000)}k tokens, over the reset limit] The server resets your context after this turn: a fresh session of this same workspace continues from a short summary of agents and state. Update ${where} now so nothing is lost. ${OPEN_ITEMS_FORMAT} Then reply in one or two lines. Do not start new work.`;
}

// Told once to the arbiter of a workspace that had no folder yet (see ensureWorkspaceNotes in agentOptions).
export const migrationNotice = (meta: Meta & { notes: string }, wsDir: string) =>
  `[notes layout changed] Your notes now have their own folder ${wsDir} with status.md, open-items.md and journal/ (one file YYYY-MM-DD.md per day; do not add to the old journal files in ${meta.notes}/journal/). Copy your own entries once from ${meta.notes}/status.md and ${meta.notes}/open-items.md (the ones tagged "${oneLine(meta.name)}" or clearly about your work) into your files; open items in the strict format. Then remove only those entries from the shared files with small Edits. Leave other workspaces' entries and everything untagged alone.`;

// Pointer for a workspace created by another one.
export const creatorNotesLine = (wsDir: string) => `The creator's notes: ${wsDir} (read only).`;
