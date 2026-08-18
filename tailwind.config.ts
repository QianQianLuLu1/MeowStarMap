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
      transitionTimingFunction: {
        win11: 'cubic-bezier(0.4, 0, 0.2, 1)',
        'win11-decelerate': 'cubic-bezier(0.0, 0, 0.2, 1)'
      }
    }
  },
  plugins: []
}

export default config
