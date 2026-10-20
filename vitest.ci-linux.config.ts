/**
 * CI（ubuntu-latest）宿主模拟配置 —— 开发机专用，**不进 CI**。
 *
 * 跑法：`npm run test:ci-linux [路径过滤]`
 *
 * 刻意不复制一份测试作用域，而是从 `vitest.config.ts` 派生后只追加装置 setup：
 * 复制 glob 会与真实 CI 面漂移（`vitest.config.ts:28-29` 记录过 projects 数组配置
 * 「合并而非覆盖」的坑），装置一旦与 CI 跑的不是同一批文件，它的读数就没有意义。
 * coverage 块整块去掉：模拟态下的覆盖率读数不代表 CI 读数，留着只会诱动人去动阈值。
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
    // 轴 5 曾在此把 electron 指向必抛错的壳，用来复刻 CI「装了但没有二进制」。
    // 现在不需要了：基座 `vitest.config.ts` 已把 electron 别名到惰性替身，
    // 两侧行为一致 ⇒ 装置继续是 CI 的替身，而不是比 CI 更严。
    // （防复发由 scripts/__tests__/path-semantics-guard.test.ts 断言该别名仍在。）
    alias: Object.entries(baseAlias).map(([find, replacement]) => ({ find, replacement }))
  },
  test: {
    ...testWithoutCoverage,
    setupFiles: ['./tests/setup.ts', './tests/ci-linux.setup.ts']
  }
})
