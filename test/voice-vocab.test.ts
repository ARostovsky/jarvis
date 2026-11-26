import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { voiceVocab, MAX_WORD, MAX_FILE } from '../src/voice-vocab.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'jarvis-vocab-'));

test('uses JARVIS_VOICE_VOCAB, creates the folder and file on add, list creates nothing', () => {
  const d = dir();
  const f = join(d, 'sub', 'v.txt');
  process.env.JARVIS_VOICE_VOCAB = f;
  try {
    assert.deepEqual(voiceVocab('list').words, []);
    assert.equal(existsSync(f), false);
    const r = voiceVocab('add', [' Кафка ', 'Grafana']);
    assert.deepEqual(r.added, ['Кафка', 'Grafana']);
    assert.equal(r.total, 2);
    assert.equal(readFileSync(f, 'utf8'), 'Кафка\nGrafana\n');
    assert.deepEqual(readdirSync(join(d, 'sub')), ['v.txt']); // no temp file left
  } finally { delete process.env.JARVIS_VOICE_VOCAB; }
});

test('add dedupes case-insensitively, rejects bad words, keeps comments and other lines', () => {
  const f = join(dir(), 'v.txt');
  writeFileSync(f, '# my words\n\nGrafana\n');
  const r = voiceVocab('add', ['grafana', 'New', 'new', '  ', '# x', 'a\nb', 'x'.repeat(MAX_WORD + 1)], f);
  assert.deepEqual(r.added, ['New']);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['already there', 'already there', 'empty', 'starts with #', 'contains a newline', `longer than ${MAX_WORD} chars`]);
  assert.equal(readFileSync(f, 'utf8'), '# my words\n\nGrafana\nNew\n');
  assert.equal(r.total, 2);
});

test('remove matches exact words case-insensitively and leaves comments alone', () => {
  const f = join(dir(), 'v.txt');
  writeFileSync(f, '# Grafana\nGrafana\nGrafana Labs\nфоо\n');
  const r = voiceVocab('remove', ['grafana', 'ФОО', 'missing'], f);
  assert.deepEqual(r.removed, ['Grafana', 'фоо']);
  assert.equal(readFileSync(f, 'utf8'), '# Grafana\nGrafana Labs\n');
  assert.deepEqual(voiceVocab('list', [], f).words, ['Grafana Labs']);
});

test('the file size is capped and a long list warns about the prompt budget', () => {
  const f = join(dir(), 'v.txt');
  const words = Array.from({ length: 800 }, (_, i) => `слово${i}`);
  const r = voiceVocab('add', words, f);
  assert.ok(readFileSync(f).length <= MAX_FILE);
  assert.ok(r.skipped.some((s) => s.reason.startsWith('file would exceed')));
  assert.match(r.warning ?? '', /fit the Whisper prompt/);
  assert.equal(voiceVocab('add', ['a'], join(dir(), 'w.txt')).warning, undefined);
});
