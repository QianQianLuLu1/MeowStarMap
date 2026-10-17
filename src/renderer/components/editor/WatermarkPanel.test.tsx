/**
 * @layer L3
 * @module src/renderer/components/editor/WatermarkPanel
 * @coverage 模板保存的 result.success 分支 与 loadTemplates 的失败兜底
 * @remarks
 * 缺陷（docs/plans/2026-10-17-fix-image-watermark-media-auth.md §5 N3）：
 * preload 的 call<T>() 剥掉了外层 IpcResponse.success，而本组件判的是 handler 自己返回对象
 * 里的 success（WatermarkPanel.tsx handleSaveTemplate）。handler 只返回 {id} 时该判断恒为
 * undefined → 点「保存」后输入框不清空、列表不刷新、无任何提示，表现为「点了没反应」，
 * 但 DB 行其实已插入。本组用例把「内层 success」契约钉在渲染层这一侧。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { mockT } = vi.hoisted(() => {
  const fn = ((key: string) => key) as unknown as ((key: string) => string) & {
    mock: { calls: unknown[][] }
  }
  return { mockT: fn }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'zh-CN' } })
}))

// SliderControl 会牵进主题/样式依赖，本组用例不关心它，替身为最小占位
vi.mock('../common/SliderControl', () => ({
  SliderControl: () => null
}))

// 插件模板扩展点：返回空列表，隔离插件运行时
vi.mock('../../plugins/plugin-runtime', () => ({
  getPluginWatermarkTemplates: vi.fn(() => Promise.resolve([]))
}))

import { WatermarkPanel } from './WatermarkPanel'

interface WatermarkBridge {
  loadTemplates: ReturnType<typeof vi.fn>
  saveTemplate: ReturnType<typeof vi.fn>
  deleteTemplate: ReturnType<typeof vi.fn>
}

let bridge: WatermarkBridge
let consoleErrorSpy: ReturnType<typeof vi.spyOn>

function installBridge(): void {
  bridge = {
    loadTemplates: vi.fn().mockResolvedValue([]),
    saveTemplate: vi.fn().mockResolvedValue({ success: true, id: 1 }),
    deleteTemplate: vi.fn().mockResolvedValue({ deleted: true })
  }
  ;(window as unknown as { electronAPI: { watermark: WatermarkBridge } }).electronAPI = {
    watermark: bridge
  }
}

const NAME_INPUT_PLACEHOLDER = 'watermark.templateNamePlaceholder'

describe('WatermarkPanel 模板区', () => {
  beforeEach(() => {
    installBridge()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('B1 保存成功后清空名称输入框并刷新模板列表', async () => {
    // 第二次 loadTemplates 才返回新行，模拟「保存 → 重新拉列表」
    bridge.loadTemplates
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 1, name: '我的水印', config: '{}' }])

    const onChange = vi.fn()
    render(<WatermarkPanel config={null} onChange={onChange} />)

    const input = (await screen.findByPlaceholderText(NAME_INPUT_PLACEHOLDER)) as HTMLInputElement
    fireEvent.change(input, { target: { value: '我的水印' } })
    fireEvent.click(screen.getByLabelText('watermark.saveTemplateAria'))

    await waitFor(() => expect(bridge.saveTemplate).toHaveBeenCalledTimes(1))
    // 契约钉形：渲染层拿到的必须是含 success 的对象（handler 侧缺它即为缺陷）
    expect(bridge.saveTemplate.mock.calls[0][0]).toBe('我的水印')
    await waitFor(() => expect(input.value).toBe(''))
    expect(await screen.findByText('我的水印')).toBeTruthy()
  })

  it('B2 loadTemplates 失败时不产生未处理拒绝，并落一条可诊断日志', async () => {
    bridge.loadTemplates.mockRejectedValueOnce(new Error('database not ready'))

    const { container } = render(<WatermarkPanel config={null} onChange={vi.fn()} />)

    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled())
    // 失败后列表保持空态而不是抛错崩面板
    expect(container.textContent ?? '').not.toContain('database not ready')
  })

  it('B3 保存失败（IpcError 抛出）时保留已输入名称，便于用户重试', async () => {
    bridge.saveTemplate.mockRejectedValueOnce(new Error('IPC_PATH_FORBIDDEN'))

    render(<WatermarkPanel config={null} onChange={vi.fn()} />)
    const input = (await screen.findByPlaceholderText(NAME_INPUT_PLACEHOLDER)) as HTMLInputElement
    fireEvent.change(input, { target: { value: '重试我' } })
    fireEvent.click(screen.getByLabelText('watermark.saveTemplateAria'))

    await waitFor(() => expect(bridge.saveTemplate).toHaveBeenCalledTimes(1))
    expect(input.value).toBe('重试我')
  })
})
