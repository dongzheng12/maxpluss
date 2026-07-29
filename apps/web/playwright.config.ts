import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test'

const chromeChannel = process.env.E2E_CHROME_CHANNEL
const chromiumUse: PlaywrightTestConfig['use'] = chromeChannel ? { channel: chromeChannel } : {}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 7 * 60 * 1000,
  expect: {
    timeout: 20_000,
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://154.8.197.13:8083',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...chromiumUse,
      },
    },
  ],
})
