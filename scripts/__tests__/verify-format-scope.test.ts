import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import {
  parseFormatScopeKey,
  getPrettierKeys,
  selectFormatTargets,
  type FormatScopeRule
} from '../verify-format-scope'

/**
 * verify-format-scope 单测：从 package.json 的 lint-staged 配置推导「钩子会格式化哪些文件」。
 *
 * 覆盖三类：
 *   正常 — 现有 6 种键形态解析、prettier 键筛选、作用域命中
 *   异常 — 无法解析的键返回 null、空输入、非 prettier 键被排除
 *   边界 — 根作用域只匹配一层、反斜杠归一化、去重与顺序、深层嵌套、扩展名不匹配
 * 另含一条与真实 package.json 的配置契约测试，防止 lint-staged 键形态漂移导致覆盖静默丢失；
 * 以及文档口径守护：docs/CODING_CONVENTIONS.md 真相源与钩子/verify 分工一致、
 * 被跟踪指引不得把约定出处指向未入库的 .qoder/ 规则文件、根 AGENTS.md 导航表逐行可解析、
 * 本地镜像正文区与真相源逐字一致。
 */

/** 与 package.json 现状一致的夹具键（顺序也保持一致，用于校验输出顺序） */
const FIXTURE_KEYS = [
  'src/**/*.{ts,tsx}',
  '.storybook/**/*.{ts,tsx}',
  'e2e/**/*.{ts,tsx}',
  'src/**/*.{js,jsx,json,css,md}',
  'scripts/**/*.{ts,js}',
  '*.{ts,js,json,md}'
]

describe('parseFormatScopeKey', () => {
  describe('正常：现有键形态', () => {
    it('目录 + 花括号多扩展名', () => {
      expect(parseFormatScopeKey('src/**/*.{ts,tsx}')).toEqual({
        dir: 'src',
        exts: ['ts', 'tsx']
      } satisfies FormatScopeRule)
    })

    it('多级目录前缀', () => {
      expect(parseFormatScopeKey('src/main/ipc/**/*.{ts,tsx}')).toEqual({
        dir: 'src/main/ipc',
        exts: ['ts', 'tsx']
      })
    })

    it('以点开头的目录名（.storybook）', () => {
      expect(parseFormatScopeKey('.storybook/**/*.{ts,tsx}')).toEqual({
        dir: '.storybook',
        exts: ['ts', 'tsx']
      })
    })

    it('单扩展名（无花括号）', () => {
      expect(parseFormatScopeKey('e2e/**/*.ts')).toEqual({ dir: 'e2e', exts: ['ts'] })
    })

    it('仓库根作用域（不含斜杠）→ dir 为 null', () => {
      expect(parseFormatScopeKey('*.{ts,js,json,md}')).toEqual({
        dir: null,
        exts: ['ts', 'js', 'json', 'md']
      })
    })

    it('根作用域单扩展名形态', () => {
      expect(parseFormatScopeKey('*.json')).toEqual({ dir: null, exts: ['json'] })
    })

    it('混合扩展名列表完整保留', () => {
      expect(parseFormatScopeKey('src/**/*.{js,jsx,json,css,md}')).toEqual({
        dir: 'src',
        exts: ['js', 'jsx', 'json', 'css', 'md']
      })
    })
  })

  describe('异常：无法解析的形态返回 null（调用方需显式告警）', () => {
    it.each([
      ['缺省文件名', 'src/**'],
      ['否定形态', '!src/**/*.ts'],
      ['纯字面路径', 'README.md'],
      ['花括号未闭合', 'src/**/*.{ts,tsx'],
      ['后缀带额外片段', 'src/**/*.d.ts'],
      ['空字符串', '']
    ])('%s', (_label, key) => {
      expect(parseFormatScopeKey(key)).toBeNull()
    })
  })
})

describe('getPrettierKeys', () => {
  it('筛出任务中含 prettier 的键，保持配置顺序', () => {
    const lintStaged = {
      'src/**/*.{ts,tsx}': ['eslint --fix', 'prettier --write', 'npm run test:precommit --'],
      '.storybook/**/*.{ts,tsx}': ['eslint --fix', 'prettier --write'],
      'src/**/*.{js,jsx,json,css,md}': ['prettier --write'],
      'tools/**/*.{ts,js}': ['eslint --fix']
    }
    expect(getPrettierKeys(lintStaged)).toEqual([
      'src/**/*.{ts,tsx}',
      '.storybook/**/*.{ts,tsx}',
      'src/**/*.{js,jsx,json,css,md}'
    ])
  })

  it('支持任务为字符串单值的写法', () => {
    expect(getPrettierKeys({ 'docs/**/*.md': 'prettier --write' })).toEqual(['docs/**/*.md'])
  })

  it('异常输入：空配置 / 非 prettier 命令 → 空数组', () => {
    expect(getPrettierKeys({})).toEqual([])
    expect(getPrettierKeys({ 'src/*.ts': ['eslint --fix'] })).toEqual([])
    expect(getPrettierKeys({ 'src/*.ts': [] })).toEqual([])
  })
})

