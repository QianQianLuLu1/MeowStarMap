// 阶段 5 · A4：同步图库语言包完整性回归。
// 背景教训见同目录 nav-resonance-records.test.ts：key 曾在 12 个语言包整体缺失，
// 侧边栏直接渲染原始 key 文本。本文件把同类回归前移成守卫，覆盖导航项、状态栏与整块文案。
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

/** 递归收集叶子键路径，用于比对 12 包的 `syncGallery` 子树是否同构。 */
function leafKeys(node: unknown, prefix = ''): string[] {
  if (!node || typeof node !== 'object') return [prefix]
  return Object.entries(node as LocaleNode).flatMap(([key, value]) =>
    leafKeys(value, prefix ? `${prefix}.${key}` : key)
  )
}

/** 页面与 store 实际消费的全部键（漏加即此测试红，避免运行期渲染原始 key）。 */
const REQUIRED_KEYS = [
  'nav.syncGallery',
  'appShell.viewStatus.syncGallery',
  'syncGallery.title',
  'syncGallery.subtitle',
  'syncGallery.loading',
  'syncGallery.toolbar.statusTip',
  'syncGallery.toolbar.refresh',
  'syncGallery.toolbar.scan',
  'syncGallery.toolbar.status.ready',
  'syncGallery.toolbar.status.degraded',
  'syncGallery.toolbar.status.off',
  'syncGallery.empty.title',
  'syncGallery.empty.linkHint',
  'syncGallery.empty.runtimeOff',
  'syncGallery.empty.gameRootMissing',
  'syncGallery.empty.noAssets',
  'syncGallery.empty.retry',
  'syncGallery.toolbar.detail',
  'syncGallery.drawer.title',
  'syncGallery.drawer.basic',
  'syncGallery.drawer.fields.assetId',
  'syncGallery.drawer.fields.type',
  'syncGallery.drawer.fields.state',
  'syncGallery.drawer.fields.motion',
  'syncGallery.drawer.fields.revision',
  'syncGallery.drawer.fields.gameVersion',
  'syncGallery.drawer.fields.resolution',
  'syncGallery.drawer.fields.size',
  'syncGallery.drawer.fields.hash',
  'syncGallery.drawer.fields.metadata',
  // store 的 error 存的就是这两个键，页面直接 t(error)
  'syncGallery.error.bridgeMissing',
  'syncGallery.error.loadFailed'
]

describe('同步图库语言包完整性', () => {
  it('12 个语言包都定义了全部必需键且为非空字符串', () => {
    for (const [code, locale] of Object.entries(LOCALES)) {
      for (const key of REQUIRED_KEYS) {
        const value = readPath(locale, key)
        expect(value, `${code}.json 缺失 ${key}`).toBeDefined()
        expect(value, `${code}.json ${key} 应为字符串`).toBeTypeOf('string')
        expect((value as string).trim(), `${code}.json ${key} 不应为空`).not.toHaveLength(0)
      }
    }
  })

  it('zh-CN 导航项文案为「同步图库」', () => {
    expect(readPath(LOCALES['zh-CN'], 'nav.syncGallery')).toBe('同步图库')
  })

  it('各语言 nav.syncGallery 与 appShell.viewStatus.syncGallery 一致（复用共鸣录的不变式）', () => {
    for (const [code, locale] of Object.entries(LOCALES)) {
      const navValue = readPath(locale, 'nav.syncGallery')
      expect(
        readPath(locale, 'appShell.viewStatus.syncGallery'),
        `${code}.json 两处文案不一致`
      ).toBe(navValue)
    }
  })

  it('12 个语言包的 syncGallery 子树键集与 zh-CN 完全同构（防漏键漂移）', () => {
    const baseline = leafKeys(LOCALES['zh-CN'].syncGallery).sort()
    for (const [code, locale] of Object.entries(LOCALES)) {
      expect(
        leafKeys(locale.syncGallery).sort(),
        `${code}.json syncGallery 键集与 zh-CN 不一致`
      ).toEqual(baseline)
    }
  })

  it('linkHint 一定带上可执行命令 npm run link:nikkisync（空态的价值就在这条指令）', () => {
    for (const [code, locale] of Object.entries(LOCALES)) {
      expect(
        readPath(locale, 'syncGallery.empty.linkHint'),
        `${code}.json empty.linkHint 未给出可执行命令`
      ).toContain('npm run link:nikkisync')
      expect(
        readPath(locale, 'syncGallery.error.bridgeMissing'),
        `${code}.json error.bridgeMissing 未给出可执行命令`
      ).toContain('npm run link:nikkisync')
    }
  })
})
