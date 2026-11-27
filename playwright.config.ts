import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';

// One root for everything a run creates in the temp dir (data dirs, job sources, spec folders): workers and servers inherit TMPDIR, and the runner removes the root when it exits, pass or fail. A killed run leaves one dir that the server sweep (src/tmpguard.ts) removes after a day.
if (!process.env.JARVIS_TMP_ROOT) {
  process.env.JARVIS_TMP_ROOT = mkdtempSync(join(tmpdir(), 'jarvis-tmp-e2e-'));
  const root = process.env.JARVIS_TMP_ROOT;
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
}
process.env.TMPDIR = process.env.JARVIS_TMP_ROOT;
process.env.JARVIS_TMPGUARD = '0'; // test servers never sweep the real /tmp

// Every worker owns a server (port BASE + STRIDE * worker index) and a data dir, so specs running in parallel never see each other's state.
// Some specs also start extra servers at the worker's port + OFFSETS (resume and voice 1000-1005, arbiter-reset 1100, health 2000).
// No port is used twice: two ports clash only if two offsets differ by STRIDE times the distance between two workers, i.e. by 10, 20, ... 90 (at most 10 workers). The offsets differ by 1-5 (inside 1000-1005), 95-100 (1100 against 1000-1005), 895-1000 and more: never by 10-90.
const BASE = Number(process.env.E2E_PORT || 7798);
const STRIDE = 10;
const OFFSETS = [0, 1000, 1001, 1002, 1003, 1004, 1005, 1100, 2000];
// A 2 vCPU CI runner gets 2 workers; a bigger machine half its CPUs (each worker is a browser plus a server), at most 8.
const WORKERS = Number(process.env.E2E_WORKERS || (process.env.CI ? 2 : Math.min(8, Math.max(2, availableParallelism() >> 1))));
if (!Number.isInteger(WORKERS) || WORKERS < 1 || WORKERS > 10) throw new Error(`bad E2E_WORKERS (1-10): ${process.env.E2E_WORKERS}`);
const MAX_BASE = 65535 - Math.max(...OFFSETS) - STRIDE * (WORKERS - 1);
if (!Number.isInteger(BASE) || BASE < 1 || BASE > MAX_BASE) throw new Error(`bad E2E_PORT (1-${MAX_BASE} for ${WORKERS} workers): ${process.env.E2E_PORT}`);
// 7777 is the real Jarvis: no test server may ever bind it.
for (let i = 0; i < WORKERS; i++) for (const o of OFFSETS) if (BASE + STRIDE * i + o === 7777) throw new Error(`E2E_PORT ${BASE} with ${WORKERS} workers would use port 7777, which is the real Jarvis; pick another base`);

// Playwright sets TEST_PARALLEL_INDEX in each worker process, which loads this file again; the runner itself has none.
const index = Number(process.env.TEST_PARALLEL_INDEX || 0);
if (index >= WORKERS) throw new Error(`worker ${index} has no server: only ${WORKERS} are started; raise E2E_WORKERS (max 10) instead of passing a larger --workers`);
export const PORT = BASE + STRIDE * index;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const DATA_HOME = join(tmpdir(), `jarvis-e2e-data-${PORT}`);
// The open stub (e2e/fake-open.sh) appends the paths it gets here; the real xdg-open never runs in tests.
export const OPEN_LOG = join(tmpdir(), `jarvis-e2e-open-${PORT}.log`);
// Where the job-source specs install copies of e2e/fake-job-source (outside the data folder, as the location rules need); one per worker like the data dir.
// connections.json lives under XDG_CONFIG_HOME/jarvis; one config home per worker, never the real ~/.config.
export const CONFIG_HOME = join(tmpdir(), `jarvis-e2e-config-${PORT}`);
export const JOB_SOURCES_DIR = join(tmpdir(), `jarvis-e2e-job-sources-${PORT}`);
// Servers a spec spawns inherit this: none may read the real ~/.config/jarvis/job-sources.
process.env.JARVIS_JOB_SOURCES_DIR ??= JOB_SOURCES_DIR;
process.env.XDG_CONFIG_HOME ??= CONFIG_HOME;
process.env.JARVIS_ENV_FILE ??= '/dev/null'; // never read the real local env file

const server = (i: number) => {
  const port = BASE + STRIDE * i;
  return {
    // The data dir is wiped on every run; never the real ~/.local/share/jarvis.
    command: `node -e "for (const d of [process.env.XDG_DATA_HOME, process.env.JARVIS_JOB_SOURCES_DIR, process.env.XDG_CONFIG_HOME]) fs.rmSync(d,{recursive:true,force:true})" && node src/server.ts`,
    url: `http://127.0.0.1:${port}/workspaces`,
    // Nothing listens on port 1: the status poll fails fast and no spec touches the network.
    // Agent sessions run on a scripted fake of the SDK: no API calls, no cost.
    env: { PORT: String(port), XDG_DATA_HOME: join(tmpdir(), `jarvis-e2e-data-${port}`), XDG_CONFIG_HOME: join(tmpdir(), `jarvis-e2e-config-${port}`), JARVIS_FAKE_SDK: join(import.meta.dirname, 'e2e', 'fake-sdk.ts'), JARVIS_STATUS_URL: 'http://127.0.0.1:1/', JARVIS_HEALTH_PROBE: '0', JARVIS_JOB_SOURCES_DIR: join(tmpdir(), `jarvis-e2e-job-sources-${port}`), JARVIS_JOBS_MIN_POLL_S: '1', JARVIS_OPEN_CMD: join(import.meta.dirname, 'e2e', 'fake-open.sh'), JARVIS_OPEN_LOG: join(tmpdir(), `jarvis-e2e-open-${port}.log`) },
    reuseExistingServer: false,
  };
};

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  workers: WORKERS,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { actionTimeout: 10_000, trace: process.env.CI ? 'retain-on-failure' : 'off', baseURL: ORIGIN, browserName: 'chromium' },
  // The runner starts one server per worker; workers only use theirs.
  webServer: Array.from({ length: WORKERS }, (_, i) => server(i)),
});
