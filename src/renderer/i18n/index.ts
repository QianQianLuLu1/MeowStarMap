// P2-01 + P3 优化：i18n 初始化配置（按需加载版）
// 设计要点：
// 1. 中文（zh-CN）为基准语言，静态加载，翻译最完整
// 2. 其他 11 种语言改为动态 import()，由 Vite 拆分为独立 chunk
//    仅在用户切换语言或启动时持久化语言非 zh-CN 时才加载，减小 renderer 主 bundle 体积
// 3. 语言选择持久化到 localStorage，启动时读取并预加载
// 4. 'auto' 表示跟随系统语言（基于 navigator.language 匹配）
// 5. 对外 API 完全保持兼容：SUPPORTED_LANGUAGES / changeLanguage / getCurrentLanguage / detectSystemLanguage

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './locales/zh-CN.json'
import { setAppErrorTranslator } from '../../shared/errors/app-error'
import { setImageProcessorTranslator } from '../utils/imageProcessor'

// P2-01：支持的语言列表（顺序影响设置页下拉展示顺序）
// label 为语言自称名（endonym，国际惯例不随界面语言翻译）；本常量在 i18n 实例 init 前求值，
// 无法调用 t()，故按数据值豁免中文检测。
export const SUPPORTED_LANGUAGES = [
  // eslint-disable-next-line no-restricted-syntax -- 模块级常量早于 i18n init 求值；设置页另由 settings.language.auto 展示"跟随系统"
  { code: 'auto', label: '跟随系统', englishName: 'Auto' },
  // eslint-disable-next-line no-restricted-syntax -- 语言 endonym（自称名），按惯例不翻译
  { code: 'zh-CN', label: '简体中文', englishName: 'Simplified Chinese' },
  // eslint-disable-next-line no-restricted-syntax -- 语言 endonym（自称名），按惯例不翻译
  { code: 'zh-TW', label: '繁體中文', englishName: 'Traditional Chinese' },
  { code: 'en', label: 'English', englishName: 'English' },
  // eslint-disable-next-line no-restricted-syntax -- 语言 endonym（自称名），按惯例不翻译
  { code: 'ja', label: '日本語', englishName: 'Japanese' },
  { code: 'ko', label: '한국어', englishName: 'Korean' },
  { code: 'fr', label: 'Français', englishName: 'French' },
  { code: 'de', label: 'Deutsch', englishName: 'German' },
  { code: 'es', label: 'Español', englishName: 'Spanish' },
  { code: 'pt', label: 'Português', englishName: 'Portuguese' },
  { code: 'ru', label: 'Русский', englishName: 'Russian' },
  { code: 'th', label: 'ไทย', englishName: 'Thai' },
  { code: 'vi', label: 'Tiếng Việt', englishName: 'Vietnamese' }
] as const

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code']

// P3：非 zh-CN 语言的动态加载器（Vite 会将每个 import() 拆分为独立 chunk）
// locale JSON 为嵌套结构（titleBar/common/... 不是扁平 key-value），用 unknown 兜底
const LAZY_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  'zh-TW': () => import('./locales/zh-TW.json'),
  en: () => import('./locales/en.json'),
  ja: () => import('./locales/ja.json'),
  ko: () => import('./locales/ko.json'),
  fr: () => import('./locales/fr.json'),
  de: () => import('./locales/de.json'),
  es: () => import('./locales/es.json'),
  pt: () => import('./locales/pt.json'),
  ru: () => import('./locales/ru.json'),
  th: () => import('./locales/th.json'),
  vi: () => import('./locales/vi.json')
}

// P3：已加载语言集合，避免重复加载
const loadedLanguages = new Set<string>(['zh-CN'])

// P3：动态加载语言包；已加载则直接返回 true，加载失败返回 false
export async function loadLanguage(lng: string): Promise<boolean> {
  if (loadedLanguages.has(lng)) return true
  const loader = LAZY_LOADERS[lng]
  if (!loader) return false
  try {
    const mod = await loader()
    // addResourceBundle 的第 4 个参数 true 表示 deep merge，第 5 个 true 表示覆盖
    i18n.addResourceBundle(lng, 'translation', mod.default, true, true)
    loadedLanguages.add(lng)
    return true
  } catch (err) {
    console.error(`[i18n] Failed to load language: ${lng}`, err)
    return false
  }
}

