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
 * coverage 采用显式 include 清单（已被测试覆盖的模块逐步纳入）：
 * 清单内模块均已通过 mock Electron / better-sqlite3 / 原生模块实现单元测试；
 * 后续批 2 文件随新测试落地追加。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      ['./src/renderer/**/*.test.tsx', 'jsdom'],
      ['./src/renderer/hooks/**/*.test.ts', 'jsdom']
    ],
    include: ['./src/**/*.test.ts', './src/**/*.test.tsx', './scripts/**/*.test.ts'],
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
        // 注意：vitest 1.6 v8 provider 下 include 条目不能带 './' 前缀，否则 glob 不匹配、报告为空
        'src/main/utils/media-constants.ts',
        'src/shared/scene-category.ts',
        'src/renderer/utils/game-events.ts',
        'src/main/utils/phash.ts',
        'src/main/utils/concurrency.ts',
        'src/main/utils/file-utils.ts',
        'src/main/utils/duplicate-scoring.ts',
        'src/main/database/media-repository.ts',
        'src/renderer/stores/operationHistoryStore.ts',
        'src/renderer/stores/mediaStore.ts',
        'src/renderer/utils/lut.ts',
        'src/renderer/utils/imageProcessor.ts',
        // ── 批 1：scanner / media-worker / database（均已通过 mock Electron/better-sqlite3/原生模块实现单测）
        'src/main/scanner/index.ts',
        'src/main/scanner/path-classifier.ts',
        'src/main/scanner/uid-discovery.ts',
        'src/main/scanner/worker-protocol.ts',
        'src/main/scanner/scanner-worker-bridge.ts',
        'src/main/scanner/worker-entry.ts',
        'src/main/scanner/repair-legacy-data-v1.ts',
        'src/main/media-worker/bktree-index.ts',
        'src/main/media-worker/bridge.ts',
        'src/main/media-worker/manager.ts',
        'src/main/media-worker/worker-entry.ts',
        'src/main/media-worker/worker-protocol.ts',
        'src/main/database/connection.ts',
        'src/main/database/import-root-repository.ts',
        'src/main/database/sql-chunk.ts',
        'src/main/database/worker/database-worker-bridge.ts',
        // ── 批 2：随新增缺口测试纳入（同样不带 './' 前缀）
        'src/main/scanner/repair-legacy-data-v3.ts',
        'src/main/scanner/repair-legacy-data-v4.ts',
        'src/main/scanner/game-directory-discovery.ts',
        'src/main/media-worker/bktree-js.ts',
        'src/main/database/worker/database-worker.ts',
        'src/main/database/worker/worker-protocol.ts'
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
