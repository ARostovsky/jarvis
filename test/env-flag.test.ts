import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flagLine, pickFlag } from '../src/env-flag.ts';

test('pickFlag: shell, then env file, then off; garbage warns and falls through', () => {
  const table: { shell?: string; file?: string; want: [boolean, string, string?]; warns: string[] }[] = [
    { want: [false, 'default'], warns: [] },
    { shell: '', file: '', want: [false, 'default'], warns: [] },
    { shell: '1', want: [true, 'shell'], warns: [] },
    { shell: ' 1 ', want: [true, 'shell'], warns: [] },
    { shell: '0', want: [false, 'shell'], warns: [] },
    { file: '1', want: [true, 'env file'], warns: [] },
    { file: '0', want: [false, 'env file'], warns: [] },
    { shell: '0', file: '1', want: [false, 'shell'], warns: [] },
    { shell: '1', file: '0', want: [true, 'shell'], warns: [] },
    { shell: 'cpu', want: [true, 'shell', 'cpu'], warns: [] },
    { file: 'cpu', want: [true, 'env file', 'cpu'], warns: [] },
    { shell: 'true', file: '1', want: [true, 'env file'], warns: ['T: unknown value "true" in shell (use 1 or 0), ignoring it'] },
    { shell: 'off', file: '0', want: [false, 'env file'], warns: ['T: unknown value "off" in shell (use 1 or 0), ignoring it'] },
    { shell: '1', file: 'yes', want: [true, 'shell'], warns: [] },
    { shell: 'yes', file: '-1', want: [false, 'default'], warns: ['T: unknown value "yes" in shell (use 1 or 0), ignoring it', 'T: unknown value "-1" in env file (use 1 or 0), ignoring it'] },
  ];
  for (const [i, t] of table.entries()) {
    const warns: string[] = [];
    const f = pickFlag(`T${i}`, ['cpu'], t.shell, t.file, (m) => warns.push(m.replace(/^T\d+:/, 'T:')));
    assert.deepEqual([f.enabled, f.source, f.mode], [t.want[0], t.want[1], t.want[2]], JSON.stringify(t));
    assert.deepEqual(warns, t.warns, JSON.stringify(t));
  }
  const n: string[] = [];
  pickFlag('ONCE', [], 'x', undefined, (m) => n.push(m)); pickFlag('ONCE', [], 'x', undefined, (m) => n.push(m));
  assert.equal(n.length, 1); // once per name and source
  assert.equal(pickFlag('NOCPU', [], 'cpu', undefined, () => {}).enabled, false); // cpu counts only where the caller allows it
});

test('real env file and shell: shell 0 beats file 1, garbage shell falls back to the file, for both flags', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'env-flag-')), 'env');
  writeFileSync(file, 'JARVIS_VOICE=1\nJARVIS_TELEGRAM=1\n');
  const src = "import './src/local-env.ts'; import { resolveFlag } from './src/env-flag.ts'; const a = resolveFlag('JARVIS_VOICE', 'cpu'), b = resolveFlag('JARVIS_TELEGRAM'); console.log(`${a.enabled} ${a.source} ${a.mode ?? ''}|${b.enabled} ${b.source}`);";
  const run = (env: Record<string, string>) => {
    const { JARVIS_VOICE: _v, JARVIS_TELEGRAM: _t, ...base } = process.env;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', cwd: join(import.meta.dirname, '..'), env: { ...base, JARVIS_ENV_FILE: file, ...env } });
    return { out: r.stdout.trim(), err: r.stderr };
  };
  assert.equal(run({}).out, 'true env file |true env file');
  assert.equal(run({ JARVIS_VOICE: '0', JARVIS_TELEGRAM: '0' }).out, 'false shell |false shell');
  assert.equal(run({ JARVIS_VOICE: 'cpu' }).out, 'true shell cpu|true env file');
  const bad = run({ JARVIS_VOICE: 'true', JARVIS_TELEGRAM: 'off' });
  assert.equal(bad.out, 'true env file |true env file'); // garbage shell values do not hide the file
  assert.match(bad.err, /JARVIS_VOICE: unknown value "true" in shell \(use 1 or 0\), ignoring it/);
  assert.match(bad.err, /JARVIS_TELEGRAM: unknown value "off" in shell/);
});

test('flagLine formats the status lines of jarvis start', () => {
  assert.equal(flagLine('voice input', { enabled: true, source: 'env file' }), 'voice input: enabled (env file)');
  assert.equal(flagLine('voice input', { enabled: true, source: 'shell', mode: 'cpu' }), 'voice input: enabled, cpu mode (shell)');
  assert.equal(flagLine('voice input', { enabled: false, source: 'default' }), 'voice input: disabled (default)');
  assert.equal(flagLine('telegram bridge', { enabled: false, source: 'shell' }), 'telegram bridge: disabled (shell)');
});

test('statusLines uses the resolver: file, shell and the warning of a bad shell value', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'env-flag-')), 'env');
  writeFileSync(file, 'JARVIS_VOICE=1\n');
  const src = "import './src/local-env.ts'; import { statusLines } from './src/env-flag.ts'; console.log(statusLines().join('|'));";
  const { JARVIS_VOICE: _v, JARVIS_TELEGRAM: _t, ...base } = process.env;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', cwd: join(import.meta.dirname, '..'), env: { ...base, JARVIS_ENV_FILE: file, JARVIS_TELEGRAM: 'maybe' } });
  assert.equal(r.stdout.trim(), 'voice input: enabled (env file)|telegram bridge: disabled (default)');
  assert.match(r.stderr, /JARVIS_TELEGRAM: unknown value "maybe" in shell/);
});
