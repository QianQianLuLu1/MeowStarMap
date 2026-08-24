// Storybook i18n 装饰器
//
// 语义对齐 src/renderer/i18n/index.ts：
// - zh-CN 为基准/回退语言（fallbackLng: 'zh-CN'）
// - interpolation.escapeValue = false（React 已转义）
// - returnNull: false
//
// 区别：应用入口对非中文语言包采用动态 import 拆分 chunk，
// Storybook 为工具链环境不追求 bundle 体积，故静态 import 全部 12 个语言包，
// 保证工具栏切换任意语言即时生效。

import { useEffect } from 'react'
import type { Decorator } from '@storybook/react-vite'
import i18n from 'i18next'
import { initReactI18next, I18nextProvider } from 'react-i18next'
import zhCN from '../../src/renderer/i18n/locales/zh-CN.json'
import zhTW from '../../src/renderer/i18n/locales/zh-TW.json'
import en from '../../src/renderer/i18n/locales/en.json'
import ja from '../../src/renderer/i18n/locales/ja.json'
import ko from '../../src/renderer/i18n/locales/ko.json'
import fr from '../../src/renderer/i18n/locales/fr.json'
import de from '../../src/renderer/i18n/locales/de.json'
import es from '../../src/renderer/i18n/locales/es.json'
import pt from '../../src/renderer/i18n/locales/pt.json'
import ru from '../../src/renderer/i18n/locales/ru.json'
import th from '../../src/renderer/i18n/locales/th.json'
import vi from '../../src/renderer/i18n/locales/vi.json'

// 独立 i18next 实例：避免与应用入口（src/renderer/i18n）的单例初始化逻辑耦合。
// 导出实例供 stories 的 play 函数按当前语言解析可见文案（语义化定位按钮）。
export const storybookI18n = i18n.createInstance()

void storybookI18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'zh-TW': { translation: zhTW },
    en: { translation: en },
    ja: { translation: ja },
    ko: { translation: ko },
    fr: { translation: fr },
    de: { translation: de },
    es: { translation: es },
    pt: { translation: pt },
    ru: { translation: ru },
    th: { translation: th },
    vi: { translation: vi }
  },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: {
    escapeValue: false
  },
  returnNull: false
})

export const withI18n: Decorator = (Story, context) => {
  const locale = (context.globals.locale as string) || 'zh-CN'
  useEffect(() => {
    void storybookI18n.changeLanguage(locale)
  }, [locale])
  return (
    <I18nextProvider i18n={storybookI18n}>
      <Story />
    </I18nextProvider>
  )
}
