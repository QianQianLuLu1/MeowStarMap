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
import { Readable } from 'node:stream'
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

import {
  registerMediaProtocol,
  invalidateMediaPathCache,
  isMediaPathAllowed
} from '../media-protocol'
import {
  clearNikkiSyncResourcePaths,
  registerNikkiSyncResourcePaths
} from '../../nikkisync/resource-allowlist'

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

  // 默认：access 通过，stat 返回 1KB 文件，createReadStream 返回真实空 Readable。
  // （createManagedReadStream 会对其挂 'error'/'close' 监听需要事件接口；2026-10-15 起
  //   响应体经 Readable.toWeb 适配进入 Response body，mock 必须是真实 Readable 才能被包装）
  fsAccessMock.mockResolvedValue(undefined)
  fsStatMock.mockResolvedValue({ size: 1024 })
  fsCreateReadStreamMock.mockImplementation(() => new Readable({ read() {} }))

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

  it('17b. 定向失效仅删除目标路径，无关路径继续命中缓存', async () => {
    const targetPath = path.resolve('/invalidate/target.jpg')
    const unrelatedPath = path.resolve('/invalidate/unrelated.jpg')
    const getMock = vi.fn(() => undefined)
    const db = {
      prepare: vi.fn(() => ({ get: getMock, all: vi.fn(() => []) }))
    }
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler

    await handler!(makeRequest(targetPath))
    await handler!(makeRequest(unrelatedPath))
    const callsAfterWarmup = getMock.mock.calls.length

    ;(invalidateMediaPathCache as unknown as (paths: string[]) => void)([targetPath])

    await handler!(makeRequest(unrelatedPath))
    expect(getMock.mock.calls.length).toBe(callsAfterWarmup)

    await handler!(makeRequest(targetPath))
    expect(getMock.mock.calls.length).toBeGreaterThan(callsAfterWarmup)
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

describe('media:// 第 4 条规则：NikkiSync 资源路径授权（阶段 4）', () => {
  /**
   * 图库切到 NikkiSync 数据源后，资产路径来自上游 `resources.source_path`，
   * 不在本 App 的 `media_files` 里。本组用例锁四件事：
   * ① 登记过的确切路径可示；② 同目录未登记的一律 403（不给目录级授权）；
   * ③ 扩展名白名单仍然生效（登记过也不放 .txt）；④ 本 App DB 未就绪不影响该规则
   * （两份库彼此独立，否则启动早期整屏裂图）。
   */
  function register(): NonNullable<typeof mediaHandler> {
    const ctx = makeAppCtx({ db: makeDb(() => undefined) })
    registerMediaProtocol(ctx)
    return protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler
  }

  beforeEach(() => {
    clearNikkiSyncResourcePaths()
    invalidateMediaPathCache()
  })

  it('25. 登记过的 NikkiSync 路径返回 200（DB 无任何匹配）', async () => {
    const target = `/mock/nikki/a.png`
    registerNikkiSyncResourcePaths(1, [target])
    const response = await register()(makeRequest(target))
    expect(response.status).toBe(200)
  })

  it('26. 同目录未登记的路径返回 403（精确匹配，不做前缀授权）', async () => {
    registerNikkiSyncResourcePaths(1, ['/mock/nikki/a.png'])
    const response = await register()(makeRequest('/mock/nikki/other.png'))
    expect(response.status).toBe(403)
  })

  it('27. 扩展名不在媒体白名单时，即便登记过也返回 403', async () => {
    registerNikkiSyncResourcePaths(1, ['/mock/nikki/notes.txt'])
    const response = await register()(makeRequest('/mock/nikki/notes.txt'))
    expect(response.status).toBe(403)
  })

  it('28. 本 App DB 为 null 时该规则仍生效（两份库彼此独立）', async () => {
    const target = '/mock/nikki/b.png'
    registerNikkiSyncResourcePaths(1, [target])
    const ctx = makeAppCtx({ db: null })
    registerMediaProtocol(ctx)
    const handler = protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler
    const response = await handler(makeRequest(target))
    expect(response.status).toBe(200)
  })

  it('29. realpath 逃逸：登记原路径而请求解引用到表外 ⇒ 403', async () => {
    registerNikkiSyncResourcePaths(1, ['/mock/nikki/link.png'])
    fsRealpathMock.mockImplementation(async () => 'C:/Windows/system.png')
    const response = await register()(makeRequest('/mock/nikki/link.png'))
    expect(response.status).toBe(403)
  })

  it('30. clear（Runtime 停止/未就绪）后同一律回落到 403', async () => {
    const target = '/mock/nikki/c.png'
    registerNikkiSyncResourcePaths(1, [target])
    clearNikkiSyncResourcePaths()
    const response = await register()(makeRequest(target))
    expect(response.status).toBe(403)
  })

  it('31. Windows 大小写差异不裂图：登记大写形式、请求小写形式仍命中', async () => {
    const upper = 'D:/mock/nikki/D.PNG'
    const lower = 'd:/mock/nikki/d.png'
    registerNikkiSyncResourcePaths(1, [upper])
    if (process.platform === 'win32') {
      const response = await register()(makeRequest(lower))
      expect(response.status).toBe(200)
    } else {
      // 非 Windows 保留大小写敏感：同一路径自身仍必须命中
      const response = await register()(makeRequest(upper))
      expect(response.status).toBe(200)
    }
  })
})

describe('阶段 5 · C1：读通道与展示通道同口径 —— isMediaPathAllowed 含 NikkiSync 资源规则', () => {
  /**
   * 阶段 4 只把第 4 条规则写进了协议 handler（`media-protocol.ts` 的 `registerMediaProtocol`），
   * 但 `assertMediaReadPath` / `assertMediaAccessPath` 走的是 `isMediaPathAllowed` 本身。
   * 于是「照片在图库能显示、`decrypt:decodeFile` 却报 IPC_PATH_FORBIDDEN」——
   * 穿搭/拍摄参数展示（阶段 5 C2/C3）与分享图取原图（B）都挡在这道闸上。
   * 本组用例把口径统一到 `isMediaPathAllowed`，并锁死「不放宽」的三条边界。
   */
  const ctxNoRows = () => makeAppCtx({ db: makeDb(() => undefined) })

  beforeEach(() => {
    clearNikkiSyncResourcePaths()
    invalidateMediaPathCache()
  })

  it('32. 登记过的 NikkiSync 路径 ⇒ isMediaPathAllowed true（读通道不再 403）', () => {
    const target = '/mock/nikki/a.png'
    registerNikkiSyncResourcePaths(1, [target])
    expect(isMediaPathAllowed(ctxNoRows(), target)).toBe(true)
  })

  it('33. 登记过但扩展名不在媒体白名单 ⇒ false（不放 .txt/.exe）', () => {
    registerNikkiSyncResourcePaths(1, ['/mock/nikki/notes.txt', '/mock/nikki/run.exe'])
    expect(isMediaPathAllowed(ctxNoRows(), '/mock/nikki/notes.txt')).toBe(false)
    expect(isMediaPathAllowed(ctxNoRows(), '/mock/nikki/run.exe')).toBe(false)
  })

  it('34. 未登记路径 ⇒ false（精确匹配，不给目录级授权）', () => {
    registerNikkiSyncResourcePaths(1, ['/mock/nikki/a.png'])
    expect(isMediaPathAllowed(ctxNoRows(), '/mock/nikki/other.png')).toBe(false)
  })

  it('35. 本 App DB 为 null 时规则仍生效（两份库彼此独立）', () => {
    const target = '/mock/nikki/b.png'
    registerNikkiSyncResourcePaths(1, [target])
    expect(isMediaPathAllowed(makeAppCtx({ db: null }), target)).toBe(true)
  })

  it('36. 授权表清空后一律拒绝，且否定结果不会被上一轮的判定残留', () => {
    const target = '/mock/nikki/c.png'
    registerNikkiSyncResourcePaths(1, [target])
    expect(isMediaPathAllowed(ctxNoRows(), target)).toBe(true)
    clearNikkiSyncResourcePaths()
    expect(isMediaPathAllowed(ctxNoRows(), target)).toBe(false)
  })

  it('37. Windows 大小写差异在读通道同样不裂：登记大写、判定小写 ⇒ true', () => {
    registerNikkiSyncResourcePaths(1, ['D:/mock/nikki/D.PNG'])
    if (process.platform === 'win32') {
      expect(isMediaPathAllowed(ctxNoRows(), 'd:/mock/nikki/d.png')).toBe(true)
    } else {
      expect(isMediaPathAllowed(ctxNoRows(), 'D:/mock/nikki/D.PNG')).toBe(true)
    }
  })
})

/**
 * 缺陷背景（2026-10-15 v2.5.3 线上启动闪退，docs/plans/2026-10-15-media-stream-cancel-race-fix.md）：
 * `new Response(fs.ReadStream)` 使 undici 以 ReadableStreamFrom 包装 Node 流，该包装的
 * pull 完成回调经微任务对 controller 执行 close 且无"流已关闭"守卫。渲染进程快速滚动/
 * 视频 Range 切换触发请求取消时，取消与迟到 close 竞态，抛
 * ERR_INVALID_STATE: ReadableStream is already closed（生产堆栈：
 * ReadableByteStreamController.close ← node:internal/deps/undici/undici ←
 * processTicksAndRejections），经 uncaughtException 一律致命策略升级为 app.exit(1)。
 *
 * 多进程 IPC 取消时序无法在单测中确定性触发（生产为概率竞态），因此 T1 直接断言
 * 缺陷机制本身：响应体的关闭路径不得经过 undici 的 Node 流适配层；T2-T4 以敌对
 * 交错护栏锁定替换路径（Readable.toWeb）的消费/取消/终止行为。
 */
describe('media:// 响应体流安全（2026-10-15 启动闪退修复）', () => {
  /** 用真实 Readable 代替 dummy 流：携带 Symbol.asyncIterator，使 Response 走 undici 的 Node 流包装路径 */
  function makeRealStream(data: Buffer[]): InstanceType<typeof Readable> {
    return new Readable({
      read() {
        while (data.length > 0) this.push(data.shift())
        this.push(null)
      }
    })
  }

  /** 捕获 ReadableByteStreamController 原型（undici 对 Node 流的包装使用该控制器） */
  function getByteControllerProto(): Record<string, unknown> {
    let proto: Record<string, unknown> | null = null
    new ReadableStream({
      type: 'bytes',
      start(c) {
        proto = Object.getPrototypeOf(c) as Record<string, unknown>
      }
    })
    return proto as Record<string, unknown>
  }

  /** 注册协议并捕获 handler（白名单走 file_path 精确命中，与既有用例 12/13 同款） */
  function setupHandler(): NonNullable<typeof mediaHandler> {
    const targetPath = path.resolve('/videos/race.mp4')
    const db = makeDb((sql, param) => {
      if (sql.includes('file_path') && param === targetPath) return { 1: 1 }
      return undefined
    })
    const ctx = makeAppCtx({ db })
    registerMediaProtocol(ctx)
    return protocolHandleMock.mock.calls[
      protocolHandleMock.mock.calls.length - 1
    ][1] as typeof mediaHandler
  }

  it('T1【缺陷复现】响应体的 controller.close 不得经由 undici 适配层调用', async () => {
    fsStatMock.mockResolvedValue({ size: 10000 })
    fsCreateReadStreamMock.mockImplementation(() => makeRealStream([Buffer.alloc(1024, 1)]))
    const handler = setupHandler()

    const proto = getByteControllerProto()
    const origClose = proto.close as (...args: unknown[]) => unknown
    const closeCallers: string[] = []
    proto.close = function (this: unknown, ...args: unknown[]) {
      closeCallers.push(new Error().stack ?? '')
      return origClose.apply(this, args)
    }
    try {
      const response = await handler(makeRequest(path.resolve('/videos/race.mp4'), 'bytes=0-1023'))
      expect(response.status).toBe(206)
      // 消费响应体到自然结束（Electron 侧 Readable.fromWeb 泵送的等价物）
      const reader = response.body!.getReader()
      let bytes = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
      }
      expect(bytes).toBe(1024)
      // 核心断言：所有 close 调用不得来自 undici 内部。
      // 修复前：close 由 node:internal/deps/undici 的无守卫微任务调用（生产 24.18 在
      // undici:1583、本机 Node 26 在 undici:1965，行号随版本漂移，故只匹配模块名）→ 红灯
      for (const caller of closeCallers) {
        expect(caller).not.toContain('node:internal/deps/undici')
      }
    } finally {
      proto.close = origClose
    }
  })

  it('T2【护栏·正常】206 与 200 分支响应体可完整消费，字节数与 mock 数据一致', async () => {
    // 模拟真实 fs.createReadStream 语义：按 {start,end} 切片返回
    const full = Buffer.concat([Buffer.alloc(1024, 7), Buffer.alloc(1024, 8)])
    fsStatMock.mockResolvedValue({ size: full.length })
    fsCreateReadStreamMock.mockImplementation(
      (_p: string, opts?: { start?: number; end?: number }) => {
        const start = opts?.start ?? 0
        const end = opts?.end ?? full.length - 1
        return makeRealStream([full.subarray(start, end + 1)])
      }
    )
    const handler = setupHandler()

    // 206 分支（Range 0-1023 → 1024 字节）
    const r206 = await handler(makeRequest(path.resolve('/videos/race.mp4'), 'bytes=0-1023'))
    expect(r206.status).toBe(206)
    const reader206 = r206.body!.getReader()
    let bytes206 = 0
    for (;;) {
      const { done, value } = await reader206.read()
      if (done) break
      bytes206 += value.byteLength
    }
    expect(bytes206).toBe(1024)

    // 200 分支（完整文件 2048 字节）
    const r200 = await handler(makeRequest(path.resolve('/videos/race.mp4')))
    expect(r200.status).toBe(200)
    const reader200 = r200.body!.getReader()
    let bytes200 = 0
    for (;;) {
      const { done, value } = await reader200.read()
      if (done) break
      bytes200 += value.byteLength
    }
    expect(bytes200).toBe(2048)
  })

  it('T3【护栏·异常】在途消费时 cancel 与流销毁任意交错不产生逃逸异常', async () => {
    fsStatMock.mockResolvedValue({ size: 10000 })
    const srcStreams: InstanceType<typeof Readable>[] = []
    fsCreateReadStreamMock.mockImplementation(() => {
      // 慢速流：首块后挂起，模拟磁盘 IO 窗口（生产竞态的必要条件）
      const s = new Readable({ read() {} })
      s.push(Buffer.alloc(1024, 3))
      srcStreams.push(s)
      return s
    })
    const handler = setupHandler()

    const uncaught: unknown[] = []
    const onUncaught = (e: unknown): void => {
      uncaught.push(e)
    }
    process.on('uncaughtException', onUncaught)
    try {
      // 敌对交错 A：消费者先 cancel（Chromium 取消请求），流随后销毁（request.signal abort）。
      // cancel 与 Electron 网络层一致采用 fire-and-forget（主进程不等待取消完成）
      const responseA = await handler(makeRequest(path.resolve('/videos/race.mp4'), 'bytes=0-9999'))
      const readerA = responseA.body!.getReader()
      await readerA.read()
      const pendingA = readerA.read()
      await new Promise((r) => setTimeout(r, 5))
      readerA.cancel().catch(() => {})
      srcStreams[0].destroy()
      await pendingA.catch(() => {})

      // 敌对交错 B：流先销毁，消费者后 cancel
      const responseB = await handler(makeRequest(path.resolve('/videos/race.mp4'), 'bytes=0-9999'))
      const readerB = responseB.body!.getReader()
      await readerB.read()
      const pendingB = readerB.read()
      await new Promise((r) => setTimeout(r, 5))
      srcStreams[1].destroy()
      readerB.cancel().catch(() => {})
      await pendingB.catch(() => {})

      await new Promise((r) => setTimeout(r, 50))
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })

  it('T4【护栏·边界】空文件响应体立即结束，重复 cancel 幂等', async () => {
    fsStatMock.mockResolvedValue({ size: 0 })
    fsCreateReadStreamMock.mockImplementation(() => makeRealStream([]))
    const handler = setupHandler()

    const response = await handler(makeRequest(path.resolve('/videos/race.mp4')))
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const { done } = await reader.read()
    expect(done).toBe(true)
    await reader.cancel()
    await reader.cancel()
  })
})
