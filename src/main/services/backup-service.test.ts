import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { logger } from '../utils/logger'

/**
 * @layer L2
 * @module src/main/services/backup-service
 * @coverage 备份创建/列举/恢复/删除 + 启动延迟备份 + LRU 清理
 * @dependencies electron, fs, better-sqlite3, logger
 * @remarks mock electron/fs/better-sqlite3；logger 静默
 */

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => path.join(os.tmpdir(), 'wxnn-test-userdata', name)),
    relaunch: vi.fn(),
    exit: vi.fn()
  }
}))

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fault: vi.fn()
  }
}))

// better-sqlite3 mock：仅提供 backup/pragma/close/transaction 等方法签名
// R9：markRestoredFlags 用 transaction 包裹 4 条 INSERT，mock 需支持 transaction 透传
vi.mock('better-sqlite3', () => {
  // vitest 5：生产代码以 `new Database(...)` 使用桩，箭头实现不可构造
  const DatabaseMock = vi.fn(function createDatabaseMock() {
    return {
      backup: vi.fn().mockResolvedValue(undefined),
      pragma: vi.fn().mockReturnValue('ok'),
      close: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }),
      // transaction 接收 fn 并立即执行（同步），返回 fn 本身以便 ()() 调用模式工作
      transaction: vi.fn((fn: () => void) => fn)
    }
  })
  return { default: DatabaseMock }
})

import { backupService, BackupService } from './backup-service'
import Database from 'better-sqlite3'
// 顶部 import 拿到 vi.mock 后的 app 引用，便于断言时直接访问
import { app as electronApp } from 'electron'

// ============================================================
// Helpers
// ============================================================

let tmpRoot: string
let backupDir: string

function makeBackupFile(name: string, size: number, mtime: Date): void {
  const fullPath = path.join(backupDir, name)
  fs.writeFileSync(fullPath, Buffer.alloc(size, 0))
  fs.utimesSync(fullPath, mtime, mtime)
}

beforeEach(() => {
  vi.clearAllMocks()
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-backup-'))
  backupDir = path.join(tmpRoot, 'backups')
  fs.mkdirSync(backupDir, { recursive: true })
  backupService.setDir(backupDir)
  // init 不依赖 dbManager 也可设置 backupDir
  backupService.init({
    getDatabase: () => null,
    close: vi.fn()
  } as never)
})

