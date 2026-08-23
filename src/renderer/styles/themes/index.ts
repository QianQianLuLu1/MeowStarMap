/**
 * 界面主题配置中心
 * 新增主题只需：1) 在此注册；2) 添加同名 CSS 主题文件并在 globals.css 中引入。
 */

export type UITheme = 'default' | 'soft-pink-luxury'

export interface ThemeConfig {
  id: UITheme
  /** i18n key，UI 展示时用 t(nameKey) 解析 */
  nameKey: string
  /** 作用于 document.documentElement 的 CSS 类名，空字符串表示不附加类 */
  className: string
}

export const themes: ThemeConfig[] = [
  { id: 'default', nameKey: 'themes.default', className: '' },
  { id: 'soft-pink-luxury', nameKey: 'themes.softPinkLuxury', className: 'soft-pink-luxury' }
]

export const defaultTheme: UITheme = 'default'

export function getThemeConfig(themeId: UITheme): ThemeConfig {
  return themes.find((t) => t.id === themeId) ?? themes[0]
}
