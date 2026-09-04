import path from 'path'
import { fileURLToPath } from 'url'
import type { StorybookConfig } from '@storybook/react-vite'

// main.ts 以 ESM 加载（无 __dirname），由 import.meta.url 推导仓库根目录
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Storybook 主配置（阶段 1 基础设施）
 *
 * - stories：渲染层组件故事 + docs/storybook 下的 MDX 文档（目录暂不存在，glob 为空即可）
 * - framework：@storybook/react-vite（与项目 Vite 5 构建链同源）
 * - autodocs：默认对所有故事生成文档页
 */
const config: StorybookConfig = {
  stories: ['../src/renderer/**/*.stories.@(ts|tsx)', '../docs/storybook/**/*.mdx'],
  addons: ['@storybook/addon-a11y', '@storybook/addon-docs'],
  framework: {
    name: '@storybook/react-vite',
    options: {}
  },
  docs: {
    autodocs: 'tag'
  },
  core: {
    // 禁用遥测，避免首次运行时产生网络请求与交互提示
    telemetry: false
  },
  /**
   * 与 electron.vite.config.ts renderer 别名保持一致，修改需同步。
   * 同时与 vitest.config.ts 的 resolve.alias 保持同一语义。
   */
  async viteFinal(config) {
    const { mergeConfig } = await import('vite')
    return mergeConfig(config, {
      resolve: {
        alias: {
          '@': path.resolve(root, 'src/renderer'),
          '@main': path.resolve(root, 'src/main'),
          '@common': path.resolve(root, 'src/common'),
          // 渲染层禁止真实 electron：指向空 stub（同 electron.vite.config.ts 与 vite.preview.config.ts）
          electron: path.resolve(root, 'scripts/electron-browser-stub.js')
        }
      },
      define: {
        // 编译期常量：Storybook 永远按非预览版构建
        __PREVIEW__: JSON.stringify(false)
      }
    })
  }
}

export default config
