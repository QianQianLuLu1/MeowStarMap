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
 * coverage 全量统计 src 下的源码（all: true，include 匹配 src 内全部 ts/tsx），
 * 显式排除测试文件、纯类型目录与进程入口壳文件。
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
      reporter: ['text', 'html', 'json-summary'],
      // vitest 1.6 v8 provider：include/exclude 条目不能带 './' 前缀，否则 glob 不匹配、报告为空（历史坑）
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        // 测试与类型声明（显式声明，不依赖默认值）
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/__tests__/**',
        '**/*.d.ts',
        // Storybook 故事文件与故事夹具（展示层样例，非单元测试对象）
        '**/*.stories.{ts,tsx}',
        '**/story-fixtures.ts',
        // 纯类型目录（仅 import type 消费，无运行时代码）
        'src/shared/types/**',
        'src/main/types/**',
        'src/renderer/types/**',
        // 进程入口/引导壳文件，无法单元测试
        'src/main/index.ts',
        'src/main/preload.ts',
        'src/main/preload-logger.ts',
        'src/renderer/main.tsx',
        'src/renderer/App.tsx',
        'src/renderer/preview-entry.tsx',
        // 资源目录（如有 .ts 产物）与仓库噪声防护
        'src/renderer/icons/**',
        'src/renderer/styles/**',
        'src/renderer/assets/**',
        'dist/**',
        'release/**',
        'coverage/**'
      ],
      // 覆盖率门控阈值：基于 2026-10 基线（statements 69.94% / branches 81.43% / functions 68.55% / lines 69.94%），
      // 取整后设为下限；后续随测试补全逐步提升至 80% 目标。CI 中 vitest --coverage 超阈值即失败阻断。
      thresholds: {
        statements: 69,
        branches: 80,
        functions: 68,
        lines: 69
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
      '@main': path.resolve(__dirname, './src/main'),
      '@common': path.resolve(__dirname, './src/common')
    }
  },
  // 让 vi.mock 能拦截 node_modules 依赖（如 react-virtuoso 虚拟列表），否则外部化后 mock 不生效
  server: {
    deps: {
      inline: ['react-virtuoso']
    }
  }
})
