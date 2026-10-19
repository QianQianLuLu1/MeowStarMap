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
    // vitest 5 把 clearMocks 默认值从 false 改为 true：模块加载期（如 preload 入口装配、
    // vi.hoisted 捕获的暴露记录）写入的调用历史会在每个用例开始前被清空，
    // 既有断言「模块级调用记录」的用例因此恒为 0 次。这里显式恢复升级前（vitest 1.6）
    // 的 false 语义，保持 S1 依赖升级为行为无损。
    clearMocks: false,
    // vitest 5 移除了 environmentMatchGlobs（未知配置项被静默忽略 → 渲染层组件测试全部落到
    // node 环境，报 "window is not defined"）。官方替代写法是 test.projects：
    // 两个 project 的 include 互斥且并集等于原全量 include，环境按原 globs 分配。
    // 注意：projects 的数组型配置是「合并」而非「覆盖」，所以 include 只在 project 内声明，
    // 根配置留空——否则每个 project 都会继承根 include 并各跑一遍全量用例（重复计数）。
    include: [],
    projects: [
      {
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['./src/renderer/**/*.test.tsx', './src/renderer/hooks/**/*.test.ts']
        }
      },
      {
        test: {
          name: 'node',
          environment: 'node',
          // e2e/ 下的 *.test.ts 是 Playwright 用例的配套纯函数单测（如 e2e/dist-guard.ts），
          // 不在 Playwright 的 testMatch(*.e2e.ts) 内，也不会真的启动应用；此处纳入后
          // npm test 与 npm run verify（按路径派发）才都能命中它们。
          include: [
            './src/**/*.test.ts',
            './src/**/*.test.tsx',
            './scripts/**/*.test.ts',
            './e2e/**/*.test.ts'
          ],
          exclude: ['./src/renderer/**/*.test.tsx', './src/renderer/hooks/**/*.test.ts']
        }
      }
    ],
    exclude: ['node_modules', 'dist', 'release'],
    globals: true,
    testTimeout: 10000,
    // 默认 threads 池在历史版本 + Node 22 下曾出现 teardown 挂起；继续使用每文件独立 forks。
    // Vitest 4+ 已移除 poolOptions，原 singleFork:false 即当前默认行为，无需额外配置。
    pool: 'forks',
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
      // 覆盖率门控阈值：按 Vitest 5 v8 新口径重新基线（2026-10-14 实测 statements 66.69% / branches 58.19% /
      // functions 59.22% / lines 68.27%，全量 373 文件通过、含 2 例既有 skip），整数下取整后作为回归下限。
      // 读数较 2026-10 旧基线（69.94/81.43/68.55/69.94）下移属 v8 provider 口径修正——旧 provider 把从未调用的
      // 箭头函数体计入所在语句并判为已覆盖，非测试退化（取证见 DEBT-032 / round2 §15）。禁止为凑数换 provider
      // 或扩大 exclude；后续靠补薄封装模块的真实调用测试回升，目标仍为 80%。
      thresholds: {
        statements: 66,
        branches: 58,
        functions: 59,
        lines: 68
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
