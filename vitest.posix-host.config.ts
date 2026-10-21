/**
 * POSIX 宿主（**不带装置**）复现配置 —— 开发机专用，**不进 CI**。
 *
 * 跑法：`npm run test:posix-host -- <路径过滤>`
 *
 * 写法照抄 `vitest.ci-linux.config.ts`：刻意不复制一份测试作用域，而是从 `vitest.config.ts`
 * 派生后只追加 setup（`vitest.config.ts:28-29` 记录过 projects 数组配置「合并而非覆盖」的坑）。
 * coverage 块整块去掉：本 profile 是诊断用的「半个装置」，其覆盖率读数不代表任何一侧的读数。
 */
import { defineConfig } from 'vitest/config'
import baseConfig from './vitest.config'

const baseTest: Record<string, unknown> =
  (baseConfig as { test?: Record<string, unknown> }).test ?? {}

// 整块剔除 coverage：留一个 `coverage: undefined` 会让 vitest 解析时读到 undefined.enabled
const testWithoutCoverage = Object.fromEntries(
  Object.entries(baseTest).filter(([key]) => key !== 'coverage')
)

const baseAlias =
  (baseConfig as { resolve?: { alias?: Record<string, string> } }).resolve?.alias ?? {}

export default defineConfig({
  ...baseConfig,
  resolve: {
    alias: Object.entries(baseAlias).map(([find, replacement]) => ({ find, replacement }))
  },
  test: {
    ...testWithoutCoverage,
    // 与基座同一份 `tests/setup.ts`（electron 惰性替身等共用语义），只额外叠一根 posix 轴
    setupFiles: ['./tests/setup.ts', './tests/posix-host.setup.ts']
  }
})