describe('selectFormatTargets', () => {
  it('命中目录作用域（含深层嵌套）', () => {
    expect(
      selectFormatTargets(
        ['src/main/ipc/validator.ts', 'src/renderer/pages/Gallery.tsx'],
        ['src/**/*.{ts,tsx}']
      )
    ).toEqual(['src/main/ipc/validator.ts', 'src/renderer/pages/Gallery.tsx'])
  })

  it('根作用域只匹配一层文件，不匹配子目录', () => {
    expect(
      selectFormatTargets(
        ['AGENTS.md', 'CHANGELOG.md', 'package.json', 'docs/IPC_CONTRACT.md'],
        ['*.{ts,js,json,md}']
      )
    ).toEqual(['AGENTS.md', 'CHANGELOG.md', 'package.json'])
  })

  it('扩展名不在列表内 → 不匹配', () => {
    expect(selectFormatTargets(['src/index.html'], ['src/**/*.{ts,tsx}'])).toEqual([])
  })

  it('多键合并去重并保持输入顺序', () => {
    expect(
      selectFormatTargets(['scripts/a.ts', 'src/b.ts', 'scripts/a.ts', 'AGENTS.md'], FIXTURE_KEYS)
    ).toEqual(['scripts/a.ts', 'src/b.ts', 'AGENTS.md'])
  })

  it('边界：Windows 反斜杠输入归一化为 posix 后匹配', () => {
    expect(selectFormatTargets(['src\\main\\a.ts'], ['src/**/*.{ts,tsx}'])).toEqual([
      'src/main/a.ts'
    ])
  })

  it('无花括号键同样支持深层嵌套', () => {
    expect(selectFormatTargets(['e2e/pages/login.e2e.ts'], ['e2e/**/*.ts'])).toEqual([
      'e2e/pages/login.e2e.ts'
    ])
  })

  it('边界：无扩展名路径与目录名本身不匹配', () => {
    expect(
      selectFormatTargets(['src', 'src/main', 'README'], ['src/**/*.{ts,tsx}', '*.md'])
    ).toEqual([])
  })

  it('异常：空文件列表 / 空键列表 → 空数组', () => {
    expect(selectFormatTargets([], FIXTURE_KEYS)).toEqual([])
    expect(selectFormatTargets(['src/a.ts'], [])).toEqual([])
  })

  it('无法解析的键不影响其他键的匹配', () => {
    expect(selectFormatTargets(['src/a.ts'], ['src/**', 'src/**/*.{ts,tsx}'])).toEqual(['src/a.ts'])
  })
})

describe('与真实 package.json 的 lint-staged 配置契约', () => {
  const lintStaged = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
  )['lint-staged'] as Record<string, string | string[]>

  it('每个含 prettier 的键都能被本模块解析（键形态漂移时先在这里失败）', () => {
    const keys = getPrettierKeys(lintStaged)
    expect(keys.length).toBeGreaterThan(0)
    const unparsed = keys.filter((k) => parseFormatScopeKey(k) === null)
    expect(unparsed).toEqual([])
  })

  it('钩子会格式化的路径全部命中', () => {
    const keys = getPrettierKeys(lintStaged)
    expect(
      selectFormatTargets(
        [
          'src/renderer/pages/Gallery.tsx',
          'src/main/index.ts',
          'scripts/verify-changes.ts',
          '.storybook/preview.ts',
          'e2e/smoke.e2e.ts',
          'src/renderer/styles/globals.css',
          'AGENTS.md',
          'CHANGELOG.md',
          'package.json'
        ],
        keys
      )
    ).toEqual([
      'src/renderer/pages/Gallery.tsx',
      'src/main/index.ts',
      'scripts/verify-changes.ts',
      '.storybook/preview.ts',
      'e2e/smoke.e2e.ts',
      'src/renderer/styles/globals.css',
      'AGENTS.md',
      'CHANGELOG.md',
      'package.json'
    ])
  })

  it('钩子不格式化的路径不得进入格式检查（避免比闸门更严的假失败）', () => {
    const keys = getPrettierKeys(lintStaged)
    expect(
      selectFormatTargets(
        [
          'docs/IPC_CONTRACT.md',
          '.qoder/rules/project-conventions.md',
          'scripts/AGENTS.md',
          'plugins-samples/custom-watermark-template/index.ts'
        ],
        keys
      )
    ).toEqual([])
  })
})

