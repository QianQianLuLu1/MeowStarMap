import { defineConfig } from '@playwright/test'

/**
 * 打包产物运行时冒烟配置（用例清单见 docs/manual-smoke-checklist.md；
 * 原方案文档已归档至 docs/archive/plans/e2e-smoke-playwright.md §5，不入仓、git 历史可查）
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
  // CI 下追加 Playwright 内置 github reporter：每条失败用例写成
  // `::error file=…,line=…,title=…::message`，落入 check run 注解。
  // job 日志需仓库权限才能读（/actions/jobs/{id}/logs 匿名 403、产物 zip 401），
  // 而 /check-runs/{id}/annotations 免鉴权可读——run 39583778122 的 build job 只有
  // 2 条注解（output.annotations_count=2，完整集），说明 list 只写 stdout、什么都没注解，
  // 定位「哪条用例红」只能靠人工取日志。本地仍只用 list，避免终端混入 workflow 命令噪声。
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure'
  },
  expect: {
    timeout: 15_000
  }
})
