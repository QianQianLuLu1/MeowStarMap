/**
 * 主进程 i18n 实例
 *
 * 设计要点：
 * 1. 与渲染进程独立实例（非 react-i18next），同步初始化，主进程各模块直接调用 t()
 * 2. 复用 src/renderer/i18n/locales/ 下的 12 份 JSON，避免拆分主进程专用 locale
 * 3. zh-CN 为基准语言，静态 require 加载，启动时即可同步使用
 * 4. 其他语言在切换时通过 loadMainProcessLanguage 异步加载
 * 5. 初始化时机：app.whenReady() 之后（lifecycle.ts 阶段 3 initLogger 同期调用 initMainI18n）
 *
 * 使用方式：
 *   import { t } from '@main/i18n'
 *   dialog.showMessageBox({ title: t('main.dialog.title') })
 */
import i18n from 'i18next'
import { app } from 'electron'
import zhCN from '../../renderer/i18n/locales/zh-CN.json'
import { logger } from '../utils/logger'

// 已加载语言集合，避免重复加载
const loadedLanguages = new Set<string>(['zh-CN'])

// 非 zh-CN 语言的动态加载器
// 主进程 require 路径相对 src/main/i18n/index.ts，需向上两层到 renderer
const LAZY_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  'zh-TW': () => import('../../renderer/i18n/locales/zh-TW.json'),
  en: () => import('../../renderer/i18n/locales/en.json'),
  ja: () => import('../../renderer/i18n/locales/ja.json'),
  ko: () => import('../../renderer/i18n/locales/ko.json'),
  fr: () => import('../../renderer/i18n/locales/fr.json'),
  de: () => import('../../renderer/i18n/locales/de.json'),
  es: () => import('../../renderer/i18n/locales/es.json'),
  pt: () => import('../../renderer/i18n/locales/pt.json'),
  ru: () => import('../../renderer/i18n/locales/ru.json'),
  th: () => import('../../renderer/i18n/locales/th.json'),
  vi: () => import('../../renderer/i18n/locales/vi.json')
}

// 同步初始化：仅加载 zh-CN 基准语言
// fallbackLng=zh-CN 保证缺失 key 时回退到中文，避免主进程崩溃
i18n.init({
  resources: {
    'zh-CN': { translation: zhCN }
  },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: {
    escapeValue: false
  },
  returnNull: false
})

/**
 * 初始化主进程 i18n
 * 必须在 app.whenReady() 之后调用，用于读取持久化的语言设置并预加载
 * 与 lifecycle.ts 阶段 3 initLogger 同期调用
 */
export async function initMainI18n(): Promise<void> {
  try {
    const stored = readStoredLanguage()
    if (stored && stored !== 'zh-CN' && stored !== 'auto') {
      const ok = await loadMainProcessLanguage(stored)
      if (ok) {
        await i18n.changeLanguage(stored)
      }
    }
  } catch (err) {
    // 主进程 i18n 初始化失败不应阻塞应用启动，回退到 zh-CN
    logger.warn('[MainI18n] init failed, fallback to zh-CN:', err)
  }
}

/**
 * 切换主进程语言
 * 由渲染进程通过 IPC 触发（settings 切换语言时同步主进程）
 */
export async function changeMainProcessLanguage(lng: string): Promise<void> {
  if (lng === 'auto') {
    const detected = detectSystemLanguage()
    if (detected && detected !== 'zh-CN') {
      await changeMainProcessLanguage(detected)
    } else {
      await i18n.changeLanguage('zh-CN')
    }
    return
  }
  if (lng !== 'zh-CN' && !loadedLanguages.has(lng)) {
    await loadMainProcessLanguage(lng)
  }
  await i18n.changeLanguage(lng)
}

/**
 * 异步加载主进程语言包
 */
async function loadMainProcessLanguage(lng: string): Promise<boolean> {
  if (loadedLanguages.has(lng)) return true
  const loader = LAZY_LOADERS[lng]
  if (!loader) return false
  try {
    const mod = await loader()
    i18n.addResourceBundle(lng, 'translation', mod.default, true, true)
    loadedLanguages.add(lng)
    return true
  } catch (err) {
    logger.warn(`[MainI18n] Failed to load language: ${lng}`, err)
    return false
  }
}

/**
 * 读取持久化的语言设置
 * 主进程通过 electron-store 或 app.getPath('userData') 下的配置文件读取
 * 当前实现：从 app_settings 表由调用方传入，主进程 i18n 仅读取环境变量兜底
 */
function readStoredLanguage(): string | null {
  // 主进程不直接读 localStorage（渲染进程才用）
  // 语言设置由 Application 在启动时通过 changeMainProcessLanguage 注入
  // 此处仅作占位返回 null，实际语言切换由 settings-handler 调用 changeMainProcessLanguage
  return null
}

/**
 * 推断系统语言（主进程版本，使用 app.getLocale()）
 */
function detectSystemLanguage(): string | null {
  try {
    const locale = app.getLocale().toLowerCase()
    if (locale.startsWith('zh')) {
      return locale.includes('tw') || locale.includes('hk') || locale.includes('mo')
        ? 'zh-TW'
        : 'zh-CN'
    }
    if (locale.startsWith('en')) return 'en'
    if (locale.startsWith('ja')) return 'ja'
    if (locale.startsWith('ko')) return 'ko'
    if (locale.startsWith('fr')) return 'fr'
    if (locale.startsWith('de')) return 'de'
    if (locale.startsWith('es')) return 'es'
    if (locale.startsWith('pt')) return 'pt'
    if (locale.startsWith('ru')) return 'ru'
    if (locale.startsWith('th')) return 'th'
    if (locale.startsWith('vi')) return 'vi'
  } catch {
    // app.getLocale 在某些环境可能抛错，回退到 zh-CN
  }
  return null
}

/**
 * 主进程同步翻译函数
 * @param key i18n key，如 'main.dialog.title'
 * @param options 插值参数
 * @returns 翻译后的字符串；key 缺失时返回 key 本身（便于诊断）
 */
export function t(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options)
}

export default i18n
