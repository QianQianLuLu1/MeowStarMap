import { describe, it, expect } from 'vitest'
import { removeFromWarnBlock } from '../prune-whitelist'
import { applyEdits, fileHasTScope } from '../codemod'
import { evaluateGuard, type GuardInput } from '../guard'
import { loadWhitelistFiles, loadZhCNValueIndex } from '../_shared'

const SAMPLE_CONFIG = `const config = [
  {
    files: ['src/**/*.test.ts', 'src/**/__tests__/**'],
    rules: { 'no-restricted-syntax': 'off' }
  },
  {
    // legacy whitelist
    files: [
      'src/main/a.ts',
      'src/renderer/b.tsx',
      'src/shared/c.ts'
    ],
    rules: { 'no-restricted-syntax': ['warn', ...i18nGuardSelectors] }
  }
]
`

describe('prune-whitelist.removeFromWarnBlock', () => {
  it('仅移除 warn 块内的目标路径，不动 test 块', () => {
    const out = removeFromWarnBlock(SAMPLE_CONFIG, ['src/renderer/b.tsx'])
    expect(out).toContain("'src/main/a.ts'")
    expect(out).toContain("'src/shared/c.ts'")
    expect(out).not.toContain('src/renderer/b.tsx')
    // test 块不受影响
    expect(out).toContain("'src/**/*.test.ts'")
  })

  it('移除多个路径', () => {
    const out = removeFromWarnBlock(SAMPLE_CONFIG, ['src/main/a.ts', 'src/shared/c.ts'])
    expect(out).toContain("'src/renderer/b.tsx'")
    expect(out).not.toContain('src/main/a.ts')
    expect(out).not.toContain('src/shared/c.ts')
  })

  it('无匹配时不改动配置', () => {
    const out = removeFromWarnBlock(SAMPLE_CONFIG, ['src/renderer/nope.ts'])
    expect(out).toBe(SAMPLE_CONFIG)
  })
})

describe('codemod.applyEdits', () => {
  it('按偏移精确替换（从后往前避免偏移漂移）', () => {
    const content = `x = "你好"`
    // "你好" 位于索引 4..8（含引号）
    const out = applyEdits(content, [{ start: 4, end: 8, replacement: `t('k')` }])
    expect(out).toBe(`x = t('k')`)
  })

  it('多编辑从后往前应用', () => {
    const content = `a = "一"; b = "二"`
    const out = applyEdits(content, [
      { start: 4, end: 7, replacement: `t('a')` },
      { start: 13, end: 16, replacement: `t('b')` }
    ])
    expect(out).toBe(`a = t('a'); b = t('b')`)
  })
})

describe('codemod.fileHasTScope', () => {
  it('识别 react-i18next / useTranslation / t()', () => {
    expect(fileHasTScope(`import { useTranslation } from 'react-i18next'`)).toBe(true)
    expect(fileHasTScope(`const { t } = useTranslation()`)).toBe(true)
    expect(fileHasTScope(`foo(t('x'))`)).toBe(true)
  })
  it('无 t 作用域返回 false', () => {
    expect(fileHasTScope(`const x = 1\nconsole.log('hi')`)).toBe(false)
  })
})

describe('guard.evaluateGuard', () => {
  const mk = (files: string[]): GuardInput => ({
    currentFiles: files,
    stats: new Map(files.map((f) => [f, { file: f, violations: 5, loc: [] }])),
    baseline: { files: ['src/main/a.ts', 'src/renderer/b.tsx', 'src/shared/c.ts'] }
  })

  it('正常收敛（子集且无清零）通过', () => {
    expect(evaluateGuard(mk(['src/main/a.ts']))).toEqual([])
  })

  it('新增白名单文件则失败（只减不增）', () => {
    const r = evaluateGuard(mk(['src/main/a.ts', 'src/extra/new.ts']))
    expect(r.some((v) => v.includes('只减不增'))).toBe(true)
  })

  it('清零却未移除则失败', () => {
    const input = mk(['src/main/a.ts'])
    input.stats.set('src/main/a.ts', { file: 'src/main/a.ts', violations: 0, loc: [] })
    const r = evaluateGuard(input)
    expect(r.some((v) => v.includes('i18n:prune-whitelist'))).toBe(true)
  })
})

describe('_shared 数据源', () => {
  it('loadWhitelistFiles 在白名单清偿完成后返回空集（2026-08-23 全量出清）', async () => {
    const files = await loadWhitelistFiles()
    expect(files.length).toBe(0)
  })

  it('loadZhCNValueIndex 建立中文值→key 反查', () => {
    const idx = loadZhCNValueIndex()
    expect(idx.size).toBeGreaterThan(0)
  })
})