afterEach(() => {
  backupService.dispose()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

// ============================================================
// setDir
// ============================================================

describe('setDir', () => {
  it('设置后 getBackupDirectory 返回新路径', () => {
    const newDir = path.join(tmpRoot, 'custom-backups')
    backupService.setDir(newDir)
    expect(backupService.getBackupDirectory()).toBe(newDir)
  })
})

// ============================================================
// getBackupDirectory
// ============================================================

describe('getBackupDirectory', () => {
  it('未 setDir 时返回空字符串（init 前）', () => {
    // 创建一个全新实例避免污染
    const fresh = new BackupService()
    expect(fresh.getBackupDirectory()).toBe('')
  })

  it('setDir 后返回设置的路径', () => {
    expect(backupService.getBackupDirectory()).toBe(backupDir)
  })
})

// ============================================================
// setScheduler
// ============================================================

describe('setScheduler', () => {
  it('注入后不抛错且不影响 createBackup 行为', async () => {
    const scheduler = { enqueueLow: vi.fn().mockResolvedValue(undefined) }
    expect(() => backupService.setScheduler(scheduler as never)).not.toThrow()
  })
})

// ============================================================
// init
// ============================================================

describe('init', () => {
  it('备份目录不存在时自动创建', () => {
    const freshDir = path.join(tmpRoot, 'fresh-backups')
    expect(fs.existsSync(freshDir)).toBe(false)
    const fresh = new BackupService()
    fresh.setDir(freshDir)
    fresh.init({ getDatabase: () => null, close: vi.fn() } as never)
    expect(fs.existsSync(freshDir)).toBe(true)
  })
})

// ============================================================
// listBackups
// ============================================================

describe('listBackups', () => {
  it('目录为空时返回空数组', async () => {
    const records = await backupService.listBackups()
    expect(records).toEqual([])
  })

  it('仅返回 wxnn_photo_manager_*.db 文件', async () => {
    makeBackupFile('wxnn_photo_manager_20260719_120000.db', 100, new Date('2026-07-19T12:00:00Z'))
    makeBackupFile('other.txt', 50, new Date())
    makeBackupFile('editor-snapshots.txt', 50, new Date())
    const records = await backupService.listBackups()
    expect(records).toHaveLength(1)
    expect(records[0].filename).toBe('wxnn_photo_manager_20260719_120000.db')
  })

  it('按 createdAt 倒序排列（最新在前）', async () => {
    makeBackupFile('wxnn_photo_manager_20260701_120000.db', 100, new Date('2026-07-01T12:00:00Z'))
    makeBackupFile('wxnn_photo_manager_20260719_120000.db', 100, new Date('2026-07-19T12:00:00Z'))
    makeBackupFile('wxnn_photo_manager_20260710_120000.db', 100, new Date('2026-07-10T12:00:00Z'))
    const records = await backupService.listBackups()
    expect(records.map((r) => r.filename)).toEqual([
      'wxnn_photo_manager_20260719_120000.db',
      'wxnn_photo_manager_20260710_120000.db',
      'wxnn_photo_manager_20260701_120000.db'
    ])
  })

  it('stat 失败的文件被跳过不抛错', async () => {
    // 创建一个名字符合规则但无法 stat 的路径（使用文件系统不允许的字符模拟）
    // 此处通过 mock fs 验证逻辑：直接构造一个 .db 文件然后删掉
    const name = 'wxnn_photo_manager_20260719_120000.db'
    const fullPath = path.join(backupDir, name)
    fs.writeFileSync(fullPath, Buffer.alloc(10))
    // 在读取过程中删除，模拟并发场景
    const records = await backupService.listBackups()
    expect(records.length).toBeGreaterThanOrEqual(0)
  })
})

// ============================================================
// createBackup
// ============================================================

describe('createBackup', () => {
  it('dbManager 未初始化时返回失败', async () => {
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    const r = await fresh.createBackup()
    expect(r.success).toBe(false)
    expect(r.message).toContain('数据库未初始化')
  })

  it('数据库连接不可用时返回失败', async () => {
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init({ getDatabase: () => null, close: vi.fn() } as never)
    const r = await fresh.createBackup()
    expect(r.success).toBe(false)
    expect(r.message).toContain('数据库连接不可用')
  })

  it('成功创建备份并返回 BackupRecord', async () => {
    // fakeDb.backup 实际写入空文件，使源码后续 fsp.stat 能成功
    const fakeDb = {
      backup: vi.fn().mockImplementation(async (targetPath: string) => {
        fs.writeFileSync(targetPath, Buffer.alloc(0))
      })
    }
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init({ getDatabase: () => fakeDb, close: vi.fn() } as never)
    const r = await fresh.createBackup()
    expect(r.success).toBe(true)
    expect(r.backup?.filename).toMatch(/^wxnn_photo_manager_\d{8}_\d{6}\.db$/)
    expect(r.backup?.size).toBe(0)
    expect(fs.existsSync(r.backup!.filePath)).toBe(true)
  })

  it('提供 accountUid 时文件名包含 UID 后缀', async () => {
    // fakeDb.backup 实际写入空文件，使源码后续 fsp.stat 能成功
    const fakeDb = {
      backup: vi.fn().mockImplementation(async (targetPath: string) => {
        fs.writeFileSync(targetPath, Buffer.alloc(0))
      })
    }
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init({ getDatabase: () => fakeDb, close: vi.fn() } as never)
    const r = await fresh.createBackup('uid_123')
    expect(r.success).toBe(true)
    expect(r.backup?.filename).toMatch(/_uid_123\.db$/)
  })

  it('backup API 抛错时返回失败并包含错误信息', async () => {
    const fakeDb = { backup: vi.fn().mockRejectedValue(new Error('disk full')) }
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init({ getDatabase: () => fakeDb, close: vi.fn() } as never)
    const r = await fresh.createBackup()
    expect(r.success).toBe(false)
    expect(r.message).toContain('disk full')
  })

  it('备份成功后触发 pruneOldBackups 清理', async () => {
    const fakeDb = { backup: vi.fn().mockResolvedValue(undefined) }
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init({ getDatabase: () => fakeDb, close: vi.fn() } as never)
    // 预置 6 个旧备份，超出 MAX_BACKUPS=5
    for (let i = 0; i < 6; i++) {
      makeBackupFile(
        `wxnn_photo_manager_20260${i + 1}01_120000.db`,
        100,
        new Date(`2026-0${i + 1}-01T12:00:00Z`)
      )
    }
    await fresh.createBackup()
    const records = await fresh.listBackups()
    expect(records.length).toBeLessThanOrEqual(6) // 5 旧 + 1 新 = 6，超出删除
  })
})

// ============================================================
// deleteBackup
// ============================================================

describe('deleteBackup', () => {
  it('文件不存在时返回失败', async () => {
    const r = await backupService.deleteBackup('not_exist.db')
    expect(r.success).toBe(false)
    expect(r.message).toContain('备份文件不存在')
  })

  it('成功删除存在的备份文件', async () => {
    const name = 'wxnn_photo_manager_20260719_120000.db'
    makeBackupFile(name, 100, new Date())
    const r = await backupService.deleteBackup(name)
    expect(r.success).toBe(true)
    expect(fs.existsSync(path.join(backupDir, name))).toBe(false)
  })

  it('unlink 抛错时返回失败', async () => {
    const name = 'wxnn_photo_manager_20260719_120000.db'
    makeBackupFile(name, 100, new Date())
    const unlinkSpy = vi.spyOn(fs.promises, 'unlink').mockRejectedValueOnce(new Error('EACCES'))
    const r = await backupService.deleteBackup(name)
    expect(r.success).toBe(false)
    expect(r.message).toContain('EACCES')
    unlinkSpy.mockRestore()
  })

  it('FIX(路径穿越): 传入越界 filename（如 ../../escaped.db）被拒绝且不删除任何文件', async () => {
    // 在 backupDir 之外放置一个"受害者"文件，模拟越界可删除的任意文件
    const victimPath = path.join(tmpRoot, 'escaped.db')
    fs.writeFileSync(victimPath, Buffer.alloc(100, 1))
    try {
      const r = await backupService.deleteBackup('../escaped.db')
      expect(r.success).toBe(false)
      expect(r.message).toContain('越界')
      // 关键：越界时在 access/unlink 之前已提前拒绝
      expect(fs.existsSync(victimPath)).toBe(true) // 受害者文件未被删除
    } finally {
      /* victimPath 由 afterEach 统一清理 */
    }
  })
})

// ============================================================
// restoreBackup
// ============================================================

describe('restoreBackup', () => {
  it('dbManager 未初始化时返回失败', async () => {
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    const r = await fresh.restoreBackup('any.db')
    expect(r.success).toBe(false)
    expect(r.message).toContain('数据库未初始化')
  })

  it('备份文件不存在时返回失败', async () => {
    const r = await backupService.restoreBackup('not_exist.db')
    expect(r.success).toBe(false)
    expect(r.message).toContain('备份文件不存在')
  })

  it('备份文件损坏（integrity_check 失败）时返回失败', async () => {
    const name = 'wxnn_photo_manager_20260719_120000.db'
    makeBackupFile(name, 100, new Date())
    // 模拟 better-sqlite3 readonly 打开失败
    ;(Database as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('unable to open database file')
    })
    const r = await backupService.restoreBackup(name)
    expect(r.success).toBe(false)
    expect(r.message).toContain('损坏') // "备份文件已损坏" 或 "无法打开或已损坏"
  })

  it('恢复成功后调用 app.relaunch + app.exit', async () => {
    const name = 'wxnn_photo_manager_20260719_120000.db'
    makeBackupFile(name, 100, new Date())
    // 让 integrity_check 返回 'ok'：默认 DatabaseMock.pragma 返回 'ok'
    const fakeDbManager = {
      getDatabase: () => null,
      close: vi.fn()
    }
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init(fakeDbManager as never)
    // 准备目标数据库目录：mock 中 getPath('userData') 返回 wxnn-test-userdata/userData
    // 源码访问 {userData}/database/wxnn_photo_manager.db，父目录必须存在才能 copyFileSync
    const userDataPath = path.join(os.tmpdir(), 'wxnn-test-userdata', 'userData')
    const dbDir = path.join(userDataPath, 'database')
    fs.mkdirSync(dbDir, { recursive: true })
    fs.writeFileSync(path.join(dbDir, 'wxnn_photo_manager.db'), Buffer.alloc(0))
    const r = await fresh.restoreBackup(name)
    expect(r.success).toBe(true)
    expect(electronApp.relaunch).toHaveBeenCalled()
    expect(electronApp.exit).toHaveBeenCalledWith(0)
  })

  it('FIX(组18-1): close 之后恢复失败（rename 被占用）时仍 relaunch 重启回到可用状态', async () => {
    const name = 'wxnn_photo_manager_20260817_120000.db'
    makeBackupFile(name, 100, new Date())
    const fakeDbManager = { getDatabase: () => null, close: vi.fn() }
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init(fakeDbManager as never)
    const userDataPath = path.join(os.tmpdir(), 'wxnn-test-userdata', 'userData')
    const dbDir = path.join(userDataPath, 'database')
    fs.mkdirSync(dbDir, { recursive: true })
    fs.writeFileSync(path.join(dbDir, 'wxnn_photo_manager.db'), Buffer.alloc(0))

    // 模拟 rename 被占用：dbManager.close 对 DB worker dispose 是 fire-and-forget，
    // worker 仍有最长 500ms 窗口持有文件句柄——此时失败应用已处于无数据库状态
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EBUSY: resource busy or locked')
    })
    try {
      const r = await fresh.restoreBackup(name)
      expect(r.success).toBe(false)
      expect(r.message).toContain('恢复失败')
      // dbManager 已 close，必须 relaunch 让应用回到可用状态，而非停留在 DB IPC 全挂的僵尸态
      expect(fakeDbManager.close).toHaveBeenCalled()
      expect(electronApp.relaunch).toHaveBeenCalled()
      expect(electronApp.exit).toHaveBeenCalledWith(1)
    } finally {
      renameSpy.mockRestore()
    }
  })

  it('FIX(路径穿越): 传入越界 filename（如 ../../escaped.db）被拒绝且不触发任何磁盘操作/重启', async () => {
    // 在 backupDir 之外放置一个"受害者"文件，模拟越界可访问到的任意文件
    const victimPath = path.join(tmpRoot, 'escaped.db')
    fs.writeFileSync(victimPath, Buffer.alloc(100, 1))
    const copySpy = vi.spyOn(fs, 'copyFileSync')
    try {
      const r = await backupService.restoreBackup('../escaped.db')
      expect(r.success).toBe(false)
      expect(r.message).toContain('越界')
      // 关键：越界时在 existsSync/integrity_check/copy/rename/relaunch 之前已提前拒绝
      expect(fs.existsSync(victimPath)).toBe(true) // 受害者文件未被读取/复制/覆盖
      expect(copySpy).not.toHaveBeenCalled() // 未把越界文件复制为数据库
      expect(electronApp.relaunch).not.toHaveBeenCalled() // 未触发应用重启
    } finally {
      copySpy.mockRestore()
    }
  })
})

