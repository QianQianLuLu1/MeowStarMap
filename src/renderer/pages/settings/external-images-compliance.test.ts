// @core-change: 新增参考图片总开关，关闭时 refdata:resolve-image 零网络短路
/**
 * T4 失败先行回归：外部图片总开关 / 来源标注 / 权利声明 / 用途声明。
 *
 * 授权条件（gongeo #218、nikki_albums #20）要求「保持可回滚」「应用内明确标注
 * 来源并附回链」「保留 Infold 等权利方声明」「不用于 AI 训练或商业用途」。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (rel: string): string | null => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

describe('外部图片合规文案与总开关接线（源码级）', () => {
  it('设置页「外部参考数据」渲染 gongeo.us 来源标注与回链', () => {
    const src = read('src/renderer/pages/settings/reference-data-sections.tsx') ?? ''
    expect(src).toContain('settings.referenceData.imageSourceLabel')
    expect(src).toContain('settings.referenceData.imageSourceNotice')
    expect(src).toContain('https://gongeo.us')
  })

  it('设置页渲染 Infold 商标声明与限定第三方资产的用途声明', () => {
    const src = read('src/renderer/pages/settings/reference-data-sections.tsx') ?? ''
    expect(src).toContain('settings.referenceData.trademarkNotice')
    expect(src).toContain('settings.referenceData.usageNotice')
  })

  it('设置页提供 remoteImagesEnabled 开关并同步渲染层 flag', () => {
    const src = read('src/renderer/pages/settings/reference-data-sections.tsx') ?? ''
    expect(src).toContain('referenceData.remoteImagesEnabled')
    expect(src).toContain('setRemoteImagesEnabled')
  })

  it('既有 gongeo 热链与新增取图链路均受 flag 控制', () => {
    const cdn = read('src/renderer/utils/resonance/cdnImageUrl.ts') ?? ''
    const hook = read('src/renderer/hooks/useReferenceImage.ts') ?? ''
    expect(cdn).toContain('isRemoteImagesEnabled')
    expect(hook).toContain('isRemoteImagesEnabled')
  })

  it('RENDERER_PREF_KEYS 含新开关键，settings-handler 有 boolean 校验', () => {
    const keys = read('src/shared/settings-keys.ts') ?? ''
    const handler = read('src/main/ipc/handlers/settings-handler.ts') ?? ''
    expect(keys).toContain('referenceData.remoteImagesEnabled')
    expect(handler).toContain('referenceData.remoteImagesEnabled')
    expect(handler).toMatch(/typeof value !== 'boolean'/)
  })

  it('12 语包新增合规键均真实非空', () => {
    const codes = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'th', 'vi']
    const required = [
      'imageSourceLabel',
      'imageSourceNotice',
      'trademarkNotice',
      'usageNotice',
      'remoteImagesEnabledLabel',
      'remoteImagesEnabledHint'
    ]
    for (const code of codes) {
      const locale = JSON.parse(read(`src/renderer/i18n/locales/${code}.json`) ?? '{}') as {
        settings?: { referenceData?: Record<string, unknown> }
      }
      for (const key of required) {
        const value = locale.settings?.referenceData?.[key]
        expect(typeof value, `${code}.json ${key} 缺失`).toBe('string')
        expect((value as string).trim(), `${code}.json ${key} 不应为空串`).not.toHaveLength(0)
      }
    }
  })

  it('Infold 商标声明在 12 语包均点名 Infold', () => {
    const codes = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'th', 'vi']
    for (const code of codes) {
      const locale = JSON.parse(read(`src/renderer/i18n/locales/${code}.json`) ?? '{}') as {
        settings?: { referenceData?: { trademarkNotice?: string } }
      }
      expect(
        locale.settings?.referenceData?.trademarkNotice,
        `${code}.json 商标声明未点名 Infold`
      ).toContain('Infold')
    }
  })

  it('用途声明在 12 语包均明确「不适用于本项目 MIT 源代码」的边界语义', () => {
    const codes = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'th', 'vi']
    for (const code of codes) {
      const locale = JSON.parse(read(`src/renderer/i18n/locales/${code}.json`) ?? '{}') as {
        settings?: { referenceData?: { usageNotice?: string } }
      }
      const text = locale.settings?.referenceData?.usageNotice ?? ''
      // 各语言均须含 MIT 字样，避免「整个项目不可商用」的误导
      expect(text, `${code}.json 用途声明缺少 MIT 边界`).toContain('MIT')
    }
  })
})
