import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const PORT = Number(process.env.E2E_PORT || 7798);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 64535) throw new Error(`bad E2E_PORT (1-64535, resume.spec uses PORT+1000): ${process.env.E2E_PORT}`);
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const DATA_HOME = join(tmpdir(), `jarvis-e2e-data-${PORT}`);

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { actionTimeout: 10_000, trace: process.env.CI ? 'retain-on-failure' : 'off', baseURL: ORIGIN, browserName: 'chromium' },
  webServer: {
    // The data dir is wiped on every run; never the real ~/.local/share/jarvis.
    command: `node -e "fs.rmSync(process.env.XDG_DATA_HOME,{recursive:true,force:true})" && node src/server.ts`,
    url: `${ORIGIN}/workspaces`,
    // Agent sessions run on a scripted fake of the SDK: no API calls, no cost.
    env: { PORT: String(PORT), XDG_DATA_HOME: DATA_HOME, JARVIS_FAKE_SDK: join(import.meta.dirname, 'e2e', 'fake-sdk.ts') },
    reuseExistingServer: false,
  },
});
