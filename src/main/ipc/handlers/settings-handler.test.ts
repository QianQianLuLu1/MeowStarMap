/**
 * @layer L3
 * @module src/main/ipc/handlers/settings-handler
 * @coverage settings 域 IPC handler（settings:get / set）
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppError } from '../../../shared/errors/app-error'
import { createSchemasMock, makeCtx, getHandler } from './_test-helpers'

const { handleMock, assertFileReadPathMock, assertFileWritePathMock, mockAppGetPath } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    assertFileReadPathMock: vi.fn(),
    assertFileWritePathMock: vi.fn(),
    mockAppGetPath: vi.fn((name: string) => (name === 'userData' ? '' : ''))
  })
)

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  app: { getPath: mockAppGetPath }
}))

let tmpUserDir: string

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

  beforeAll(() => {
    tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-pref-'))
    mockAppGetPath.mockImplementation((name: string) =>
      name === 'userData' ? tmpUserDir : ''
    )
  })

  afterAll(() => {
    fs.rmSync(tmpUserDir, { recursive: true, force: true })
  })

  afterEach(() => {
    // 隔离：清理硬件加速偏好镜像，避免跨用例残留导致断言误判
    const pref = path.join(tmpUserDir, 'gpu-pref.json')
    if (fs.existsSync(pref)) fs.rmSync(pref, { force: true })
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

  it('settings:set hardwareAcceleration=false 双写到 userData/gpu-pref.json', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(handleMock, 'settings:set')([
      'hardwareAcceleration',
      false
    ])) as {
      success: true
      data: { saved: boolean }
    }
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('hardwareAcceleration', false)
    expect(result.data.saved).toBe(true)
    const pref = JSON.parse(
      fs.readFileSync(path.join(tmpUserDir, 'gpu-pref.json'), 'utf8')
    ) as { hardwareAcceleration: boolean }
    expect(pref.hardwareAcceleration).toBe(false)
  })

  it('settings:set hardwareAcceleration 非布尔值 → 被拒且不写镜像', async () => {
    registerSettingsHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'settings:set')([
      'hardwareAcceleration',
      'on'
    ])) as {
      success: false
      error: { code: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
    expect(fs.existsSync(path.join(tmpUserDir, 'gpu-pref.json'))).toBe(false)
  })
})
