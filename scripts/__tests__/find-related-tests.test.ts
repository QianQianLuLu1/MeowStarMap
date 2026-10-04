import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { findRelatedTests } from '../find-related-tests'

/**
 * findRelatedTests 单测：源文件 → 相关测试文件匹配的共享规则。
 *
 * 覆盖：同目录同名 / __tests__/ 子目录回退（新增行为）/ 同目录优先级 /
 * 后缀优先级 / 测试文件直接收集 / .d.ts 与 .stories 排除 / 非 TS 忽略 /
 * 去重 / 无套件落 missing / 混合场景 / 深层嵌套与绝对路径输入。
 *
 * 使用真实临时目录作为 fixture 根（匹配规则依赖 existsSync），
 * 期望路径用 join 构造以保持与 relative() 输出在 Windows/POSIX 一致。
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'find-related-tests-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 在 fixture 根下按相对路径创建空文件（自动补建父目录） */
function makeTree(files: string[]): void {
  for (const f of files) {
    const abs = resolve(root, f)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, '')
  }
}

describe('findRelatedTests', () => {
  describe('正常匹配', () => {
    it('同目录同名 <base>.test.ts 命中', () => {
      makeTree(['src/foo.ts', 'src/foo.test.ts'])
      const r = findRelatedTests(root, ['src/foo.ts'])
      expect(r.tests).toEqual([join('src', 'foo.test.ts')])
      expect(r.missing).toEqual([])
    })

    it('仅 __tests__/ 下有套件时回退命中（新增行为）', () => {
      makeTree(['src/main/app/foo.ts', 'src/main/app/__tests__/foo.test.ts'])
      const r = findRelatedTests(root, ['src/main/app/foo.ts'])
      expect(r.tests).toEqual([join('src', 'main', 'app', '__tests__', 'foo.test.ts')])
      expect(r.missing).toEqual([])
    })

    it('仅 __tests__/ 下有 <base>.test.tsx 时回退命中', () => {
      makeTree(['src/foo.tsx', 'src/__tests__/foo.test.tsx'])
      const r = findRelatedTests(root, ['src/foo.tsx'])
      expect(r.tests).toEqual([join('src', '__tests__', 'foo.test.tsx')])
      expect(r.missing).toEqual([])
    })

    it('输入即测试文件时原样收集（不要求同目录存在源文件）', () => {
      makeTree(['src/foo.test.tsx'])
      const r = findRelatedTests(root, ['src/foo.test.tsx'])
      expect(r.tests).toEqual([join('src', 'foo.test.tsx')])
      expect(r.missing).toEqual([])
    })
  })

  describe('优先级', () => {
    it('同目录与 __tests__/ 均有套件时取同目录', () => {
      makeTree(['src/foo.ts', 'src/foo.test.ts', 'src/__tests__/foo.test.ts'])
      const r = findRelatedTests(root, ['src/foo.ts'])
      expect(r.tests).toEqual([join('src', 'foo.test.ts')])
    })

    it('同目录 .test.ts 与 .test.tsx 均有套件时取 .test.ts', () => {
      makeTree(['src/foo.ts', 'src/foo.test.tsx', 'src/foo.test.ts'])
      const r = findRelatedTests(root, ['src/foo.ts'])
      expect(r.tests).toEqual([join('src', 'foo.test.ts')])
    })

    it('__tests__/ 下 .test.ts 优先于 .test.tsx', () => {
      makeTree(['src/foo.ts', 'src/__tests__/foo.test.tsx', 'src/__tests__/foo.test.ts'])
      const r = findRelatedTests(root, ['src/foo.ts'])
      expect(r.tests).toEqual([join('src', '__tests__', 'foo.test.ts')])
    })
  })

  describe('输入过滤', () => {
    it('.d.ts 与 .stories.* 不参与匹配也不计入 missing', () => {
      makeTree(['src/types.d.ts', 'src/comp.stories.tsx'])
      const r = findRelatedTests(root, ['src/types.d.ts', 'src/comp.stories.tsx'])
      expect(r.tests).toEqual([])
      expect(r.missing).toEqual([])
    })

    it('非 TS/TSX 输入忽略', () => {
      makeTree(['README.md', 'package.json'])
      const r = findRelatedTests(root, ['README.md', 'package.json'])
      expect(r.tests).toEqual([])
      expect(r.missing).toEqual([])
    })

    it('重复输入去重：同一测试文件只出现一次', () => {
      makeTree(['src/foo.test.ts'])
      const r = findRelatedTests(root, ['src/foo.test.ts', 'src/foo.test.ts'])
      expect(r.tests).toEqual([join('src', 'foo.test.ts')])
    })

    it('重复输入的无套件源文件按输入原样保留在 missing 中', () => {
      const r = findRelatedTests(root, ['src/foo.ts', 'src/foo.ts'])
      expect(r.tests).toEqual([])
      expect(r.missing).toEqual(['src/foo.ts', 'src/foo.ts'])
    })
  })

  describe('未命中与混合', () => {
    it('无任何匹配套件时落入 missing（tests 为空）', () => {
      makeTree(['src/lonely.ts'])
      const r = findRelatedTests(root, ['src/lonely.ts'])
      expect(r.tests).toEqual([])
      expect(r.missing).toEqual(['src/lonely.ts'])
    })

    it('混合场景：有套件的命中、无套件的落 missing', () => {
      makeTree(['src/has.ts', 'src/has.test.ts', 'src/none.ts'])
      const r = findRelatedTests(root, ['src/has.ts', 'src/none.ts'])
      expect(r.tests).toEqual([join('src', 'has.test.ts')])
      expect(r.missing).toEqual(['src/none.ts'])
    })

    it('空输入返回空结果', () => {
      expect(findRelatedTests(root, [])).toEqual({ tests: [], missing: [] })
    })
  })

  describe('路径形态', () => {
    it('深层嵌套路径命中 __tests__/ 回退', () => {
      makeTree(['src/main/app/ipc.ts', 'src/main/app/__tests__/ipc.test.ts'])
      const r = findRelatedTests(root, ['src/main/app/ipc.ts'])
      expect(r.tests).toEqual([join('src', 'main', 'app', '__tests__', 'ipc.test.ts')])
    })

    it('绝对路径输入与相对路径输入等价', () => {
      makeTree(['src/main/app/ipc.ts', 'src/main/app/__tests__/ipc.test.ts'])
      const abs = resolve(root, 'src/main/app/ipc.ts')
      const r = findRelatedTests(root, [abs])
      expect(r.tests).toEqual([join('src', 'main', 'app', '__tests__', 'ipc.test.ts')])
      expect(r.missing).toEqual([])
    })
  })
})
