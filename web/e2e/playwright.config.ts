import { defineConfig } from '@playwright/test';
import path from 'node:path';

const sizes = [{ width: 390, height: 844 }, { width: 360, height: 800 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }];
const browsers = ['chromium', 'webkit', 'firefox'] as const;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  reporter: [['list'], ['html', { outputFolder: path.resolve(__dirname, 'playwright-report'), open: 'never' }]],
  outputDir: path.resolve(__dirname, 'test-results'),
  use: { baseURL: 'http://127.0.0.1:4173', ignoreHTTPSErrors: true, proxy: { server: 'http://127.0.0.1:4174', bypass: '127.0.0.1,localhost' }, screenshot: 'off', trace: { mode: 'retain-on-failure', screenshots: false }, serviceWorkers: 'block' },
  projects: browsers.flatMap(browserName => sizes.map(viewport => ({
    name: `${browserName}-${viewport.width}x${viewport.height}`,
    use: { browserName, viewport, ...(browserName === 'chromium' ? { launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } } : {}) },
  }))),
  webServer: { command: 'node e2e/server.mjs', cwd: path.resolve(__dirname, '..'), url: 'http://127.0.0.1:4173', timeout: 240_000, reuseExistingServer: false },
});
