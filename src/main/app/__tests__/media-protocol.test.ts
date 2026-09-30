/**
 * @layer L2
 * @module src/main/app/media-protocol
 * @coverage registerMediaProtocol / invalidateMediaPathCache + 私有 isMediaPathAllowed / getCachedSourcePaths
 * @dependencies electron (protocol)、fs、utils/media-constants（真实）、utils/constants（真实）
 *
 * 难点：
 * 1. 私有 isMediaPathAllowed / getCachedSourcePaths 通过 protocol.handle 注册的 handler 间接测试
 * 2. 模块级单例 mediaPathCache / mediaSourcePathCache 跨用例共享
 *    → beforeEach 调用 invalidateMediaPathCache() 清空
 * 3. handler 是 async + 多分支（视频/图片 + Range/无 Range）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import { makeAppCtx } from '../../ipc/handlers/_test-helpers'

// 共享 mock：protocol 句柄
const { protocolUnhandleMock, protocolHandleMock } = vi.hoisted(() => ({
  protocolUnhandleMock: vi.fn(),
  protocolHandleMock: vi.fn()
}))

vi.mock('electron', () => ({
  protocol: {
    unhandle: protocolUnhandleMock,
    handle: protocolHandleMock
  }
}))

// 被测模块经 logger 写日志会触发 electron.app.getPath（logger.ts:133），
// 且本文件 mock 了 fs 只保留 access/stat/createReadStream，真实 logger 的
// fs.promises.appendFile 不可用；统一 mock logger 隔离 electron/fs 依赖
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

// fs mock：access/stat/createReadStream/constants.R_OK 全部可控
const { fsAccessMock, fsStatMock, fsCreateReadStreamMock, fsRealpathMock } = vi.hoisted(() => ({
  fsAccessMock: vi.fn(),
  fsStatMock: vi.fn(),
  fsCreateReadStreamMock: vi.fn(),
  // resolveRealPath 调 fs.promises.realpath 解引用符号链接，默认恒等返回（测试路径都是已解析路径）
  fsRealpathMock: vi.fn((p: string) => p)
}))

vi.mock('fs', () => ({
  default: {
    promises: {
      access: fsAccessMock,
      stat: fsStatMock,
      realpath: fsRealpathMock
    },
    createReadStream: fsCreateReadStreamMock,
    constants: { R_OK: 4, W_OK: 2 }
  },
  promises: {
    access: fsAccessMock,
    stat: fsStatMock,
    realpath: fsRealpathMock
  },
  createReadStream: fsCreateReadStreamMock,
  constants: { R_OK: 4, W_OK: 2 }
}))

import { registerMediaProtocol, invalidateMediaPathCache } from '../media-protocol'

// 捕获 protocol.handle 注册的 handler
let mediaHandler:
  | ((request: {
      url: string
      headers: { get: (n: string) => string | null }
    }) => Promise<Response>)
  | null = null

// 构造 mock 请求
function makeRequest(
  urlPath: string,
  range?: string,
  ifNoneMatch?: string
): {
  url: string
  headers: { get: (n: string) => string | null }
} {
  return {
    url: `media://x?path=${encodeURIComponent(urlPath)}`,
    headers: {
      get: (name: string): string | null => {
        const lower = name.toLowerCase()
        if (lower === 'range') return range ?? null
        if (lower === 'if-none-match') return ifNoneMatch ?? null
        return null
      }
    }
  }
}

// 构造 mock DB：prepare(sql) 返回 { get: (p) => row }
function makeDb(getImpl: (sql: string, param: string) => unknown): {
  prepare: ReturnType<typeof vi.fn>
} {
  return {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn((param: string) => getImpl(sql, param)),
      all: vi.fn(() => [])
    }))
  }
}

beforeEach(() => {
  protocolUnhandleMock.mockReset()
  protocolHandleMock.mockReset()
  fsAccessMock.mockReset()
  fsStatMock.mockReset()
  fsCreateReadStreamMock.mockReset()
  fsRealpathMock.mockReset()
  fsRealpathMock.mockImplementation(async (p: string) => p)

  // 默认：access 通过，stat 返回 1KB 文件，createReadStream 返回带 on/once 监听接口的 dummy stream
  // （createManagedReadStream 会对其挂 'error' / 'close' 监听，mock 须提供这些方法）
  fsAccessMock.mockResolvedValue(undefined)
  fsStatMock.mockResolvedValue({ size: 1024 })
  const dummyStream = {
    destroyed: false,
    on: vi.fn(function (this: unknown) {
      return this
    }),
    once: vi.fn(function (this: unknown) {
      return this
    }),
    destroy: vi.fn()
  }
  fsCreateReadStreamMock.mockReturnValue(dummyStream as unknown as NodeJS.ReadStream)

  // 清空模块级单例缓存
  invalidateMediaPathCache()

  // 捕获 handler
  mediaHandler = null
  protocolHandleMock.mockImplementation((_scheme, handler) => {
    mediaHandler = handler
  })

  registerMediaProtocol(makeAppCtx())
})

describe('registerMediaProtocol', () => {
  it('1. 先 unhandle("media") 再 handle("media", fn)', () => {
    expect(protocolUnhandleMock).toHaveBeenCalledTimes(1)
    expect(protocolUnhandleMock).toHaveBeenCalledWith('media')
    expect(protocolHandleMock).toHaveBeenCalledTimes(1)
    expect(protocolHandleMock).toHaveBeenCalledWith('media', expect.any(Function))
  })

  it('2. unhandle 抛错时被吞掉（不向上传播）', async () => {
    // 重新注册：unhandle 抛错也应正常完成
    protocolUnhandleMock.mockReset()
    protocolUnhandleMock.mockImplementation(() => {
      throw new Error('unhandle failed')
    })
    protocolHandleMock.mockReset()

    expect(() => registerMediaProtocol(makeAppCtx())).not.toThrow()
    expect(protocolHandleMock).toHaveBeenCalledTimes(1)
  })

  it('3. 请求 URL 缺少 path 参数返回 400', async () => {
    const response = await mediaHandler!({
      url: 'media://x',
      headers: { get: () => null }
    })
    expect(response.status).toBe(400)
  })

  it('4. 路径在白名单外返回 403（DB 无任何匹配）', async () => {
    // DB 全部返回 undefined
    const db = makeDb(() => undefined)
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    // 重新捕获 handler
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    const response = await handler!(makeRequest('/unknown/path/file.jpg'))
    expect(response.status).toBe(403)
  })

  it('5. getDatabase() 返回 null 时直接返回 403', async () => {
    const ctx = makeAppCtx({ db: null })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    const response = await handler!(makeRequest('/any/path/file.jpg'))
    expect(response.status).toBe(403)
  })

  it('6. 缩略图目录下的文件允许访问（返回 200）', async () => {
    // thumbnailGen.getCacheDir 默认返回 '/mock/cache'（makeAppCtx stub）
    // 路径以 /mock/cache + path.sep 开头 → allowed=true
    const cacheDir = '/mock/cache'
    const ctx = makeAppCtx({
      thumbnailGen: { getCacheDir: vi.fn(() => cacheDir), generate: vi.fn() }
    })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    const response = await handler!(makeRequest(`${cacheDir}${path.sep}thumb_001.jpg`))
    expect(response.status).toBe(200)
  })

  it('7. file_path 精确命中数据库记录允许访问', async () => {
    const targetPath = path.resolve('/indexed/photo.jpg')
    const db = makeDb((sql, param) => {
      if (sql.includes('file_path') && param === targetPath) return { 1: 1 }
      return undefined
    })
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    const response = await handler!(makeRequest(targetPath))
    expect(response.status).toBe(200)
  })

  it('8. thumbnail 精确命中允许访问（file_path 未命中）', async () => {
    const targetPath = path.resolve('/thumbnails/thumb_002.jpg')
    const db = makeDb((sql, param) => {
      if (sql.includes('thumbnail') && param === targetPath) return { 1: 1 }
      return undefined
    })
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    const response = await handler!(makeRequest(targetPath))
    expect(response.status).toBe(200)
  })

  it('FIX(组6-1): 文件名含 % 的已索引文件不被二次解码（原路径命中白名单）', async () => {
    // 修复前：searchParams 已解码一次，再 decodeURIComponent 会把 '100%20photos.jpg'
    // 二次解码成 '100 photos.jpg' → 白名单未命中 403（图库裂图）
    const targetPath = path.resolve('/indexed/100%20photos.jpg')
    const db = makeDb((sql, param) => {
      if (sql.includes('file_path') && param === targetPath) return { 1: 1 }
      return undefined
    })
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    const response = await handler!(makeRequest(targetPath))
    expect(response.status).toBe(200)
  })

  it('FIX(组6-1): 文件名含非法转义序列（如 50%off.png）不再抛 URIError 500', async () => {
    // 修复前：decodeURIComponent('50%off.png') 因 '%of' 非法十六进制抛 URIError → 500
    const targetPath = path.resolve('/indexed/50%off.png')
    const db = makeDb((sql, param) => {
      if (sql.includes('file_path') && param === targetPath) return { 1: 1 }
      return undefined
    })
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    const response = await handler!(makeRequest(targetPath))
    expect(response.status).toBe(200)
  })

  it('9. source_path 目录下、扩展名在白名单内允许访问', async () => {
    const sourcePath = '/game/photos'
    const targetPath = path.resolve(`${sourcePath}/sub/photo.jpg`)
    // DB：file_path/thumbnail 未命中，source_path 列表返回 sourcePath
    const db = {
      prepare: vi.fn((sql: string) => ({
        get: vi.fn(() => undefined),
        all: vi.fn(() => {
          if (sql.includes('DISTINCT source_path')) {
            return [{ source_path: sourcePath }]
          }
          return []
        })
      }))
    }
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    const response = await handler!(makeRequest(targetPath))
    expect(response.status).toBe(200)
  })

  it('10. source_path 目录下、扩展名不在白名单内拒绝（.txt 文件）', async () => {
    const sourcePath = '/game/photos'
    const targetPath = path.resolve(`${sourcePath}/sub/secret.txt`)
    const db = {
      prepare: vi.fn((sql: string) => ({
        get: vi.fn(() => undefined),
        all: vi.fn(() => {
          if (sql.includes('DISTINCT source_path')) {
            return [{ source_path: sourcePath }]
          }
          return []
        })
      }))
    }
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    const response = await handler!(makeRequest(targetPath))
    expect(response.status).toBe(403)
  })

  it('11. 文件不存在返回 404（isMediaPathAllowed 通过但 access 抛错）', async () => {
    const targetPath = path.resolve('/indexed/missing.jpg')
    const db = makeDb((sql, param) => {
      if (sql.includes('file_path') && param === targetPath) return { 1: 1 }
      return undefined
    })
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    fsAccessMock.mockRejectedValue(new Error('ENOENT'))

    const response = await handler!(makeRequest(targetPath))
    expect(response.status).toBe(404)
  })

  it('12. 视频文件带 Range 头返回 206 + Content-Range', async () => {
    const targetPath = path.resolve('/videos/clip.mp4')
    const db = makeDb((sql, param) => {
      if (sql.includes('file_path') && param === targetPath) return { 1: 1 }
      return undefined
    })
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    fsStatMock.mockResolvedValue({ size: 10000 })

    const response = await handler!(makeRequest(targetPath, 'bytes=0-1023'))
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 0-1023/10000')
    expect(response.headers.get('Content-Length')).toBe('1024')
    // CORS 放行：media:// 相对 app://renderer 页面为跨源，canvas 消费需要该头
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    // createReadStream 经由 createManagedReadStream 调用，range 作为第二个参数传入
    expect(fsCreateReadStreamMock).toHaveBeenCalledWith(targetPath, { start: 0, end: 1023 })
  })

  it('13. 视频文件无 Range 头返回 200 + 完整流', async () => {
    const targetPath = path.resolve('/videos/full.mp4')
    const db = makeDb((sql, param) => {
      if (sql.includes('file_path') && param === targetPath) return { 1: 1 }
      return undefined
    })
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    fsStatMock.mockResolvedValue({ size: 5000 })

    const response = await handler!(makeRequest(targetPath))
    // 默认 status 200（Response 构造未传 status 时为 200）
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe('5000')
    // CORS 放行：media:// 相对 app://renderer 页面为跨源，canvas 消费需要该头
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    // 无 Range：createReadStream 仍经由 createManagedReadStream 调用，第二参数为空 options
    expect(fsCreateReadStreamMock).toHaveBeenCalledWith(targetPath, {})
  })

  it('14. 图片文件带 Range 头返回 206', async () => {
    const targetPath = path.resolve('/images/pic.jpg')
    const db = makeDb((sql, param) => {
      if (sql.includes('file_path') && param === targetPath) return { 1: 1 }
      return undefined
    })
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    fsStatMock.mockResolvedValue({ size: 2048 })

    const response = await handler!(makeRequest(targetPath, 'bytes=512-'))
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe(`bytes 512-2047/2048`)
    expect(fsCreateReadStreamMock).toHaveBeenCalledWith(targetPath, { start: 512, end: 2047 })
  })

  it('15b. Range 起点越界返回 416 + Content-Range: bytes */size（不返回负数 Content-Length）', async () => {
    const targetPath = path.resolve('/videos/clip.mp4')
    const db = makeDb((sql, param) => {
      if (sql.includes('file_path') && param === targetPath) return { 1: 1 }
      return undefined
    })
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    fsStatMock.mockResolvedValue({ size: 10000 })

    const response = await handler!(makeRequest(targetPath, 'bytes=10000-20000'))
    expect(response.status).toBe(416)
    expect(response.headers.get('Content-Range')).toBe('bytes */10000')
    expect(response.headers.get('Content-Length')).toBeNull()
    // 越界不应创建任何读流
    expect(fsCreateReadStreamMock).not.toHaveBeenCalled()
  })

  it('15. 路径缓存命中时跳过 DB 查询', async () => {
    const targetPath = path.resolve('/cached/photo.jpg')
    const getMock = vi.fn(() => undefined)
    const db = {
      prepare: vi.fn(() => ({ get: getMock, all: vi.fn(() => []) }))
    }
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    // 第一次请求：触发 DB 查询
    await handler!(makeRequest(targetPath))
    const callsAfterFirst = getMock.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    // 第二次请求：缓存命中，不应再触发 DB 查询
    await handler!(makeRequest(targetPath))
    expect(getMock.mock.calls.length).toBe(callsAfterFirst)
  })

  it('16. 缓存满 1000 条时 LRU 淘汰最早 key', async () => {
    const getMock = vi.fn(() => undefined)
    const db = {
      prepare: vi.fn(() => ({ get: getMock, all: vi.fn(() => []) }))
    }
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    // 生成 1001 个唯一路径，全部 DB 未命中 → 全部缓存为 not-allowed
    const paths: string[] = []
    for (let i = 0; i < 1001; i++) {
      paths.push(path.resolve(`/mock/source/file_${i}.jpg`))
    }
    for (const p of paths) {
      await handler!(makeRequest(p))
    }

    // path[0] 是最早插入的，应在第 1001 次插入时被淘汰
    const callsBefore = getMock.mock.calls.length
    // 重新请求 path[0]：若 LRU 淘汰生效，应再次触发 DB 查询
    await handler!(makeRequest(paths[0]))
    const callsAfter = getMock.mock.calls.length

    // 缓存未命中时应触发 2 次 DB 查询（file_path + thumbnail）
    expect(callsAfter - callsBefore).toBeGreaterThan(0)
  })

  it('17. invalidateMediaPathCache 清空两个缓存（重新请求触发 DB 查询）', async () => {
    const targetPath = path.resolve('/invalidate/test.jpg')
    const getMock = vi.fn(() => undefined)
    const db = {
      prepare: vi.fn(() => ({ get: getMock, all: vi.fn(() => []) }))
    }
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    // 第一次请求：触发 DB 查询
    await handler!(makeRequest(targetPath))
    const callsAfterFirst = getMock.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    // 第二次请求：缓存命中，无新查询
    await handler!(makeRequest(targetPath))
    expect(getMock.mock.calls.length).toBe(callsAfterFirst)

    // 清空缓存后再次请求：应再次触发 DB 查询
    invalidateMediaPathCache()
    await handler!(makeRequest(targetPath))
    expect(getMock.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })

  it('18. handler 内部抛错返回 500（fs.stat 抛非 access 错误）', async () => {
    const targetPath = path.resolve('/error/case.jpg')
    const db = makeDb((sql, param) => {
      if (sql.includes('file_path') && param === targetPath) return { 1: 1 }
      return undefined
    })
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    // access 通过，但 stat 抛错（非 access 错误）
    fsAccessMock.mockResolvedValue(undefined)
    fsStatMock.mockRejectedValue(new Error('stat internal error'))

    const response = await handler!(makeRequest(targetPath))
    expect(response.status).toBe(500)
  })
})

