import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/renderer/**/*.{js,jsx,ts,tsx}', './src/renderer/index.html'],
  theme: {
    extend: {
      colors: {
        accent: 'var(--accent)',
        // P2-U13：补充 accent 系列变体映射，统一组件中 var(--accent-*) 内联引用为 Tailwind 类名
        'accent-light': 'var(--accent-light)',
        'accent-soft': 'var(--accent-soft)',
        'accent-deep': 'var(--accent-deep)',
        'bg-primary': 'var(--bg-primary)',
        'bg-secondary': 'var(--bg-secondary)',
        'bg-tertiary': 'var(--bg-tertiary)',
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-tertiary': 'var(--text-tertiary)',
        divider: 'var(--divider)',
        danger: 'var(--danger)',
        'danger-hover': 'var(--danger-hover)',
        success: 'var(--success)'
      },
      // fix-image-selection-border-visibility R4：ring 令牌进 Tailwind——覆盖默认值使
      // ring-*/ring-offset-* 与 globals.css 的 --accent/--bg-primary 一致。
      // 未覆盖前裸用 ring-2 恒为默认蓝 #3b82f6、ring-offset 恒为 #fff（在深/柔粉底上露白圈）
      ringColor: {
        DEFAULT: 'var(--accent)',
        accent: 'var(--accent)',
        'accent-soft': 'var(--accent-soft)'
      },
      ringOffsetColor: {
        DEFAULT: 'var(--bg-primary)'
      },
      // 视觉体系 v3：圆角/阴影令牌进 Tailwind——覆盖默认值使 rounded-*/shadow-* 与
      // globals.css 的 --radius-*/--shadow-* 完全一致，全项目单一圆角与阴影体系
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        pill: 'var(--radius-pill)'
      },
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)'
      },
      fontFamily: {
        sans: [
          'Segoe UI Variable Text',
          'Segoe UI',
          'Microsoft YaHei',
          'system-ui',
          '-apple-system',
          'sans-serif'
        ]
      },
      // 动画类（animate-fade-in 等）引用 globals.css 中已定义的全局 @keyframes，
      // 此处不重复声明关键帧，避免同名 keyframes 双份定义
      animation: {
        'fade-in': 'fadeIn 250ms cubic-bezier(0.4, 0, 0.2, 1) forwards',
        'scale-in': 'scaleIn 250ms cubic-bezier(0, 0, 0.2, 1) forwards',
        'slide-in-bottom': 'slideInBottom 300ms cubic-bezier(0, 0, 0.2, 1) forwards'
      },
      transitionTimingFunction: {
        win11: 'cubic-bezier(0.4, 0, 0.2, 1)',
        'win11-decelerate': 'cubic-bezier(0.0, 0, 0.2, 1)',
        emphasized: 'cubic-bezier(0.2, 0, 0, 1)',
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)'
      }
    }
  },
  plugins: []
}

export default config
