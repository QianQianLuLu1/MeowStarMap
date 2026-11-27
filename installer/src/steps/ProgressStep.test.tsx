import { act, render } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProgressStep from './ProgressStep'

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  cancelInstall: vi.fn(),
  getInstallLog: vi.fn(),
  getInstallProgress: vi.fn()
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('../api', () => ({
  cancelInstall: mocks.cancelInstall,
  getInstallLog: mocks.getInstallLog,
  getInstallProgress: mocks.getInstallProgress
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('ProgressStep', () => {
  it('卸载后才完成的监听注册必须立即反注册，不能泄漏', async () => {
    vi.useFakeTimers()
    let resolveListen: ((unlisten: () => void) => void) | undefined
    const unlisten = vi.fn()
    mocks.listen.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveListen = resolve
      })
    )
    mocks.getInstallProgress.mockResolvedValue({ percent: 0, message: '准备安装' })
    mocks.getInstallLog.mockResolvedValue([])

    const view = render(<ProgressStep />)
    view.unmount()

    await act(async () => {
      resolveListen?.(unlisten)
      await Promise.resolve()
    })

    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('进入文件替换提交点后必须禁用取消并说明不可逆', async () => {
    vi.useFakeTimers()
    mocks.listen.mockResolvedValue(vi.fn())
    mocks.getInstallProgress.mockResolvedValue({
      percent: 92,
      message: '文件替换完成',
      cancellable: false
    })
    mocks.getInstallLog.mockResolvedValue([])

    const view = render(<ProgressStep />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    expect(view.getByRole('button', { name: '取消安装' })).toBeDisabled()
    expect(view.getByText(/不可逆/)).toBeInTheDocument()
  })
})
