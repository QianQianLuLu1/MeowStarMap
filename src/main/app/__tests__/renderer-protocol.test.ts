/**
 * @layer L2
 * @module src/main/app/renderer-protocol
 * @coverage registerRendererProtocol + handler 七种场景
 * @dependencies electron (protocol, app)、fs、path
 *
 * 设计说明：
 * - 使用 beforeEach 中 vi.resetModules() 清除模块缓存，确保每个用例获得
 *   全新的模块实例（registered=false）。
 * - 每个用例在动态 import 之后立即调用 registerRendererProtocol 并捕获 handler。
 * - 协议实现为 fs.readFile + Response（显式 Content-Type/Content-Length），
 *   不使用 net.fetch：fs 是官方明确支持 asar 的 Node API。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// 共享 mock - 用 vi.hoisted 保证在 vi.mock 提升前创建
const { protocolHandleMock, appIsReadyMock, fsExistsSyncMock, fsReadFileMock } = vi.hoisted(() => ({
  protocolHandleMock: vi.fn(),
  appIsReadyMock: vi.fn(),
  fsExistsSyncMock: vi.fn(),
  fsReadFileMock: vi.fn()
}))

vi.mock('electron', () => ({
  protocol: {
    handle: protocolHandleMock
  },
  app: {
    isReady: appIsReadyMock
  }
}))

vi.mock('node:fs', () => ({
  default: {
    existsSync: fsExistsSyncMock,
    promises: { readFile: fsReadFileMock }
  },
  existsSync: fsExistsSyncMock,
  promises: { readFile: fsReadFileMock }
}))

vi.mock('../../utils/startup-diagnostic', () => ({
  diagLog: vi.fn(),
  logStartupError: vi.fn()
}))

function makeAppRequest(urlPath: string): { url: string } {
  return { url: `app://renderer${urlPath}` }
}

describe('registerRendererProtocol', () => {
  beforeEach(() => {
    vi.resetModules()
    protocolHandleMock.mockReset()
    appIsReadyMock.mockReset()
    fsExistsSyncMock.mockReset()
    fsReadFileMock.mockReset()
  })

  it('1. app 就绪后注册成功 -> protocol.handle 被调用 1 次，scheme 为 app，处理器为 function', async () => {
    appIsReadyMock.mockReturnValue(true)
    const { registerRendererProtocol } = await import('../renderer-protocol')
    registerRendererProtocol()

    expect(protocolHandleMock).toHaveBeenCalledTimes(1)
    expect(protocolHandleMock).toHaveBeenCalledWith('app', expect.any(Function))
  })

  it('2. app 未就绪不注册且不置位 -> 再次（就绪后）调用能成功注册', async () => {
    appIsReadyMock.mockReturnValue(false)
    const { registerRendererProtocol } = await import('../renderer-protocol')
    registerRendererProtocol()
    // 未就绪时不应调用 protocol.handle
    expect(protocolHandleMock).toHaveBeenCalledTimes(0)

    // 再次调用，现在 app 就绪了
    appIsReadyMock.mockReturnValue(true)
    registerRendererProtocol()
    // 就绪后应能正常注册
    expect(protocolHandleMock).toHaveBeenCalledTimes(1)
    expect(protocolHandleMock).toHaveBeenCalledWith('app', expect.any(Function))
  })

  it('3. 正常文档请求走 fs.readFile -> 返回 200 + Content-Type + Content-Length', async () => {
    appIsReadyMock.mockReturnValue(true)
    fsExistsSyncMock.mockReturnValue(true)
    const html = '<!doctype html><html></html>'
    fsReadFileMock.mockResolvedValue(Buffer.from(html))

    const { registerRendererProtocol } = await import('../renderer-protocol')
    registerRendererProtocol()

    const handler = protocolHandleMock.mock.calls[0]?.[1]
    expect(handler).toBeDefined()

    const response = await handler(makeAppRequest('/index.html'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('Content-Length')).toBe(String(Buffer.byteLength(html)))
    const body = new Uint8Array(await response.arrayBuffer())
    expect(Buffer.from(body).toString('utf8')).toBe(html)
    expect(fsReadFileMock).toHaveBeenCalledTimes(1)
  })

  it('4. 缺失文件 404 -> 不调用 fs.readFile', async () => {
    appIsReadyMock.mockReturnValue(true)
    fsExistsSyncMock.mockReturnValue(false)

    const { registerRendererProtocol } = await import('../renderer-protocol')
    registerRendererProtocol()

    const handler = protocolHandleMock.mock.calls[0]?.[1]
    expect(handler).toBeDefined()

    const response = await handler(makeAppRequest('/missing.html'))
    expect(response.status).toBe(404)
    expect(fsReadFileMock).not.toHaveBeenCalled()
  })

  it('5. 目录穿越 403 -> 不调用 fs.existsSync / fs.readFile', async () => {
    appIsReadyMock.mockReturnValue(true)

    const { registerRendererProtocol } = await import('../renderer-protocol')
    registerRendererProtocol()

    const handler = protocolHandleMock.mock.calls[0]?.[1]
    expect(handler).toBeDefined()

    // 使用 %2f 编码的斜杠来绕过 URL 解析器的自动归一化
    // decodeURIComponent 后得到 /../outside，path.normalize 后超出 RENDERER_DIR
    const response = await handler(makeAppRequest('/..%2foutside'))
    expect(response.status).toBe(403)
    expect(fsExistsSyncMock).not.toHaveBeenCalled()
    expect(fsReadFileMock).not.toHaveBeenCalled()
  })

  it('6. fs.readFile 抛错兜底 -> handler 不 throw，返回 404', async () => {
    appIsReadyMock.mockReturnValue(true)
    fsExistsSyncMock.mockReturnValue(true)
    fsReadFileMock.mockRejectedValue(new Error('ENOENT: no such file'))

    const { registerRendererProtocol } = await import('../renderer-protocol')
    registerRendererProtocol()

    const handler = protocolHandleMock.mock.calls[0]?.[1]
    expect(handler).toBeDefined()

    // 直接调用 handler，验证它不抛异常并返回 404
    const response = await handler(makeAppRequest('/index.html'))
    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(404)
  })

  it('7. 非法 % 转义不抛 -> 返回合法 Response(404)', async () => {
    appIsReadyMock.mockReturnValue(true)

    const { registerRendererProtocol } = await import('../renderer-protocol')
    registerRendererProtocol()

    const handler = protocolHandleMock.mock.calls[0]?.[1]
    expect(handler).toBeDefined()

    // 非法 % 转义在 decodeURIComponent 抛 URIError，由 catch 兜底为 404
    const response = await handler(makeAppRequest('/50%off.js'))
    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(404)
  })
})
