/**
 * @layer L3
 * @module src/main/ipc/handlers/backup
 * @coverage 备份域 IPC handler 注册与执行
 * @dependencies electron / backup-service / set-dir-handler
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'
import { AppError } from '../../../shared/errors/app-error'

// 捕获 ipcMain.handle 注册的 channel 与回调（vi.hoisted 保证 vi.mock 之前完成初始化）
const {
  handleMock,
  createBackupMock,
  listBackupsMock,
  restoreBackupMock,
  deleteBackupMock,
  getBackupDirectoryMock,
  registerSetDirHandlerMock,
  registerResetDirHandlerMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  createBackupMock: vi.fn(),
  listBackupsMock: vi.fn(),
  restoreBackupMock: vi.fn(),
  deleteBackupMock: vi.fn(),
  getBackupDirectoryMock: vi.fn(),
  registerSetDirHandlerMock: vi.fn(),
  registerResetDirHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    on: vi.fn()
  }
}))

vi.mock('../../services/backup-service', () => ({
  backupService: {
    createBackup: createBackupMock,
    listBackups: listBackupsMock,
    restoreBackup: restoreBackupMock,
    deleteBackup: deleteBackupMock,
    getBackupDirectory: getBackupDirectoryMock
  }
}))

vi.mock('./set-dir-handler', () => ({
  registerSetDirHandler: registerSetDirHandlerMock,
  registerResetDirHandler: registerResetDirHandlerMock
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

// mock validator：让 wrapHandler 透传到 handler，直接调用业务函数
vi.mock('../validator', () => {
  // 测试约定：handler 调用时第一个实参为参数元组，需解包为 zod parseResult.data 形式
  const unwrap = (args: unknown[]) => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args)
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
    wrapHandlerRaw: vi.fn(
      (ctx: unknown, handler: (args: unknown[]) => unknown) =>
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
    schemas: {
      filePath: { min: () => ({ max: () => ({}) }) },
      backupFilename: { regex: () => ({}) }
    },
    assertFileReadPath: vi.fn(),
    assertFileWritePath: vi.fn()
  }
})

import { registerBackupHandlers } from './backup'

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

/** 从 handleMock 中提取指定 channel 的回调函数 */
function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  for (const call of handleMock.mock.calls) {
    if (call[0] === channel) return call[1]
  }
  throw new Error(`未找到 channel: ${channel}`)
}

