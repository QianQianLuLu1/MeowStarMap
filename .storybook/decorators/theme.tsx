// Storybook 主题装饰器
//
// 复用 themeStore 的 applyTheme 将选中主题类挂到 document.documentElement，
// 与生产行为一致（applyThemeClass 内部会先移除所有已注册主题类再附加新类）。
// 不调用 setTheme：避免触发 zustand persist 写入，保持 Storybook 环境只读。

import { useEffect } from 'react'
import type { Decorator } from '@storybook/react-vite'
import { defaultTheme, type UITheme } from '../../src/renderer/styles/themes'
import { useThemeStore } from '../../src/renderer/stores/themeStore'

export const withTheme: Decorator = (Story, context) => {
  const theme = (context.globals.theme as UITheme) || defaultTheme
  const applyTheme = useThemeStore((state) => state.applyTheme)
  useEffect(() => {
    applyTheme(theme)
  }, [theme, applyTheme])
  return <Story />
}
