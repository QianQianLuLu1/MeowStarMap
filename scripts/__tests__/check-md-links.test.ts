import { describe, it, expect } from 'vitest'
import {
  isPathLike,
  extractRefs,
  candidatePaths,
  classifyRef,
  checkDocument,
  hasScopeDeclaration,
  runCheck,
  type MdRef
} from '../check-md-links'

/**
 * check-md-links 单测：被跟踪 Markdown 里 `[x](path)` 与行内反引号路径的可解析性判定。
 *
 * 覆盖四类：
 *   正常 — 根锚点路径、源文件相对路径、目录引用、被跟踪文件命中
 *   异常 — 跳出仓库根、本机留存区、构建产物、已交代去向的历史路径
 *   边界 — 围栏代码块与行内代码段不产生引用、正则/代码片段不判为链接、
 *          IPC 通道名与模板占位不算路径、锚点与查询串被剥除
 * 另含一条真实仓库契约：`runCheck()` 的死引用数必须为 0。这条用例把「文档不得留死引用」
 * 钉进 `npm test` 与 CI，是本轮补上的机制缺口（2026-10-10 那轮 §8.2 登记的遗留风险）。
 */

const TRACKED = [
  'AGENTS.md',
  'docs/CODING_CONVENTIONS.md',
  'docs/IPC_CONTRACT.md',
  'docs/plans/2026-10-10-markdown-inventory-and-corrections.md',
  'src/main/preload/AGENTS.md',
  'src/main/index.ts',
  'scripts/verify-changes.ts',
  'e2e/smoke.e2e.ts'
] as const

const trackedSet = new Set<string>(TRACKED)
const trackedPrefixes = [...trackedSet]

function ref(raw: string, context = '', kind: MdRef['kind'] = 'markdown-link'): MdRef {
  return { raw, kind, line: 1, context }
}

function verdictOf(raw: string, source = 'docs/IPC_CONTRACT.md', context = ''): string {
  return classifyRef(ref(raw, context), source, trackedSet, trackedPrefixes).verdict
}

describe('isPathLike：行内反引号 token 的路径判定（刻意保守）', () => {
  it('根锚点 + 已知扩展名 / 结尾斜杠才视为路径', () => {
    expect(isPathLike('docs/IPC_CONTRACT.md')).toBe(true)
    expect(isPathLike('src/main/index.ts')).toBe(true)
    expect(isPathLike('scripts/')).toBe(true)
  })

  it('模块内简写不算仓库路径（按仓库根解析必然成片误报）', () => {
    for (const token of ['app/', 'preload/ipc.ts', '__tests__/', '.ts/.tsx', 'handlers/']) {
      expect(isPathLike(token), token).toBe(false)
    }
  })

  it('含通配符、模板占位、空格、省略号、反斜杠、盘符、协议串的 token 一律跳过', () => {
    for (const token of [
      'src/**',
      'docs/plans/*.md',
      '{userData}/database/wxnn.db',
      'app://renderer/<path>',
      'docs/plans/ … 若干',
      'src\\main\\index.ts',
      'D:/Zcode/x.md',
      'media://file/1',
      'src/index.tsx:120',
      'e2e:smoke'
    ]) {
      expect(isPathLike(token), token).toBe(false)
    }
  })
})

describe('extractRefs：引用抽取与代码噪声屏蔽', () => {
  it('抽取 markdown 链接、引用定义与行内路径', () => {
    const md = [
      '[契约](docs/IPC_CONTRACT.md)',
      '[ref]: src/main/index.ts',
      '见 `scripts/verify-changes.ts`。'
    ].join('\n')
    const kinds = extractRefs(md).map((r) => r.kind)
    expect(kinds).toEqual(['markdown-link', 'reference-definition', 'inline-path'])
  })

  it('围栏代码块内的路径是示例，不产生引用', () => {
    const md = ['```', 'docs/nowhere.md', '```', '正文 `docs/IPC_CONTRACT.md`'].join('\n')
    expect(extractRefs(md)).toHaveLength(1)
  })

  it('解释链接语法本身不构成引用（反引号内的 [x](path) 被屏蔽）', () => {
    expect(extractRefs('它只校验 `[x](path)` 形态')).toHaveLength(0)
  })

  it('正则字面量不被误读成链接', () => {
    expect(extractRefs('- UID 正则 `[\\\\/](\\d{6,12})[\\\\/]`')).toHaveLength(0)
  })

  it('剥除锚点与查询串后再判定', () => {
    const refs = extractRefs('[见附录](docs/IPC_CONTRACT.md#section-2)')
    expect(refs[0].raw).toBe('docs/IPC_CONTRACT.md#section-2')
    expect(candidatePaths(refs[0].raw, 'README.md')).toEqual(['docs/IPC_CONTRACT.md'])
  })
})

