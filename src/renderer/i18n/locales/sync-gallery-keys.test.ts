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

/**
 * 阶段 6：元数据解析开关的披露文案完整性。
 *
 * 这个开关一旦打开就向第三方端点发出站请求（携带 UID 与照片内嵌参数信封），
 * 因此「每个语言包都必须把这件事说清楚」是验收项，不是可选项——
 * 漏一个语言包就等于对那一半用户在未经充分披露的情况下开启了外网请求。
 */
const METADATA_KEYS = [
  'settings.sync.metadata.enable',
  'settings.sync.metadata.enableDesc',
  'settings.sync.metadata.disclosure'
]

describe('阶段 6：元数据解析开关语言包完整性', () => {
  it('12 个语言包都定义了三个必需键且为非空字符串', () => {
    for (const [code, locale] of Object.entries(LOCALES)) {
      for (const key of METADATA_KEYS) {
        const value = readPath(locale, key)
        expect(value, `${code}.json 缺失 ${key}`).toBeDefined()
        expect(value, `${code}.json ${key} 应为字符串`).toBeTypeOf('string')
        expect((value as string).trim(), `${code}.json ${key} 不应为空`).not.toHaveLength(0)
      }
    }
  })

  it('披露文案必须点名实际端点主机（与 metadata-resolver-driver 的常量同主机）', () => {
    // 这里刻意写主机字面量而不是 import 主进程常量：渲染层不得依赖 `src/main/**`，
    // 跨边界的共享位是 `src/shared/**`。同一主机由两侧各一条断言钉住：
    // `metadata-resolver-driver.test.ts` 断言 NUAN5_METADATA_ENDPOINT 以 https://nuan5.pro 开头，
    // 任一侧改动即有一处先红。
    for (const [code, locale] of Object.entries(LOCALES)) {
      expect(
        readPath(locale, 'settings.sync.metadata.disclosure'),
        `${code}.json disclosure 未点名出站端点主机`
      ).toContain('nuan5.pro')
    }
  })

  it('披露文案必须交代「随局域网同步下发给已配对设备」这一后果', () => {
    // 上游 publicMetadata() 只剥两把原始信封字段，第三方解码结果原样进局域网响应体；
    // 不说清这一条的披露是不完整的
    const zh = String(readPath(LOCALES['zh-CN'], 'settings.sync.metadata.disclosure'))
    expect(zh).toMatch(/配对|已配对/)
    expect(zh).toMatch(/局域网|本地网络/)
  })
})
