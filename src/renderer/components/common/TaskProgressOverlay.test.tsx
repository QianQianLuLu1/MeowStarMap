import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TaskProgressOverlay } from './TaskProgressOverlay'
import type { TaskProgress } from '../../../shared/types/progress'

const baseProgress = (over: Partial<TaskProgress> = {}): TaskProgress => ({
  taskId: 't-1',
  taskType: 'batch',
  phase: 'processing',
  current: 1,
  total: 3,
  percent: 33,
  startedAt: 0,
  canCancel: false,
  ...over
})

describe('TaskProgressOverlay 阶段步骤渲染', () => {
  it('存在 stages 时渲染步骤列表（含序号与文案）', () => {
    render(
      <TaskProgressOverlay
        progress={baseProgress({
          stages: [
            { id: '0', label: '准备', status: 'done' },
            { id: '1', label: '处理', status: 'active' },
            { id: '2', label: '收尾', status: 'pending' }
          ]
        })}
      />
    )
    expect(screen.getByText('1. 准备')).toBeInTheDocument()
    expect(screen.getByText('2. 处理')).toBeInTheDocument()
    expect(screen.getByText('3. 收尾')).toBeInTheDocument()
  })

  it('无 stages 时不渲染步骤列表', () => {
    const { container } = render(<TaskProgressOverlay progress={baseProgress()} />)
    // 仅 percent 行 + ETA 行，不应出现「N. 文案」形式的步骤
    expect(container.querySelector('ul')).toBeNull()
    expect(screen.queryByText(/1\. /)).toBeNull()
  })

  it('failed 阶段渲染失败详情', () => {
    render(
      <TaskProgressOverlay
        progress={baseProgress({
          phase: 'error',
          stages: [{ id: '0', label: '处理', status: 'failed', detail: '文件被占用' }]
        })}
      />
    )
    expect(screen.getByText('文件被占用')).toBeInTheDocument()
  })

  it('canCancel 且提供 onCancel 时显示取消按钮', () => {
    const onCancel = vi.fn()
    render(<TaskProgressOverlay progress={baseProgress({ canCancel: true })} onCancel={onCancel} />)
    const btn = screen.getByLabelText('取消任务')
    expect(btn).toBeInTheDocument()
    btn.click()
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('progress=null 时不渲染', () => {
    const { container } = render(<TaskProgressOverlay progress={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('progress 从有值变为 null 时卡片卸载（退场动画挂载点守卫）', () => {
    const { rerender, container } = render(<TaskProgressOverlay progress={baseProgress()} />)
    // 注意卡片内 Spinner 也有 role="status"，此处以毛玻璃卡片类名定位浮窗本体
    expect(container.querySelector('.glass-card')).not.toBeNull()
    rerender(<TaskProgressOverlay progress={null} />)
    expect(container.firstChild).toBeNull()
  })
})
