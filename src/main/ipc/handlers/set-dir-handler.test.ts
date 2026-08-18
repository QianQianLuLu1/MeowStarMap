/**
 * @layer L3
 * @module src/main/ipc/handlers/set-dir-handler
 * @coverage setDir/resetDir 工厂函数生成的 handler
 * @dependencies electron / fs / path / dbManager / dir-manager
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'
import { AppError } from '../../../shared/errors/app-error'

const { handleMock, fsMkdirMock, fsWriteFileMock, fsUnlinkMock, assertFileWritePathMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    fsMkdirMock: vi.fn(),
    fsWriteFileMock: vi.fn(),
    fsUnlinkMock: vi.fn(),
    assertFileWritePathMock: vi.fn()
  }))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() }
}))

vi.mock('fs', () => ({
  default: {
    promises: {
      mkdir: fsMkdirMock,
      writeFile: fsWriteFileMock,
      unlink: fsUnlinkMock
    }
  }
}))

// mock validator：使用真实 zod schemas 让 z.tuple 构造正常，但 assertFileWritePath 跳过 PathGuard
vi.mock('../validator', async () => {
  const zmod = await vi.importActual<typeof import('zod')>('zod')
  const unwrap = (args: unknown[]) => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args)
  const filePath = zmod.z.string().min(1).max(1024)
  return {
    wrapHandler: vi.fn(
      (ctx: unknown, _schema: unknown, handler: (args: unknown[]) => unknown) =>
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
    schemas: { filePath },
    assertFileReadPath: vi.fn(),
    assertFileWritePath: assertFileWritePathMock
  }
})

// mock logger
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

// mock SETTING_KEYS - 让真实模块加载
import { SETTING_KEYS } from '../../utils/dir-manager'

function makeCtx(setSettingMock: ReturnType<typeof vi.fn> = vi.fn()): HandlerContext {
  return {
    dbManager: {
      setSetting: setSettingMock
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

import { registerSetDirHandler, registerResetDirHandler } from './set-dir-handler'

describe('registerSetDirHandler', () => {
  beforeEach(() => {
    handleMock.mockClear()
    fsMkdirMock.mockReset()
    fsWriteFileMock.mockReset()
    fsUnlinkMock.mockReset()
    assertFileWritePathMock.mockReset()
  })

  it('应在指定 channel 注册 handler', () => {
    const setSettingMock = vi.fn()
    registerSetDirHandler(makeCtx(setSettingMock), 'test:setDir', 'backupDir')
    expect(handleMock.mock.calls[0][0]).toBe('test:setDir')
  })

  it('目录可写时持久化到 settings 并返回 success+needRestart', async () => {
    fsMkdirMock.mockResolvedValue(undefined)
    fsWriteFileMock.mockResolvedValue(undefined)
    fsUnlinkMock.mockResolvedValue(undefined)
    const setSettingMock = vi.fn()
    registerSetDirHandler(makeCtx(setSettingMock), 'test:setDir', 'backupDir')
    const handler = getHandler('test:setDir')
    const result = (await handler(['/home/user/backup'])) as {
      success: true
      data: { success: boolean; needRestart: boolean; message: string }
    }
    expect(assertFileWritePathMock).toHaveBeenCalledWith('/home/user/backup')
    expect(fsMkdirMock).toHaveBeenCalledWith('/home/user/backup', { recursive: true })
    expect(fsWriteFileMock).toHaveBeenCalled()
    expect(fsUnlinkMock).toHaveBeenCalled()
    expect(setSettingMock).toHaveBeenCalledWith(SETTING_KEYS.backupDir, '/home/user/backup')
    expect(result.data.success).toBe(true)
    expect(result.data.needRestart).toBe(true)
    expect(result.data.message).toContain('/home/user/backup')
  })

  it('mkdir 失败时返回 success=false 与错误消息', async () => {
    fsMkdirMock.mockRejectedValue(new Error('EACCES'))
    const setSettingMock = vi.fn()
    registerSetDirHandler(makeCtx(setSettingMock), 'test:setDir', 'logDir')
    const result = (await getHandler('test:setDir')(['/forbidden'])) as {
      success: true
      data: { success: boolean; message: string }
    }
    expect(result.data.success).toBe(false)
    expect(result.data.message).toContain('目录不可写')
    expect(setSettingMock).not.toHaveBeenCalled()
  })

  it('writeFile 失败时返回 success=false', async () => {
    fsMkdirMock.mockResolvedValue(undefined)
    fsWriteFileMock.mockRejectedValue(new Error('只读文件系统'))
    registerSetDirHandler(makeCtx(), 'test:setDir', 'crashDir')
    const result = (await getHandler('test:setDir')(['/dir'])) as {
      success: true
      data: { success: boolean }
    }
    expect(result.data.success).toBe(false)
  })

  it('unlink 失败时返回 success=false', async () => {
    fsMkdirMock.mockResolvedValue(undefined)
    fsWriteFileMock.mockResolvedValue(undefined)
    fsUnlinkMock.mockRejectedValue(new Error('无法删除'))
    registerSetDirHandler(makeCtx(), 'test:setDir', 'thumbnailCacheDir')
    const result = (await getHandler('test:setDir')(['/dir'])) as {
      success: true
      data: { success: boolean }
    }
    expect(result.data.success).toBe(false)
  })

  it('抛非 Error 值时也能安全返回失败', async () => {
    fsMkdirMock.mockRejectedValue('字符串错误')
    registerSetDirHandler(makeCtx(), 'test:setDir', 'backupDir')
    const result = (await getHandler('test:setDir')(['/dir'])) as {
      success: true
      data: { success: boolean; message: string }
    }
    expect(result.data.success).toBe(false)
    expect(result.data.message).toContain('字符串错误')
  })
})

describe('registerResetDirHandler', () => {
  beforeEach(() => {
    handleMock.mockClear()
  })

  it('应在指定 channel 注册 handler', () => {
    registerResetDirHandler(makeCtx(), 'test:resetDir', 'backupDir')
    expect(handleMock.mock.calls[0][0]).toBe('test:resetDir')
  })

  it('成功时清空设置项并返回 needRestart=true', async () => {
    const setSettingMock = vi.fn()
    registerResetDirHandler(makeCtx(setSettingMock), 'test:resetDir', 'logDir')
    const result = (await getHandler('test:resetDir')()) as {
      success: true
      data: { success: boolean; needRestart: boolean; message: string }
    }
    expect(setSettingMock).toHaveBeenCalledWith(SETTING_KEYS.logDir, '')
    expect(result.data.success).toBe(true)
    expect(result.data.needRestart).toBe(true)
    expect(result.data.message).toContain('已恢复为默认目录')
  })

  it('setSetting 抛 Error 时返回 success=false', async () => {
    const setSettingMock = vi.fn(() => {
      throw new Error('数据库锁定')
    })
    registerResetDirHandler(makeCtx(setSettingMock), 'test:resetDir', 'crashDir')
    const result = (await getHandler('test:resetDir')()) as {
      success: true
      data: { success: boolean; message: string }
    }
    expect(result.data.success).toBe(false)
    expect(result.data.message).toContain('数据库锁定')
  })

  it('setSetting 抛非 Error 时也能安全返回失败', async () => {
    const setSettingMock = vi.fn(() => {
      throw '字符串错误'
    })
    registerResetDirHandler(makeCtx(setSettingMock), 'test:resetDir', 'backupDir')
    const result = (await getHandler('test:resetDir')()) as {
      success: true
      data: { success: boolean; message: string }
    }
    expect(result.data.success).toBe(false)
    expect(result.data.message).toContain('字符串错误')
  })
})
