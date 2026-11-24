import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { GlobalToastContext } from '../common/ToastProvider'
import { GONGEO_SITE_URL } from '../../utils/external-links'
import { ResonanceGateDialog } from './ResonanceGateDialog'

/**
 * 共鸣录身份门弹窗测试：mock electronAPI.shell.openExternal（tests/setup.ts 已
 * 初始化 i18n 为 zh-CN，断言直接写中文文案）；错误场景经 GlobalToastContext.Provider
 * 注入 showMessage mock 断言（范式对齐 about-sections.test.tsx）。
 */

describe('ResonanceGateDialog 身份门弹窗', () => {
  let openExternalMock: Mock<() => Promise<{ opened: boolean }>>
  let onContinue: Mock<() => void>

  beforeEach(() => {
    openExternalMock = vi.fn(() => Promise.resolve({ opened: true }))
    onContinue = vi.fn<() => void>()
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      shell: { openExternal: openExternalMock }
    }
  })
  afterEach(() => {
    cleanup()
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  function renderGate(): void {
    render(<ResonanceGateDialog open={true} onContinue={onContinue} />)
  }

  it('渲染身份门：主标题、含目标站点的副标题与两个操作按钮', () => {
    renderGate()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('共鸣录暂停更新')).toBeTruthy()
    expect(screen.getByText(/gongeo\.us/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '仍要继续' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '跳转网页' })).toBeTruthy()
  })

  it('aria-modal 为 true 且 aria-labelledby 指向主标题', () => {
    renderGate()
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const labelledBy = dialog.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy as string)?.textContent).toBe('共鸣录暂停更新')
  })

  it('点击「仍要继续」触发 onContinue 且不外跳', () => {
    renderGate()
    fireEvent.click(screen.getByRole('button', { name: '仍要继续' }))
    expect(onContinue).toHaveBeenCalledTimes(1)
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('点击「跳转网页」以目标 URL 调用系统浏览器且不关闭弹窗', () => {
    renderGate()
    fireEvent.click(screen.getByRole('button', { name: '跳转网页' }))
    expect(openExternalMock).toHaveBeenCalledTimes(1)
    expect(openExternalMock).toHaveBeenCalledWith(GONGEO_SITE_URL)
    expect(openExternalMock).toHaveBeenCalledWith('https://gongeo.us')
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('openExternal 失败时经全局 Toast 报错、弹窗保持且不触发 onContinue', async () => {
    openExternalMock.mockRejectedValueOnce(new Error('shell unavailable'))
    const showMessageMock = vi.fn()
    render(
      <GlobalToastContext.Provider value={showMessageMock}>
        <ResonanceGateDialog open={true} onContinue={onContinue} />
      </GlobalToastContext.Provider>
    )
    fireEvent.click(screen.getByRole('button', { name: '跳转网页' }))
    await waitFor(() => expect(showMessageMock).toHaveBeenCalled())
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('electronAPI 缺失时点击「跳转网页」守卫兜底不抛错', () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    renderGate()
    expect(() => fireEvent.click(screen.getByRole('button', { name: '跳转网页' }))).not.toThrow()
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('点击遮罩不关闭身份门（closeOnOverlayClick=false）', () => {
    renderGate()
    fireEvent.click(screen.getByRole('dialog'))
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('open=false 时不渲染弹窗', () => {
    render(<ResonanceGateDialog open={false} onContinue={onContinue} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('遮罩为局部绝对定位（不覆盖整个应用窗口）', () => {
    renderGate()
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('absolute')
    expect(dialog.className).not.toContain('fixed')
  })
})
