/**
 * @layer L3
 * @module src/main/ipc/handlers/app-handler
 * @coverage app 域 IPC handler（app:relaunch / getVersion / gpu-status）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler } from './_test-helpers'

const { handleMock, appRelaunchMock, appQuitMock, appGetVersionMock, collectGpuStatusMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    appRelaunchMock: vi.fn(),
    appQuitMock: vi.fn(),
    appGetVersionMock: vi.fn(),
    collectGpuStatusMock: vi.fn()
  }))

vi.mock('electron', () => ({
  app: {
    relaunch: appRelaunchMock,
    quit: appQuitMock,
    getVersion: appGetVersionMock
  },
  ipcMain: { handle: handleMock, on: vi.fn() }
}))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

vi.mock('../../app/gpu-status', () => ({
  collectGpuStatus: collectGpuStatusMock
}))

import { registerAppHandlers } from './app-handler'

describe('registerAppHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    appRelaunchMock.mockReset()
    appQuitMock.mockReset()
    appGetVersionMock.mockReset()
    collectGpuStatusMock.mockReset()
  })

  it('应注册 app:relaunch / app:getVersion channel', () => {
    registerAppHandlers(makeCtx({}))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('app:relaunch')
    expect(channels).toContain('app:getVersion')
  })

  it('app:gpu-status 注册并透传 collectGpuStatus 结果（只读探针）', async () => {
    const fakeStatus = {
      hardwareAcceleration: { enabled: true, reason: 'default' },
      fallback: { active: false, consecutiveFailures: 0, fallbackVersion: null },
      discretePreference: { mode: 'high-performance', registry: 'set' },
      featureStatus: null,
      gpus: null,
      activeGpu: null,
      electronVersion: '41.0.0',
      platform: 'win32'
    }
    collectGpuStatusMock.mockResolvedValue(fakeStatus)
    registerAppHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'app:gpu-status')()) as {
      success: boolean
      data: typeof fakeStatus
    }
    expect(result.success).toBe(true)
    expect(result.data).toEqual(fakeStatus)
    expect(collectGpuStatusMock).toHaveBeenCalledTimes(1)
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
