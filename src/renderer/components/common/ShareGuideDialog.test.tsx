/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('./BaseDialog', () => ({
  BaseDialog: ({ open, children, onClose }: any) =>
    open ? (
      <div role="dialog" data-testid="base-dialog">
        <button data-testid="close-btn" onClick={onClose}>
          close
        </button>
        {children}
      </div>
    ) : null
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: any) => {
      // share.guide.channels.xxx 直接返回渠道 id，便于后续拼接
      if (key.startsWith('share.guide.channels.')) return key.split('.').pop() as string
      if (opts && opts.name) return `${key}:${opts.name}`
      return key
    }
  })
}))

vi.mock('../../icons', () => ({
  IconWeChat: (p: any) => <svg data-testid="icon-wechat" {...p} />,
  IconQQ: (p: any) => <svg data-testid="icon-qq" {...p} />,
  IconVivo: (p: any) => <svg data-testid="icon-vivo" {...p} />
}))

import { ShareGuideDialog } from './ShareGuideDialog'

describe('ShareGuideDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('open=false 时不渲染', () => {
    const { container } = render(
      <ShareGuideDialog
        open={false}
        channelId="wechat"
        installed={true}
        running={true}
        onClose={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('open=true 但 channelId=null 时不渲染', () => {
    const { container } = render(
      <ShareGuideDialog
        open={true}
        channelId={null}
        installed={true}
        running={true}
        onClose={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('已安装且运行中时显示运行中引导文案', () => {
    render(
      <ShareGuideDialog
        open={true}
        channelId="wechat"
        installed={true}
        running={true}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('share.guide.guides.wechat.running')).toBeTruthy()
  })

  it('已安装未运行时显示未运行引导文案', () => {
    render(
      <ShareGuideDialog
        open={true}
        channelId="qq"
        installed={true}
        running={false}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('share.guide.guides.qq.notRunning')).toBeTruthy()
  })

  it('未安装时显示未安装引导文案', () => {
    render(<ShareGuideDialog open={true} channelId="vivo" installed={false} onClose={vi.fn()} />)
    expect(screen.getByText('share.guide.guides.vivo.notInstalled')).toBeTruthy()
  })

  it('已安装未运行时显示"打开 XX"按钮', () => {
    render(
      <ShareGuideDialog
        open={true}
        channelId="wechat"
        installed={true}
        running={false}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('share.guide.open:wechat')).toBeTruthy()
  })

  it('已安装且运行中时不显示打开按钮', () => {
    render(
      <ShareGuideDialog
        open={true}
        channelId="wechat"
        installed={true}
        running={true}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByText(/share\.guide\.open/)).toBeNull()
  })

  it('点击"我知道了"按钮触发 onClose', () => {
    const onClose = vi.fn()
    render(
      <ShareGuideDialog
        open={true}
        channelId="wechat"
        installed={true}
        running={true}
        onClose={onClose}
      />
    )
    fireEvent.click(screen.getByText('share.guide.known'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('复制失败时显示失败对话框', () => {
    render(
      <ShareGuideDialog
        open={true}
        channelId="wechat"
        installed={true}
        running={true}
        copyResult={{ success: false, message: '复制失败原因', count: 0, skipped: 0 }}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('share.guide.failed')).toBeTruthy()
    expect(screen.getByText('复制失败原因')).toBeTruthy()
  })

  it('复制失败时不自动关闭', () => {
    const onClose = vi.fn()
    render(
      <ShareGuideDialog
        open={true}
        channelId="wechat"
        installed={true}
        running={true}
        copyResult={{ success: false, message: '失败', count: 0, skipped: 0 }}
        onClose={onClose}
      />
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it('已安装且运行中时 3 秒后自动关闭', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    render(
      <ShareGuideDialog
        open={true}
        channelId="wechat"
        installed={true}
        running={true}
        onClose={onClose}
      />
    )
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('未安装时 5 秒后自动关闭', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    render(<ShareGuideDialog open={true} channelId="wechat" installed={false} onClose={onClose} />)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('已安装未运行时不自动关闭', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    render(
      <ShareGuideDialog
        open={true}
        channelId="wechat"
        installed={true}
        running={false}
        onClose={onClose}
      />
    )
    act(() => {
      vi.advanceTimersByTime(10000)
    })
    expect(onClose).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('skipped > 0 时显示跳过提示', () => {
    render(
      <ShareGuideDialog
        open={true}
        channelId="wechat"
        installed={true}
        running={true}
        copyResult={{ success: true, message: '', count: 5, skipped: 2 }}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('share.guide.skipped')).toBeTruthy()
  })

  it('skipped = 0 时不显示跳过提示', () => {
    render(
      <ShareGuideDialog
        open={true}
        channelId="wechat"
        installed={true}
        running={true}
        copyResult={{ success: true, message: '', count: 5, skipped: 0 }}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByText('share.guide.skipped')).toBeNull()
  })

  it('点击"打开"按钮调用 electronAPI.share.launchApp', async () => {
    const launchApp = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).electronAPI = { share: { launchApp } }

    render(
      <ShareGuideDialog
        open={true}
        channelId="wechat"
        installed={true}
        running={false}
        onClose={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('share.guide.open:wechat'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(launchApp).toHaveBeenCalledWith('wechat')
  })

  it('launchApp 返回 success=true 时显示成功消息', async () => {
    const launchApp = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).electronAPI = { share: { launchApp } }

    render(
      <ShareGuideDialog
        open={true}
        channelId="wechat"
        installed={true}
        running={false}
        onClose={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('share.guide.open:wechat'))
    expect(await screen.findByText('share.guide.launchSuccess')).toBeTruthy()
  })

  it('launchApp 抛错时显示失败消息', async () => {
    const launchApp = vi.fn().mockRejectedValue(new Error('boom'))
    ;(window as any).electronAPI = { share: { launchApp } }

    render(
      <ShareGuideDialog
        open={true}
        channelId="wechat"
        installed={true}
        running={false}
        onClose={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('share.guide.open:wechat'))
    expect(await screen.findByText(/share\.guide\.launchFailed/)).toBeTruthy()
  })

  it('渠道为 wechat 时显示微信图标', () => {
    render(
      <ShareGuideDialog
        open={true}
        channelId="wechat"
        installed={true}
        running={true}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByTestId('icon-wechat')).toBeTruthy()
  })

  it('渠道为 qq 时显示 QQ 图标', () => {
    render(
      <ShareGuideDialog
        open={true}
        channelId="qq"
        installed={true}
        running={true}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByTestId('icon-qq')).toBeTruthy()
  })

  it('渠道为 vivo 时显示 vivo 图标', () => {
    render(
      <ShareGuideDialog
        open={true}
        channelId="vivo"
        installed={true}
        running={true}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByTestId('icon-vivo')).toBeTruthy()
  })
})
