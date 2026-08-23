/**
 * @layer L3
 * @module src/main/ipc/handlers/cache
 * @coverage 缓存域 IPC handler 注册与执行
 * @dependencies electron / ThumbnailGenerator / set-dir-handler
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'

const {
  handleMock,
  registerSetDirHandlerMock,
  registerResetDirHandlerMock,
  mediaRepoSetSettingMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  registerSetDirHandlerMock: vi.fn(),
  registerResetDirHandlerMock: vi.fn(),
  mediaRepoSetSettingMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock, on: vi.fn() } }))

vi.mock('./set-dir-handler', () => ({
  registerSetDirHandler: registerSetDirHandlerMock,
  registerResetDirHandler: registerResetDirHandlerMock
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

// R13：mock MediaRepository，避免在 cache 测试中引入真实 DB / worker。
// repo.setSetting 的行为本身在 media-repository.test.ts 中覆盖。
vi.mock('../../database/media-repository', () => ({
  MediaRepository: vi.fn().mockImplementation(() => ({
    setSetting: mediaRepoSetSettingMock
  }))
}))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerCacheHandlers } from './cache'
import { MIN_CACHE_LIMIT_BYTES } from '../../thumbnail/generator'

interface ThumbnailGenStubs {
  getCacheStats: ReturnType<typeof vi.fn>
  cleanAll: ReturnType<typeof vi.fn>
  setCacheLimit: ReturnType<typeof vi.fn>
  enforceLimitNow: ReturnType<typeof vi.fn>
  getCacheDir: ReturnType<typeof vi.fn>
}

interface CtxOverrides {
  /** getDatabase 返回值；null 触发同步直写降级路径 */
  db?: unknown
  workerBridge?: unknown
}

function makeCtx(thumbnailGen: ThumbnailGenStubs, overrides: CtxOverrides = {}): HandlerContext {
  return {
    thumbnailGen,
    dbManager: {
      getSetting: vi.fn(),
      setSetting: vi.fn(),
      getDatabase: vi.fn(() => overrides.db ?? null),
      getWorkerBridge: vi.fn(() => overrides.workerBridge ?? null),
      getDbPath: vi.fn(() => '/mock/db.sqlite')
    },
    getMainWindow: () => null,
    notifyMediaUpdated: vi.fn(),
    invalidateMediaPathCache: vi.fn(),
    applyUITheme: vi.fn(),
    isThumbnailsGenerating: () => false,
    setThumbnailsGenerating: vi.fn()
  } as unknown as HandlerContext
}

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  for (const call of handleMock.mock.calls) {
    if (call[0] === channel) return call[1]
  }
  throw new Error(`未找到 channel: ${channel}`)
}

