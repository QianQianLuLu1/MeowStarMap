/**
 * @layer L3
 * @module src/main/ipc/handlers/watermark
 * @coverage 水印域 IPC handler 注册与执行
 * @dependencies electron / WatermarkService / DBManager
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'

const { handleMock } = vi.hoisted(() => {
  return { handleMock: vi.fn() }
})

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerWatermarkHandlers } from './watermark'
import { assertFileReadPath, assertFileWritePath } from '../validator'

const assertFileReadPathMock = vi.mocked(assertFileReadPath)
const assertFileWritePathMock = vi.mocked(assertFileWritePath)

interface WatermarkServiceStub {
  applyBatch: ReturnType<typeof vi.fn>
}

interface DbStub {
  prepare: ReturnType<typeof vi.fn>
}

function makeCtx(watermarkService: WatermarkServiceStub, db?: DbStub | null): HandlerContext {
  return {
    watermarkService,
    dbManager: {
      getDatabase: vi.fn(() => (db === undefined ? {} : db))
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

describe('registerWatermarkHandlers', () => {
  let watermarkService: WatermarkServiceStub

  beforeEach(() => {
    handleMock.mockClear()
    assertFileReadPathMock.mockReset()
    assertFileWritePathMock.mockReset()
    watermarkService = { applyBatch: vi.fn() }
  })

  it('应注册 4 个 watermark channel', () => {
    registerWatermarkHandlers(makeCtx(watermarkService))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toEqual([
      'watermark:apply',
      'watermark:saveTemplate',
      'watermark:loadTemplates',
      'watermark:deleteTemplate'
    ])
  })

  it('watermark:apply 校验路径并调用 applyBatch', async () => {
    const sendMock = vi.fn()
    const ctx = makeCtx(watermarkService)
    ;(ctx.getMainWindow as unknown as ReturnType<typeof vi.fn>) = vi.fn(() => ({
      webContents: { send: sendMock }
    }))
    watermarkService.applyBatch.mockResolvedValue({ processed: 2 })
    registerWatermarkHandlers(ctx)
    const config = { text: 'watermark' }
    const result = (await getHandler('watermark:apply')([config, ['/a', '/b'], '/out'])) as {
      success: true
      data: { processed: number }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/a')
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/b')
    expect(assertFileWritePathMock).toHaveBeenCalledWith('/out')
    expect(watermarkService.applyBatch).toHaveBeenCalledWith(
      config,
      ['/a', '/b'],
      '/out',
      expect.any(Function),
      expect.any(AbortSignal)
    )
    expect(result.data.processed).toBe(2)
  })

  it('watermark:apply progress 回调被调用时通过 webContents 发送 watermark:progress', async () => {
    const sendMock = vi.fn()
    const ctx = makeCtx(watermarkService)
    ;(ctx.getMainWindow as unknown as ReturnType<typeof vi.fn>) = vi.fn(() => ({
      webContents: { send: sendMock }
    }))
    watermarkService.applyBatch.mockImplementation(
      async (_c: unknown, _f: unknown, _t: unknown, onProgress: (c: number, t: number) => void) => {
        onProgress(1, 2)
        return { processed: 2 }
      }
    )
    registerWatermarkHandlers(ctx)
    await getHandler('watermark:apply')([{}, ['/a'], '/out'])
    expect(sendMock).toHaveBeenCalledWith('watermark:progress', { current: 1, total: 2 })
  })

  it('watermark:apply 主窗口为 null 时不抛错（仅跳过 progress 通知）', async () => {
    watermarkService.applyBatch.mockImplementation(
      async (_c: unknown, _f: unknown, _t: unknown, onProgress: (c: number, t: number) => void) => {
        onProgress(1, 2)
        return { processed: 1 }
      }
    )
    registerWatermarkHandlers(makeCtx(watermarkService))
    const result = (await getHandler('watermark:apply')([{}, ['/a'], '/out'])) as {
      success: true
      data: { processed: number }
    }
    expect(result.data.processed).toBe(1)
  })

  it('watermark:saveTemplate 成功时返回自增 id', async () => {
    const runMock = vi.fn(() => ({ lastInsertRowid: 10n }))
    const db = { prepare: vi.fn(() => ({ run: runMock })) }
    registerWatermarkHandlers(makeCtx(watermarkService, db))
    const result = (await getHandler('watermark:saveTemplate')(['模板1', '{"k":1}'])) as {
      success: true
      data: { id: number }
    }
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO watermark_templates')
    )
    expect(runMock).toHaveBeenCalledWith('模板1', '{"k":1}')
    expect(result.data.id).toBe(10)
  })

  it('watermark:saveTemplate 数据库未初始化时抛 preconditionFailed', async () => {
    registerWatermarkHandlers(makeCtx(watermarkService, null))
    const result = (await getHandler('watermark:saveTemplate')(['n', '{}'])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
  })

  it('watermark:loadTemplates 成功时返回行数组', async () => {
    const allMock = vi.fn(() => [{ id: 1, name: 't1', config: '{}' }])
    const db = { prepare: vi.fn(() => ({ all: allMock })) }
    registerWatermarkHandlers(makeCtx(watermarkService, db))
    const result = (await getHandler('watermark:loadTemplates')()) as {
      success: true
      data: unknown[]
    }
    expect(db.prepare).toHaveBeenCalledWith(
      'SELECT * FROM watermark_templates ORDER BY created_at DESC'
    )
    expect(result.data).toHaveLength(1)
  })

  it('watermark:loadTemplates 数据库为 null 时返回空数组', async () => {
    registerWatermarkHandlers(makeCtx(watermarkService, null))
    const result = (await getHandler('watermark:loadTemplates')()) as {
      success: true
      data: unknown[]
    }
    expect(result.data).toEqual([])
  })

  it('watermark:deleteTemplate 调用 DELETE 语句', async () => {
    const runMock = vi.fn()
    const db = { prepare: vi.fn(() => ({ run: runMock })) }
    registerWatermarkHandlers(makeCtx(watermarkService, db))
    const result = (await getHandler('watermark:deleteTemplate')([5])) as {
      success: true
      data: { deleted: boolean }
    }
    expect(db.prepare).toHaveBeenCalledWith('DELETE FROM watermark_templates WHERE id = ?')
    expect(runMock).toHaveBeenCalledWith(5)
    expect(result.data.deleted).toBe(true)
  })

  it('watermark:deleteTemplate 数据库未初始化时抛 preconditionFailed', async () => {
    registerWatermarkHandlers(makeCtx(watermarkService, null))
    const result = (await getHandler('watermark:deleteTemplate')([1])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
  })
})