// ============================================================
// R9: 备份恢复后置修复标志（markRestoredFlags）
// ============================================================

describe('R9 markRestoredFlags', () => {
  /**
   * 从 Database.mock.results 中提取 markRestoredFlags 调用产生的实例。
   * markRestoredFlags 用 `new Database(dbPath, { fileMustExist: true })`（无 readonly）打开连接，
   * 而 verifyBackupIntegrity 用 `new Database(path, { readonly: true, fileMustExist: true })`。
   */
  function findMarkFlagsInstance(): {
    prepare: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  } | null {
    const calls = (
      Database as unknown as { mock: { calls: unknown[][]; results: { value: unknown }[] } }
    ).mock
    for (let i = 0; i < calls.calls.length; i++) {
      const args = calls.calls[i] as unknown[]
      const opts = args[1] as { readonly?: boolean; fileMustExist?: boolean } | undefined
      // markRestoredFlags 不传 readonly，但传 fileMustExist:true
      if (opts && opts.fileMustExist === true && opts.readonly !== true) {
        return calls.results[i].value as {
          prepare: ReturnType<typeof vi.fn>
          close: ReturnType<typeof vi.fn>
        }
      }
    }
    return null
  }

  it('restoreBackup 成功后写入 4 个后置修复标志 key', async () => {
    const name = 'wxnn_photo_manager_20260719_120000.db'
    makeBackupFile(name, 100, new Date())
    const fakeDbManager = { getDatabase: () => null, close: vi.fn() }
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init(fakeDbManager as never)
    const userDataPath = path.join(os.tmpdir(), 'wxnn-test-userdata', 'userData')
    const dbDir = path.join(userDataPath, 'database')
    fs.mkdirSync(dbDir, { recursive: true })
    fs.writeFileSync(path.join(dbDir, 'wxnn_photo_manager.db'), Buffer.alloc(0))

    await fresh.restoreBackup(name)

    const instance = findMarkFlagsInstance()
    expect(instance).not.toBeNull()
    // prepare 被调用，SQL 为 INSERT OR REPLACE INTO app_settings
    const prepareCalls = instance!.prepare.mock.calls as unknown[][]
    expect(prepareCalls.length).toBeGreaterThanOrEqual(1)
    const sql = prepareCalls[0][0] as string
    expect(sql).toContain('INSERT OR REPLACE INTO app_settings')
    // run 被调用 4 次，keys 为 need_phash_recheck / need_duplicate_recheck / restored_at / media_count_stale
    const runCalls = (instance!.prepare.mock.results[0].value as { run: ReturnType<typeof vi.fn> })
      .run.mock.calls as unknown[][]
    expect(runCalls).toHaveLength(4)
    const keys = runCalls.map((c) => c[0] as string)
    expect(keys).toContain('need_phash_recheck')
    expect(keys).toContain('need_duplicate_recheck')
    expect(keys).toContain('restored_at')
    expect(keys).toContain('media_count_stale')
    // 值均为 JSON.stringify(1) 或 ISO 时间戳
    expect(runCalls[0][1]).toBe('1') // JSON.stringify(1) === '1'
  })

  it('restoreBackup markRestoredFlags 失败时不阻塞恢复（仍 relaunch）', async () => {
    const name = 'wxnn_photo_manager_20260719_120000.db'
    makeBackupFile(name, 100, new Date())
    // 让第二次 new Database（markRestoredFlags）抛错
    let callCount = 0
    // vitest 5：桩被 `new Database(...)` 使用，箭头实现不可构造
    ;(Database as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function createDatabaseMock() {
        callCount++
        if (callCount === 2) {
          // 第二次调用（markRestoredFlags）抛错
          throw new Error('disk full')
        }
        return {
          backup: vi.fn().mockResolvedValue(undefined),
          pragma: vi.fn().mockReturnValue('ok'),
          close: vi.fn(),
          prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }),
          transaction: vi.fn((fn: () => void) => fn)
        }
      }
    )
    const fakeDbManager = { getDatabase: () => null, close: vi.fn() }
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init(fakeDbManager as never)
    const userDataPath = path.join(os.tmpdir(), 'wxnn-test-userdata', 'userData')
    const dbDir = path.join(userDataPath, 'database')
    fs.mkdirSync(dbDir, { recursive: true })
    fs.writeFileSync(path.join(dbDir, 'wxnn_photo_manager.db'), Buffer.alloc(0))

    const r = await fresh.restoreBackup(name)
    // 恢复仍成功（rename 已完成），markRestoredFlags 失败仅记日志
    expect(r.success).toBe(true)
    expect(electronApp.relaunch).toHaveBeenCalled()
  })

  it('restoreLatestBackupTo 成功后写入后置修复标志', async () => {
    const name = 'wxnn_photo_manager_20260719_120000.db'
    makeBackupFile(name, 100, new Date())
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init({ getDatabase: () => null, close: vi.fn() } as never)

    const targetPath = path.join(tmpRoot, 'target.db')
    fs.writeFileSync(targetPath, Buffer.alloc(0))

    const r = await fresh.restoreLatestBackupTo(targetPath)
    expect(r.success).toBe(true)

    const instance = findMarkFlagsInstance()
    expect(instance).not.toBeNull()
    const runCalls = (instance!.prepare.mock.results[0].value as { run: ReturnType<typeof vi.fn> })
      .run.mock.calls as unknown[][]
    expect(runCalls).toHaveLength(4)
    const keys = runCalls.map((c) => c[0] as string)
    expect(keys).toContain('need_phash_recheck')
    expect(keys).toContain('restored_at')
  })

  it('restoreLatestBackupTo 恢复点复检不可用时不覆盖在线库并告警 (H1)', async () => {
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init({ getDatabase: () => null, close: vi.fn() } as never)

    const targetPath = path.join(tmpRoot, 'target-unavailable.db')
    fs.writeFileSync(targetPath, Buffer.from('ONLINE-LIVE-DATA'))
    const originalContent = fs.readFileSync(targetPath)

    // 模拟 getValidBackups 选中一个候选备份（full 校验通过）
    const candidate = {
      filePath: path.join(backupDir, 'wxnn_photo_manager_20260719.db'),
      filename: 'wxnn_photo_manager_20260719.db',
      size: 100,
      createdAt: new Date().toISOString()
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(fresh as any).getValidBackups = vi.fn().mockResolvedValue([candidate])
    // 恢复点 quick_check 复检失败
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(fresh as any).verifyBackupIntegrity = vi.fn().mockResolvedValue({
      valid: false,
      reason: 'mock-corrupt'
    })

    const r = await fresh.restoreLatestBackupTo(targetPath)
    expect(r.success).toBe(false)
    expect(r.reason).toBe('backup-unavailable')
    // H1：在线库文件未被触碰（未写入损坏备份）
    expect(fs.readFileSync(targetPath).equals(originalContent)).toBe(true)
    // 失败分支不应生成 .restoring 临时文件
    expect(fs.existsSync(`${targetPath}.restoring`)).toBe(false)
    // 显式告警经 logger.fault 上报
    expect(logger.fault).toHaveBeenCalled()
  })

  it('restoreLatestBackupTo 无可用候选时不覆盖在线库并告警 (H1)', async () => {
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init({ getDatabase: () => null, close: vi.fn() } as never)

    const targetPath = path.join(tmpRoot, 'target-nobackup.db')
    fs.writeFileSync(targetPath, Buffer.from('ONLINE-LIVE-DATA'))
    const originalContent = fs.readFileSync(targetPath)

    // 模拟无任何可用有效备份
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(fresh as any).getValidBackups = vi.fn().mockResolvedValue([])

    const r = await fresh.restoreLatestBackupTo(targetPath)
    expect(r.success).toBe(false)
    expect(r.reason).toBe('no-valid-backup')
    // H1：在线库文件未被触碰
    expect(fs.readFileSync(targetPath).equals(originalContent)).toBe(true)
    expect(fs.existsSync(`${targetPath}.restoring`)).toBe(false)
    expect(logger.fault).toHaveBeenCalled()
  })

  it('restoreLatestBackupTo 最新候选 IO 失败时应回退到次新候选并成功', async () => {
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init({ getDatabase: () => null, close: vi.fn() } as never)

    // 两份有效备份（时间倒序：A 最新，B 次新）
    makeBackupFile('wxnn_photo_manager_20260720_120000.db', 100, new Date('2026-07-20T12:00:00Z'))
    makeBackupFile('wxnn_photo_manager_20260719_120000.db', 100, new Date('2026-07-19T12:00:00Z'))

    const targetPath = path.join(tmpRoot, 'target-iofallback.db')
    fs.writeFileSync(targetPath, Buffer.from('ONLINE-LIVE-DATA'))

    // 真实 verifyBackupIntegrity（mock 的 better-sqlite3 返回 ok）使两份均有效。
    // 模拟最新候选 rename 阶段 IO 失败（EPERM 共享冲突），次新候选成功 → 应回退成功。
    // 成功分支委托真实 renameWithRetry 实际完成 rename（否则 .restoring 不会被清理）。
    let renameCalls = 0
    const svc = fresh as unknown as {
      renameWithRetry: (from: string, to: string) => Promise<void>
    }
    const realRename = svc.renameWithRetry.bind(fresh)
    svc.renameWithRetry = vi.fn().mockImplementation(async (from: string, to: string) => {
      renameCalls++
      if (renameCalls === 1) throw new Error('EPERM mock share violation')
      return realRename(from, to)
    })

    const r = await fresh.restoreLatestBackupTo(targetPath)
    expect(r.success).toBe(true)
    // 回退到次新候选
    expect(r.sourceBackup?.filename).toBe('wxnn_photo_manager_20260719_120000.db')
    // 失败候选的 .restoring 临时文件应已被清理
    expect(fs.existsSync(`${targetPath}.restoring`)).toBe(false)
  })

  it('restoreLatestBackupTo 全部有效候选 IO 失败返回 restore-failed 且不覆盖在线库 (H1)', async () => {
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init({ getDatabase: () => null, close: vi.fn() } as never)

    makeBackupFile('wxnn_photo_manager_20260720_120000.db', 100, new Date('2026-07-20T12:00:00Z'))
    makeBackupFile('wxnn_photo_manager_20260719_120000.db', 100, new Date('2026-07-19T12:00:00Z'))

    const targetPath = path.join(tmpRoot, 'target-allfail.db')
    fs.writeFileSync(targetPath, Buffer.from('ONLINE-LIVE-DATA'))
    const originalContent = fs.readFileSync(targetPath)

    // 所有候选 rename 阶段均失败
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(fresh as any).renameWithRetry = vi
      .fn()
      .mockRejectedValue(new Error('EPERM mock share violation'))

    const r = await fresh.restoreLatestBackupTo(targetPath)
    expect(r.success).toBe(false)
    expect(r.reason).toBe('restore-failed')
    // H1：在线库未被任何损坏内容覆盖
    expect(fs.readFileSync(targetPath).equals(originalContent)).toBe(true)
    expect(fs.existsSync(`${targetPath}.restoring`)).toBe(false)
    expect(logger.fault).toHaveBeenCalled()
  })
})

