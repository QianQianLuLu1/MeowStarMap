/**
 * @layer L3
 * @module src/main/ipc/handlers/app-handler
 * @coverage app 域 IPC handler（app:relaunch / getVersion）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../../shared/errors/app-error'
import { createSchemasMock, makeCtx, getHandler } from './_test-helpers'

const { handleMock, appRelaunchMock, appQuitMock, appGetVersionMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  appRelaunchMock: vi.fn(),
  appQuitMock: vi.fn(),
  appGetVersionMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    relaunch: appRelaunchMock,
    quit: appQuitMock,
    getVersion: appGetVersionMock
  },
  ipcMain: { handle: handleMock, on: vi.fn() }
}))

vi.mock('../validator', () => ({
  wrapHandler: vi.fn(),
  wrapHandlerNoArgs: vi.fn((ctx: unknown, handler: () => unknown) => async () => {
    try {
      const data = await handler()
      return { success: true as const, data }
    } catch (e) {
      if (e instanceof AppError) return { success: false as const, error: e.toIpcError() }
      return {
        success: false as const,
        error: { code: 'IPC_INTERNAL_ERROR', message: e instanceof Error ? e.message : String(e) }
      }
    }
  }),
  wrapHandlerRaw: vi.fn(),
  schemas: createSchemasMock(),
  assertFileReadPath: vi.fn(),
  assertFileWritePath: vi.fn()
}))

import { registerAppHandlers } from './app-handler'

describe('registerAppHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    appRelaunchMock.mockReset()
    appQuitMock.mockReset()
    appGetVersionMock.mockReset()
  })

  it('应注册 app:relaunch / app:getVersion channel', () => {
    registerAppHandlers(makeCtx({}))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('app:relaunch')
    expect(channels).toContain('app:getVersion')
  })

  it('app:relaunch 调用 app.relaunch + app.quit', async () => {
    registerAppHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'app:relaunch')()) as {
      success: true
      data: { relaunching: boolean }
    }
    expect(appRelaunchMock).toHaveBeenCalled()
    expect(appQuitMock).toHaveBeenCalled()
    expect(result.data.relaunching).toBe(true)
  })

  it('app:getVersion 返回 app.getVersion()', async () => {
    appGetVersionMock.mockReturnValue('2.3.0')
    registerAppHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'app:getVersion')()) as {
      success: true
      data: string
    }
    expect(result.data).toBe('2.3.0')
  })
})
