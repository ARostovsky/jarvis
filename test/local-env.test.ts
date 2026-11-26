import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalEnv } from '../src/local-env.ts';

const file = join(mkdtempSync(join(tmpdir(), 'local-env-')), 'env');

test('env beats file, file beats default, missing file changes nothing', () => {
  writeFileSync(file, 'LOCAL_ENV_T1=from-file\nLOCAL_ENV_T2=from-file\n');
  process.env.LOCAL_ENV_T1 = 'from-env';
  delete process.env.LOCAL_ENV_T2;
  loadLocalEnv(file);
  assert.equal(process.env.LOCAL_ENV_T1, 'from-env');
  assert.equal(process.env.LOCAL_ENV_T2, 'from-file');
  delete process.env.LOCAL_ENV_T3;
  loadLocalEnv(join(tmpdir(), 'local-env-missing', 'env'));
  assert.equal(process.env.LOCAL_ENV_T3, undefined);
});
