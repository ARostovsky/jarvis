// Optional per-machine env file (KEY=value lines), loaded before any other module reads process.env. Variables already set win; a missing file changes nothing.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { fileEnv, fromFile } from './env-flag.ts';

export const localEnvFile = () => process.env.JARVIS_ENV_FILE || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'jarvis', 'env');

export function loadLocalEnv(file = localEnvFile()) {
  try {
    const parsed = parseEnv(readFileSync(file, 'utf8')); // also kept for env-flag.ts, which must see a file value behind a bad shell value
    for (const [k, v] of Object.entries(parsed)) { if (v !== undefined) fileEnv[k] = v; if (process.env[k] === undefined) fromFile.add(k); }
    process.loadEnvFile(file);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`env file ${file} ignored: ${(e as Error).message}`); }
}

loadLocalEnv();
