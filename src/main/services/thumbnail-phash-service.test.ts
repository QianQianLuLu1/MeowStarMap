import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * @layer L2
 * @module src/main/services/thumbnail-phash-service
 * @coverage processThumbnailForRow / generateThumbnailsForUnprocessed /
 *           generatePhashForUnprocessed / markDuplicates
 * @dependencies sharp, phash, HandlerContext(ctx)
 * @remarks Mock sharp/calculatePHash；构造伪 ctx 对象（含 thumbnailGen/mediaWorkerManager/taskScheduler）
 */

// ============================================================
// Mock 声明（hoisted）
// ============================================================

// sharp mock：返回带 metadata 的链式调用
vi.mock('sharp', () => {
  const sharpFactory = vi.fn((_filePath: string) => ({
    metadata: vi.fn().mockResolvedValue({ width: 1920, height: 1080 })
  }))
  return { default: sharpFactory }
})

vi.mock('../utils/phash', () => ({
  calculatePHash: vi.fn()
}))

// logger mock：隔离被测实现写日志时的 electron.app.getPath 依赖（logger.ts:133）
const loggerMocks = vi.hoisted(() => ({
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  logFaultMock: vi.fn(),
  getLogDirectoryMock: vi.fn(() => '/mock/logs')
}))

vi.mock('../utils/logger', () => ({
  logger: {
    info: loggerMocks.loggerInfoMock,
    warn: loggerMocks.loggerWarnMock,
    error: loggerMocks.loggerErrorMock,
    debug: loggerMocks.loggerDebugMock
  },
  logFault: loggerMocks.logFaultMock,
  getLogDirectory: loggerMocks.getLogDirectoryMock
}))

// ============================================================
// Import after mock
// ============================================================
import sharp from 'sharp'
import { calculatePHash } from '../utils/phash'
import {
  processThumbnailForRow,
  generateThumbnailsForUnprocessed,
  generatePhashForUnprocessed,
  markDuplicates
} from './thumbnail-phash-service'
import type { HandlerContext } from '../ipc/handler-context'

// ============================================================
// Helpers
// ============================================================

interface CtxOverrides {
  generateThumbnail?: (filePath: string) => Promise<string | null>
  isThumbnailsGenerating?: () => boolean
  setThumbnailsGenerating?: (v: boolean) => void
}

function makeCtx(overrides: CtxOverrides = {}): HandlerContext {
  const mockMainWindow = {
    webContents: { send: vi.fn() }
  }
  // 最外层 as unknown as HandlerContext 兜底强转，内部字段直接写对象字面量
  return {
    dbManager: {},
    scannerManager: {},
    mediaWorkerManager: {
      startThumbnailBatch: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
      stopThumbnailBatch: vi.fn(),
      startPhashBatch: vi
        .fn()
        .mockResolvedValue({ success: true, processed: 5, total: 10, message: 'ok' }),
      stopPhashBatch: vi.fn(),
      startDuplicateMark: vi
        .fn()
        .mockResolvedValue({ success: true, markedDuplicates: 3, totalGroups: 2, message: 'ok' }),
      stopDuplicateMark: vi.fn()
    },
    taskScheduler: {
      runHighPriority: vi.fn(async (task: () => Promise<void>) => await task()),
      enqueueLow: vi.fn(async (task: () => Promise<void>) => await task())
    },
    thumbnailGen: {
      generate: overrides.generateThumbnail || vi.fn().mockResolvedValue('/cache/thumb.jpg'),
      getCacheDir: vi.fn().mockReturnValue('/cache/thumbnails')
    },
    fileService: {},
    videoService: {},
    watermarkService: {},
    getMainWindow: vi.fn(() => mockMainWindow),
    notifyMediaUpdated: vi.fn(),
    invalidateMediaPathCache: vi.fn(),
    applyUITheme: vi.fn(),
    isThumbnailsGenerating: overrides.isThumbnailsGenerating || vi.fn(() => false),
    setThumbnailsGenerating: overrides.setThumbnailsGenerating || vi.fn()
  } as unknown as HandlerContext
}

// 从被测函数签名提取 updateStmt 参数类型（better-sqlite3 的 Statement）
type SqlStmt = Parameters<typeof processThumbnailForRow>[2]

