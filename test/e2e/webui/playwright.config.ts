import { defineConfig, devices } from '@playwright/test';

const isCdp = Boolean(process.env.PW_CDP_URL);

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  outputDir: '../../../test-results/webui-e2e',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../../../playwright-report/webui-e2e' }],
  ],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: isCdp ? 'off' : 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
