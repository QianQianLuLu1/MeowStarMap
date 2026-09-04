/**
 * @layer L1
 * @module src/main/app/navigation-guard
 * @coverage isAppDocumentUrl / guardNavigation
 * @dependencies mock: ../utils/logger (logFault)
 *
 * 背景：preload 是 webContents 级 webPreferences，对窗口加载的任何文档都会执行。
 * 历史白名单放行 file:// 与任意 http://localhost 端口，等于把完整 IPC 桥
 * （window.electronAPI）授予本地 evil.html 或本机任意进程起的 HTTP 服务。
 * 本模块是收口后的授信判定：file:// 一律拒绝，http://localhost 仅 dev 且限 5173 端口。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { guardNavigation, isAppDocumentUrl } from '../navigation-guard'

const { logFaultMock } = vi.hoisted(() => ({
  logFaultMock: vi.fn()
}))

vi.mock('../../utils/logger', () => ({
  logFault: logFaultMock
}))

beforeEach(() => {
  logFaultMock.mockReset()
  logFaultMock.mockResolvedValue(undefined)
})

describe('isAppDocumentUrl', () => {
  const trustedAlways = [
    'app://renderer/index.html',
    'app://renderer',
    'media://file?path=C%3A%2Fa.jpg',
    'media://file'
  ]

  const neverTrusted = [
    // 本地文件：历史白名单放行的头号泄露面
    'file:///C:/Users/me/Downloads/evil.html',
    'file://',
    // 外站
    'https://example.com',
    'http://example.com',
    // 非 5173 端口的 localhost（恶意软件 / 被劫持的 dev server）
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    // 前缀欺骗：startsWith('http://localhost') 会把这些一并放行
    'http://localhost:5173.evil.com',
    'http://localhost5173.example',
    // 空值
    ''
  ]

  it.each(trustedAlways)('1. 生产与 dev 均放行应用自身协议: %s', (url) => {
    expect(isAppDocumentUrl(url, false)).toBe(true)
    expect(isAppDocumentUrl(url, true)).toBe(true)
  })

  it.each(neverTrusted)('2. 生产一律拒绝: %s', (url) => {
    expect(isAppDocumentUrl(url, false)).toBe(false)
  })

  it.each(neverTrusted)('3. dev 同样拒绝（file:// 与外站无 dev 豁免）: %s', (url) => {
    expect(isAppDocumentUrl(url, true)).toBe(false)
  })

  it('4. dev server 地址仅在 dev 放行（限 5173 端口的 localhost/127.0.0.1）', () => {
    for (const url of [
      'http://localhost:5173',
      'http://localhost:5173/',
      'http://127.0.0.1:5173'
    ]) {
      expect(isAppDocumentUrl(url, true)).toBe(true)
      expect(isAppDocumentUrl(url, false)).toBe(false)
    }
  })

  it('5. dev 下带路径/查询的 dev server URL 仍放行（HMR 全量刷新）', () => {
    expect(isAppDocumentUrl('http://localhost:5173/index.html?v=1', true)).toBe(true)
  })
})

describe('guardNavigation', () => {
  function makeEvent(): { preventDefault: ReturnType<typeof vi.fn> } {
    return { preventDefault: vi.fn() }
  }

  it('1. 授信 URL：放行且不 preventDefault、不记故障', () => {
    const event = makeEvent()
    const allowed = guardNavigation(event, 'app://renderer/index.html', {
      source: 'will-navigate',
      isDev: false
    })

    expect(allowed).toBe(true)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(logFaultMock).not.toHaveBeenCalled()
  })

  it('2. 越权 URL：preventDefault + 写 navigation-blocked 故障（含 source 与 url）', () => {
    const event = makeEvent()
    const url = 'file:///C:/Users/me/Downloads/evil.html'
    const allowed = guardNavigation(event, url, { source: 'will-navigate', isDev: false })

    expect(allowed).toBe(false)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(logFaultMock).toHaveBeenCalledWith(
      'navigation-blocked',
      expect.any(Error),
      expect.objectContaining({ source: 'will-navigate', url })
    )
  })

  it('3. 子帧来源在故障上下文里可区分（will-frame-navigate）', () => {
    const event = makeEvent()
    guardNavigation(event, 'file:///evil.html', {
      source: 'will-frame-navigate',
      isDev: false
    })

    expect(logFaultMock).toHaveBeenCalledWith(
      'navigation-blocked',
      expect.any(Error),
      expect.objectContaining({ source: 'will-frame-navigate' })
    )
  })

  it('4. logFault 返回的 promise 被 catch（不产生未处理拒绝）', () => {
    logFaultMock.mockRejectedValueOnce(new Error('disk full'))
    const event = makeEvent()

    expect(() =>
      guardNavigation(event, 'http://localhost:8080', { source: 'will-navigate', isDev: false })
    ).not.toThrow()
    expect(logFaultMock).toHaveBeenCalledTimes(1)
  })
})