function makeUpdateStmt(): {
  run: ReturnType<typeof vi.fn>
  _calls: Array<{ args: unknown[] }>
} {
  const _calls: Array<{ args: unknown[] }> = []
  return {
    run: vi.fn((...args: unknown[]) => {
      _calls.push({ args })
    }),
    _calls
  }
}

let tmpRoot: string
let imagePath: string
let videoPath: string

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(sharp).mockReturnValue({
    metadata: vi.fn().mockResolvedValue({ width: 1920, height: 1080 })
  } as unknown as ReturnType<typeof sharp>)
  vi.mocked(calculatePHash).mockResolvedValue('phash-abcdef')

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-phash-'))
  imagePath = path.join(tmpRoot, 'photo.jpg')
  fs.writeFileSync(imagePath, Buffer.from('fake-image'))
  videoPath = path.join(tmpRoot, 'video.mp4')
  fs.writeFileSync(videoPath, Buffer.from('fake-video'))
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

// ============================================================
// describe: processThumbnailForRow
// ============================================================

describe('processThumbnailForRow', () => {
  it('image 类型：并行 sharp.metadata + thumbnailGen.generate + calculatePHash 并调用 updateStmt.run', async () => {
    const ctx = makeCtx()
    const stmt = makeUpdateStmt()

    // 源码使用 updateStmt.run(...)，因此应传入 stmt 对象本身而非 stmt.run
    const r = await processThumbnailForRow(
      ctx,
      { id: 1, file_path: imagePath, file_type: 'image' },
      stmt as unknown as SqlStmt
    )

    expect(r).toBe(true)
    expect(sharp).toHaveBeenCalledWith(imagePath)
    expect(ctx.thumbnailGen.generate).toHaveBeenCalledWith(imagePath)
    expect(calculatePHash).toHaveBeenCalledWith(imagePath)
    expect(stmt.run).toHaveBeenCalledWith(1920, 1080, '/cache/thumb.jpg', 'phash-abcdef', 1)
  })

  it('image 类型：sharp.metadata 抛错时 metadata=null 但仍正常处理（catch 兜底）', async () => {
    vi.mocked(sharp).mockReturnValue({
      metadata: vi.fn().mockRejectedValue(new Error('decode failed'))
    } as unknown as ReturnType<typeof sharp>)
    const ctx = makeCtx()
    const stmt = makeUpdateStmt()

    const r = await processThumbnailForRow(
      ctx,
      { id: 2, file_path: imagePath, file_type: 'image' },
      stmt as unknown as SqlStmt
    )

    expect(r).toBe(true)
    expect(stmt.run).toHaveBeenCalledWith(null, null, '/cache/thumb.jpg', 'phash-abcdef', 2)
  })

  it('image 类型：thumbnailGen.generate 返回 null 时 thumbnailPath=null', async () => {
    const ctx = makeCtx({ generateThumbnail: vi.fn().mockResolvedValue(null) })
    const stmt = makeUpdateStmt()

    const r = await processThumbnailForRow(
      ctx,
      { id: 3, file_path: imagePath, file_type: 'image' },
      stmt as unknown as SqlStmt
    )

    expect(r).toBe(true)
    expect(stmt.run).toHaveBeenCalledWith(1920, 1080, null, 'phash-abcdef', 3)
  })

  it('video 类型：仅调用 thumbnailGen.generate，不计算 phash', async () => {
    const ctx = makeCtx()
    const stmt = makeUpdateStmt()

    const r = await processThumbnailForRow(
      ctx,
      { id: 4, file_path: videoPath, file_type: 'video' },
      stmt as unknown as SqlStmt
    )

    expect(r).toBe(true)
    expect(ctx.thumbnailGen.generate).toHaveBeenCalledWith(videoPath)
    expect(calculatePHash).not.toHaveBeenCalled()
    expect(stmt.run).toHaveBeenCalledWith(null, null, '/cache/thumb.jpg', null, 4)
  })

  it('video 类型：thumbnailGen.generate 抛错时返回 false', async () => {
    const ctx = makeCtx({
      generateThumbnail: vi.fn().mockRejectedValue(new Error('ffmpeg failed'))
    })
    const stmt = makeUpdateStmt()

    const r = await processThumbnailForRow(
      ctx,
      { id: 5, file_path: videoPath, file_type: 'video' },
      stmt as unknown as SqlStmt
    )

    expect(r).toBe(false)
    expect(stmt.run).not.toHaveBeenCalled()
  })

  it('未知 file_type：updateStmt.run 以 null 参数调用并返回 true', async () => {
    const ctx = makeCtx()
    const stmt = makeUpdateStmt()

    const r = await processThumbnailForRow(
      ctx,
      { id: 6, file_path: imagePath, file_type: 'unknown' },
      stmt as unknown as SqlStmt
    )

    expect(r).toBe(true)
    expect(ctx.thumbnailGen.generate).not.toHaveBeenCalled()
    expect(calculatePHash).not.toHaveBeenCalled()
    expect(stmt.run).toHaveBeenCalledWith(null, null, null, null, 6)
  })

  it('image 类型：calculatePHash 抛错时整个 try 失败，返回 false', async () => {
    vi.mocked(calculatePHash).mockRejectedValue(new Error('phash failed'))
    const ctx = makeCtx()
    const stmt = makeUpdateStmt()

    const r = await processThumbnailForRow(
      ctx,
      { id: 7, file_path: imagePath, file_type: 'image' },
      stmt as unknown as SqlStmt
    )

    expect(r).toBe(false)
    expect(stmt.run).not.toHaveBeenCalled()
  })
})

