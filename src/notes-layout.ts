// Per-workspace notes layout: <notes>/workspaces/<workspace-id>/{status.md,open-items.md}. Pure helpers (no SDK, no registry), so the prompts and the file format are unit-tested.
import { closeSync, lstatSync, mkdirSync, openSync, writeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { journalKey } from './slug.ts';

type Meta = { id: string; name: string; notes?: string };

export const workspaceDir = (m: { id: string; notes: string }) => join(m.notes, 'workspaces', m.id);

// The one sentence that tells an arbiter how to write open items; the parser below reads exactly this.
export const OPEN_ITEMS_FORMAT = `Keep open items only in your open-items.md, one per line: '- [ ] <DD-MM-YYYY> <text>' open, '- [~] <DD-MM-YYYY> <text>' parked (end the text with "(waiting on user)" or "(not verified)"), '- [x] <text> verified <DD-MM-YYYY>: <what, by which check>' done and verified. Never write [x] without a real check. When the goal is done remove the [x] lines.`;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

const statusTemplate = (name: string, id: string) => `# Status: ${oneLine(name)}
Workspace id: ${id}. Only this workspace edits this file. Open items live in open-items.md.

Summary: (one line, what this workspace is doing now)

## Current state
(newest facts first; the state, not history; history goes to the journal)
`;

const openItemsTemplate = (name: string) => `# Open items: ${oneLine(name)}
<!-- One item per line, strict format, parsed by Jarvis. Only this workspace edits this file. Dates are DD-MM-YYYY. -->
<!-- - [ ] <DD-MM-YYYY> <text>               open
     - [~] <DD-MM-YYYY> <text>               parked: waiting on the user, or not verified; do not re-check, do not list in chat
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

export type OpenItem = { kind: 'open' | 'parked' | 'done'; date: string; text: string; check?: string };
const DATE = '(\\d{2}-\\d{2}-\\d{4}|\\d{4}-\\d{2}-\\d{2})'; // DD-MM-YYYY as written by the prompts; YYYY-MM-DD tolerated
const OPEN_RE = new RegExp(`^- \\[( |~)\\] ${DATE} (\\S.*)$`);
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
    if (o && validDate(o[2])) items.push({ kind: o[1] === '~' ? 'parked' : 'open', date: o[2], text: o[3] });
    else if (d && validDate(d[2])) items.push({ kind: 'done', date: d[2], text: d[1], check: d[3] });
    else invalid.push(line);
  }
  return { items, invalid };
}

// The arbiter's notes paragraph. `wsDir` is its own folder under <notes>/workspaces.
export function arbiterNotesPrompt(meta: Meta & { notes: string }, wsDir: string) {
  const notes = meta.notes;
  return `\nPersistent project notes live at ${notes}; they outlive this workspace and are shared with other workspaces on the same project. Your own files are in ${wsDir}: status.md (the current state of this workspace; its first line after the title is 'Summary: <one line>'), open-items.md and, as your running log, journal/YYYY-MM-DD-${journalKey(meta)}.md in ${notes}: decisions, findings, what agents did, open threads. Only you write these three. Other workspaces have their own folders under ${notes}/workspaces/: read their status.md when their state matters, never edit their files. Do not add entries to ${notes}/status.md or ${notes}/open-items.md (legacy shared files). Project-wide facts go to README.md, CLAUDE.md and decisions.md; those are shared and may be edited at the same time by Jarvis in another workspace, so read a file again right before each edit, use small Edit changes, never a whole-file Write. At the start of a new goal, read README.md, CLAUDE.md, your status.md and your open-items.md if they exist. ${OPEN_ITEMS_FORMAT} Dates in status.md and open-items.md are DD-MM-YYYY; journal file names use YYYY-MM-DD. Keep the notes current yourself: after an agent finishes something meaningful, or after a decision, a finding or a change of plan, update your status.md and the relevant files. Keep your status.md short: the current state, not history. If the folder has no README.md, create it (an index of the files). Never put secret values there. Tell agents the notes path when a task needs that context. When you create or edit ${notes}/CLAUDE.md, follow the claude-md-improver skill (its quality criteria and templates): concise, one line per concept, nothing stale or obvious. Keep that CLAUDE.md about the project and the user's working rules; do not record Jarvis's own mechanics there (journal files, git commits, edit rules). Its file search must run on ${notes}, not on your own folder. When a goal is done, capture this session's learnings (working rules, gotchas, commands, access quirks) into ${notes}/CLAUDE.md the way /revise-claude-md does, but apply them directly without asking: the folder is yours to maintain and git history is the safety net. Jarvis commits the folder to git after each of your turns; do not run git there. In a turn where you changed the notes, call notes_message once with a one-line description of the change for the reader of the history, not a description of the process.`;
}

// The text that asks the arbiter to save its state before a context reset. `forced`: the user pressed RESET; otherwise the context passed the limit (`ctx` tokens).
export function saveTurnText(kind: 'forced' | 'auto', meta: Meta & { notes: string }, wsDir: string, ctx = 0) {
  const where = `${wsDir}/status.md, ${wsDir}/open-items.md and your journal (journal/YYYY-MM-DD-${journalKey(meta)}.md in ${meta.notes})`;
  return kind === 'forced'
    ? `[reset ordered by the user] The user explicitly ordered a reset of your context right now. Do not ask questions and do not argue. The server resets your context after this turn: a fresh session of this same workspace continues from a short summary of agents and state. Save everything important to ${where} now, because what is not saved there is lost. ${OPEN_ITEMS_FORMAT} Then reply in one or two lines. Do not start new work.`
    : `[context ${Math.round(ctx / 1000)}k tokens, over the reset limit] The server resets your context after this turn: a fresh session of this same workspace continues from a short summary of agents and state. Update ${where} now so nothing is lost. ${OPEN_ITEMS_FORMAT} Then reply in one or two lines. Do not start new work.`;
}

// Told once to the arbiter of a workspace that had no folder yet (see ensureWorkspaceNotes in agentOptions).
export const migrationNotice = (meta: Meta & { notes: string }, wsDir: string) =>
  `[notes layout changed] Your notes now have their own folder ${wsDir} with status.md and open-items.md. Copy your own entries once from ${meta.notes}/status.md and ${meta.notes}/open-items.md (the ones tagged "${oneLine(meta.name)}" or clearly about your work) into your files; open items in the strict format. Then remove only those entries from the shared files with small Edits. Leave other workspaces' entries and everything untagged alone.`;

// Pointer for a workspace created by another one.
export const creatorNotesLine = (wsDir: string) => `The creator's notes: ${wsDir} (read only).`;
