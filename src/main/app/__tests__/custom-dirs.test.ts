/**
 * @layer L3
 * @module src/main/app/custom-dirs
 * @coverage applyCustomDirectories + 私有 applyCustomDir（4 个目录通用迁移流程）
 * @dependencies electron (app)、services/backup-service、utils/logger (setLogDirectory)、
 *               services/crash-service (setCrashDirectory)、utils/dir-manager、utils/startup-diagnostic
 *
 * 难点：
 * 1. 4 个目录（backupDir / thumbnailCacheDir / logDir / crashDir）共用 applyCustomDir 私有函数，需逐个验证副作用
 * 2. resolveCustomDir / ensureDir / migrateDirFiles 是 dir-manager 导出，需 mock
 * 3. fallback 分支：resolveCustomDir 抛错时回退到默认目录，postSetup 仍被调用
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import { makeAppCtx } from '../../ipc/handlers/_test-helpers'

// 共享 mock
const {
  appGetPathMock,
  appSetPathMock,
  backupSetDirMock,
  setLogDirectoryMock,
  setCrashDirectoryMock,
  resolveCustomDirMock,
  ensureDirMock,
  migrateDirFilesMock,
  logStartupErrorMock,
  loggerInfoMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(() => '/mock/userData'),
  appSetPathMock: vi.fn(),
  backupSetDirMock: vi.fn(),
  setLogDirectoryMock: vi.fn(),
  setCrashDirectoryMock: vi.fn(),
  resolveCustomDirMock: vi.fn(),
  ensureDirMock: vi.fn(),
  migrateDirFilesMock: vi.fn(),
  logStartupErrorMock: vi.fn(),
  loggerInfoMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: appGetPathMock,
    setPath: appSetPathMock
  }
}))

vi.mock('../../services/backup-service', () => ({
  backupService: { setDir: backupSetDirMock }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: loggerInfoMock, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setLogDirectory: setLogDirectoryMock
}))

vi.mock('../../services/crash-service', () => ({
  setCrashDirectory: setCrashDirectoryMock
}))

vi.mock('../../utils/dir-manager', () => ({
  resolveCustomDir: resolveCustomDirMock,
  ensureDir: ensureDirMock,
  migrateDirFiles: migrateDirFilesMock,
  MIGRATE_PATTERNS: {
    backupDir: /^wxnn_photo_manager_.*\.db$/,
    thumbnailCacheDir: /\.(jpg|jpeg|png|webp)$/i,
    logDir: /\.(log|jsonl)$/,
    crashDir: /\.(dmp|dump|crash)$/
  },
  SETTING_KEYS: {
    backupDir: 'backupDir',
    thumbnailCacheDir: 'thumbnailCacheDir',
    logDir: 'logDir',
    crashDir: 'crashDir'
  }
}))

vi.mock('../../utils/startup-diagnostic', () => ({
  logStartupError: logStartupErrorMock
}))

import { applyCustomDirectories } from '../custom-dirs'

beforeEach(() => {
  appGetPathMock.mockReset()
  appSetPathMock.mockReset()
  backupSetDirMock.mockReset()
  setLogDirectoryMock.mockReset()
  setCrashDirectoryMock.mockReset()
  resolveCustomDirMock.mockReset()
  ensureDirMock.mockReset()
  migrateDirFilesMock.mockReset()
  logStartupErrorMock.mockReset()
  loggerInfoMock.mockReset()

  appGetPathMock.mockReturnValue('/mock/userData')
  // 默认：resolveCustomDir 返回与默认目录不同的路径（触发迁移）
  resolveCustomDirMock.mockImplementation((_dbManager: unknown, key: string) => {
    return `/custom/${key}`
  })
  // 默认：migrateDirFiles 返回 moved:0
  migrateDirFilesMock.mockResolvedValue({ moved: 0, failed: 0 })
})

describe('applyCustomDirectories', () => {
  it('1. 4 个目录均调用 resolveCustomDir + ensureDir', async () => {
    const ctx = makeAppCtx({ thumbnailGenExt: { setDir: vi.fn(), setCacheLimitBytes: vi.fn() } })

    await applyCustomDirectories(ctx)

    expect(resolveCustomDirMock).toHaveBeenCalledTimes(4)
    expect(ensureDirMock).toHaveBeenCalledTimes(4)
    // 验证 4 个 key 都被解析
    const keys = resolveCustomDirMock.mock.calls.map((c) => c[1] as string)
    expect(keys).toContain('backupDir')
    expect(keys).toContain('thumbnailCacheDir')
    expect(keys).toContain('logDir')
    expect(keys).toContain('crashDir')
  })

  it('2. 自定义目录与默认目录不同时调用 migrateDirFiles', async () => {
    const ctx = makeAppCtx({ thumbnailGenExt: { setDir: vi.fn(), setCacheLimitBytes: vi.fn() } })

    await applyCustomDirectories(ctx)

    // resolveCustomDir 返回 /custom/{key}，默认是 /mock/userData/{subdir}，所以会调用 migrateDirFiles 4 次
    expect(migrateDirFilesMock).toHaveBeenCalledTimes(4)
  })

  it('3. 自定义目录与默认目录相同时跳过迁移', async () => {
    // resolveCustomDir 返回与默认目录相同的路径（用 path.join 适配平台路径分隔符）
    resolveCustomDirMock.mockImplementation((_dbManager: unknown, key: string) => {
      const subdirs: Record<string, string> = {
        backupDir: 'backups',
        thumbnailCacheDir: 'thumbnails',
        logDir: 'logs',
        crashDir: 'crashes'
      }
      return path.join('/mock/userData', subdirs[key])
    })
    const ctx = makeAppCtx({ thumbnailGenExt: { setDir: vi.fn(), setCacheLimitBytes: vi.fn() } })

    await applyCustomDirectories(ctx)

    expect(migrateDirFilesMock).not.toHaveBeenCalled()
  })

  it('4. migrateDirFiles 返回 moved>0 时 logger.info 输出迁移数量', async () => {
    migrateDirFilesMock.mockResolvedValue({ moved: 5, failed: 0 })
    const ctx = makeAppCtx({ thumbnailGenExt: { setDir: vi.fn(), setCacheLimitBytes: vi.fn() } })

    await applyCustomDirectories(ctx)

    // 实现通过 logger.info 输出迁移日志（custom-dirs.ts:91）
    expect(loggerInfoMock).toHaveBeenCalledWith(expect.stringContaining('[Dir] 迁移'))
  })

  it('5. backupDir 副作用：调用 backupService.setDir', async () => {
    const ctx = makeAppCtx({ thumbnailGenExt: { setDir: vi.fn(), setCacheLimitBytes: vi.fn() } })

    await applyCustomDirectories(ctx)

    expect(backupSetDirMock).toHaveBeenCalledWith('/custom/backupDir')
  })

  it('6. thumbnailCacheDir 副作用：调用 thumbnailGen.setDir + 恢复 setCacheLimitBytes', async () => {
    const setDir = vi.fn()
    const setCacheLimitBytes = vi.fn()
    const ctx = makeAppCtx({
      thumbnailGenExt: { setDir, setCacheLimitBytes }
    })
    // savedLimit >= 100MB 才恢复
    ctx.dbManager.getSetting.mockImplementation((key: string) => {
      if (key === 'thumbnailCacheLimitBytes') return 200 * 1024 * 1024
      return ''
    })

    await applyCustomDirectories(ctx)

    expect(setDir).toHaveBeenCalledWith('/custom/thumbnailCacheDir')
    expect(setCacheLimitBytes).toHaveBeenCalledWith(200 * 1024 * 1024)
  })

  it('7. thumbnailCacheLimitBytes < 100MB 时不恢复上限', async () => {
    const setDir = vi.fn()
    const setCacheLimitBytes = vi.fn()
    const ctx = makeAppCtx({
      thumbnailGenExt: { setDir, setCacheLimitBytes }
    })
    ctx.dbManager.getSetting.mockImplementation((key: string) => {
      if (key === 'thumbnailCacheLimitBytes') return 50 * 1024 * 1024 // 50MB < 100MB
      return ''
    })

    await applyCustomDirectories(ctx)

    expect(setDir).toHaveBeenCalledWith('/custom/thumbnailCacheDir')
    expect(setCacheLimitBytes).not.toHaveBeenCalled()
  })

  it('8. logDir 副作用：调用 setLogDirectory', async () => {
    const ctx = makeAppCtx({ thumbnailGenExt: { setDir: vi.fn(), setCacheLimitBytes: vi.fn() } })

    await applyCustomDirectories(ctx)

    expect(setLogDirectoryMock).toHaveBeenCalledWith('/custom/logDir')
  })

  it('9. crashDir 副作用：调用 app.setPath("crashDumps") + setCrashDirectory', async () => {
    const ctx = makeAppCtx({ thumbnailGenExt: { setDir: vi.fn(), setCacheLimitBytes: vi.fn() } })

    await applyCustomDirectories(ctx)

    expect(appSetPathMock).toHaveBeenCalledWith('crashDumps', '/custom/crashDir')
    expect(setCrashDirectoryMock).toHaveBeenCalledWith('/custom/crashDir')
  })

  it('10. resolveCustomDir 抛错时回退到默认目录，postSetup 仍被调用', async () => {
    // backupDir 抛错
    resolveCustomDirMock.mockImplementation((_dbManager: unknown, key: string) => {
      if (key === 'backupDir') throw new Error('resolve failed')
      return `/custom/${key}`
    })
    const ctx = makeAppCtx({ thumbnailGenExt: { setDir: vi.fn(), setCacheLimitBytes: vi.fn() } })

    await applyCustomDirectories(ctx)

    // 回退到默认 userData/backups。必须用**本文件已 import 的 path**（与被测代码同一绑定）：
    // `require('path')` 绕过 `vi.mock('path')`，在 `npm run test:ci-linux` 装置里会取到 win32
    // 的 join 而被测代码取到 posix，造出一条与 CI 无关的假红灯。
    const expectedBackupDir = path.join('/mock/userData', 'backups')
    expect(backupSetDirMock).toHaveBeenCalledWith(expectedBackupDir)
    // logStartupError 被调用
    expect(logStartupErrorMock).toHaveBeenCalledWith(
      'applyCustomDirectories.backups',
      expect.any(Error)
    )
  })

  it('11. fallback 也失败时记录 logStartupError 但不抛错', async () => {
    resolveCustomDirMock.mockImplementation(() => {
      throw new Error('resolve failed')
    })
    // ensureDir 在 fallback 时也抛错
    ensureDirMock.mockImplementation(() => {
      throw new Error('ensureDir failed')
    })
    const ctx = makeAppCtx({ thumbnailGenExt: { setDir: vi.fn(), setCacheLimitBytes: vi.fn() } })

    // 不抛错
    await expect(applyCustomDirectories(ctx)).resolves.toBeUndefined()
    // 4 个目录 + 4 个 fallback 都失败，logStartupError 至少 8 次
    expect(logStartupErrorMock).toHaveBeenCalledWith(
      'applyCustomDirectories.backups',
      expect.any(Error)
    )
    expect(logStartupErrorMock).toHaveBeenCalledWith(
      'applyCustomDirectories.backups.fallback',
      expect.any(Error)
    )
  })

  it('12. setSetting 持久化目录路径（4 次调用）', async () => {
    const ctx = makeAppCtx({ thumbnailGenExt: { setDir: vi.fn(), setCacheLimitBytes: vi.fn() } })

    await applyCustomDirectories(ctx)

    expect(ctx.dbManager.setSetting).toHaveBeenCalledTimes(4)
    // 各 key 持久化
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('backupDir', '/custom/backupDir')
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith(
      'thumbnailCacheDir',
      '/custom/thumbnailCacheDir'
    )
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('logDir', '/custom/logDir')
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('crashDir', '/custom/crashDir')
  })
})
