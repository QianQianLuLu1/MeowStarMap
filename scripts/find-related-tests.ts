/**
 * 源文件 → 相关测试文件匹配的共享规则（单一实现）
 *
 * 供 scripts/verify-changes.ts 与 scripts/run-precommit-tests.ts 共用，
 * 保证两条入口的匹配规则一致、不再分叉。
 *
 * 匹配策略（每个源文件按序取首个命中，最多匹配一个测试文件）：
 *   1. <源文件目录>/<base>.test.ts
 *   2. <源文件目录>/<base>.test.tsx
 *   3. <源文件目录>/__tests__/<base>.test.ts
 *   4. <源文件目录>/__tests__/<base>.test.tsx
 * 测试文件自身（*.test.ts(x)）直接作为待运行测试收集，不要求存在同名源文件。
 * .d.ts 与 *.stories.* 及非 TS/TSX 文件不参与匹配。
 */

import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

export interface RelatedTestsResult {
  /** 待运行的测试文件（相对 cwd，已去重） */
  tests: string[]
  /** 未命中任何匹配套件的源文件（保留输入原样，供调用方显式输出） */
  missing: string[]
}

const TEST_SUFFIXES = ['.test.ts', '.test.tsx'] as const

function isTestFile(f: string): boolean {
  return f.endsWith('.test.ts') || f.endsWith('.test.tsx')
}

export function findRelatedTests(cwd: string, files: string[]): RelatedTestsResult {
  const tests = new Set<string>()
  const missing: string[] = []

  for (const f of files) {
    const ext = extname(f)
    if (ext !== '.ts' && ext !== '.tsx') continue
    if (f.endsWith('.d.ts') || f.includes('.stories.')) continue

    if (isTestFile(f)) {
      tests.add(relative(cwd, resolve(cwd, f)))
      continue
    }

    const absPath = resolve(cwd, f)
    const base = basename(absPath).replace(/\.(ts|tsx)$/, '')
    const dir = dirname(absPath)
    let matched = false
    for (const location of [dir, join(dir, '__tests__')]) {
      for (const suffix of TEST_SUFFIXES) {
        const testPath = join(location, base + suffix)
        if (existsSync(testPath)) {
          tests.add(relative(cwd, testPath))
          matched = true
          break
        }
      }
      if (matched) break
    }
    if (!matched) missing.push(f)
  }

  return { tests: [...tests], missing }
}