describe('registerCacheHandlers', () => {
  let thumbnailGen: ThumbnailGenStubs

  beforeEach(() => {
    handleMock.mockClear()
    registerSetDirHandlerMock.mockClear()
    registerResetDirHandlerMock.mockClear()
    mediaRepoSetSettingMock.mockReset()
    thumbnailGen = {
      getCacheStats: vi.fn(),
      cleanAll: vi.fn(),
      setCacheLimit: vi.fn(),
      enforceLimitNow: vi.fn(),
      getCacheDir: vi.fn()
    }
    mediaRepoSetSettingMock.mockResolvedValue(undefined)
  })

  it('应注册 5 个 cache channel 并调用 setDir/resetDir 工厂', () => {
    registerCacheHandlers(makeCtx(thumbnailGen))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toEqual([
      'cache:getStats',
      'cache:clean',
      'cache:setLimit',
      'cache:enforceLimit',
      'cache:getDir'
    ])
    expect(registerSetDirHandlerMock).toHaveBeenCalledWith(
      expect.anything(),
      'cache:setDir',
      'thumbnailCacheDir'
    )
    expect(registerResetDirHandlerMock).toHaveBeenCalledWith(
      expect.anything(),
      'cache:resetDir',
      'thumbnailCacheDir'
    )
  })

  it('cache:getStats 成功时返回统计信息', async () => {
    thumbnailGen.getCacheStats.mockResolvedValue({ totalBytes: 1024, fileCount: 5 })
    registerCacheHandlers(makeCtx(thumbnailGen))
    const result = (await getHandler('cache:getStats')()) as {
      success: true
      data: { totalBytes: number }
    }
    expect(result.data.totalBytes).toBe(1024)
  })

  it('cache:getStats 抛 Error 时返回 INTERNAL_ERROR', async () => {
    thumbnailGen.getCacheStats.mockRejectedValue(new Error('读取目录失败'))
    registerCacheHandlers(makeCtx(thumbnailGen))
    const result = (await getHandler('cache:getStats')()) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
    expect(result.error.message).toContain('获取缓存统计失败')
  })

  it('cache:clean 成功时返回清理结果', async () => {
    thumbnailGen.cleanAll.mockResolvedValue({ cleaned: 10 })
    registerCacheHandlers(makeCtx(thumbnailGen))
    const result = (await getHandler('cache:clean')()) as {
      success: true
      data: { cleaned: number }
    }
    expect(result.data.cleaned).toBe(10)
  })

  it('cache:clean 抛错时返回 INTERNAL_ERROR', async () => {
    thumbnailGen.cleanAll.mockRejectedValue(new Error('删除失败'))
    registerCacheHandlers(makeCtx(thumbnailGen))
    const result = (await getHandler('cache:clean')()) as {
      success: false
      error: { code: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
  })

  it('cache:setLimit 成功时先持久化 DB（worker 事务）再更新 in-memory', async () => {
    thumbnailGen.setCacheLimit.mockResolvedValue({ applied: true })
    const ctx = makeCtx(thumbnailGen, { db: {}, workerBridge: {} })
    registerCacheHandlers(ctx)
    const result = (await getHandler('cache:setLimit')([104857600])) as {
      success: true
      data: { applied: boolean }
    }
    // R13：DB 持久化走 MediaRepository.setSetting（worker 事务），而非 dbManager.setSetting
    expect(mediaRepoSetSettingMock).toHaveBeenCalledWith('thumbnailCacheLimitBytes', 104857600)
    expect(ctx.dbManager.setSetting).not.toHaveBeenCalled()
    // in-memory 更新发生在 DB 持久化之后
    expect(thumbnailGen.setCacheLimit).toHaveBeenCalledWith(104857600)
    expect(result.data.applied).toBe(true)
  })

  it('R13：cache:setLimit DB 持久化失败时返回 INTERNAL_ERROR 且不触碰 in-memory', async () => {
    mediaRepoSetSettingMock.mockRejectedValueOnce(new Error('worker 故障'))
    thumbnailGen.setCacheLimit.mockResolvedValue({ applied: true })
    const ctx = makeCtx(thumbnailGen, { db: {}, workerBridge: {} })
    registerCacheHandlers(ctx)
    const result = (await getHandler('cache:setLimit')([104857600])) as {
      success: false
      error: { code: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
    // DB 失败 → in-memory 未被触碰（setCacheLimit 不应被调用）
    expect(thumbnailGen.setCacheLimit).not.toHaveBeenCalled()
  })

  it('R13：cache:setLimit DB 为 null 时降级为同步直写 dbManager.setSetting', async () => {
    thumbnailGen.setCacheLimit.mockResolvedValue({ applied: true })
    const ctx = makeCtx(thumbnailGen) // db 默认 null
    registerCacheHandlers(ctx)
    const result = (await getHandler('cache:setLimit')([104857600])) as {
      success: true
      data: { applied: boolean }
    }
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('thumbnailCacheLimitBytes', 104857600)
    expect(mediaRepoSetSettingMock).not.toHaveBeenCalled()
    expect(result.data.applied).toBe(true)
  })

  it('R13：cache:setLimit 低于下限时返回 applied:false 且不写 DB/in-memory', async () => {
    const ctx = makeCtx(thumbnailGen, { db: {}, workerBridge: {} })
    registerCacheHandlers(ctx)
    const result = (await getHandler('cache:setLimit')([1024])) as {
      success: true
      data: { applied: boolean }
    }
    expect(result.data.applied).toBe(false)
    expect(mediaRepoSetSettingMock).not.toHaveBeenCalled()
    expect(ctx.dbManager.setSetting).not.toHaveBeenCalled()
    expect(thumbnailGen.setCacheLimit).not.toHaveBeenCalled()
  })

  it('R13：cache:setLimit 下限边界值（MIN_CACHE_LIMIT_BYTES）正常持久化', async () => {
    thumbnailGen.setCacheLimit.mockResolvedValue({ applied: true })
    const ctx = makeCtx(thumbnailGen, { db: {}, workerBridge: {} })
    registerCacheHandlers(ctx)
    const result = (await getHandler('cache:setLimit')([MIN_CACHE_LIMIT_BYTES])) as {
      success: true
      data: { applied: boolean }
    }
    expect(result.data.applied).toBe(true)
    expect(mediaRepoSetSettingMock).toHaveBeenCalledWith(
      'thumbnailCacheLimitBytes',
      MIN_CACHE_LIMIT_BYTES
    )
    expect(thumbnailGen.setCacheLimit).toHaveBeenCalledWith(MIN_CACHE_LIMIT_BYTES)
  })

  it('cache:setLimit in-memory 更新失败时返回 INTERNAL_ERROR（DB 已持久化，下次重启从 DB 加载正确值）', async () => {
    thumbnailGen.setCacheLimit.mockRejectedValue(new Error('磁盘满'))
    const ctx = makeCtx(thumbnailGen, { db: {}, workerBridge: {} })
    registerCacheHandlers(ctx)
    const result = (await getHandler('cache:setLimit')([104857600])) as {
      success: false
      error: { code: string }
    }
    expect(result.success).toBe(false)
    // DB 已先于 in-memory 写入（R13 顺序保证）
    expect(mediaRepoSetSettingMock).toHaveBeenCalledWith('thumbnailCacheLimitBytes', 104857600)
    expect(thumbnailGen.setCacheLimit).toHaveBeenCalledWith(104857600)
  })

  it('cache:enforceLimit 成功时返回淘汰结果', async () => {
    thumbnailGen.enforceLimitNow.mockResolvedValue({ evicted: 3 })
    registerCacheHandlers(makeCtx(thumbnailGen))
    const result = (await getHandler('cache:enforceLimit')()) as {
      success: true
      data: { evicted: number }
    }
    expect(result.data.evicted).toBe(3)
  })

  it('cache:enforceLimit 抛错时返回 INTERNAL_ERROR', async () => {
    thumbnailGen.enforceLimitNow.mockRejectedValue(new Error('LRU 异常'))
    registerCacheHandlers(makeCtx(thumbnailGen))
    const result = (await getHandler('cache:enforceLimit')()) as {
      success: false
      error: { code: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
  })

  it('cache:getDir 返回缓存目录字符串', async () => {
    thumbnailGen.getCacheDir.mockReturnValue('/mock/cache/dir')
    registerCacheHandlers(makeCtx(thumbnailGen))
    const result = (await getHandler('cache:getDir')()) as { success: true; data: string }
    expect(result.data).toBe('/mock/cache/dir')
  })
})
