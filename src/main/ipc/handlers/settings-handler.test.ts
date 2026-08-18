/**
 * @layer L3
 * @module src/main/ipc/handlers/settings-handler
 * @coverage settings 域 IPC handler（settings:get / set）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../../shared/errors/app-error'
import { createSchemasMock, makeCtx, getHandler } from './_test-helpers'

const { handleMock, assertFileReadPathMock, assertFileWritePathMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  assertFileReadPathMock: vi.fn(),
  assertFileWritePathMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock, on: vi.fn() } }))

vi.mock('../validator', () => ({
  wrapHandler: vi.fn(
    (ctx: unknown, _schema: unknown, handler: (args: unknown[]) => unknown) =>
      async (...args: unknown[]) => {
        try {
          const data = await handler(args.length === 1 && Array.isArray(args[0]) ? args[0] : args)
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
  ),
  wrapHandlerNoArgs: vi.fn(),
  wrapHandlerRaw: vi.fn(
    (ctx: unknown, handler: (args: unknown[], ctx?: unknown) => unknown) =>
      async (...args: unknown[]) => {
        try {
          const data = await handler(
            args.length === 1 && Array.isArray(args[0]) ? args[0] : args,
            ctx
          )
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
  ),
  schemas: createSchemasMock(),
  assertFileReadPath: assertFileReadPathMock,
  assertFileWritePath: assertFileWritePathMock
}))

import { registerSettingsHandlers } from './settings-handler'

describe('registerSettingsHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
  })

  it('应注册 settings:get / settings:set channel', () => {
    registerSettingsHandlers(makeCtx({}))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('settings:get')
    expect(channels).toContain('settings:set')
  })

  it('settings:get 校验失败时抛 validation', async () => {
    registerSettingsHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'settings:get')(['', 'default'])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
  })

  it('settings:get 成功时返回 settings 值', async () => {
    const ctx = makeCtx({})
    ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockReturnValue('value')
    registerSettingsHandlers(ctx)
    const result = (await getHandler(handleMock, 'settings:get')(['key', 'default'])) as {
      success: true
      data: string
    }
    expect(ctx.dbManager.getSetting).toHaveBeenCalledWith('key', 'default')
    expect(result.data).toBe('value')
  })

  it('settings:set 白名单内 key 成功持久化并返回 saved', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(handleMock, 'settings:set')(['uiTheme', 'default'])) as {
      success: true
      data: { saved: boolean }
    }
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('uiTheme', 'default')
    expect(result.data.saved).toBe(true)
  })

  it('settings:set customScanPaths 经内联校验放行', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(
      handleMock,
      'settings:set'
    )(['customScanPaths', ['C:\\Users\\test\\photos']])) as {
      success: true
      data: { saved: boolean }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('C:\\Users\\test\\photos')
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('customScanPaths', [
      'C:\\Users\\test\\photos'
    ])
    expect(result.data.saved).toBe(true)
  })

  it('settings:set 安全敏感 key 被拒且错误信息含专用通道名', async () => {
    registerSettingsHandlers(makeCtx({}))
    const cases: Array<[string, string]> = [
      ['backupDir', 'backup:setDir'],
      ['thumbnailCacheDir', 'cache:setDir'],
      ['logDir', 'log:setDir'],
      ['crashDir', 'crash:setDir'],
      ['export.defaultDir', 'export:setDefaultDir'],
      ['export.namingPattern', 'export:setNamingPattern']
    ]
    for (const [key, channel] of cases) {
      const result = (await getHandler(handleMock, 'settings:set')([key, 'x'])) as {
        success: false
        error: { code: string; message: string }
      }
      expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
      expect(result.error.message).toContain(channel)
    }
  })

  it('settings:set 未知 key 被拒', async () => {
    registerSettingsHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'settings:set')(['unknownKey', 'x'])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
    expect(result.error.message).toContain('未知')
  })

  it('settings:set 值超过 1MB 时抛 validation', async () => {
    registerSettingsHandlers(makeCtx({}))
    const big = 'x'.repeat(1024 * 1024 + 1)
    const result = (await getHandler(handleMock, 'settings:set')(['key', big])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
    expect(result.error.message).toContain('过大')
  })
})
