import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 600000,
  expect: { timeout: 30000 },
  use: {
    actionTimeout: 30000,
    baseURL: `http://localhost:${process.env.REPELLET_E2E_PORT || 3315}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node tests/e2e-server.mjs',
    url: `http://localhost:${process.env.REPELLET_E2E_PORT || 3315}/api/setup/status`,
    reuseExistingServer: false,
    timeout: 60000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 30000 },
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
