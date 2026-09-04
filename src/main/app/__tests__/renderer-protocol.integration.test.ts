/**
 * @layer L2
 * @module src/main/app/renderer-protocol
 * @coverage 真实文件 I/O 集成用例：handler 经真实 fs.readFile 读取磁盘上的
 *           index.html，返回 200 + 正确 Content-Type(text/html) + 正确 Content-Length + 字节一致。
 *
 * 设计说明：
 * - 本用例不做 fs/electron 的完整 mock，仅用 vi.mock 提供 protocol.handle / app.isReady 的桩，
 *   真实文件系统（fs.readFile / fs.existsSync）保持原生，以验证 path.join + normalize +
 *   decodeURIComponent + asar 安全读取 的完整链路。
 * - 通过 WXNN_RENDERER_DIR 环境变量把 RENDERER_DIR 指向一个临时目录（生产不使用该变量），
 *   在其中写入真实 index.html 后调用 handler，校验响应。
 * - 不污染源码树：临时目录在 os.tmpdir() 下，用例结束后清理。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const protocolHandleMock = vi.fn()
const appIsReadyMock = vi.fn()

vi.mock('electron', () => ({
  protocol: { handle: protocolHandleMock },
  app: { isReady: appIsReadyMock }
}))
// 注意：不 mock 'node:fs'，保留真实文件 I/O
vi.mock('../../utils/startup-diagnostic', () => ({
  diagLog: vi.fn(),
  logStartupError: vi.fn()
}))

let tmpDir: string

function writeFixture(name: string, content: string): string {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, content, 'utf8')
  return p
}

describe('renderer-protocol integration (真实文件 I/O)', () => {
  beforeEach(() => {
    vi.resetModules()
    protocolHandleMock.mockReset()
    appIsReadyMock.mockReset()
    // 每个用例新建独立临时渲染目录
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-renderer-int-'))
    process.env.WXNN_RENDERER_DIR = tmpDir
  })

  afterAll(() => {
    // 清理所有本用例创建的临时目录
    delete process.env.WXNN_RENDERER_DIR
  })

  it('真实 index.html 经 handler 返回 200 + text/html + 正确 Content-Length + 字节一致', async () => {
    appIsReadyMock.mockReturnValue(true)
    const html = '<!doctype html><html><head><title>WXNN</title></head><body>ok</body></html>'
    writeFixture('index.html', html)

    const { registerRendererProtocol } = await import('../renderer-protocol')
    registerRendererProtocol()

    const handler = protocolHandleMock.mock.calls[0]?.[1]
    expect(typeof handler).toBe('function')

    const response = await handler({ url: 'app://renderer/index.html' })
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('Content-Length')).toBe(String(Buffer.byteLength(html)))

    const body = Buffer.from(await response.arrayBuffer())
    expect(body.toString('utf8')).toBe(html)
  })

  it('真实子目录资源（assets/app.js）经 handler 返回 200 + text/javascript + 正确长度', async () => {
    appIsReadyMock.mockReturnValue(true)
    writeFixture('index.html', '<!doctype html>')
    const jsDir = path.join(tmpDir, 'assets')
    fs.mkdirSync(jsDir, { recursive: true })
    const js = 'console.log("hello");'
    fs.writeFileSync(path.join(jsDir, 'app.js'), js, 'utf8')

    const { registerRendererProtocol } = await import('../renderer-protocol')
    registerRendererProtocol()

    const handler = protocolHandleMock.mock.calls[0]?.[1]
    const response = await handler({ url: 'app://renderer/assets/app.js' })
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/javascript')
    expect(response.headers.get('Content-Length')).toBe(String(Buffer.byteLength(js)))
    expect(Buffer.from(await response.arrayBuffer()).toString('utf8')).toBe(js)
  })

  it('真实缺失文件经 handler 返回 404（真实 fs.existsSync 判真）', async () => {
    appIsReadyMock.mockReturnValue(true)
    // 不写入该文件
    const { registerRendererProtocol } = await import('../renderer-protocol')
    registerRendererProtocol()

    const handler = protocolHandleMock.mock.calls[0]?.[1]
    const response = await handler({ url: 'app://renderer/nope.html' })
    expect(response.status).toBe(404)
  })

  it('URL 编码后的真实子路径（%2F -> 子目录）仍能正确命中文件', async () => {
    appIsReadyMock.mockReturnValue(true)
    const dir = path.join(tmpDir, 'sub')
    fs.mkdirSync(dir, { recursive: true })
    const html = '<h1>sub</h1>'
    fs.writeFileSync(path.join(dir, 'page.html'), html, 'utf8')

    const { registerRendererProtocol } = await import('../renderer-protocol')
    registerRendererProtocol()

    const handler = protocolHandleMock.mock.calls[0]?.[1]
    // decodeURIComponent 把 %2F 还原为 /，得到 /sub/page.html
    const response = await handler({ url: 'app://renderer/sub%2Fpage.html' })
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer()).toString('utf8')).toBe(html)
  })
})
