/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('./BaseDialog', () => ({
  BaseDialog: ({ open, children }: any) => (open ? <div role="dialog">{children}</div> : null)
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: any) => {
      if (opts && opts.label) return `${key}:${opts.label}`
      return key
    }
  })
}))

vi.mock('../../icons', () => ({
  IconClose: (p: any) => <svg data-testid="icon-close" {...p} />
}))

import { FeedbackDialog } from './FeedbackDialog'

describe('FeedbackDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('open=false 时不渲染', () => {
    const { container } = render(<FeedbackDialog open={false} onClose={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('open=true 时渲染对话框', () => {
    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('渲染标题', () => {
    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    expect(screen.getByText('common.feedbackDialog.title')).toBeTruthy()
  })

  it('渲染错误描述输入框', () => {
    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    expect(screen.getByPlaceholderText('common.feedbackDialog.descriptionPlaceholder')).toBeTruthy()
  })

  it('输入描述时更新内容', () => {
    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    const textarea = screen.getByPlaceholderText(
      'common.feedbackDialog.descriptionPlaceholder'
    ) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '出现错误' } })
    expect(textarea.value).toBe('出现错误')
  })

  it('渲染字符计数（初始 0/500）', () => {
    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    expect(screen.getByText('0/500')).toBeTruthy()
  })

  it('输入文本后字符计数更新', () => {
    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    const textarea = screen.getByPlaceholderText('common.feedbackDialog.descriptionPlaceholder')
    fireEvent.change(textarea, { target: { value: '12345' } })
    expect(screen.getByText('5/500')).toBeTruthy()
  })

  it('maxLength=500 限制输入长度', () => {
    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    const textarea = screen.getByPlaceholderText(
      'common.feedbackDialog.descriptionPlaceholder'
    ) as HTMLTextAreaElement
    expect(textarea.maxLength).toBe(500)
  })

  it('默认勾选"附带日志"', () => {
    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    const checkboxes = screen.getAllByRole('checkbox')
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true)
  })

  it('默认勾选"附带系统信息"', () => {
    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    const checkboxes = screen.getAllByRole('checkbox')
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true)
  })

  it('点击复选框切换勾选状态', () => {
    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false)
  })

  it('渲染导出诊断包按钮', () => {
    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    expect(screen.getByText('common.feedbackDialog.exportButton')).toBeTruthy()
  })

  it('点击导出按钮调用 electronAPI.log.exportZip', async () => {
    const exportZip = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).electronAPI = { log: { exportZip } }

    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('common.feedbackDialog.exportButton'))
    })
    expect(exportZip).toHaveBeenCalledTimes(1)
  })

  it('导出成功时显示成功消息', async () => {
    const exportZip = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).electronAPI = { log: { exportZip } }

    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('common.feedbackDialog.exportButton'))
    })
    expect(screen.getByText('common.feedbackDialog.exportSuccess')).toBeTruthy()
  })

  it('导出失败时显示失败消息', async () => {
    const exportZip = vi.fn().mockResolvedValue({ success: false, message: '磁盘不足' })
    ;(window as any).electronAPI = { log: { exportZip } }

    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('common.feedbackDialog.exportButton'))
    })
    expect(screen.getByText('磁盘不足')).toBeTruthy()
  })

  it('导出中按钮 disabled', async () => {
    let resolveFn: () => void
    const exportZip = vi.fn(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          resolveFn = () => resolve({ success: true })
        })
    )
    ;(window as any).electronAPI = { log: { exportZip } }

    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('common.feedbackDialog.exportButton'))
    // 导出中文案出现
    expect(screen.getByText('common.feedbackDialog.exporting')).toBeTruthy()
    const button = screen.getByText('common.feedbackDialog.exporting').closest('button')!
    expect((button as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      resolveFn!()
    })
  })

  it('用户取消保存对话框时不显示错误', async () => {
    const exportZip = vi.fn().mockResolvedValue({ canceled: true })
    ;(window as any).electronAPI = { log: { exportZip } }

    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('common.feedbackDialog.exportButton'))
    })
    expect(screen.queryByText('common.feedbackDialog.exportFailed')).toBeNull()
  })

  it('导出抛错时显示错误消息', async () => {
    const exportZip = vi.fn().mockRejectedValue(new Error('IPC 断开'))
    ;(window as any).electronAPI = { log: { exportZip } }

    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('common.feedbackDialog.exportButton'))
    })
    expect(screen.getByText('IPC 断开')).toBeTruthy()
  })

  it('点击 QQ 群按钮调用 clipboard.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true
    })

    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('common.feedbackDialog.qqGroupLabel'))
    })
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('点击 GitHub 按钮调用 clipboard.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true
    })

    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('common.feedbackDialog.githubLabel'))
    })
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('点击关闭按钮触发 onClose', () => {
    const onClose = vi.fn()
    render(<FeedbackDialog open={true} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('icon-close').closest('button')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
