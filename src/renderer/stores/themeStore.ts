import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { type UITheme, defaultTheme, getThemeConfig, themes } from '../styles/themes'

interface ThemeState {
  theme: UITheme
  setTheme: (theme: UITheme) => void
  applyTheme: (theme: UITheme) => void
}

function applyThemeClass(theme: UITheme): void {
  const root = document.documentElement
  const config = getThemeConfig(theme)

  // 移除所有已注册的主题类名，确保只有一个主题生效
  themesClasses.forEach((cls) => {
    if (cls) root.classList.remove(cls)
  })

  if (config.className) {
    root.classList.add(config.className)
  }
}

// P2-U12：从 themes 配置自动派生所有非空 className，新增主题时无需手动维护此列表
const themesClasses = themes.map((t) => t.className).filter(Boolean)

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: defaultTheme,
      setTheme: (theme) => {
        if (theme === get().theme) return
        set({ theme })
        applyThemeClass(theme)
      },
      applyTheme: (theme) => {
        applyThemeClass(theme)
      }
    }),
    {
      name: 'wxnn-ui-theme',
      partialize: (state) => ({ theme: state.theme })
    }
  )
)

export { applyThemeClass }
