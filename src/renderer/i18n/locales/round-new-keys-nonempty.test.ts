// 本轮新增能力文案键的「值非空」守卫。
//
// `npm run i18n:check` / `npm run i18n:guard` 只比对键的存在性，从不检查值：本阶段
// 新增的键一度在 10–11 个语言包里以空串占位（靠 fallbackLng 回退 zh-CN 显示），
// 闸门一路绿灯。此守卫把本轮新增/收尾新增的键锁定为 12 语包均须真实非空译文。
// 范式与验收口径对齐同目录 settings-nav-keys.test.ts。
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

/**
 * 本轮新增能力（阶段 1–5）+ 收尾阶段新增文案键的 allowlist。
 * 追加新键时必须给出 12 语包真实译文，否则下方守卫立即转红。
 */
export const REQUIRED_NON_EMPTY_KEYS: readonly string[] = [
  'detail.multiPlayer.copyHeader',
  'main.settings.error.manifestBaseUrlInvalid',
  'main.settings.error.imageMirrorBaseUrlInvalid',
  'locationMap.title',
  'locationMap.clickToView',
  'locationMap.loading',
  'locationMap.outdatedVersion',
  'locationMap.lackData',
  'locationMap.notReady',
  'locationMap.noTiles',
  'locationMap.lackWorldMap',
  'locationMap.outsideBounds',
  'camera.nikkiPoseAction',
  'camera.playingPercent',
  'camera.momoPose',
  'camera.momoPoseTime',
  'camera.momoAdjust',
  'camera.momoRotate',
  'camera.autoGroundSnap',
  'camera.floatingEffect',
  'camera.poseWithNikki',
  // 收尾阶段新增：许可证声明 / 外部图片合规 / 自动更新开关
  'settings.about.upstreamCopyright',
  'settings.about.upstreamCopyrightNote',
  'settings.referenceData.imageSourceLabel',
  'settings.referenceData.imageSourceNotice',
  'settings.referenceData.trademarkNotice',
  'settings.referenceData.usageNotice',
  'settings.referenceData.remoteImagesEnabledLabel',
  'settings.referenceData.remoteImagesEnabledHint',
  'settings.referenceData.autoUpdateLabel',
  'settings.referenceData.autoUpdateHint',
  // 审查修复（2026-11-11）：autoUpdate 开关与手动刷新入口补齐 UI 时新增
  'settings.referenceData.refreshLabel',
  'settings.referenceData.refreshSuccess',
  'settings.referenceData.refreshFailed',
  // 审查修复（2026-11-11）：新增运行时依赖 Leaflet / protobufjs 入致谢表
  'settings.about.depDesc.leaflet',
  'settings.about.depDesc.protobufjs',
  'main.settings.error.referenceDataSwitchNotBoolean',
  // 共鸣录身份门（2026-11-23）：板块暂停更新拦截弹窗
  'resonance.gate.title',
  'resonance.gate.notice',
  'resonance.gate.continue',
  'resonance.gate.visit'
]

/** 纯函数：空串 / 缺失 / 非字符串一律抛明确断言错误，不静默通过。 */
export function assertNonEmptyString(
  code: string,
  key: string,
  node: LocaleNode | undefined
): void {
  const value = readPath(node, key)
  expect(value, `${code}.json 缺失 ${key}`).toBeDefined()
  expect(value, `${code}.json ${key} 应为字符串`).toBeTypeOf('string')
  expect((value as string).trim(), `${code}.json ${key} 不应为空串`).not.toHaveLength(0)
}

describe('本轮新增能力文案键的 12 语包值守卫', () => {
  it('allowlist 内每个键在 12 个语言包都齐备且为非空字符串', () => {
    for (const [code, locale] of Object.entries(LOCALES)) {
      for (const key of REQUIRED_NON_EMPTY_KEYS) assertNonEmptyString(code, key, locale)
    }
  })

  it('存量空串键不受守卫影响（守卫只覆盖 allowlist，不改动既有占位惯例）', () => {
    expect(readPath(LOCALES['en'], 'appShell.categoriesSummary')).toBe('')
  })

  it('注入空串占位时 assertNonEmptyString 抛明确错误', () => {
    expect(() => assertNonEmptyString('fake', 'a.b', { a: { b: '' } })).toThrow()
  })

  it('缺失键时 assertNonEmptyString 抛明确错误', () => {
    expect(() => assertNonEmptyString('fake', 'a.b', { a: {} })).toThrow()
  })

  it('allowlist 无重复，且至少覆盖本轮 21 个键（后续新键可追加）', () => {
    expect(new Set(REQUIRED_NON_EMPTY_KEYS).size).toBe(REQUIRED_NON_EMPTY_KEYS.length)
    expect(REQUIRED_NON_EMPTY_KEYS.length).toBeGreaterThanOrEqual(21)
  })
})
