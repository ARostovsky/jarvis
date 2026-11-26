// Optional per-machine env file (KEY=value lines), loaded before any other module reads process.env. Variables already set win; a missing file changes nothing.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const localEnvFile = () => process.env.JARVIS_ENV_FILE || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'jarvis', 'env');

export function loadLocalEnv(file = localEnvFile()) {
  try { process.loadEnvFile(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`env file ${file} ignored: ${(e as Error).message}`); }
}

loadLocalEnv();