// P2-01：根据浏览器 navigator.language 推断系统语言
// 返回 null 表示无法匹配到支持的语言（调用方回退到 zh-CN）
export function detectSystemLanguage(): string | null {
  // 非浏览器环境（如 node 测试）无 navigator，回退到 null 由调用方兜底
  const nav = typeof navigator === 'undefined' ? '' : (navigator.language?.toLowerCase() ?? '')
  if (nav.startsWith('zh')) {
    // zh-TW / zh-HK / zh-Mo 视为繁体，其余视为简体
    return nav.includes('tw') || nav.includes('hk') || nav.includes('mo') ? 'zh-TW' : 'zh-CN'
  }
  if (nav.startsWith('en')) return 'en'
  if (nav.startsWith('ja')) return 'ja'
  if (nav.startsWith('ko')) return 'ko'
  if (nav.startsWith('fr')) return 'fr'
  if (nav.startsWith('de')) return 'de'
  if (nav.startsWith('es')) return 'es'
  if (nav.startsWith('pt')) return 'pt'
  if (nav.startsWith('ru')) return 'ru'
  if (nav.startsWith('th')) return 'th'
  if (nav.startsWith('vi')) return 'vi'
  return null
}

// P2-01：从 localStorage 读取已持久化的语言选择
// 'auto' 或具体语言代码；未配置时默认 'auto'
function loadStoredLanguage(): string {
  try {
    const stored = localStorage.getItem('app-language')
    if (stored && SUPPORTED_LANGUAGES.some((l) => l.code === stored)) return stored
  } catch {
    // localStorage 不可用时静默回退
  }
  return 'auto'
}

// P2-01：解析最终生效的语言代码
// 'auto' → 推断系统语言（推断失败回退 zh-CN）
// 其他 → 直接使用
function resolveLanguage(code: string): string {
  if (code === 'auto') {
    return detectSystemLanguage() ?? 'zh-CN'
  }
  return code
}

// P3：i18n 同步初始化，仅加载 zh-CN（基准语言）
// 其他语言由 initializeI18n() 在 React 渲染前异步预加载
i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN }
  },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: {
    // React 已默认转义，避免重复转义影响显示
    escapeValue: false
  },
  returnNull: false,
  // 空串视为未译、回退 fallbackLng（zh-CN）。i18next 默认 returnEmptyString: true，
  // 会把语言包里的空串当有效译文——本仓 11 个非基准包各有约 2.4k 条空串，于是按钮
  // 文字与提示全部渲染成空白，用户看着就是"点了没反应"（导出修复的 R5 即此因）。
  returnEmptyString: false
})

// AppError 默认 userMessage 的翻译接线（shared 层不能反向依赖本模块）
setAppErrorTranslator((key, options) => i18n.t(key, options as never) as unknown as string)

// 图像管线的错误文案同样靠注入获得：imageProcessor 要被预览 worker 直接 import，
// 不能自己 import 本模块（那会把 react-i18next 与语言包拖进 worker chunk）。
setImageProcessorTranslator((key, options) => i18n.t(key, options as never) as unknown as string)

// P3：启动时预加载持久化语言（若非 zh-CN）
// 应在 React 渲染前 await 调用，避免非中文用户首次看到中文闪烁
const storedLang = loadStoredLanguage()
const initialLang = resolveLanguage(storedLang)

export async function initializeI18n(): Promise<void> {
  if (initialLang === 'zh-CN') return
  const ok = await loadLanguage(initialLang)
  if (ok) {
    await i18n.changeLanguage(initialLang)
  }
}

// P2-01：暴露切换语言的工具函数
// P3：切换前确保目标语言已加载（懒加载）
export async function changeLanguage(code: string): Promise<string> {
  const resolved = resolveLanguage(code)
  if (resolved !== 'zh-CN' && !loadedLanguages.has(resolved)) {
    await loadLanguage(resolved)
  }
  await i18n.changeLanguage(resolved)
  try {
    localStorage.setItem('app-language', code)
  } catch {
    // localStorage 不可用时静默忽略
  }
  return resolved
}

// P2-01：获取当前生效的语言代码（已解析，不会返回 'auto'）
export function getCurrentLanguage(): string {
  return i18n.language || 'zh-CN'
}

export default i18n
