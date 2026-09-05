import { defineConfig } from '@playwright/test'

/**
 * 打包产物运行时冒烟配置（详见 docs/archive/plans/e2e-smoke-playwright.md §5）
 *
 * - testMatch 限定 *.e2e.ts：与 vitest 的 *.test.ts 约定天然隔离，vitest 不会误跑
 * - fullyParallel=false + workers=1：单实例串行，避免多开 Electron 抢 userData
 * - 超时护栏：单用例 60s / expect 15s / launch 30s（helpers 内），防 CI 挂起
 * - retries 仅 CI 生效（process.env.CI），本地快速反馈
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  outputDir: '../test-results',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure'
  },
  expect: {
    timeout: 15_000
  }
})
