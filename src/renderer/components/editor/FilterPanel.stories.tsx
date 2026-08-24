import { useState, type ComponentProps } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { FilterPanel } from './FilterPanel'
import { builtinFilterPresets } from '../../utils/filterPresets'
import type { FilterPreset } from '../../utils/imageProcessor'

/**
 * 编辑器滤镜面板故事（作为 editor 目录代表组件）。
 * FilterPanel 为全受控组件（预设名 / 滤镜 / 强度均由父组件持有），
 * 故事通过 StatefulFilterPanel 包装组件在本地维护状态，使滑杆与输入可交互。
 * 预设缩略图基于 sourceUrl（SVG data URL）经 canvas 实时生成，不依赖本地文件。
 * 桩环境下 `editor.loadPresets` 返回 undefined 会被组件 try/catch 静默吞掉，安全渲染。
 * 全部文案走既有 i18n key（filter.*）。
 */

/** 演示用渐变图（SVG data URL，不引用真实本地路径） */
const DEMO_IMAGE_URL =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0%" stop-color="#f6c8d0"/>' +
      '<stop offset="50%" stop-color="#9ecbff"/>' +
      '<stop offset="100%" stop-color="#5b7fd6"/>' +
      '</linearGradient></defs>' +
      '<rect width="240" height="240" fill="url(#g)"/>' +
      '<circle cx="170" cy="60" r="34" fill="#fff7d6" opacity="0.9"/>' +
      '</svg>'
  )

interface WrapperProps {
  initialPreset?: FilterPreset | null
  initialIntensity?: number
  sourceUrl?: string | null
}

/** 受控状态包装：本地维护预设名 / 当前滤镜 / 强度，回调转发到 story args（fn() 打点） */
function StatefulFilterPanel({
  initialPreset = null,
  initialIntensity = 80,
  sourceUrl = DEMO_IMAGE_URL,
  ...rest
}: WrapperProps &
  Omit<
    ComponentProps<typeof FilterPanel>,
    'filter' | 'filterIntensity' | 'presetName' | 'sourceUrl'
  >) {
  const [presetName, setPresetName] = useState('')
  const [filter, setFilter] = useState<FilterPreset | null>(initialPreset)
  const [intensity, setIntensity] = useState(initialIntensity)
  return (
    <FilterPanel
      {...rest}
      presetName={presetName}
      filter={filter}
      filterIntensity={intensity}
      sourceUrl={sourceUrl}
      onApplyPreset={(preset) => {
        setFilter(preset)
        rest.onApplyPreset(preset)
      }}
      onIntensityChange={(value) => {
        setIntensity(value)
        rest.onIntensityChange(value)
      }}
      onPresetNameChange={(name) => {
        setPresetName(name)
        rest.onPresetNameChange(name)
      }}
    />
  )
}

const meta: Meta<typeof StatefulFilterPanel> = {
  title: 'Editor/FilterPanel',
  component: StatefulFilterPanel,
  tags: ['autodocs'],
  argTypes: {
    initialPreset: { control: false },
    sourceUrl: { control: false },
    onApplyPreset: { action: 'applyPreset' },
    onIntensityChange: { action: 'intensityChange' },
    onIntensityCommit: { action: 'intensityCommit' },
    onExportPreset: { action: 'exportPreset' },
    onImportPreset: { action: 'importPreset' },
    onSavePreset: { action: 'savePreset' },
    onPresetNameChange: { action: 'presetNameChange' }
  },
  args: {
    onApplyPreset: fn(),
    onIntensityChange: fn(),
    onIntensityCommit: fn(),
    onExportPreset: fn(),
    onImportPreset: fn(),
    onPresetNameChange: fn()
  },
  decorators: [(Story) => <div className="w-80 p-3">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          '编辑器滤镜面板（editor 目录代表组件）：预设命名与保存 / 导出导入、滤镜分类切换、强度滑杆与内置预设缩略图网格。' +
          '组件为全受控设计，本组故事经 `StatefulFilterPanel` 包装在本地维护 `presetName / filter / filterIntensity` 状态，' +
          '原始回调经 `fn()` 打点（见 Actions 面板）。' +
          '预设缩略图基于 `sourceUrl`（SVG data URL，不引用真实本地路径）经 canvas 并发（4）实时生成。' +
          '依赖命名空间：`window.electronAPI.editor.loadPresets` / `editor.deletePreset`（加载 / 删除自定义预设）；' +
          '桩环境下返回 undefined 被组件 try/catch 静默忽略，安全渲染且仅展示内置预设。' +
          '无障碍要点：保存 / 导出 / 导入 / 删除按钮均带 `aria-label`，预设卡片 `aria-label` 含预设名。' +
          '文案走 `filter.*` i18n key，预设名经 `t(preset.name)` 解析。' +
          '同置测试：暂无（受控交互经 story fn() 打点演示）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof StatefulFilterPanel>

/** 默认：无选中预设，缩略图基于演示图实时生成；保存按钮在命名为空时禁用 */
export const Default: Story = {}

/** 已选中预设：初始选中内置「自然系」第一项，展示选中态描边 */
export const SelectedPreset: Story = {
  args: {
    initialPreset: builtinFilterPresets[0],
    initialIntensity: 60
  }
}

/** 无图源：sourceUrl 为 null，缩略图网格回退到占位图标样式 */
export const NoSource: Story = {
  args: {
    sourceUrl: null
  }
}