describe('classifyRef：判定口径', () => {
  it('命中被跟踪文件 → ok', () => {
    expect(verdictOf('docs/IPC_CONTRACT.md')).toBe('ok')
    expect(verdictOf('src/main/index.ts')).toBe('ok')
  })

  it('目录引用命中跟踪文件的前缀 → ok', () => {
    expect(verdictOf('src/main/')).toBe('ok')
    expect(verdictOf('scripts/', 'AGENTS.md')).toBe('ok')
  })

  it('相对源文件的 ./ 与 ../ 路径按所在目录折算', () => {
    // 源文件在 docs/plans/ 下，../ 折回 docs/
    expect(
      verdictOf(
        '../CODING_CONVENTIONS.md',
        'docs/plans/2026-10-10-markdown-inventory-and-corrections.md'
      )
    ).toBe('ok')
    expect(verdictOf('./plans/2026-10-10-markdown-inventory-and-corrections.md')).toBe('ok')
    expect(verdictOf('../../../AGENTS.md', 'src/main/preload/AGENTS.md')).toBe('ok')
  })

  it('少写一层 ../ 即为死链（nikkisync/sync 的 AGENTS.md 本轮就是这么错的）', () => {
    expect(verdictOf('../../AGENTS.md', 'src/main/nikkisync/AGENTS.md')).toBe('dead')
    expect(verdictOf('../../../AGENTS.md', 'src/main/nikkisync/AGENTS.md')).toBe('ok')
  })

  it('点开头目录属仓库根，不当作相对路径', () => {
    const tracked = new Set<string>([...TRACKED, '.github/workflows/build.yml'])
    const v = classifyRef(ref('.github/workflows/build.yml'), 'docs/x.md', tracked, [...tracked])
    expect(v.verdict).toBe('ok')
  })

  it('跳出仓库根 → dead', () => {
    expect(verdictOf('../../../outside.md', 'docs/x.md')).toBe('dead')
  })

  it('未跟踪且无交代 → dead', () => {
    expect(verdictOf('docs/PLUGIN_SYSTEM_PLAN.md')).toBe('dead')
  })

  it('落在本机留存区（docs/archive 等） → ignored-local 提醒', () => {
    expect(verdictOf('docs/archive/plans/2026-09-29-x.md')).toBe('ignored-local')
    expect(verdictOf('docs/archive/')).toBe('ignored-local')
    expect(verdictOf('.qoder/rules/project-conventions.md')).toBe('ignored-local')
  })

  it('相对所在目录的简写命中忽略区时不误判为 dead', () => {
    expect(verdictOf('archive/x.md', 'docs/packaged-scan-crash-report.md')).toBe('ignored-local')
  })

  it('构建产物目录 → artifact', () => {
    expect(verdictOf('dist/main/main/app/index.js')).toBe('artifact')
    expect(verdictOf('coverage/coverage-summary.json')).toBe('artifact')
  })

  it('同行交代去向 → annotated-gone 提醒', () => {
    expect(
      verdictOf(
        'src/path_resolver.py',
        'CHANGELOG.md',
        '移除 Python 扫描器原型：`src/path_resolver.py`'
      )
    ).toBe('annotated-gone')
    expect(verdictOf('scripts/x.ps1', 'docs/y.md', '该脚本至今未纳入版本控制')).toBe(
      'annotated-gone'
    )
    expect(
      verdictOf('docs/plans/a.md', 'docs/b.md', '原计划文档已归档至 docs/archive/plans/')
    ).toBe('annotated-gone')
  })

  it('网络与自定义协议、页内锚点 → external', () => {
    expect(
      classifyRef(ref('https://example.com/a.md'), 'README.md', trackedSet, trackedPrefixes).verdict
    ).toBe('external')
    expect(classifyRef(ref('#toc'), 'README.md', trackedSet, trackedPrefixes).verdict).toBe(
      'external'
    )
  })
})

describe('hasScopeDeclaration：文档级路径作用域声明', () => {
  it('声明须落在前 12 行内', () => {
    const ok = [
      '# T',
      '',
      '> 路径作用域：混指本仓与上游 NikkiSync 仓，未落地的项按原文保留。'
    ].join('\n')
    expect(hasScopeDeclaration(ok)).toBe(true)
    const tooLate = [
      Array.from({ length: 14 }, (_, i) => `行${i}`).join('\n'),
      '> 路径作用域：上游'
    ].join('\n')
    expect(hasScopeDeclaration(tooLate)).toBe(false)
  })

  it('声明生效后，无法解析的仓库风格路径降级为提醒而非死链', () => {
    const md = [
      '# 阶段计划',
      '',
      '> 路径作用域：本文为阶段计划快照，属上游或当时设计未落地的项按原文保留。',
      '',
      '新建 `src/main/sync/scan-journal.ts`。'
    ].join('\n')
    const findings = checkDocument(
      'docs/sync-integration/05-ui-scanner-integration-plan.md',
      md,
      trackedSet,
      trackedPrefixes
    )
    expect(findings.dead).toHaveLength(0)
    expect(findings.advisory.map((r) => r.verdict)).toContain('upstream-scope')
  })
})

describe('真实仓库契约：被跟踪文档不留死引用', () => {
  it('runCheck() 的死引用数为 0', () => {
    const { totals, files } = runCheck()
    const detail = files
      .flatMap((f) => f.dead.map((d) => `  ${f.file}:${d.line} ${d.kind} \`${d.raw}\``))
      .join('\n')
    expect(totals.dead, `发现 ${totals.dead} 处死引用：\n${detail}`).toBe(0)
  })

  it('确实扫描到被跟踪 markdown（防止 glob 失效导致闸门空转）', () => {
    const { totals } = runCheck()
    expect(totals.docs).toBeGreaterThan(50)
  })
})
