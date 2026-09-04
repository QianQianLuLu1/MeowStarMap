import { nativeTheme } from 'electron'
import type { AppContext } from './app-context'
import { sendToRenderer } from './renderer-bridge'

/**
 * 应用 UI 主题（持久化 + 同步 nativeTheme + 标题栏叠加色）。
 */
export function applyUITheme(ctx: AppContext, theme: 'default' | 'soft-pink-luxury'): void {
  ctx.dbManager.setSetting('uiTheme', theme)

  // 当前主题集合均为浅色，保留深色主题扩展能力
  const darkThemes = new Set<string>([])
  const isDark = darkThemes.has(theme)

  // 同步系统原生主题为对应亮/暗模式，使标题栏按钮颜色匹配
  nativeTheme.themeSource = isDark ? 'dark' : 'light'

  // 更新窗口标题栏叠加按钮颜色
  const win = ctx.mainWindow
  if (win && !win.isDestroyed()) {
    win.setTitleBarOverlay({
      color: 'rgba(0,0,0,0)',
      symbolColor: isDark ? '#FFFFFF' : '#1A1A1A',
      height: 40
    })
    const backgroundColors: Record<string, string> = {
      default: '#F5F5F5',
      'soft-pink-luxury': '#fdf9fb'
    }
    win.setBackgroundColor(backgroundColors[theme] ?? '#F5F5F5')
  }
}

/**
 * 注册 nativeTheme 'updated' 监听器，向渲染进程广播 theme:changed。
 */
export function setupThemeListener(ctx: AppContext): void {
  nativeTheme.on('updated', () => {
    sendToRenderer(ctx, 'theme:changed', {
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors
    })
  })
}
