// 设置页导航合并（2026-10-16）的语言包完整性回归。结构对齐同目录
// sync-gallery-keys.test.ts / nav-resonance-records.test.ts 的既有范式。
//
// 为什么要单独钉这一份：`npm run i18n:guard` 与 scripts/check-i18n-keys.ts 只比对
// **键的存在性**，从不检查值是否为空串。合并前 `settings.sections.gameRoots` 等 6 个键
// 在 11 个语言包里就是 ""，非中文用户的左导航直接渲染成空白条目，而两条闸门一路绿灯。
// 这些键在合并后升级为「扫描目录」页的块标题，所以把「非空」收成本文件的硬断言。
import { describe, expect, it } from 'vitest'
import zhCN from './zh-CN.json'
import zhTW from './zh-TW.json'
import en from './en.json'
import ja from './ja.json'
import ko from './ko.json'
import fr from './fr.json'
import de from './de.json'
import es from './es.json'
import pt from './pt.json'
import ru from './ru.json'
import th from './th.json'
import vi from './vi.json'

type LocaleNode = Record<string, unknown>

const LOCALES: Record<string, LocaleNode> = {
  'zh-CN': zhCN as LocaleNode,
  'zh-TW': zhTW as LocaleNode,
  en: en as LocaleNode,
  ja: ja as LocaleNode,
  ko: ko as LocaleNode,
  fr: fr as LocaleNode,
  de: de as LocaleNode,
  es: es as LocaleNode,
  pt: pt as LocaleNode,
  ru: ru as LocaleNode,
  th: th as LocaleNode,
  vi: vi as LocaleNode
}

function readPath(node: LocaleNode | undefined, dottedKey: string): unknown {
  let cur: unknown = node
  for (const seg of dottedKey.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as LocaleNode)[seg]
  }
  return cur
}

/** 递归收集叶子键路径，用于比对 12 包的子树是否同构。 */
function leafKeys(node: unknown, prefix = ''): string[] {
  if (!node || typeof node !== 'object') return [prefix]
  return Object.entries(node as LocaleNode).flatMap(([key, value]) =>
    leafKeys(value, prefix ? `${prefix}.${key}` : key)
  )
}

/** 合并新增的 5 个键（原 12 包均无，缺任一个都会在导航上渲染成原始 key）。 */
const NEW_KEYS = [
  'settings.groups.toolsPlugins',
  'settings.sections.themeDisplay',
  'settings.sections.scanDirectories',
  'settings.sections.cacheCleanup',
  'settings.sections.aboutOverview'
]

/**
 * 合并后 SETTINGS_GROUPS 实际消费的全部导航文案：8 个分组标题 + 17 个节标题。
 * 与 SettingsPage.test.tsx 的「8 组 17 项」计数断言互为补充——那边锁结构，这边锁文案。
 */
const GROUP_LABEL_KEYS = [
  'settings.groups.general',
  'settings.groups.appearance',
  'settings.groups.scan',
  'settings.groups.profile',
  'settings.groups.data',
  'settings.groups.diagnostics',
  'settings.groups.about',
  'settings.groups.toolsPlugins'
]

const SECTION_LABEL_KEYS = [
  'settings.sections.startup',
  'settings.sections.fileops',
  'settings.sections.exportWorkflow',
  'settings.sections.language',
  'settings.sections.themeDisplay',
  'settings.sections.scanDirectories',
  'settings.sections.scanOptions',
  'settings.sections.profileManage',
  'settings.sections.dataBackup',
  'settings.sections.cacheCleanup',
  'settings.sections.scanDiagnostic',
  'settings.sections.diagnosticsLogs',
  'settings.sections.diagnosticsCrash',
  'settings.sections.aboutOverview',
  'settings.sections.aboutLicense',
  'settings.sections.shareCode',
  'settings.sections.pluginManage'
]

const NAV_LABEL_KEYS = [...GROUP_LABEL_KEYS, ...SECTION_LABEL_KEYS]

/**
 * 合并后降级为页内块标题、但仍必须继续存在的旧键：
 * 壳组件堆叠的是原节本体，所以这些键一个都不能删（删了块标题就变原始 key）。
 */
const DEMOTED_BLOCK_TITLE_KEYS = [
  'settings.sections.theme',
  'settings.sections.display',
  'settings.sections.scanPaths',
  'settings.sections.gameRoots',
  'settings.sections.importRoots',
  'settings.sections.scanFallback',
  'settings.sections.dataCache',
  'settings.sections.dataClear',
  'settings.sections.aboutInfo',
  'settings.sections.aboutContact'
]

const assertNonEmptyString = (code: string, key: string): void => {
  const value = readPath(LOCALES[code], key)
  expect(value, `${code}.json 缺失 ${key}`).toBeDefined()
  expect(value, `${code}.json ${key} 应为字符串`).toBeTypeOf('string')
  expect((value as string).trim(), `${code}.json ${key} 不应为空串`).not.toHaveLength(0)
}

describe('设置页导航合并的语言包完整性', () => {
  it('5 个新增键在 12 个语言包都齐备且为非空字符串', () => {
    for (const code of Object.keys(LOCALES)) {
      for (const key of NEW_KEYS) assertNonEmptyString(code, key)
    }
  })

  it('8 个分组标题 + 17 个节标题在 12 个语言包全部非空（抓闸门盲区里的空串）', () => {
    for (const code of Object.keys(LOCALES)) {
      for (const key of NAV_LABEL_KEYS) assertNonEmptyString(code, key)
    }
  })

  it('被合并降级为块标题的 10 个旧键仍在导航树之外被消费，不得顺手删除', () => {
    for (const code of Object.keys(LOCALES)) {
      for (const key of DEMOTED_BLOCK_TITLE_KEYS) assertNonEmptyString(code, key)
    }
  })

  it('zh-CN 的合并后分组与节标题文案正确', () => {
    expect(readPath(LOCALES['zh-CN'], 'settings.groups.toolsPlugins')).toBe('工具与插件')
    expect(readPath(LOCALES['zh-CN'], 'settings.sections.themeDisplay')).toBe('主题与显示')
    expect(readPath(LOCALES['zh-CN'], 'settings.sections.scanDirectories')).toBe('扫描目录')
    expect(readPath(LOCALES['zh-CN'], 'settings.sections.cacheCleanup')).toBe('缓存与清理')
    expect(readPath(LOCALES['zh-CN'], 'settings.sections.aboutOverview')).toBe('应用信息与联系方式')
  })

  it('12 个语言包的 settings.groups 子树键集与 zh-CN 完全同构（防漏键漂移）', () => {
    const groups = (LOCALES['zh-CN'].settings as LocaleNode).groups
    const baseline = leafKeys(groups).sort()
    for (const [code, locale] of Object.entries(LOCALES)) {
      const node = (locale.settings as LocaleNode | undefined)?.groups
      expect(leafKeys(node).sort(), `${code}.json settings.groups 键集与 zh-CN 不一致`).toEqual(
        baseline
      )
    }
  })

  it('12 个语言包的 settings.sections 子树键集与 zh-CN 完全同构（防漏键漂移）', () => {
    const sections = (LOCALES['zh-CN'].settings as LocaleNode).sections
    const baseline = leafKeys(sections).sort()
    for (const [code, locale] of Object.entries(LOCALES)) {
      const node = (locale.settings as LocaleNode | undefined)?.sections
      expect(leafKeys(node).sort(), `${code}.json settings.sections 键集与 zh-CN 不一致`).toEqual(
        baseline
      )
    }
  })
})