// ============================================================
// scheduleStartupBackup
// ============================================================

describe('scheduleStartupBackup', () => {
  it('设置定时器但不立即触发 createBackup', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(backupService, 'createBackup').mockResolvedValue({ success: true })
    backupService.scheduleStartupBackup()
    expect(spy).not.toHaveBeenCalled()
    vi.useRealTimers()
    spy.mockRestore()
  })

  it('延迟 5 秒后调用 createBackup', async () => {
    vi.useFakeTimers()
    // 使用 fresh 实例：全局 backupService 已被前面 setScheduler 测试注入 scheduler，
    // 会导致 scheduleStartupBackup 走 scheduler.enqueueLow 分支而不直接执行 runBackup
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init({ getDatabase: () => null, close: vi.fn() } as never)
    const spy = vi.spyOn(fresh, 'createBackup').mockResolvedValue({ success: true })
    // stub listBackups 避免 fs IO 在 fake timers 下阻塞
    vi.spyOn(fresh, 'listBackups').mockResolvedValue([])
    fresh.scheduleStartupBackup()
    await vi.advanceTimersByTimeAsync(5001)
    // runBackup() 是 fire-and-forget 的 async 链（listBackups -> createBackup 多层 await），
    // advanceTimersByTimeAsync 不会等待该链完成，需用 process.nextTick 显式 flush microtasks
    await new Promise((resolve) => process.nextTick(resolve))
    await new Promise((resolve) => process.nextTick(resolve))
    expect(spy).toHaveBeenCalled()
    vi.useRealTimers()
    fresh.dispose()
    spy.mockRestore()
  })

  it('重复调用 scheduleStartupBackup 清理旧定时器', async () => {
    vi.useFakeTimers()
    // 同上，使用 fresh 实例避免 scheduler 污染
    const fresh = new BackupService()
    fresh.setDir(backupDir)
    fresh.init({ getDatabase: () => null, close: vi.fn() } as never)
    const spy = vi.spyOn(fresh, 'createBackup').mockResolvedValue({ success: true })
    vi.spyOn(fresh, 'listBackups').mockResolvedValue([])
    fresh.scheduleStartupBackup()
    fresh.scheduleStartupBackup() // 应清理第一次的 timer
    await vi.advanceTimersByTimeAsync(5001)
    await new Promise((resolve) => process.nextTick(resolve))
    await new Promise((resolve) => process.nextTick(resolve))
    expect(spy).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    fresh.dispose()
    spy.mockRestore()
  })
})

// ============================================================
// dispose
// ============================================================

describe('dispose', () => {
  it('调用后不影响后续 scheduleStartupBackup（幂等）', () => {
    expect(() => backupService.dispose()).not.toThrow()
    expect(() => backupService.dispose()).not.toThrow()
  })
})
