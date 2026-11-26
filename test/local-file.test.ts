// /local-file policy: roots allowlist, dot/secret names, symlinks, size, types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localFile } from '../src/local-file.ts';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-lf-'));
const out = mkdtempSync(join(tmpdir(), 'jarvis-lf-out-'));
process.env.JARVIS_FILE_ROOTS = tmp;
const file = (p: string, c: string | Buffer = 'x') => (mkdirSync(join(p, '..'), { recursive: true }), writeFileSync(p, c), p);

test('allowed files get their type; svg gets a sandbox CSP', () => {
  assert.equal(localFile(file(join(tmp, 'a.png')))?.type, 'image/png');
  assert.equal(localFile(file(join(tmp, 'a.LOG')))?.type, 'text/plain; charset=utf-8');
  assert.equal(localFile(file(join(tmp, 'a.png')))?.csp, undefined);
  assert.equal(localFile(file(join(tmp, 'a.svg'), '<svg onload="alert(1)"/>'))?.csp, 'sandbox');
});

test('denied: outside roots, .., dot dirs, secret names, unknown types, directories, oversize, missing', () => {
  assert.equal(localFile(file(join(out, 'a.png'))), undefined);
  assert.equal(localFile(`${tmp}/../${out.split('/').pop()}/a.png`), undefined);
  assert.equal(localFile(file(join(tmp, '.ssh', 'a.txt'))), undefined);
  assert.equal(localFile(file(join(tmp, '.git', 'a.txt'))), undefined);
  assert.equal(localFile(file(join(tmp, 'my-token.txt'))), undefined);
  assert.equal(localFile(file(join(tmp, 'a.sh'))), undefined);
  mkdirSync(join(tmp, 'd.png'));
  assert.equal(localFile(join(tmp, 'd.png')), undefined);
  assert.equal(localFile(file(join(tmp, 'big.png'), Buffer.alloc(20 * 1024 * 1024 + 1))), undefined);
  assert.equal(localFile(join(tmp, 'none.png')), undefined);
  assert.equal(localFile('a.png'), undefined);
});

test('symlinks out of the roots or to another type are denied; inside is fine', () => {
  symlinkSync(file(join(out, 's.png')), join(tmp, 'link.png'));
  assert.equal(localFile(join(tmp, 'link.png')), undefined);
  symlinkSync(file(join(tmp, 'real.sh')), join(tmp, 'sh.png'));
  assert.equal(localFile(join(tmp, 'sh.png')), undefined);
  symlinkSync(join(tmp, 'a.png'), join(tmp, 'ok.png'));
  assert.equal(localFile(join(tmp, 'ok.png'))?.type, 'image/png');
});
