/**
 * pre-commit 测试运行器
 *
 * 由 lint-staged 调用，接收暂存的源文件路径作为参数，
 * 查找同目录下的对应测试文件并仅运行这些测试。
 *
 * 匹配策略：src/foo/bar.ts → src/foo/bar.test.ts | src/foo/bar.test.tsx
 *
 * 用法：lint-staged 通过 "scripts/run-precommit-tests.ts" 调用（自动传入匹配文件）
 * 也可手动执行：npx tsx scripts/run-precommit-tests.ts src/main/services/backup.ts
 */

import { existsSync } from 'fs'
import { resolve, extname, relative } from 'path'
import { spawnSync } from 'child_process'

const cwd = process.cwd()
const stagedFiles = process.argv.slice(2)

if (stagedFiles.length === 0) {
  console.log('[precommit-test] 无暂存文件，跳过测试')
  process.exit(0)
}

// ── 筛选源文件与测试文件 ──
const testFiles: string[] = []
const sourceFiles: string[] = []

for (const f of stagedFiles) {
  const ext = extname(f)
  if (ext !== '.ts' && ext !== '.tsx') continue
  if (f.endsWith('.d.ts') || f.includes('.stories.')) continue

  if (f.endsWith('.test.ts') || f.endsWith('.test.tsx')) {
    // 暂存的是测试文件 → 直接运行（使用相对路径避免 Windows 特殊字符干扰正则匹配）
    testFiles.push(relative(cwd, resolve(cwd, f)))
  } else {
    sourceFiles.push(f)
  }
}

// 为每个源文件查找同目录下的对应测试文件
for (const file of sourceFiles) {
  const absPath = resolve(cwd, file)
  const base = absPath.replace(/\.(ts|tsx)$/, '')

  for (const suffix of ['.test.ts', '.test.tsx']) {
    const testPath = base + suffix
    if (existsSync(testPath)) {
      testFiles.push(relative(cwd, testPath))
      break // 每个源文件最多匹配一个测试文件
    }
  }
}

// 去重
const uniqueTestFiles = [...new Set(testFiles)]

if (uniqueTestFiles.length === 0) {
  console.log(`[precommit-test] 未找到相关测试文件（${sourceFiles.length} 个源文件），跳过`)
  process.exit(0)
}

console.log(`[precommit-test] 找到 ${uniqueTestFiles.length} 个相关测试文件，开始运行...`)

// ── 运行 vitest（Windows 上 npx 是 .cmd，需要 shell: true） ──
const result = spawnSync('npx', ['vitest', 'run', '--reporter=basic', ...uniqueTestFiles], {
  stdio: 'inherit',
  cwd,
  shell: true
})

process.exit(result.status ?? 1)
