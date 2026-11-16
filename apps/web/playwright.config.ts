import { defineConfig, devices } from '@playwright/test';

/**
 * Browser checks of the web app against stubbed `/api/**` (no api or registry
 * runs). Not part of `pnpm test` or CI: run `pnpm --filter @asf/web test:e2e`.
 */
const PORT = 4174;

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/test-results',
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: { command: `vite --port ${PORT} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${PORT}`, reuseExistingServer: false },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'phone', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } } },
  ],
});
