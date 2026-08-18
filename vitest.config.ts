import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

/**
 * T16：vitest 配置
 *
 * 测试范围：
 * - 主进程纯函数工具模块（node 环境）
 * - 渲染层 zustand store（node 环境）
 * - 渲染层 React 组件（jsdom 环境，配套 @testing-library/react）
 *
 * 不测：依赖 Electron API / better-sqlite3 / sharp 的模块（需 mock，复杂度过高）
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      ['./src/renderer/**/*.test.tsx', 'jsdom'],
      ['./src/renderer/hooks/**/*.test.ts', 'jsdom']
    ],
    include: ['./src/**/*.test.ts', './src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', 'release'],
    globals: true,
    testTimeout: 10000,
    // ── 提速修复层 1：默认 threads 池在 vitest 1.6.1 + Node 22 下 teardown 挂起
    // （实测 8 文件最小挂起集 threads 下挂、forks 下 2.3s 干净退出）。改用 forks
    // 绕过 worker 线程回收缺陷；每文件独立 fork 也便于分片隔离挂起文件。
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false
      }
    },
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        './src/main/utils/media-constants.ts',
        './src/main/utils/scene-category.ts',
        './src/main/utils/game-events.ts',
        './src/main/utils/phash.ts',
        './src/main/utils/concurrency.ts',
        './src/main/utils/file-utils.ts',
        './src/main/utils/duplicate-scoring.ts',
        './src/main/database/media-repository.ts',
        './src/renderer/stores/operationHistoryStore.ts',
        './src/renderer/stores/mediaStore.ts',
        './src/renderer/utils/lut.ts',
        './src/renderer/utils/imageProcessor.ts'
      ]
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
      '@main': path.resolve(__dirname, './src/main'),
      '@common': path.resolve(__dirname, './src/common')
    }
  }
})