// ============================================================
// describe: generateThumbnailsForUnprocessed
// ============================================================

describe('generateThumbnailsForUnprocessed', () => {
  it('priority=high：调用 taskScheduler.runHighPriority + mediaWorkerManager.startThumbnailBatch', async () => {
    const ctx = makeCtx()

    await generateThumbnailsForUnprocessed(ctx, 'high')

    expect(ctx.taskScheduler.runHighPriority).toHaveBeenCalled()
    expect(ctx.mediaWorkerManager.startThumbnailBatch).toHaveBeenCalledWith({
      cacheDir: '/cache/thumbnails',
      thumbnailQuality: 'standard'
    })
  })

  it('priority=low：调用 taskScheduler.enqueueLow', async () => {
    const ctx = makeCtx()

    await generateThumbnailsForUnprocessed(ctx, 'low')

    expect(ctx.taskScheduler.enqueueLow).toHaveBeenCalled()
    expect(ctx.taskScheduler.runHighPriority).not.toHaveBeenCalled()
  })

  it('成功路径：发送 media:updated 事件给主窗口', async () => {
    const ctx = makeCtx()

    await generateThumbnailsForUnprocessed(ctx, 'high')

    expect(ctx.getMainWindow).toHaveBeenCalled()
  })

  it('worker 返回 success=false + 取消消息时不发送错误日志也不抛错', async () => {
    const ctx = makeCtx()
    vi.mocked(ctx.mediaWorkerManager.startThumbnailBatch).mockResolvedValue({
      success: false,
      message: '用户取消'
    } as never)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(generateThumbnailsForUnprocessed(ctx, 'high')).resolves.toBeUndefined()

    expect(consoleSpy).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('worker 返回 success=false + 已在进行中消息时不发送错误日志', async () => {
    const ctx = makeCtx()
    vi.mocked(ctx.mediaWorkerManager.startThumbnailBatch).mockResolvedValue({
      success: false,
      message: '已在进行中'
    } as never)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(generateThumbnailsForUnprocessed(ctx, 'high')).resolves.toBeUndefined()

    expect(consoleSpy).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('worker 返回 success=false + 其他错误消息时输出 logger.error', async () => {
    const ctx = makeCtx()
    vi.mocked(ctx.mediaWorkerManager.startThumbnailBatch).mockResolvedValue({
      success: false,
      message: 'batch failed'
    } as never)

    await generateThumbnailsForUnprocessed(ctx, 'high')

    expect(loggerMocks.loggerErrorMock).toHaveBeenCalledWith(
      '[Thumbnail] 批量生成失败:',
      'batch failed'
    )
  })

  it('互斥锁：isThumbnailsGenerating=true 时直接 return 不启动 batch', async () => {
    const ctx = makeCtx({ isThumbnailsGenerating: () => true })

    await generateThumbnailsForUnprocessed(ctx, 'high')

    expect(ctx.mediaWorkerManager.startThumbnailBatch).not.toHaveBeenCalled()
  })

  it('finally 块：成功后释放互斥锁 setThumbnailsGenerating(false)', async () => {
    const ctx = makeCtx()
    const setSpy = vi.mocked(ctx.setThumbnailsGenerating)

    await generateThumbnailsForUnprocessed(ctx, 'high')

    expect(setSpy).toHaveBeenCalledWith(true)
    expect(setSpy).toHaveBeenCalledWith(false)
  })

  it('finally 块：失败后也释放互斥锁', async () => {
    const ctx = makeCtx()
    vi.mocked(ctx.mediaWorkerManager.startThumbnailBatch).mockRejectedValue(new Error('crashed'))
    const setSpy = vi.mocked(ctx.setThumbnailsGenerating)

    // 源码 finally 释放锁后错误仍向上抛，这里只关心锁是否被释放
    await generateThumbnailsForUnprocessed(ctx, 'high').catch(() => {})

    expect(setSpy).toHaveBeenCalledWith(true)
    expect(setSpy).toHaveBeenCalledWith(false)
  })

  it('priority=low：enqueueLow 被调用时传入 cancel 函数', async () => {
    const ctx = makeCtx()
    const enqueueSpy = vi.mocked(ctx.taskScheduler.enqueueLow)

    await generateThumbnailsForUnprocessed(ctx, 'low')

    expect(enqueueSpy).toHaveBeenCalled()
    const args = enqueueSpy.mock.calls[0]
    expect(args[1]).toHaveProperty('id', 'thumbnail-batch')
    expect(typeof args[1].cancel).toBe('function')
  })
})

// ============================================================
// describe: generatePhashForUnprocessed
// ============================================================

describe('generatePhashForUnprocessed', () => {
  it('priority=high：成功时返回 {processed, total} 来自 worker', async () => {
    const ctx = makeCtx()

    const r = await generatePhashForUnprocessed(ctx, 'high')

    expect(r).toEqual({ processed: 5, total: 10 })
    expect(ctx.taskScheduler.runHighPriority).toHaveBeenCalled()
    expect(ctx.mediaWorkerManager.startPhashBatch).toHaveBeenCalled()
  })

  it('priority=low：使用 enqueueLow 调度', async () => {
    const ctx = makeCtx()

    await generatePhashForUnprocessed(ctx, 'low')

    expect(ctx.taskScheduler.enqueueLow).toHaveBeenCalled()
    expect(ctx.taskScheduler.runHighPriority).not.toHaveBeenCalled()
  })

  it('默认 priority 为 high', async () => {
    const ctx = makeCtx()

    await generatePhashForUnprocessed(ctx)

    expect(ctx.taskScheduler.runHighPriority).toHaveBeenCalled()
  })

  it('worker 返回 success=false + 取消消息时返回 {0,0} 不报错', async () => {
    const ctx = makeCtx()
    vi.mocked(ctx.mediaWorkerManager.startPhashBatch).mockResolvedValue({
      success: false,
      message: '用户取消'
    } as never)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const r = await generatePhashForUnprocessed(ctx, 'high')

    expect(r).toEqual({ processed: 0, total: 0 })
    expect(consoleSpy).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('worker 返回 success=false + 其他错误时输出 logger.error 并返回 {0,0}', async () => {
    const ctx = makeCtx()
    vi.mocked(ctx.mediaWorkerManager.startPhashBatch).mockResolvedValue({
      success: false,
      message: 'worker crashed'
    } as never)

    const r = await generatePhashForUnprocessed(ctx, 'high')

    expect(r).toEqual({ processed: 0, total: 0 })
    expect(loggerMocks.loggerErrorMock).toHaveBeenCalledWith('[pHash] 补算失败:', 'worker crashed')
  })

  it('worker 抛出异常时输出 logger.error 并返回 {0,0}', async () => {
    const ctx = makeCtx()
    vi.mocked(ctx.mediaWorkerManager.startPhashBatch).mockRejectedValue(new Error('boom'))

    const r = await generatePhashForUnprocessed(ctx, 'high')

    expect(r).toEqual({ processed: 0, total: 0 })
    expect(loggerMocks.loggerErrorMock).toHaveBeenCalledWith('[pHash] 补算失败:', expect.any(Error))
  })

  it('priority=low：enqueueLow 被调用时传入 phash-batch id 与 cancel 函数', async () => {
    const ctx = makeCtx()
    const enqueueSpy = vi.mocked(ctx.taskScheduler.enqueueLow)

    await generatePhashForUnprocessed(ctx, 'low')

    expect(enqueueSpy).toHaveBeenCalled()
    const args = enqueueSpy.mock.calls[0]
    expect(args[1]).toHaveProperty('id', 'phash-batch')
    expect(typeof args[1].cancel).toBe('function')
  })
})

// ============================================================
// describe: markDuplicates
// ============================================================

describe('markDuplicates', () => {
  it('priority=high：成功时返回 {markedDuplicates, totalGroups} 来自 worker', async () => {
    const ctx = makeCtx()

    const r = await markDuplicates(ctx, 'high')

    expect(r).toEqual({ markedDuplicates: 3, totalGroups: 2 })
    expect(ctx.taskScheduler.runHighPriority).toHaveBeenCalled()
    expect(ctx.mediaWorkerManager.startDuplicateMark).toHaveBeenCalled()
  })

  it('priority=low：使用 enqueueLow 调度', async () => {
    const ctx = makeCtx()

    await markDuplicates(ctx, 'low')

    expect(ctx.taskScheduler.enqueueLow).toHaveBeenCalled()
    expect(ctx.taskScheduler.runHighPriority).not.toHaveBeenCalled()
  })

  it('默认 priority 为 high', async () => {
    const ctx = makeCtx()

    await markDuplicates(ctx)

    expect(ctx.taskScheduler.runHighPriority).toHaveBeenCalled()
  })

  it('worker 返回 success=false + 取消消息时返回 {0,0}', async () => {
    const ctx = makeCtx()
    vi.mocked(ctx.mediaWorkerManager.startDuplicateMark).mockResolvedValue({
      success: false,
      message: '用户取消'
    } as never)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const r = await markDuplicates(ctx, 'high')

    expect(r).toEqual({ markedDuplicates: 0, totalGroups: 0 })
    expect(consoleSpy).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('worker 返回 success=false + 其他错误时输出 logger.error 并返回 {0,0}', async () => {
    const ctx = makeCtx()
    vi.mocked(ctx.mediaWorkerManager.startDuplicateMark).mockResolvedValue({
      success: false,
      message: 'db locked'
    } as never)

    const r = await markDuplicates(ctx, 'high')

    expect(r).toEqual({ markedDuplicates: 0, totalGroups: 0 })
    expect(loggerMocks.loggerErrorMock).toHaveBeenCalledWith('[Duplicate] 标记失败:', 'db locked')
  })

  it('worker 抛出异常时输出 logger.error 并返回 {0,0}', async () => {
    const ctx = makeCtx()
    vi.mocked(ctx.mediaWorkerManager.startDuplicateMark).mockRejectedValue(new Error('fatal'))

    const r = await markDuplicates(ctx, 'high')

    expect(r).toEqual({ markedDuplicates: 0, totalGroups: 0 })
    expect(loggerMocks.loggerErrorMock).toHaveBeenCalledWith(
      '[Duplicate] 标记失败:',
      expect.any(Error)
    )
  })

  it('priority=low：enqueueLow 被调用时传入 duplicate-mark id 与 cancel 函数', async () => {
    const ctx = makeCtx()
    const enqueueSpy = vi.mocked(ctx.taskScheduler.enqueueLow)

    await markDuplicates(ctx, 'low')

    expect(enqueueSpy).toHaveBeenCalled()
    const args = enqueueSpy.mock.calls[0]
    expect(args[1]).toHaveProperty('id', 'duplicate-mark')
    expect(typeof args[1].cancel).toBe('function')
  })
})
