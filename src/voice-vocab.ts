// The voice vocabulary file (see voice/stt.py `VocabFile`): one word or phrase per line, blank lines and `#` lines ignored.
// The arbiter edits it through the voice_vocab tool; the sidecar re-reads it on the next transcription. Pure Node.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const MAX_WORD = 80;
export const MAX_FILE = 8 * 1024;
// shortcut: the sidecar's real budget is 223 tokens minus the default and JARVIS_VOICE_PROMPT; this is a fixed estimate, fine for a warning.
const BUDGET_TOKENS = 150;

export const vocabFile = () => process.env.JARVIS_VOICE_VOCAB?.trim() || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'jarvis', 'voice-vocab.txt');
const isWord = (l: string) => l !== '' && !l.startsWith('#');
const lines = (text: string) => text.replace(/\r?\n$/, '').split(/\r?\n/).filter((_, i, a) => a.length > 1 || a[0] !== '');
const wordsOf = (ls: string[]) => ls.map((l) => l.trim()).filter(isWord);
// Same estimate as `est_tokens` in voice/stt.py.
const estTokens = (s: string) => Math.floor([...s].reduce((n, c) => n + (c.charCodeAt(0) < 128 ? 1 : 2), 0) / 3) + 1;

function read(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function write(file: string, ls: string[]) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, ls.length ? ls.join('\n') + '\n' : '');
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export type VocabResult = { added: string[]; skipped: { word: string; reason: string }[]; removed: string[]; total: number; words?: string[]; warning?: string };

export function voiceVocab(action: 'add' | 'remove' | 'list', input: string[] = [], file = vocabFile()): VocabResult {
  let ls = lines(read(file));
  const res: VocabResult = { added: [], skipped: [], removed: [], total: 0 };
  if (action === 'add') {
    const have = new Set(wordsOf(ls).map((w) => w.toLowerCase()));
    const next = [...ls];
    let size = Buffer.byteLength(ls.join('\n')) + 1;
    for (const raw of input) {
      const w = raw.trim();
      const bad = /[\r\n]/.test(raw.trim()) ? 'contains a newline' : w === '' ? 'empty' : w.startsWith('#') ? 'starts with #' : [...w].length > MAX_WORD ? `longer than ${MAX_WORD} chars` : have.has(w.toLowerCase()) ? 'already there' : size + Buffer.byteLength(w) + 1 > MAX_FILE ? `file would exceed ${MAX_FILE} bytes` : '';
      if (bad) { res.skipped.push({ word: raw, reason: bad }); continue; }
      have.add(w.toLowerCase());
      next.push(w);
      size += Buffer.byteLength(w) + 1;
      res.added.push(w);
    }
    if (res.added.length) write(file, (ls = next));
  } else if (action === 'remove') {
    const drop = new Set(input.map((w) => w.trim().toLowerCase()).filter(isWord));
    const kept = ls.filter((l) => {
      const w = l.trim();
      if (!isWord(w) || !drop.has(w.toLowerCase())) return true;
      res.removed.push(w);
      return false;
    });
    if (res.removed.length) write(file, (ls = kept));
  }
  const words = wordsOf(ls);
  res.total = words.length;
  if (action === 'list') res.words = words;
  let room = BUDGET_TOKENS;
  const fit = words.filter((w) => (room -= estTokens(w) + 1) >= 0).length;
  if (fit < words.length) res.warning = `only the first ~${fit} of ${words.length} words fit the Whisper prompt; the rest are ignored`;
  return res;
}