/**
 * 缩略图协商缓存（ETag/304）——fix-thumbnail-loading-latency 节点1 + N7 放宽。
 *
 * 背景：media:// 对缩略图响应原为一年强缓存（max-age=31536000）且无内容指纹，
 * 白帧自愈/重生成就地覆盖同名 ${hash}.jpg 后 URL 不变，渲染层持续命中旧字节。
 * 修复：缩略图缓存目录内的响应改为 ETag（mtime+size）协商缓存，
 * 命中 If-None-Match 回 304；原图/视频/Range 206 分支保持原样。
 * N7：max-age 0 → 300——缩略图按内容 hash 命名、URL 基本不变，5 分钟内同一 URL
 * 直接命中本地缓存，消除滚动/广播期间每张可见卡回主进程 stat+ETag 的往返；
 * 代价是自愈重建同名文件后浏览器最长 5 分钟才看到新字节（用户已确认接受）。
 */
describe('缩略图协商缓存（ETag/304）', () => {
  /** 注册并捕获 handler，stat 返回带 mtimeMs 的 mock 值 */
  async function setup(
    statValue: Record<string, unknown> = { size: 4096, mtimeMs: 1700000000000 }
  ) {
    const cacheDir = '/mock/cache'
    const ctx = makeAppCtx({
      thumbnailGen: { getCacheDir: vi.fn(() => cacheDir), generate: vi.fn() }
    })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler
    fsStatMock.mockResolvedValue(statValue as unknown as { size: number })
    return { handler: handler!, thumbPath: `${cacheDir}${path.sep}abc123.jpg` }
  }

  it('19. 缩略图 200 响应带 ETag 与 max-age=300 协商缓存头', async () => {
    const { handler, thumbPath } = await setup()
    const response = await handler(makeRequest(thumbPath))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300, must-revalidate')
    const etag = response.headers.get('ETag')
    expect(etag).toBeTruthy()
    expect(etag).toMatch(/^W\//) // 弱校验器（mtime+size，非内容哈希）
  })

  it('20. 二次请求 If-None-Match 匹配当前 ETag → 304（不创建读流）', async () => {
    const { handler, thumbPath } = await setup()
    const first = await handler(makeRequest(thumbPath))
    const etag = first.headers.get('ETag')
    expect(etag).toBeTruthy()

    fsCreateReadStreamMock.mockClear()
    const second = await handler(makeRequest(thumbPath, undefined, etag!))
    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')
    expect(second.headers.get('Cache-Control')).toBe('public, max-age=300, must-revalidate')
    // 304 不应读文件流（零 IO，stat 已有）
    expect(fsCreateReadStreamMock).not.toHaveBeenCalled()
  })

  it('21. If-None-Match 不匹配 → 200（fail-open）', async () => {
    const { handler, thumbPath } = await setup()
    const response = await handler(makeRequest(thumbPath, undefined, 'W/"deadbeef-beef"'))
    expect(response.status).toBe(200)
    expect(response.headers.get('ETag')).toBeTruthy()
  })

  it('22. stat 缺少 mtimeMs 时不抛错，ETag 兜底生成', async () => {
    const { handler, thumbPath } = await setup({ size: 4096 })
    const response = await handler(makeRequest(thumbPath))
    expect(response.status).toBe(200)
    expect(response.headers.get('ETag')).toBeTruthy()
  })

  it('23. 回归守卫：非缩略图路径保持一年强缓存且无 ETag', async () => {
    const targetPath = path.resolve('/indexed/photo.jpg')
    const db = makeDb((sql, param) => {
      if (sql.includes('file_path') && param === targetPath) return { 1: 1 }
      return undefined
    })
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler
    fsStatMock.mockResolvedValue({ size: 5000, mtimeMs: 1700000000000 })

    const response = await handler(makeRequest(targetPath))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000')
    expect(response.headers.get('ETag')).toBeNull()
  })

  it('24. 回归守卫：缩略图带 Range 头仍走 206 分支（原头不变）', async () => {
    const { handler, thumbPath } = await setup({ size: 10000, mtimeMs: 1700000000000 })
    const response = await handler(makeRequest(thumbPath, 'bytes=0-1023'))
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 0-1023/10000')
    // 206 分支保持原强缓存头（缩略图 <img> 请求不会携带 Range）
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000')
  })
})
