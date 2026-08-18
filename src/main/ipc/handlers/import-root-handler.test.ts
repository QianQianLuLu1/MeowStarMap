/**
 * @layer L3
 * @module src/main/ipc/handlers/import-root-handler
 * @coverage import-root 域 IPC handler（import:roots / import:removeRoot）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../../shared/errors/app-error'
import { ImportRootRepository } from '../../database/import-root-repository'
import { MediaRepository } from '../../database/media-repository'
import { createSchemasMock, makeCtx, getHandler } from './_test-helpers'

const { handleMock } = vi.hoisted(() => ({
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

// 复刻真实 wrapHandler 行为：用传入的 zod schema 校验入参，再调用业务 handler；
// 失败按 AppError / 内部错误降级为 IpcError。wrapHandlerNoArgs 直接透传 ctx。
// 这样空 rootPath 才能被 zod（schemas.filePath = z.string().min(1)）拒绝。
vi.mock('../validator', () => {
  const schemas = createSchemasMock()
  type ZodLike = { safeParseAsync?: (v: unknown) => Promise<{ success: boolean; data?: unknown }> }
  const runHandler = async (
    handler: (args: unknown, ctx: unknown) => unknown,
    input: unknown,
    ctx: unknown
  ) => {
    try {
      const data = await handler(input, ctx)
      return { success: true as const, data }
    } catch (e) {
      if (e instanceof AppError) return { success: false as const, error: e.toIpcError() }
      return {
        success: false as const,
        error: { code: 'IPC_INTERNAL_ERROR', message: e instanceof Error ? e.message : String(e) }
      }
    }
  }
  return {
    wrapHandler: vi.fn(
      (ctx: unknown, schema: unknown, handler: (args: unknown, ctx: unknown) => unknown) => {
        return async (...args: unknown[]) => {
          const input = args.length === 1 ? args[0] : args
          const sch = schema as ZodLike
          if (sch && typeof sch.safeParseAsync === 'function') {
            const parsed = await sch.safeParseAsync(input)
            if (!parsed.success) {
              return {
                success: false as const,
                error: { code: 'IPC_INVALID_PARAMS', message: '参数校验失败' }
              }
            }
            return runHandler(handler, parsed.data, ctx)
          }
          return runHandler(handler, input, ctx)
        }
      }
    ),
    wrapHandlerNoArgs: vi.fn((ctx: unknown, handler: (ctx: unknown) => unknown) => {
      return async () => {
        try {
          const data = await handler(ctx)
          return { success: true as const, data }
        } catch (e) {
          if (e instanceof AppError) return { success: false as const, error: e.toIpcError() }
          return {
            success: false as const,
            error: {
              code: 'IPC_INTERNAL_ERROR',
              message: e instanceof Error ? e.message : String(e)
            }
          }
        }
      }
    }),
    wrapHandlerRaw: vi.fn(),
    schemas,
    assertFileReadPath: vi.fn(),
    assertFileWritePath: vi.fn(),
    pathGuard: { register: vi.fn(), setRootMediaDir: vi.fn() }
  }
})

import { registerImportRootHandlers } from './import-root-handler'

describe('registerImportRootHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    vi.restoreAllMocks()
  })

  it('应注册 import:roots / import:removeRoot channel', () => {
    registerImportRootHandlers(makeCtx({}))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('import:roots')
    expect(channels).toContain('import:removeRoot')
  })

  it('import:roots 返回 import_roots 全量路径', async () => {
    const listSpy = vi
      .spyOn(ImportRootRepository.prototype, 'listImportRoots')
      .mockReturnValue(['D:/Photos', 'E:/Videos'])
    registerImportRootHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'import:roots')()) as {
      success: true
      data: string[]
    }
    expect(listSpy).toHaveBeenCalled()
    expect(result.data).toEqual(['D:/Photos', 'E:/Videos'])
  })

  it('import:removeRoot clearRecords=false：仅调用 removeImportRoot，不调 softDeleteByRootPath', async () => {
    const removeSpy = vi
      .spyOn(ImportRootRepository.prototype, 'removeImportRoot')
      .mockResolvedValue(undefined)
    const softSpy = vi.spyOn(MediaRepository.prototype, 'softDeleteByRootPath').mockResolvedValue(0)
    registerImportRootHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'import:removeRoot')(['D:/Photos', false])) as {
      success: true
      data: { removed: boolean; cleared: number }
    }
    expect(removeSpy).toHaveBeenCalledWith('D:/Photos')
    expect(softSpy).not.toHaveBeenCalled()
    expect(result.data).toEqual({
      removed: true,
      cleared: 0,
      clearFailed: false,
      clearErrorMessage: undefined
    })
  })

  it('import:removeRoot clearRecords=true：调用 softDeleteByRootPath 且触发 notifyMediaUpdated', async () => {
    const removeSpy = vi
      .spyOn(ImportRootRepository.prototype, 'removeImportRoot')
      .mockResolvedValue(undefined)
    const softSpy = vi.spyOn(MediaRepository.prototype, 'softDeleteByRootPath').mockResolvedValue(7)
    const ctx = makeCtx({})
    registerImportRootHandlers(ctx)
    const result = (await getHandler(handleMock, 'import:removeRoot')(['D:/Photos', true])) as {
      success: true
      data: { removed: boolean; cleared: number }
    }
    expect(removeSpy).toHaveBeenCalledWith('D:/Photos')
    expect(softSpy).toHaveBeenCalledWith('D:/Photos')
    expect(result.data).toEqual({
      removed: true,
      cleared: 7,
      clearFailed: false,
      clearErrorMessage: undefined
    })
    expect(ctx.notifyMediaUpdated).toHaveBeenCalled()
  })

  it('FIX(组1-2): softDeleteByRootPath 失败时返回 clearFailed=true 与错误消息（区分"无记录"）', async () => {
    vi.spyOn(ImportRootRepository.prototype, 'removeImportRoot').mockResolvedValue(undefined)
    vi.spyOn(MediaRepository.prototype, 'softDeleteByRootPath').mockRejectedValue(
      new Error('SQLITE_BUSY')
    )
    const ctx = makeCtx({})
    registerImportRootHandlers(ctx)
    const result = (await getHandler(handleMock, 'import:removeRoot')(['D:/Photos', true])) as {
      success: true
      data: { removed: boolean; cleared: number; clearFailed: boolean; clearErrorMessage?: string }
    }
    // 登记移除成功（removed=true），但软删失败被明确标记——不再与 cleared:0 的正常场景混淆
    expect(result.data).toEqual({
      removed: true,
      cleared: 0,
      clearFailed: true,
      clearErrorMessage: 'SQLITE_BUSY'
    })
    expect(ctx.notifyMediaUpdated).not.toHaveBeenCalled()
  })

  it('空 rootPath 被 zod 拒绝（success:false，未触发任何 DB 写）', async () => {
    const removeSpy = vi
      .spyOn(ImportRootRepository.prototype, 'removeImportRoot')
      .mockResolvedValue(undefined)
    const softSpy = vi.spyOn(MediaRepository.prototype, 'softDeleteByRootPath').mockResolvedValue(0)
    registerImportRootHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'import:removeRoot')(['', false])) as {
      success: false
      error: { code: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INVALID_PARAMS')
    expect(removeSpy).not.toHaveBeenCalled()
    expect(softSpy).not.toHaveBeenCalled()
  })

  it('移除不存在的根：no-op 不抛错，removed=true cleared=0', async () => {
    const removeSpy = vi
      .spyOn(ImportRootRepository.prototype, 'removeImportRoot')
      .mockResolvedValue(undefined)
    const softSpy = vi.spyOn(MediaRepository.prototype, 'softDeleteByRootPath').mockResolvedValue(0)
    registerImportRootHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'import:removeRoot')(['C:/ghost', true])) as {
      success: true
      data: { removed: boolean; cleared: number }
    }
    expect(removeSpy).toHaveBeenCalledWith('C:/ghost')
    expect(result.data).toEqual({
      removed: true,
      cleared: 0,
      clearFailed: false,
      clearErrorMessage: undefined
    })
  })
})
