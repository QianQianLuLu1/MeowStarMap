/**
 * pre-commit 测试运行器
 *
 * 由 lint-staged 调用，接收暂存的源文件路径作为参数，
 * 按共享匹配规则（scripts/find-related-tests.ts）查找对应测试文件并仅运行这些测试。
 *
 * 匹配策略（每个源文件取首个命中，先同目录同名，再 __tests__/ 子目录）：
 *   src/foo/bar.ts → src/foo/bar.test.ts | src/foo/bar.test.tsx
 *                → src/foo/__tests__/bar.test.ts | src/foo/__tests__/bar.test.tsx
 *
 * 用法：lint-staged 通过 "scripts/run-precommit-tests.ts" 调用（自动传入匹配文件）
 * 也可手动执行：npx tsx scripts/run-precommit-tests.ts src/main/services/backup.ts
 */

import { spawnSync } from 'child_process'
import { findRelatedTests } from './find-related-tests'

const cwd = process.cwd()
const stagedFiles = process.argv.slice(2)

if (stagedFiles.length === 0) {
  console.log('[precommit-test] 无暂存文件，跳过测试')
  process.exit(0)
}

// ── 共享匹配规则：测试文件直接收集，源文件按 同目录 → __tests__/ 查找套件 ──
const { tests: uniqueTestFiles, missing } = findRelatedTests(cwd, stagedFiles)

if (uniqueTestFiles.length === 0) {
  if (missing.length > 0) {
    console.log(
      `[precommit-test] ⚠ 未命中任何测试 — ${missing.length} 个源文件缺少匹配套件（同目录与 __tests__/ 下均无 <base>.test.ts(x)），未运行任何测试：`
    )
    for (const f of missing) console.log(`  - ${f}`)
  } else {
    console.log('[precommit-test] 无 TS/TSX 暂存文件，未运行测试')
  }
  process.exit(0)
}

if (missing.length > 0) {
  console.log(`[precommit-test] ⚠ ${missing.length} 个源文件未命中任何测试（缺少匹配套件）：`)
  for (const f of missing) console.log(`  - ${f}`)
}

console.log(`[precommit-test] 找到 ${uniqueTestFiles.length} 个相关测试文件，开始运行...`)

// ── 运行 vitest（Windows 上 npx 是 .cmd，需要 shell: true） ──
// vitest 5 移除了 basic reporter：传入未知 reporter 名会在启动期直接报
// "Failed to load custom Reporter from basic" 并以非零退出，令 pre-commit 测试闸门整体失效；
// dot 是输出密度最接近原 basic 的内置 reporter。
const result = spawnSync('npx', ['vitest', 'run', '--reporter=dot', ...uniqueTestFiles], {
  stdio: 'inherit',
  cwd,
  shell: true
})

process.exit(result.status ?? 1)
