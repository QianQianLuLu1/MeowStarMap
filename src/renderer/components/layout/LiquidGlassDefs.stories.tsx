import type { Meta, StoryObj } from '@storybook/react-vite'
import { LiquidGlassDefs, REFRACT_FILTER_ID, supportsBackdropSvgFilter } from './LiquidGlassDefs'

/**
 * 液态玻璃折射滤镜 defs 故事。
 * 组件无 props、无 store 依赖，渲染一组隐藏的 SVG <filter> 节点供 CSS
 * `backdrop-filter: url(#…)` 引用，实现玻璃边缘折射效果。
 * 仅在 Chromium 108+ 环境下渲染（CSS.supports 检测），非支持环境返回 null。
 *
 * 故事内通过 beforeEach 强制 `CSS.supports` 返回 true，确保 Storybook 中可见 SVG 结构。
 */
/** beforeEach 桩化前的原 CSS.supports，供 afterEach 还原，避免桩跨故事留存 */
let origSupports: typeof CSS.supports | undefined

const meta: Meta<typeof LiquidGlassDefs> = {
  title: 'Layout/LiquidGlassDefs',
  component: LiquidGlassDefs,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          '液态玻璃折射滤镜全局单例（AppShell 挂载一次）。' +
          '技法：两张 R/G 通道编码的位移贴图（feImage + feDisplacementMap ×2）链式位移，' +
          '模拟玻璃边缘折射；中央区域保持不位移。' +
          '特性检测：`supportsBackdropSvgFilter()` 通过 `CSS.supports("backdrop-filter", …)` 判断，' +
          '非 Chromium 环境（含外部浏览器 preview.html）降级为无折射。' +
          '无障碍要点：`aria-hidden="true"` + `focusable="false"`，纯装饰性节点。' +
          '同置测试：`LiquidGlassDefs.test.tsx`（覆盖支持 / 不支持 / CSS API 缺失三种场景）。'
      }
    }
  },
  beforeEach: () => {
    // 确保组件在 Canvas 中渲染 SVG 结构（Storybook 运行在 Chromium，CSS.supports 通常可用，
    // 但显式桩保证一致性）
    origSupports = CSS.supports?.bind(CSS) as typeof CSS.supports
    CSS.supports = ((property: string, value?: string) => {
      if (property === 'backdrop-filter' && value?.includes(REFRACT_FILTER_ID)) return true
      return origSupports ? origSupports(property, value!) : true
    }) as typeof CSS.supports
  },
  afterEach: () => {
    if (origSupports) CSS.supports = origSupports
    origSupports = undefined
  }
}

export default meta
type Story = StoryObj<typeof LiquidGlassDefs>

/** 默认：渲染隐藏 SVG 节点（width=0 height=0），Canvas 中不可见但 DOM 可查 */
export const Default: Story = {}

/**
 * 可视化验证：配合一个带 `liquid-glass` 类的卡片观察折射效果
 * （仅在 Chromium 内核中有效）。
 */
export const WithGlassPreview: Story = {
  render: () => (
    <div style={{ position: 'relative', width: 400, height: 260 }}>
      {/* 背景内容 */}
      <div
        style={{
          width: '100%',
          height: '100%',
          background: 'linear-gradient(135deg, var(--accent-soft), var(--bg-secondary))',
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          color: 'var(--text-secondary)'
        }}
      >
        背景内容（折射观察区）
      </div>
      {/* 玻璃卡片 */}
      <div
        className="liquid-glass"
        style={{
          position: 'absolute',
          top: 60,
          left: 60,
          width: 280,
          height: 140,
          borderRadius: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          color: 'var(--text-primary)'
        }}
      >
        液态玻璃面板
      </div>
    </div>
  )
}

/** 特性检测结果展示（信息面板） */
export const FeatureDetection: Story = {
  render: () => {
    const supported = supportsBackdropSvgFilter()
    return (
      <div
        style={{
          padding: '16px 24px',
          borderRadius: 12,
          background: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
          fontSize: 14,
          lineHeight: 1.8
        }}
      >
        <p>
          <strong>REFRACT_FILTER_ID：</strong>
          <code>{REFRACT_FILTER_ID}</code>
        </p>
        <p>
          <strong>CSS backdrop-filter SVG 支持：</strong>
          <span style={{ color: supported ? 'var(--accent)' : 'var(--text-tertiary)' }}>
            {supported ? '✓ 支持' : '✗ 不支持（将降级为无折射）'}
          </span>
        </p>
      </div>
    )
  }
}
