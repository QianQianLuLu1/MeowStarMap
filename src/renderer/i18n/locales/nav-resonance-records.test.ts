// 侧边栏第 4 项 nav.resonanceRecords 语言包完整性回归测试
// 背景：该 key 曾在 12 个语言包全部缺失，导致侧边栏直接渲染原始 key 文本
// 'nav.resonanceRecords'（见 docs/nav-resonance-records-rename-plan.md）。
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

describe('nav.resonanceRecords 语言包完整性', () => {
  it('全部 12 个语言包均定义非空 nav.resonanceRecords（缺失会渲染原始 key）', () => {
    for (const [code, locale] of Object.entries(LOCALES)) {
      const value = readPath(locale, 'nav.resonanceRecords')
      expect(value, `${code}.json 缺失 nav.resonanceRecords`).toBeDefined()
      expect(value, `${code}.json nav.resonanceRecords 应为字符串`).toBeTypeOf('string')
      expect(value as string, `${code}.json nav.resonanceRecords 不应为空`).not.toHaveLength(0)
    }
  })

  it('zh-CN（基准语言）侧边栏文案为「共鸣录」', () => {
    expect(readPath(LOCALES['zh-CN'], 'nav.resonanceRecords')).toBe('共鸣录')
  })

  it('各语言 nav.resonanceRecords 与同文件 appShell.viewStatus.resonanceRecords 一致（复用不变式）', () => {
    for (const [code, locale] of Object.entries(LOCALES)) {
      const navValue = readPath(locale, 'nav.resonanceRecords')
      const statusValue = readPath(locale, 'appShell.viewStatus.resonanceRecords')
      expect(statusValue, `${code}.json 缺失 appShell.viewStatus.resonanceRecords`).toBeDefined()
      expect(navValue, `${code}.json 两处文案不一致`).toBe(statusValue)
    }
  })
})
