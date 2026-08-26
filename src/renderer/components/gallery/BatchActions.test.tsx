/**
 * @vitest-environment jsdom
 *
 * BatchActions（图库底部批量操作栏）单元测试
 *
 * 聚焦本次修复的「字体显示不全」问题，根因：
 *   .icon-btn 是裸 CSS（不在 @layer 内），定义 width:36px + overflow:hidden，
 *   且在 CSS 源顺序上位于 Tailwind utilities 之后，压制了按钮上的 w-auto，
 *   导致中文标签被裁剪（导出到默认→出到到、WiFi 分享→WiFi 分 1）。
 *
 * 修复方案（见 BatchActions.tsx / globals.css）：
 *   1. 容器改为 flex-nowrap + overflow-x-auto + scrollbar-hide（单行可滚动、隐藏滚动条）；
 *   2. 新增 .batch-act-btn 裸 CSS 类覆盖 .icon-btn 的固定宽度，使按钮随标签自适应。
 *
 * 验收维度：渲染 / 无障碍 / 条件渲染 / 交互 / 样式挂载点（防回归）。
 * i18n 由 tests/setup.ts 全局初始化，t() 返回真实中文，断言与用户可见文案对齐。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BatchActions } from './BatchActions'

// auto-animate 在 jsdom 下无意义，mock 为 no-op ref 避免环境差异导致误报
vi.mock('@formkit/auto-animate/react', () => ({
  useAutoAnimate: () => [{ current: null }, vi.fn()]
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const baseProps = {
  count: 3,
  total: 31,
  onSelectAll: vi.fn(),
  onInvertSelection: vi.fn(),
  onClear: vi.fn(),
  onDelete: vi.fn(),
  onExport: vi.fn(),
  onMove: vi.fn(),
  onWatermark: vi.fn()
}

describe('BatchActions — 渲染', () => {
  it('T01 渲染 role="toolbar" 容器', () => {
    render(<BatchActions {...baseProps} />)
    expect(screen.getByRole('toolbar')).toBeTruthy()
  })

  it('T02 容器应用单行滚动 + 隐藏滚动条类（防回归：不再 flex-wrap 触发换行裁剪）', () => {
    render(<BatchActions {...baseProps} />)
    const toolbar = screen.getByRole('toolbar')
    expect(toolbar.className).toContain('scrollbar-hide')
    expect(toolbar.className).toContain('overflow-x-auto')
    expect(toolbar.className).toContain('flex-nowrap')
    expect(toolbar.className).not.toContain('flex-wrap')
  })

  it('T03 渲染必选操作按钮：全选/反选/删除/导出/移动/水印', () => {
    render(<BatchActions {...baseProps} />)
    expect(screen.getByText('全选')).toBeTruthy()
    expect(screen.getByText('反选')).toBeTruthy()
    expect(screen.getByText('删除')).toBeTruthy()
    expect(screen.getByText('导出')).toBeTruthy()
    expect(screen.getByText('移动')).toBeTruthy()
    expect(screen.getByText('水印')).toBeTruthy()
  })

  it('T04 渲染选中计数文案（模板：{{count}} / {{total}} 项已选择）', () => {
    render(<BatchActions {...baseProps} />)
    expect(screen.getByText(/3 \/ 31 项已选择/)).toBeTruthy()
  })

  it('T05 清除选择按钮通过 aria-label 可访问', () => {
    render(<BatchActions {...baseProps} />)
    expect(screen.getByLabelText('清除选择')).toBeTruthy()
  })

  it('T06 仅当传入可选回调时渲染对应按钮', () => {
    const fullProps = {
      ...baseProps,
      onExportToDefault: vi.fn(),
      onBatchRename: vi.fn(),
      onCategorize: vi.fn(),
      onTransferToProfile: vi.fn(),
      onShareWifi: vi.fn(),
      onShareClipboard: vi.fn()
    }
    render(<BatchActions {...fullProps} />)
    expect(screen.getByText('导出到默认')).toBeTruthy()
    expect(screen.getByText('批量重命名')).toBeTruthy()
    expect(screen.getByText('分类')).toBeTruthy()
    expect(screen.getByText('转移到档案')).toBeTruthy()
    expect(screen.getByText('WiFi 分享')).toBeTruthy()
    expect(screen.getByText('分享')).toBeTruthy()
  })

  it('T07 未传入可选回调时不渲染对应按钮', () => {
    render(<BatchActions {...baseProps} />)
    expect(screen.queryByText('导出到默认')).toBeNull()
    expect(screen.queryByText('批量重命名')).toBeNull()
    expect(screen.queryByText('转移到档案')).toBeNull()
    expect(screen.queryByText('WiFi 分享')).toBeNull()
    expect(screen.queryByText('分享')).toBeNull()
  })
})

describe('BatchActions — 交互', () => {
  it('T08 点击全选触发 onSelectAll', () => {
    const onSelectAll = vi.fn()
    render(<BatchActions {...baseProps} onSelectAll={onSelectAll} />)
    fireEvent.click(screen.getByText('全选'))
    expect(onSelectAll).toHaveBeenCalledTimes(1)
  })

  it('T09 点击删除触发 onDelete', () => {
    const onDelete = vi.fn()
    render(<BatchActions {...baseProps} onDelete={onDelete} />)
    fireEvent.click(screen.getByText('删除'))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('T10 点击清除选择触发 onClear', () => {
    const onClear = vi.fn()
    render(<BatchActions {...baseProps} onClear={onClear} />)
    fireEvent.click(screen.getByLabelText('清除选择'))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
