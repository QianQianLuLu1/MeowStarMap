/**
 * @layer L3
 * @module src/main/ipc/handlers/decrypt-handler
 * @coverage decrypt:decodeFile 解码前的路径白名单校验分支
 * @dependencies electron / media-protocol(isMediaPathAllowed) / validator(assertFileReadPath) / decryption-service
 *
 * 验证目标（修复“图库右键属性 → 信息解析失败: 路径不在白名单内”）：
 *   1. 命中已索引媒体白名单 → 跳过 assertFileReadPath，直接解密（ok:true）
 *   2. 未命中媒体白名单 → 走 assertFileReadPath 兜底；兜底通过则仍可解密
 *   3. 非媒体路径且兜底拒绝 → 抛出白名单错误，解密被拦截（ok:false / reject）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../../handler-context'
import { AppError } from '../../../../shared/errors/app-error'

const {
  handleMock,
  assertFileReadPathMock,
  isMediaPathAllowedMock,
  decodeFileParamsMock,
  loggerDebugMock,
  schemasProxy
} = vi.hoisted(() => {
  const makeChainable = (): any => {
    const fn: any = () => makeChainable()
    return new Proxy(fn, {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        if (typeof prop === 'symbol') return undefined
        return () => makeChainable()
      }
    })
  }
  const schemasProxy: any = new Proxy(
    {},
    { get: (_, prop) => (typeof prop === 'symbol' ? undefined : makeChainable()) }
  )
  return {
    handleMock: vi.fn(),
    assertFileReadPathMock: vi.fn(),
    isMediaPathAllowedMock: vi.fn(),
    decodeFileParamsMock: vi.fn(),
    loggerDebugMock: vi.fn(),
    schemasProxy
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  app: {
    getPath: vi.fn(() => '/mock'),
    getAppPath: vi.fn(() => '/mock'),
    getName: vi.fn(() => 'mock')
  },
  BrowserWindow: vi.fn(),
  nativeImage: { createFromPath: vi.fn() },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn() }
}))

vi.mock('../../validator', () => {
  const unwrap = (args: unknown[]) => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args)
  return {
    wrapHandler: vi.fn(
      (_ctx: unknown, _schema: unknown, handler: (args: unknown[]) => unknown) =>
        async (...args: unknown[]) => {
          try {
            const data = await handler(unwrap(args))
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
    wrapHandlerNoArgs: vi.fn((_ctx: unknown, handler: () => unknown) => async () => {
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
    schemas: schemasProxy,
    assertFileReadPath: assertFileReadPathMock,
    assertFileWritePath: vi.fn()
  }
})

// 复用 media:// 已索引媒体白名单（修复核心）：由测试按分支控制返回值
vi.mock('../../../app/media-protocol', () => ({
  isMediaPathAllowed: isMediaPathAllowedMock
}))

// 解密核心逻辑（photography_decode）保持不动，仅 mock 返回值以便断言路径分支
vi.mock('../../../services/decryption-service', () => ({
  decodeFileParams: decodeFileParamsMock
}))

vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: loggerDebugMock },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

import { registerDecryptHandlers } from '../decrypt-handler'

function makeCtx(): HandlerContext {
  const dbStub = {
    prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) })
  }
  return {
    dbManager: {
      getDatabase: vi.fn(() => dbStub as never),
      getWorkerBridge: vi.fn(() => undefined),
      getDbPath: vi.fn(() => '/mock/db.sqlite')
    },
    scannerManager: {} as never,
    mediaWorkerManager: {} as never,
    taskScheduler: {} as never,
    thumbnailGen: { getCacheDir: () => '/mock/thumb' } as never,
    fileService: {} as never,
    videoService: {} as never,
    watermarkService: {} as never,
    videoEditorBridge: {} as never,
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
    if (call[0] === channel) return call[1] as (...args: unknown[]) => Promise<unknown>
  }
  throw new Error(`未找到 channel: ${channel}`)
}

describe('decrypt:decodeFile 路径白名单校验', () => {
  beforeEach(() => {
    handleMock.mockClear()
    assertFileReadPathMock.mockReset()
    isMediaPathAllowedMock.mockReset()
    decodeFileParamsMock.mockReset()
    loggerDebugMock.mockReset()
    // 默认：解密成功
    decodeFileParamsMock.mockResolvedValue({ error: null, decoded: { camera: {} } })
    // 仅注册一次，避免 hanldeMock.calls 累积导致 getHandler 命中首个旧实例
    registerDecryptHandlers(makeCtx())
  })

  it('命中已索引媒体白名单时跳过 assertFileReadPath 并成功解密', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)

    const result = (await getHandler('decrypt:decodeFile')([
      'D:/games/InfinityNikki/photo/001.jpg',
      'game',
      'uid123'
    ])) as { success: true; data: { ok: boolean } }
    expect(result.success).toBe(true)
    expect(result.data.ok).toBe(true)
    // 关键：命中媒体白名单后不得再走审批白名单
    expect(assertFileReadPathMock).not.toHaveBeenCalled()
    // 关键：解密核心逻辑被正常调用
    expect(decodeFileParamsMock).toHaveBeenCalledTimes(1)
    expect(loggerDebugMock).toHaveBeenCalled()
  })

  it('未命中媒体白名单时回退 assertFileReadPath，兜底通过则仍成功解密', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)
    assertFileReadPathMock.mockImplementation(() => undefined) // 兜底放行

    const result = (await getHandler('decrypt:decodeFile')([
      'D:/other/unknown.jpg',
      'game',
      'uid123'
    ])) as { success: true; data: { ok: boolean } }

    expect(result.success).toBe(true)
    expect(result.data.ok).toBe(true)
    // 关键：未命中媒体白名单时仍走审批白名单兜底
    expect(assertFileReadPathMock).toHaveBeenCalledTimes(1)
    expect(decodeFileParamsMock).toHaveBeenCalledTimes(1)
  })

  it('非媒体路径且兜底拒绝时解密被拦截（返回白名单错误）', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)
    assertFileReadPathMock.mockImplementation(() => {
      throw new Error('路径不在白名单内，禁止 读取 操作')
    })

    const result = (await getHandler('decrypt:decodeFile')([
      'C:/secret/secret.jpg',
      'game',
      'uid123'
    ])) as { success: false; error: { message: string } }

    expect(result.success).toBe(false)
    expect(result.error.message).toContain('路径不在白名单内')
    // 关键：解密核心逻辑不得被调用（安全边界保留）
    expect(decodeFileParamsMock).not.toHaveBeenCalled()
  })
})
