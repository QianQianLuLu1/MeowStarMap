// 图片水印失败可见化（2026-10-17）的语言包完整性回归。结构对齐同目录
// settings-nav-keys.test.ts / sync-gallery-keys.test.ts 的既有范式。
//
// 为什么要单独钉这一份：`npm run i18n:guard` 与 scripts/check-i18n-keys.ts 只比对
// **键的存在性**，从不检查值。`toast.imageProcessorLoadFailed` 在 12 个包里键都齐，
// 但除 zh-CN 外 11 个包的值是空串，而 i18next 默认把空串当**有效译文**返回
// （`returnEmptyString` 默认 true，`fallbackLng` 因此不会触发）——于是新加的
// 「logo 读不到」提示（EditorPage 的 toast、WatermarkPanel 的内联 role="alert"）
// 在非中文界面渲染成空白，失败可见化等于没做，且两条闸门一路绿灯。
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

/** 图片水印加载失败文案：渲染层 loadImage 的 reject message 与面板内联提示共用同一条 */
const LOGO_FAILED_KEY = 'toast.imageProcessorLoadFailed'

describe('图片水印失败提示的语言包完整性', () => {
  it('I1: 12 个语言包的 logo 加载失败文案均为非空字符串（闸门只看键，空串会渲染成空白提示）', () => {
    for (const code of Object.keys(LOCALES)) {
      const value = readPath(LOCALES[code], LOGO_FAILED_KEY)
      expect(value, `${code}.json 缺失 ${LOGO_FAILED_KEY}`).toBeDefined()
      expect(value, `${code}.json ${LOGO_FAILED_KEY} 应为字符串`).toBeTypeOf('string')
      expect(
        (value as string).trim(),
        `${code}.json ${LOGO_FAILED_KEY} 不应为空串`
      ).not.toHaveLength(0)
    }
  })

  it('I2: 12 个语言包都保留 {{src}} 插值占位（丢了就是把占位符当字面量吞掉）', () => {
    for (const code of Object.keys(LOCALES)) {
      const value = readPath(LOCALES[code], LOGO_FAILED_KEY)
      expect(String(value), `${code}.json ${LOGO_FAILED_KEY} 应保留 {{src}}`).toContain('{{src}}')
    }
  })

  it('I3: zh-CN 基准串未漂移（preview.html 内嵌同一串，npm run preview:check 依赖它）', () => {
    expect(readPath(LOCALES['zh-CN'], LOGO_FAILED_KEY)).toBe('加载图片失败: {{src}}')
  })
})
