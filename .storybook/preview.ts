import type { Preview } from '@storybook/react-vite'
import { themes, defaultTheme, type UITheme } from '../src/renderer/styles/themes'
import '../src/renderer/styles/globals.css'
// 修复主题令牌覆盖失效：globals.css 顶部 @import 的主题规则会被 Vite 内联到
// :root 默认令牌之前，两者特异性相同（.soft-pink-luxury 与 :root 均为 0,1,0），
// 在后的 :root 吞掉所有主题变量。此处在 globals 之后再次引入主题 CSS，使主题规则
// 在产物级联中排在 :root 之后，恢复「先 :root 后主题」的真实语义。
import '../src/renderer/styles/themes/soft-pink-luxury.css'
import { withI18n } from './decorators/i18n'
import { withTheme } from './decorators/theme'
import { installElectronApiMock } from './mocks/electron-api'

// 全局挂载 window.electronAPI 安全桩（单 story 可通过 beforeEach 覆盖）
installElectronApiMock()

const preview: Preview = {
  globalTypes: {
    locale: {
      description: '界面语言（对齐 src/renderer/i18n 支持的语言列表）',
      toolbar: {
        title: '语言',
        icon: 'globe',
        items: [
          { value: 'zh-CN', title: '简体中文' },
          { value: 'zh-TW', title: '繁體中文' },
          { value: 'en', title: 'English' },
          { value: 'ja', title: '日本語' },
          { value: 'ko', title: '한국어' },
          { value: 'fr', title: 'Français' },
          { value: 'de', title: 'Deutsch' },
          { value: 'es', title: 'Español' },
          { value: 'pt', title: 'Português' },
          { value: 'ru', title: 'Русский' },
          { value: 'th', title: 'ไทย' },
          { value: 'vi', title: 'Tiếng Việt' }
        ],
        dynamicTitle: true
      }
    },
    theme: {
      description: '界面主题（选项来自 src/renderer/styles/themes 注册表）',
      toolbar: {
        title: '主题',
        icon: 'paintbrush',
        items: themes.map((t) => ({ value: t.id, title: t.id })),
        dynamicTitle: true
      }
    }
  },
  parameters: {
    controls: { expanded: true },
    layout: 'centered'
  },
  initialGlobals: {
    locale: 'zh-CN',
    theme: defaultTheme as UITheme
  },
  decorators: [withI18n, withTheme]
}

export default preview