describe('文档口径与真实配置的一致性守护', () => {
  const lintStaged = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
  )['lint-staged'] as Record<string, string | string[]>
  const prettierKeys = getPrettierKeys(lintStaged)
  const agentsMdUrl = new URL('../../AGENTS.md', import.meta.url)
  const agentsMd = readFileSync(agentsMdUrl, 'utf-8')
  /** 编码约定的唯一真相源（已入仓）；`.qoder/` 下的 IDE 规则文件只是它的本地镜像，不入库 */
  const conventionsUrl = new URL('../../docs/CODING_CONVENTIONS.md', import.meta.url)
  const mirrorUrl = new URL('../../.qoder/rules/project-conventions.md', import.meta.url)

  /**
   * 非导航表形式的被跟踪指引文件：这些文件里的“约定出处”必须在仓内能解析。
   * 新增同类入口时同步补入本数组，否则断链守护不覆盖它。
   * （模块级 `AGENTS.md` 不在此列，由 NAV_TABLE_PATHS 从导航表动态解析，避免清单漏项。）
   */
  const GUIDE_FILES = [
    'AGENTS.md',
    'commitlint.config.cjs',
    '.gitmessage',
    '.husky/commit-msg',
    'eslint.config.js'
  ]

  /** 根 AGENTS.md「核心模块导航」表行内的指引路径（表格即导航契约，逐行必须可解析） */
  const NAV_TABLE_PATHS = agentsMd
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.startsWith('| ') && line.includes('AGENTS.md'))
    .map((line) => /\]\(([^)]+)\)/.exec(line)?.[1])
    .filter((p): p is string => Boolean(p))

  /**
   * 取正文区（锁定行首的「# 项目编码约定」一级标题及其后全部内容）并归一化行尾。
   * docs 头部声明块与镜像 banner 里的同名引用均不在行首，故 ^ + m 匹配不会误中。
   * 本机 core.autocrlf=true 时工作区为 CRLF，不归一化会造成假漂移。
   */
  function readBodyRegion(url: URL): string {
    const raw = readFileSync(url, 'utf-8').replace(/\r\n/g, '\n')
    const idx = raw.search(/^# 项目编码约定/m)
    if (idx < 0) throw new Error(`未找到正文区锚点：${url.pathname}`)
    return raw.slice(idx)
  }

  it('AGENTS.md 逐字列出当前 lint-staged 中所有含 prettier 的键', () => {
    expect(prettierKeys.length).toBeGreaterThan(0)
    const missing = prettierKeys.filter((key) => !agentsMd.includes(key))
    expect(missing).toEqual([])
  })

  it('AGENTS.md 不得重新出现“与 pre-commit 钩子等效”的旧口径', () => {
    expect(agentsMd).not.toContain('与 pre-commit 钩子等效')
    expect(agentsMd).toContain('verify 与 pre-commit 闸门的差异')
    expect(agentsMd).toContain('eslint --fix')
  })

  it('AGENTS.md 声明为“不在闸门格式范围”的路径确实不在范围内', () => {
    for (const token of ['docs/**', '.qoder/rules/*.md', 'scripts/AGENTS.md']) {
      expect(agentsMd).toContain(token)
    }
    expect(
      selectFormatTargets(
        ['docs/IPC_CONTRACT.md', '.qoder/rules/project-conventions.md', 'scripts/AGENTS.md'],
        prettierKeys
      )
    ).toEqual([])
  })

  // 真相源已入仓：文件缺失即失败，不再有“干净克隆下静默跳过”的失效路径
  it('只读格式检查脚本按 §5 携带行尾豁免，写回侧脚本不携带', () => {
    const scripts = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
    ).scripts as Record<string, string>
    expect(scripts['format:check']).toContain('prettier --check')
    expect(scripts['format:check']).toContain('--end-of-line auto')
    expect(scripts['format']).toContain('prettier --write')
    expect(scripts['format']).not.toContain('--end-of-line')
  })

  it('唯一真相源 docs/CODING_CONVENTIONS.md 的「校验与提交」与钩子/verify 分工口径一致', () => {
    const doc = readFileSync(conventionsUrl, 'utf-8')
    expect(doc).toContain('校验与提交')
    expect(doc).toContain('verify 通过不代表提交时文件内容不变')
    expect(doc).toContain('eslint --fix')
    expect(doc).not.toContain('与 pre-commit 钩子等效')
  })

  it('被跟踪指引文件一律把约定出处指向 docs 真相源，不得指向未入库的 .qoder/ 规则文件', () => {
    const guides = [...GUIDE_FILES, ...NAV_TABLE_PATHS]
    expect(guides.length).toBeGreaterThan(GUIDE_FILES.length)
    for (const rel of guides) {
      const text = readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf-8')
      expect(text, `${rel} 必须引用 docs/CODING_CONVENTIONS.md`).toContain(
        'docs/CODING_CONVENTIONS.md'
      )
      expect(text, `${rel} 不得再以 .qoder/ 规则文件为出处`).not.toContain('project-conventions.md')
    }
  })

  it('根 AGENTS.md 导航表列出的每个路径都能在仓库中解析（表格不得指向仓外文件）', () => {
    expect(NAV_TABLE_PATHS.length).toBeGreaterThanOrEqual(12)
    for (const rel of NAV_TABLE_PATHS) {
      expect(
        existsSync(new URL(`../../${rel}`, import.meta.url)),
        `导航表路径不可解析：${rel}`
      ).toBe(true)
    }
  })

  it('.qoder/ 本地镜像的正文区与 docs 真相源逐字一致（镜像缺失不属失败）', () => {
    if (!existsSync(mirrorUrl)) {
      console.warn(
        '[verify-format-scope] ⚠ 未找到 .qoder/ 规则镜像（本地资产，属预期），本轮仅校验 docs 真相源'
      )
      return
    }
    expect(readBodyRegion(mirrorUrl)).toBe(readBodyRegion(conventionsUrl))
  })
})