describe('registerBackupHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    createBackupMock.mockReset()
    listBackupsMock.mockReset()
    restoreBackupMock.mockReset()
    deleteBackupMock.mockReset()
    getBackupDirectoryMock.mockReset()
    registerSetDirHandlerMock.mockClear()
    registerResetDirHandlerMock.mockClear()
  })

  it('应在调用时注册 7 个 IPC channel（含 setDir/resetDir 工厂）', () => {
    registerBackupHandlers(makeCtx())
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('backup:create')
    expect(channels).toContain('backup:list')
    expect(channels).toContain('backup:restore')
    expect(channels).toContain('backup:delete')
    expect(channels).toContain('backup:getDir')
    // setDir/resetDir 由工厂注册
    expect(registerSetDirHandlerMock).toHaveBeenCalledWith(
      expect.anything(),
      'backup:setDir',
      'backupDir'
    )
    expect(registerResetDirHandlerMock).toHaveBeenCalledWith(
      expect.anything(),
      'backup:resetDir',
      'backupDir'
    )
  })

  it('backup:create 成功时返回备份结果', async () => {
    createBackupMock.mockResolvedValue({ success: true, filePath: '/mock/backup.db' })
    registerBackupHandlers(makeCtx())
    const handler = getHandler('backup:create')
    const result = await handler([{ accountUid: 'uid123' }])
    expect(createBackupMock).toHaveBeenCalledWith('uid123')
    expect(result).toEqual({ success: true, data: { success: true, filePath: '/mock/backup.db' } })
  })

  it('backup:create 不传 options 时按整库备份', async () => {
    createBackupMock.mockResolvedValue({ success: true })
    registerBackupHandlers(makeCtx())
    const handler = getHandler('backup:create')
    await handler([undefined])
    expect(createBackupMock).toHaveBeenCalledWith(undefined)
  })

  it('backup:create 抛 Error 时返回 INTERNAL_ERROR', async () => {
    createBackupMock.mockRejectedValue(new Error('磁盘已满'))
    registerBackupHandlers(makeCtx())
    const handler = getHandler('backup:create')
    const result = (await handler([undefined])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
    expect(result.error.message).toContain('创建备份失败')
    expect(result.error.message).toContain('磁盘已满')
  })

  it('backup:create 抛非 Error 值时也能正常包装', async () => {
    createBackupMock.mockRejectedValue('字符串错误')
    registerBackupHandlers(makeCtx())
    const handler = getHandler('backup:create')
    const result = (await handler([undefined])) as { success: false; error: { message: string } }
    expect(result.success).toBe(false)
    expect(result.error.message).toContain('字符串错误')
  })

  it('backup:list 成功时返回 backups 与 backupDir', async () => {
    listBackupsMock.mockResolvedValue([{ name: 'b1.db' }])
    getBackupDirectoryMock.mockReturnValue('/mock/backup/dir')
    registerBackupHandlers(makeCtx())
    const handler = getHandler('backup:list')
    const result = (await handler()) as {
      success: true
      data: { backups: unknown[]; backupDir: string }
    }
    expect(listBackupsMock).toHaveBeenCalled()
    expect(result.data.backups).toEqual([{ name: 'b1.db' }])
    expect(result.data.backupDir).toBe('/mock/backup/dir')
  })

  it('backup:list 抛错时返回 INTERNAL_ERROR', async () => {
    listBackupsMock.mockRejectedValue(new Error('读取目录失败'))
    registerBackupHandlers(makeCtx())
    const handler = getHandler('backup:list')
    const result = (await handler()) as { success: false; error: { code: string } }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
  })

  it('backup:restore 成功时返回 result', async () => {
    restoreBackupMock.mockResolvedValue({ success: true })
    registerBackupHandlers(makeCtx())
    const handler = getHandler('backup:restore')
    const result = await handler(['wxnn_photo_manager_20260101_120000.db'])
    expect(restoreBackupMock).toHaveBeenCalledWith('wxnn_photo_manager_20260101_120000.db')
    expect(result).toEqual({ success: true, data: { success: true } })
  })

  it('backup:restore 抛错时返回 INTERNAL_ERROR', async () => {
    restoreBackupMock.mockRejectedValue(new Error('文件损坏'))
    registerBackupHandlers(makeCtx())
    const handler = getHandler('backup:restore')
    const result = (await handler(['wxnn_photo_manager_20260101_120000.db'])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.message).toContain('恢复备份失败')
    expect(result.error.message).toContain('文件损坏')
  })

  it('backup:delete 成功时返回 service 结果', async () => {
    deleteBackupMock.mockResolvedValue({ success: true })
    registerBackupHandlers(makeCtx())
    const handler = getHandler('backup:delete')
    const result = await handler(['wxnn_photo_manager_20260101_120000.db'])
    expect(deleteBackupMock).toHaveBeenCalledWith('wxnn_photo_manager_20260101_120000.db')
    expect(result).toEqual({ success: true, data: { success: true } })
  })

  it('backup:delete 抛错时返回 INTERNAL_ERROR', async () => {
    deleteBackupMock.mockRejectedValue(new Error('权限不足'))
    registerBackupHandlers(makeCtx())
    const handler = getHandler('backup:delete')
    const result = (await handler(['wxnn_photo_manager_20260101_120000.db'])) as {
      success: false
      error: { code: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
  })

  it('backup:getDir 返回备份目录字符串', async () => {
    getBackupDirectoryMock.mockReturnValue('/mock/backup/dir')
    registerBackupHandlers(makeCtx())
    const handler = getHandler('backup:getDir')
    const result = (await handler()) as { success: true; data: string }
    expect(getBackupDirectoryMock).toHaveBeenCalled()
    expect(result.data).toBe('/mock/backup/dir')
  })
})
