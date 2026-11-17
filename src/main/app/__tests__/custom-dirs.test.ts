/**
 * @layer L3
 * @module src/main/app/custom-dirs
 * @coverage applyCustomDirectories + 私有 applyCustomDir（backup/thumbnail 通用迁移流程）
 * @dependencies electron (app)、services/backup-service、utils/dir-manager、
 *               utils/startup-diagnostic、app/forensics-migrate（mock）
 *
 * 难点：
 * 1. backupDir / thumbnailCacheDir 共用 applyCustomDir 私有函数，需逐个验证副作用
 * 2. logDir / crashDir 已强制统一，委托 unifyForensicsDirs（真实迁移/接线逻辑由
 *    forensics-migrate.test.ts 覆盖），本套件 mock 之并断言委托发生
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
  loggerInfoMock,
  unifyForensicsDirsMock
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
  loggerInfoMock: vi.fn(),
  unifyForensicsDirsMock: vi.fn()
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
    backupDir: /^meow_star_map_.*\.db$/,
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

vi.mock('../forensics-migrate', () => ({
  unifyForensicsDirs: unifyForensicsDirsMock
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
  unifyForensicsDirsMock.mockReset()
  unifyForensicsDirsMock.mockResolvedValue(undefined)

  appGetPathMock.mockReturnValue('/mock/userData')
  // 默认：resolveCustomDir 返回与默认目录不同的路径（触发迁移）
  resolveCustomDirMock.mockImplementation((_dbManager: unknown, key: string) => {
    return `/custom/${key}`
  })
  // 默认：migrateDirFiles 返回 moved:0
  migrateDirFilesMock.mockResolvedValue({ moved: 0, failed: 0 })
})

describe('applyCustomDirectories', () => {
  it('1. backup/thumbnail 走通用流程，logDir/crashDir 委托统一接线', async () => {
    const ctx = makeAppCtx({ thumbnailGenExt: { setDir: vi.fn(), setCacheLimitBytes: vi.fn() } })

    await applyCustomDirectories(ctx)

    expect(resolveCustomDirMock).toHaveBeenCalledTimes(2)
    expect(ensureDirMock).toHaveBeenCalledTimes(2)
    const keys = resolveCustomDirMock.mock.calls.map((c) => c[1] as string)
    expect(keys).toContain('backupDir')
    expect(keys).toContain('thumbnailCacheDir')
    expect(keys).not.toContain('logDir')
    expect(keys).not.toContain('crashDir')
    expect(unifyForensicsDirsMock).toHaveBeenCalledWith(ctx)
  })

  it('2. 自定义目录与默认目录不同时调用 migrateDirFiles（仅 backup/thumbnail）', async () => {
    const ctx = makeAppCtx({ thumbnailGenExt: { setDir: vi.fn(), setCacheLimitBytes: vi.fn() } })

    await applyCustomDirectories(ctx)

    expect(migrateDirFilesMock).toHaveBeenCalledTimes(2)
  })

  it('3. 自定义目录与默认目录相同时跳过迁移', async () => {
    // resolveCustomDir 返回与默认目录相同的路径（用 path.join 适配平台路径分隔符）
    resolveCustomDirMock.mockImplementation((_dbManager: unknown, key: string) => {
      const subdirs: Record<string, string> = {
        backupDir: 'backups',
        thumbnailCacheDir: 'thumbnails'
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

  it('8. logDir/crashDir 不再走自定义流程，统一委托 unifyForensicsDirs（接线断言见 forensics-migrate.test.ts）', async () => {
    const ctx = makeAppCtx({ thumbnailGenExt: { setDir: vi.fn(), setCacheLimitBytes: vi.fn() } })

    await applyCustomDirectories(ctx)

    expect(unifyForensicsDirsMock).toHaveBeenCalledTimes(1)
    expect(unifyForensicsDirsMock).toHaveBeenCalledWith(ctx)
    // 通用流程不得再触碰日志/崩溃目录
    expect(setLogDirectoryMock).not.toHaveBeenCalled()
    expect(setCrashDirectoryMock).not.toHaveBeenCalled()
    expect(appSetPathMock).not.toHaveBeenCalled()
  })

  it('9. unifyForensicsDirs 在 backup/thumbnail 之后调用（crashReporter.start 前完成接线）', async () => {
    const ctx = makeAppCtx({ thumbnailGenExt: { setDir: vi.fn(), setCacheLimitBytes: vi.fn() } })

    await applyCustomDirectories(ctx)

    expect(backupSetDirMock).toHaveBeenCalled()
    expect(unifyForensicsDirsMock).toHaveBeenCalled()
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

  it('12. setSetting 仅持久化 backup/thumbnail（logDir/crashDir 由统一接线清键，不在此持久化）', async () => {
    const ctx = makeAppCtx({ thumbnailGenExt: { setDir: vi.fn(), setCacheLimitBytes: vi.fn() } })

    await applyCustomDirectories(ctx)

    expect(ctx.dbManager.setSetting).toHaveBeenCalledTimes(2)
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('backupDir', '/custom/backupDir')
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith(
      'thumbnailCacheDir',
      '/custom/thumbnailCacheDir'
    )
    expect(ctx.dbManager.setSetting).not.toHaveBeenCalledWith('logDir', expect.anything())
    expect(ctx.dbManager.setSetting).not.toHaveBeenCalledWith('crashDir', expect.anything())
  })
})
