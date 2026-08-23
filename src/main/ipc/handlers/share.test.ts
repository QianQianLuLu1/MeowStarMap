/**
 * @layer L3
 * @module src/main/ipc/handlers/share
 * @coverage 分享域 IPC handler 注册与执行
 * @dependencies electron / wifiShareService / share-clipboard-service
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'

const {
  handleMock,
  wifiStartMock,
  wifiStopMock,
  copyFilesToClipboardMock,
  getAppStatusMock,
  launchAppMock
} = vi.hoisted(() => {
  return {
    handleMock: vi.fn(),
    wifiStartMock: vi.fn(),
    wifiStopMock: vi.fn(),
    copyFilesToClipboardMock: vi.fn(),
    getAppStatusMock: vi.fn(),
    launchAppMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() }
}))

vi.mock('../../services/share-wifi-service', () => ({
  wifiShareService: {
    start: wifiStartMock,
    stop: wifiStopMock
  }
}))

vi.mock('../../services/share-clipboard-service', () => ({
  copyFilesToClipboard: copyFilesToClipboardMock,
  getAppStatus: getAppStatusMock,
  launchApp: launchAppMock
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerShareHandlers } from './share'
import { assertFileReadPath } from '../validator'

const assertFileReadPathMock = vi.mocked(assertFileReadPath)

function makeCtx(): HandlerContext {
  return {
    dbManager: { getSetting: vi.fn(), setSetting: vi.fn() },
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

describe('registerShareHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    wifiStartMock.mockReset()
    wifiStopMock.mockReset()
    copyFilesToClipboardMock.mockReset()
    getAppStatusMock.mockReset()
    launchAppMock.mockReset()
    assertFileReadPathMock.mockReset()
  })

  it('应注册 5 个 share channel', () => {
    registerShareHandlers(makeCtx())
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toEqual([
      'share:startWifi',
      'share:stopWifi',
      'share:copyFiles',
      'share:detectApp',
      'share:launchApp'
    ])
  })

  it('share:startWifi 校验每个路径并返回 session 摘要', async () => {
    wifiStartMock.mockResolvedValue({
      url: 'http://192.168.1.1:8080/',
      port: 8080,
      pin: '123456',
      files: [{ path: '/a' }, { path: '/b' }],
      timeoutMs: 300000
    })
    registerShareHandlers(makeCtx())
    const result = (await getHandler('share:startWifi')([['/a', '/b']])) as {
      success: true
      data: { url: string; port: number; pin: string; fileCount: number; timeoutMs: number }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/a')
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/b')
    expect(wifiStartMock).toHaveBeenCalledWith(['/a', '/b'])
    expect(result.data.url).toBe('http://192.168.1.1:8080/')
    expect(result.data.pin).toBe('123456')
    expect(result.data.fileCount).toBe(2)
    expect(result.data.timeoutMs).toBe(300000)
  })

  it('share:stopWifi 调用 stop 并返回 { stopped: true }', async () => {
    registerShareHandlers(makeCtx())
    const result = (await getHandler('share:stopWifi')()) as {
      success: true
      data: { stopped: boolean }
    }
    expect(wifiStopMock).toHaveBeenCalled()
    expect(result.data.stopped).toBe(true)
  })

  it('share:copyFiles 校验路径并返回复制结果', async () => {
    copyFilesToClipboardMock.mockResolvedValue({ copied: 2, skipped: 0 })
    registerShareHandlers(makeCtx())
    const result = (await getHandler('share:copyFiles')([['/a', '/b']])) as {
      success: true
      data: { copied: number }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/a')
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/b')
    expect(copyFilesToClipboardMock).toHaveBeenCalledWith(['/a', '/b'])
    expect(result.data.copied).toBe(2)
  })

  it('share:detectApp 成功时返回 installed/running/installPath', async () => {
    getAppStatusMock.mockResolvedValue({
      installed: true,
      running: true,
      installPath: 'C:\\WeChat'
    })
    registerShareHandlers(makeCtx())
    const result = (await getHandler('share:detectApp')(['wechat'])) as {
      success: true
      data: { installed: boolean; running: boolean; installPath: string }
    }
    expect(getAppStatusMock).toHaveBeenCalledWith('wechat')
    expect(result.data.installed).toBe(true)
    expect(result.data.running).toBe(true)
    expect(result.data.installPath).toBe('C:\\WeChat')
  })

  it('share:detectApp service 抛错时返回未安装状态（避免 UI 卡死）', async () => {
    getAppStatusMock.mockRejectedValue(new Error('注册表读取失败'))
    registerShareHandlers(makeCtx())
    const result = (await getHandler('share:detectApp')(['wechat'])) as {
      success: true
      data: { installed: boolean; running: boolean; installPath: null }
    }
    expect(result.data.installed).toBe(false)
    expect(result.data.running).toBe(false)
    expect(result.data.installPath).toBeNull()
  })

  it('share:launchApp 成功时返回 service 结果', async () => {
    launchAppMock.mockResolvedValue({ success: true, message: '已启动' })
    registerShareHandlers(makeCtx())
    const result = (await getHandler('share:launchApp')(['wechat'])) as {
      success: true
      data: { success: boolean }
    }
    expect(launchAppMock).toHaveBeenCalledWith('wechat')
    expect(result.data.success).toBe(true)
  })

  it('share:launchApp service 抛 Error 时返回 INTERNAL_ERROR', async () => {
    launchAppMock.mockRejectedValue(new Error('找不到可执行文件'))
    registerShareHandlers(makeCtx())
    const result = (await getHandler('share:launchApp')(['wechat'])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
    expect(result.error.message).toContain('启动应用失败')
    expect(result.error.message).toContain('找不到可执行文件')
  })

  it('share:launchApp service 抛非 Error 时也能包装', async () => {
    launchAppMock.mockRejectedValue('字符串错误')
    registerShareHandlers(makeCtx())
    const result = (await getHandler('share:launchApp')(['wechat'])) as {
      success: false
      error: { message: string }
    }
    expect(result.error.message).toContain('字符串错误')
  })
})
