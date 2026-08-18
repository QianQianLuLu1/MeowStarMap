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
      if (opts && opts.port) return `${key}:${opts.port}`
      return key
    }
  })
}))

vi.mock('../../icons', () => ({
  IconClose: (p: any) => <svg data-testid="icon-close" {...p} />,
  IconRefresh: (p: any) => <svg data-testid="icon-refresh" {...p} />
}))

vi.mock('../../pages/settings/shared', () => ({
  useGlobalToast: () => vi.fn()
}))

import { WifiShareDialog } from './WifiShareDialog'

describe('WifiShareDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('open=false 时不渲染', () => {
    const { container } = render(
      <WifiShareDialog open={false} filePaths={['/x.jpg']} onClose={vi.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('open=true 时渲染对话框', () => {
    const startWifi = vi.fn().mockResolvedValue({
      success: true,
      url: 'http://1.2.3.4:8080',
      port: 8080,
      fileCount: 1,
      timeoutMs: 60000
    })
    ;(window as any).electronAPI = { share: { startWifi, stopWifi: vi.fn() } }

    render(<WifiShareDialog open={true} filePaths={['/x.jpg']} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('filePaths 为空时不调用 startWifi', async () => {
    const startWifi = vi.fn()
    ;(window as any).electronAPI = { share: { startWifi, stopWifi: vi.fn() } }

    render(<WifiShareDialog open={true} filePaths={[]} onClose={vi.fn()} />)
    await act(async () => {
      // 让 useEffect 触发的异步 startShare 走完
      await Promise.resolve()
    })
    expect(startWifi).not.toHaveBeenCalled()
  })

  it('startWifi 不存在时不报错', async () => {
    ;(window as any).electronAPI = { share: {} }

    await act(async () => {
      expect(() => {
        render(<WifiShareDialog open={true} filePaths={['/x.jpg']} onClose={vi.fn()} />)
      }).not.toThrow()
    })
  })

  it('启动成功后渲染访问地址', async () => {
    const startWifi = vi.fn().mockResolvedValue({
      success: true,
      url: 'http://1.2.3.4:8080',
      port: 8080,
      fileCount: 5,
      timeoutMs: 60000
    })
    ;(window as any).electronAPI = { share: { startWifi, stopWifi: vi.fn() } }

    render(<WifiShareDialog open={true} filePaths={['/x.jpg']} onClose={vi.fn()} />)
    expect(await screen.findByText('http://1.2.3.4:8080')).toBeTruthy()
  })

  it('启动成功后渲染 PIN 码', async () => {
    const startWifi = vi.fn().mockResolvedValue({
      success: true,
      url: 'http://1.2.3.4:8080',
      port: 8080,
      pin: '123456',
      fileCount: 1,
      timeoutMs: 60000
    })
    ;(window as any).electronAPI = { share: { startWifi, stopWifi: vi.fn() } }

    render(<WifiShareDialog open={true} filePaths={['/x.jpg']} onClose={vi.fn()} />)
    expect(await screen.findByText('123456')).toBeTruthy()
  })

  it('启动失败时不渲染访问地址', async () => {
    const startWifi = vi.fn().mockResolvedValue({
      success: false,
      message: '端口占用'
    })
    ;(window as any).electronAPI = { share: { startWifi, stopWifi: vi.fn() } }

    render(<WifiShareDialog open={true} filePaths={['/x.jpg']} onClose={vi.fn()} />)
    await act(async () => {
      await vi.waitFor(() => expect(startWifi).toHaveBeenCalled())
    })
    expect(screen.queryByText('http://1.2.3.4:8080')).toBeNull()
  })

  it('点击停止按钮调用 stopWifi', async () => {
    const stopWifi = vi.fn().mockResolvedValue(undefined)
    const startWifi = vi.fn().mockResolvedValue({
      success: true,
      url: 'http://1.2.3.4:8080',
      port: 8080,
      fileCount: 1,
      timeoutMs: 60000
    })
    ;(window as any).electronAPI = { share: { startWifi, stopWifi } }

    render(<WifiShareDialog open={true} filePaths={['/x.jpg']} onClose={vi.fn()} />)
    await screen.findByText('http://1.2.3.4:8080')
    fireEvent.click(screen.getByText('share.wifi.stop'))
    await act(async () => {
      await vi.waitFor(() => expect(stopWifi).toHaveBeenCalled())
    })
  })

  it('点击复制 URL 按钮调用 clipboard.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true
    })
    const startWifi = vi.fn().mockResolvedValue({
      success: true,
      url: 'http://example.com/x',
      port: 8080,
      fileCount: 1,
      timeoutMs: 60000
    })
    ;(window as any).electronAPI = { share: { startWifi, stopWifi: vi.fn() } }

    render(<WifiShareDialog open={true} filePaths={['/x.jpg']} onClose={vi.fn()} />)
    await screen.findByText('http://example.com/x')
    fireEvent.click(screen.getByText('share.wifi.copyUrl'))
    await act(async () => {
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('http://example.com/x'))
    })
  })

  it('点击关闭按钮触发 onClose', async () => {
    const onClose = vi.fn()
    const startWifi = vi.fn().mockResolvedValue({
      success: true,
      url: 'http://1.2.3.4:8080',
      port: 8080,
      fileCount: 1,
      timeoutMs: 60000
    })
    const stopWifi = vi.fn().mockResolvedValue(undefined)
    ;(window as any).electronAPI = { share: { startWifi, stopWifi } }

    render(<WifiShareDialog open={true} filePaths={['/x.jpg']} onClose={onClose} />)
    await screen.findByText('http://1.2.3.4:8080')
    fireEvent.click(screen.getByTestId('icon-close').closest('button')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('倒计时归零后清空会话', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const startWifi = vi.fn().mockResolvedValue({
      success: true,
      url: 'http://1.2.3.4:8080',
      port: 8080,
      fileCount: 1,
      timeoutMs: 1000 // 1 秒超时
    })
    const stopWifi = vi.fn().mockResolvedValue(undefined)
    ;(window as any).electronAPI = { share: { startWifi, stopWifi } }

    render(<WifiShareDialog open={true} filePaths={['/x.jpg']} onClose={vi.fn()} />)
    // 等待 Promise 解析
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.getByText('share.wifi.stopped')).toBeTruthy()
    vi.useRealTimers()
  })

  it('渲染标题', async () => {
    const startWifi = vi.fn().mockResolvedValue({
      success: true,
      url: 'http://1.2.3.4:8080',
      port: 8080,
      fileCount: 1,
      timeoutMs: 60000
    })
    ;(window as any).electronAPI = { share: { startWifi, stopWifi: vi.fn() } }

    render(<WifiShareDialog open={true} filePaths={['/x.jpg']} onClose={vi.fn()} />)
    expect(screen.getByText('share.wifi.title')).toBeTruthy()
  })
})
