import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = 7798;
export const DATA_HOME = join(tmpdir(), 'jarvis-e2e-data');

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  reporter: 'list',
  use: { actionTimeout: 10_000, baseURL: `http://127.0.0.1:${PORT}`, browserName: 'chromium' },
  webServer: {
    // The data dir is wiped on every run; never the real ~/.local/share/jarvis.
    command: `node -e "fs.rmSync(process.env.XDG_DATA_HOME,{recursive:true,force:true})" && node src/server.ts`,
    url: `http://127.0.0.1:${PORT}/workspaces`,
    env: { PORT: String(PORT), XDG_DATA_HOME: DATA_HOME },
    reuseExistingServer: false,
  },
});
