import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'jarvis-claude-test-'));
const { claudeBinary } = await import('../src/agents.ts');

const script = (dir: string, version: string, mode = 0o755) => {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'claude');
  writeFileSync(f, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
  chmodSync(f, mode);
  return f;
};
const env = (vars: Record<string, string | undefined>) => {
  for (const k of ['JARVIS_CLAUDE_PATH', 'PATH']) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
};
const root = mkdtempSync(join(tmpdir(), 'jarvis-claude-bin-'));
const log = console.log;

test('claudeBinary picks the executable claude on PATH, with the override and fallbacks', () => {
  console.log = () => {};
  try {
    const fresh = script(join(root, 'new'), '99.0.0');
    const old = script(join(root, 'old'), '1.0.0');
    const plain = script(join(root, 'plain'), '99.0.0', 0o644);
    const broken = join(root, 'broken', 'claude');
    mkdirSync(join(root, 'broken'));
    writeFileSync(broken, '#!/bin/sh\nexit 1\n');
    chmodSync(broken, 0o755);

    env({ PATH: join(root, 'new') });
    assert.equal(claudeBinary(), fresh);
    env({ PATH: ['relative', join(root, 'plain'), join(root, 'new')].join(':') }); // relative and non-executable entries are skipped
    assert.equal(claudeBinary(), fresh);
    env({ PATH: join(root, 'plain') });
    assert.equal(claudeBinary(), undefined);
    env({ PATH: join(root, 'old') }); // older than the bundled build
    assert.equal(claudeBinary(), undefined);
    env({ PATH: join(root, 'broken') }); // --version fails
    assert.equal(claudeBinary(), undefined);
    env({ PATH: join(root, 'new'), JARVIS_CLAUDE_PATH: 'bundled' });
    assert.equal(claudeBinary(), undefined);
    env({ PATH: join(root, 'new'), JARVIS_CLAUDE_PATH: old }); // an override wins, even an old one
    assert.equal(claudeBinary(), old);
  } finally {
    console.log = log;
  }
});
