// 导出功能可见性（2026-10-26 导出修复）的语言包完整性回归。结构对齐同目录
// image-watermark-toast-keys.test.ts / settings-nav-keys.test.ts 的既有范式。
//
// 为什么要单独钉这一份：`npm run i18n:guard` 与 scripts/check-i18n-keys.ts 只比对
// **键的存在性**，从不检查值。导出相关的键在 12 个包里全都齐，但除 zh-CN 外 11 个包
// 的值是空串，而 i18next 默认把空串当**有效译文**返回（`returnEmptyString` 默认 true，
// `fallbackLng` 因此不会触发）——于是非中文界面里：
// - `batch.actions.export` / `gallery.contextMenu.export` 渲染成空白，用户找不到导出入口；
// - `toast.noDefaultExportDir` / `main.validator.pathArrayRequired` 等前置拦截与失败提示
//   弹成**空 toast**，点了导出看着就像"没反应"；
// - 连成功提示 `main.file.message.exported` 也是空串，导出成功同样无声。
// 两条闸门一路绿灯，所以必须在此钉死。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

/**
 * 导出链路上会进入用户视野的全部键：
 * 批量工具栏按钮 + 右键菜单项 + 渲染层提示 + 主进程侧（主进程复用同一份 locale，
 * 见 src/main/i18n/index.ts）组装导出结果与校验失败时用到的文案。
 */
const EXPORT_KEYS = [
  // 批量操作栏（BatchActions.tsx）
  'batch.actions.export',
  'batch.actions.exportSelectDir',
  'batch.actions.exportToDefault',
  'batch.actions.exportToDefaultHint',
  // 图库右键菜单项（GalleryPage.tsx 单图导出入口，空串=入口不可见）
  'gallery.contextMenu.export',
  // 渲染层 toast（useBatchOperations.ts 的前置拦截与异常兜底）
  'toast.exportUnsupported',
  'toast.noDefaultExportDir',
  'toast.batchExportFailed',
  'toast.exportFailed',
  // 主进程：导出动作名、结果文案、前置条件与参数校验文案
  'main.file.action.export',
  'main.file.message.exported',
  'main.file.error.noDefaultExportDir',
  'main.validator.pathArrayRequired'
] as const

describe('导出相关文案的语言包完整性', () => {
  it('X1: 12 个语言包的导出相关键全部为非空字符串（闸门只看键，空串会渲染成空白按钮/空 toast）', () => {
    for (const code of Object.keys(LOCALES)) {
      for (const key of EXPORT_KEYS) {
        const value = readPath(LOCALES[code], key)
        expect(value, `${code}.json 缺失 ${key}`).toBeDefined()
        expect(value, `${code}.json ${key} 应为字符串`).toBeTypeOf('string')
        expect((value as string).trim(), `${code}.json ${key} 不应为空串`).not.toHaveLength(0)
      }
    }
  })

  it('X2: 12 个语言包的 main.file.message.exported 都保留 {{count}} 插值（丢了就是把计数吞成字面量）', () => {
    for (const code of Object.keys(LOCALES)) {
      const value = readPath(LOCALES[code], 'main.file.message.exported')
      expect(String(value), `${code}.json exported 应保留 {{count}}`).toContain('{{count}}')
    }
  })

  it('X3: zh-CN 基准串未漂移（导出成功提示与默认目录提示被 e2e/文档按字面引用）', () => {
    expect(readPath(LOCALES['zh-CN'], 'batch.actions.export')).toBe('导出')
    expect(readPath(LOCALES['zh-CN'], 'main.file.message.exported')).toBe('已导出 {{count}} 个文件')
    expect(readPath(LOCALES['zh-CN'], 'toast.noDefaultExportDir')).toBe(
      '未配置默认导出路径，请先在设置中配置'
    )
  })

  /**
   * 空串盲区的全局兜底：i18next 默认 returnEmptyString: true，把语言包里的空串当有效译文，
   * 于是 fallbackLng 永不触发——未译键在非中文界面一律渲染成空白。两侧实例都必须显式关掉，
   * 否则任何新加而漏译的键都会重演同一个"点了没反应"。
   */
  it('X4: 渲染层与主进程的 i18n 实例都关闭 returnEmptyString（空串回退 zh-CN 而非渲染成空白）', () => {
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
    for (const [label, src] of [
      ['src/renderer/i18n/index.ts', read('../index.ts')],
      ['src/main/i18n/index.ts', read('../../../main/i18n/index.ts')]
    ] as const) {
      expect(src, `${label} 必须设置 returnEmptyString: false`).toMatch(
        /returnEmptyString:\s*false/
      )
    }
  })
})
