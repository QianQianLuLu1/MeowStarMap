// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('renderer i18n language fallback', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    document.documentElement.lang = 'zh-CN'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.doMock('./locales/en.json', () =>
      Promise.reject(new Error('lazy language chunk unavailable'))
    )
  })

  afterEach(() => {
    vi.doUnmock('./locales/en.json')
    vi.restoreAllMocks()
  })

  it('懒加载失败时返回中文兜底，并同步 i18next 与 html lang 元数据', async () => {
    const { changeLanguage, getCurrentLanguage, default: i18n } = await import('./index')

    const effective = await changeLanguage('en')

    expect(effective).toBe('zh-CN')
    expect(getCurrentLanguage()).toBe('zh-CN')
    expect(i18n.language).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
  })
})
