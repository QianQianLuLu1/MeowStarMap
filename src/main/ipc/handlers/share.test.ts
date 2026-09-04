/**
 * @layer L3
 * @module src/main/ipc/handlers/share
 * @coverage 分享域 IPC handler 注册与执行（含双层路径校验语义）
 * @dependencies electron / wifiShareService / share-clipboard-service / media-read-guard
 *
 * 双层校验语义（share:startWifi / share:copyFiles）：
 *   1. 命中已索引媒体白名单（isMediaPathAllowed=true）→ 直接放行，跳过 assertFileReadPath
 *   2. 未命中媒体白名单 → 回退 assertFileReadPath；兜底通过则仍成功（防止已索引合法媒体被误拦截）
 *   3. 混合批次中任一越权路径 → 整批拒绝，服务层零调用（首个违规即抛出）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'
import { AppError } from '../../../shared/errors/app-error'

const {
  handleMock,
  wifiStartMock,
  wifiStopMock,
  copyFilesToClipboardMock,
  getAppStatusMock,
  launchAppMock,
  isMediaPathAllowedMock
} = vi.hoisted(() => {
  return {
    handleMock: vi.fn(),
    wifiStartMock: vi.fn(),
    wifiStopMock: vi.fn(),
    copyFilesToClipboardMock: vi.fn(),
    getAppStatusMock: vi.fn(),
    launchAppMock: vi.fn(),
    isMediaPathAllowedMock: vi.fn()
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

// 双层校验第一层：媒体白名单（与 decrypt-handler.test.ts 同模式），由测试按分支控制返回值；
// share.ts 经 ../media-read-guard 间接调用，vi.mock 按解析后模块 ID 匹配，此处路径即为实际命中点。
vi.mock('../../app/media-protocol', () => ({
  isMediaPathAllowed: isMediaPathAllowedMock
}))

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
    isMediaPathAllowedMock.mockReset()
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

  it('share:startWifi 双层校验通过后返回 session 摘要', async () => {
    // 未命中媒体白名单 → 回退 PathGuard 兜底放行（第一层未命中、第二层通过）
    isMediaPathAllowedMock.mockReturnValue(false)
    assertFileReadPathMock.mockImplementation(() => undefined)
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

  it('share:startWifi 命中已索引媒体白名单时跳过 assertFileReadPath 并启动服务', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)
    wifiStartMock.mockResolvedValue({
      url: 'http://192.168.1.1:8080/',
      port: 8080,
      pin: '123456',
      files: [{ path: 'D:/games/InfinityNikki/photo/001.jpg' }],
      timeoutMs: 300000
    })
    registerShareHandlers(makeCtx())
    const result = (await getHandler('share:startWifi')([
      ['D:/games/InfinityNikki/photo/001.jpg']
    ])) as { success: true; data: { fileCount: number } }
    expect(result.success).toBe(true)
    // 关键：命中媒体白名单后不得再走审批白名单（消除已索引合法媒体被误拦截）
    expect(assertFileReadPathMock).not.toHaveBeenCalled()
    expect(wifiStartMock).toHaveBeenCalledTimes(1)
    expect(result.data.fileCount).toBe(1)
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

  it('share:copyFiles 双层校验通过后返回复制结果', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)
    assertFileReadPathMock.mockImplementation(() => undefined)
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

  it('share:copyFiles 命中已索引媒体白名单时跳过 assertFileReadPath 并执行复制', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)
    copyFilesToClipboardMock.mockResolvedValue({ copied: 1, skipped: 0 })
    registerShareHandlers(makeCtx())
    const result = (await getHandler('share:copyFiles')([
      ['D:/games/InfinityNikki/photo/001.jpg']
    ])) as { success: true; data: { copied: number } }
    expect(result.success).toBe(true)
    expect(result.data.copied).toBe(1)
    expect(assertFileReadPathMock).not.toHaveBeenCalled()
    expect(copyFilesToClipboardMock).toHaveBeenCalledTimes(1)
  })

  it('混合批次（合法 + 1 越权路径）时整批拒绝且服务层零调用', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)
    assertFileReadPathMock.mockImplementation((p: string) => {
      if (p === 'C:/secret/x.jpg') throw AppError.forbidden('路径不在白名单内，禁止 读取 操作')
    })
    registerShareHandlers(makeCtx())

    for (const channel of ['share:startWifi', 'share:copyFiles'] as const) {
      const result = (await getHandler(channel)([['/a', 'C:/secret/x.jpg']])) as {
        success: false
        error: { code: string; message: string }
      }
      expect(result.success).toBe(false)
      expect(result.error.code).toBe('IPC_PATH_FORBIDDEN')
      expect(result.error.message).toContain('路径不在白名单内')
    }
    // 安全边界：越权批次不得触发任何服务层操作（首个违规即抛出）
    expect(wifiStartMock).not.toHaveBeenCalled()
    expect(copyFilesToClipboardMock).not.toHaveBeenCalled()
  })

  it('越权路径单独提交时返回 IPC_PATH_FORBIDDEN', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)
    assertFileReadPathMock.mockImplementation(() => {
      throw AppError.forbidden('路径不在白名单内，禁止 读取 操作')
    })
    registerShareHandlers(makeCtx())

    for (const channel of ['share:startWifi', 'share:copyFiles'] as const) {
      const result = (await getHandler(channel)([['C:/Windows/System32/config/SAM']])) as {
        success: false
        error: { code: string }
      }
      expect(result.success).toBe(false)
      expect(result.error.code).toBe('IPC_PATH_FORBIDDEN')
    }
    expect(wifiStartMock).not.toHaveBeenCalled()
    expect(copyFilesToClipboardMock).not.toHaveBeenCalled()
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
