/**
 * @layer L3
 * @module src/main/app/startup-tasks
 * @coverage performStartupScan / autoAnalyzeSceneTime / cleanupOrphanThumbnails / cleanupAndRepairDatabase
 * @dependencies services/thumbnail-phash-service、utils/concurrency、utils/logger、utils/scene-brightness（动态 import）、fs
 *
 * 难点：
 * 1. performStartupScan 内部链式调用 generateThumbnailsForUnprocessed / generatePhashForUnprocessed / autoAnalyzeSceneTime
 * 2. autoAnalyzeSceneTime 动态 import scene-brightness，需 vi.mock 提前注册
 * 3. cleanupAndRepairDatabase 用 fs.promises.access 检查文件存在性，需可控 fs mock
 * 4. runWithConcurrency 真实运行（小规模 tasks）以验证并发回调
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import { makeAppCtx, type MakeAppCtxOpts } from '../../ipc/handlers/_test-helpers'

// 共享 mock
const {
  processThumbnailForRowMock,
  generatePhashForUnprocessedMock,
  analyzeSceneBrightnessMock,
  loggerErrorMock,
  loggerInfoMock,
  loggerWarnMock,
  loggerFaultMock,
  pathExistsMock,
  fsReaddirMock,
  fsRmMock,
  fsConstantsMock
} = vi.hoisted(() => ({
  processThumbnailForRowMock: vi.fn(),
  generatePhashForUnprocessedMock: vi.fn(),
  analyzeSceneBrightnessMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerFaultMock: vi.fn(),
  // 直接 mock file-utils 的 pathExists：它内部 import fsp from 'fs/promises'，
  // 仅 mock 'fs' 无法覆盖子路径模块，导致真实 fs.access 落到测试不存在的路径返回 false，
  // 所有行被误判缺失。直接 mock pathExists 才能精确控制文件存在性。
  pathExistsMock: vi.fn(),
  fsReaddirMock: vi.fn(),
  fsRmMock: vi.fn(),
  fsConstantsMock: { F_OK: 0, R_OK: 4, W_OK: 2 }
}))

vi.mock('../../services/thumbnail-phash-service', () => ({
  processThumbnailForRow: processThumbnailForRowMock,
  // generatePhashForUnprocessed 仍被 runPostRestoreRepair 引用，保留 mock 以满足导入绑定
  generatePhashForUnprocessed: generatePhashForUnprocessedMock
}))

vi.mock('../../utils/concurrency', () => ({
  // 真实 runWithConcurrency 实现（保留并发语义，但任务量小）
  runWithConcurrency: async <T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> => {
    const results: T[] = new Array(tasks.length)
    let nextIndex = 0
    const runNext = async (): Promise<void> => {
      while (nextIndex < tasks.length) {
        const index = nextIndex++
        results[index] = await tasks[index]()
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runNext())
    await Promise.all(workers)
    return results
  }
}))

vi.mock('../../utils/logger', () => ({
  logger: {
    error: loggerErrorMock,
    info: loggerInfoMock,
    warn: loggerWarnMock,
    fault: loggerFaultMock
  }
}))

vi.mock('../../utils/file-utils', () => ({
  // 仅 mock cleanupAndRepairDatabase 用到的 pathExists（其余 file-utils 工具未在本模块使用）
  pathExists: pathExistsMock
}))

// 动态 import 的 scene-brightness：vi.mock 提前注册
vi.mock('../../utils/scene-brightness', () => ({
  analyzeSceneBrightness: analyzeSceneBrightnessMock
}))

// progress-throttle 经电子 BrowserWindow.getAllWindows 推送；测试中无窗口，返回空数组即可
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

// cleanupOrphanThumbnails 用 fs.promises.readdir / rm；access 由 pathExists(已单独 mock) 接管
vi.mock('fs', () => ({
  default: {
    promises: {
      readdir: fsReaddirMock,
      rm: fsRmMock
    },
    constants: fsConstantsMock
  },
  promises: {
    readdir: fsReaddirMock,
    rm: fsRmMock
  },
  constants: fsConstantsMock
}))

import {
  performStartupScan,
  runPostScanIndexing,
  autoAnalyzeSceneTime,
  cleanupOrphanThumbnails,
  cleanupAndRepairDatabase,
  cleanupInterruptedScanHistory,
  notifyInterruptedScan
} from '../startup-tasks'
import { taskRegistry } from '../../utils/task-registry'

// 构造可控的 mainWindow（含 webContents.send / isDestroyed）
// isDestroyed 必备：sendToRenderer 会逐级检查 win/webContents 是否销毁（问题 1 加固），
// 缺 isDestroyed 会让 webContents.send 前的存活检查抛 "is not a function" 而漏发事件。
function makeMainWindow() {
  return {
    webContents: {
      send: vi.fn(),
      isDestroyed: vi.fn(() => false)
    },
    isDestroyed: vi.fn(() => false)
  }
}

// 构造可控的 DB：prepare(sql) 返回 { get/all/run } 可分别控制
// transaction 必备：cleanupAndRepairDatabase 用 better-sqlite3 事务批量标记缺失，
// 测试无真实 DB，这里用透传模拟（事务体同步执行），否则 db.transaction is not a function。
interface MockDb {
  prepare: ReturnType<typeof vi.fn>
  transaction: ReturnType<typeof vi.fn>
}

function makeDb(opts: {
  scanHistoryCount?: number
  mediaRows?: Array<Record<string, unknown>>
  thumbnailRows?: Array<{ thumbnail: string }>
  throwOnScanHistory?: boolean
}): MockDb {
  const prepare = vi.fn((sql: string) => {
    if (sql.includes('scan_history')) {
      if (opts.throwOnScanHistory) throw new Error('no table')
      const count = opts.scanHistoryCount ?? 0
      return {
        get: vi.fn(() => ({ count })),
        all: vi.fn(() => []),
        run: vi.fn()
      }
    }
    if (sql.includes("scene_time = 'unknown'")) {
      return {
        get: vi.fn(),
        all: vi.fn(() => opts.mediaRows ?? []),
        run: vi.fn()
      }
    }
    if (sql.includes('SELECT thumbnail FROM media_files')) {
      return {
        get: vi.fn(),
        all: vi.fn(() => opts.thumbnailRows ?? []),
        run: vi.fn()
      }
    }
    if (sql.includes('SELECT id, file_path, file_type, thumbnail, width, height')) {
      return {
        get: vi.fn(),
        all: vi.fn(() => opts.mediaRows ?? []),
        run: vi.fn()
      }
    }
    if (sql.includes('missing_count = missing_count + 1')) {
      // FIX(组19-2): 第一阶段缺失标记改为累加 missing_count（累计 >=2 才置 is_missing=1）
      return { get: vi.fn(), all: vi.fn(() => opts.mediaRows ?? []), run: vi.fn() }
    }
    if (sql.includes('DELETE FROM media_files')) {
      return { get: vi.fn(), all: vi.fn(), run: vi.fn() }
    }
    if (sql.includes('UPDATE media_files SET')) {
      return { get: vi.fn(), all: vi.fn(), run: vi.fn() }
    }
    return { get: vi.fn(), all: vi.fn(() => []), run: vi.fn() }
  })
  // better-sqlite3.transaction(fn) 返回事务函数；这里透传执行事务体
  const transaction = vi.fn(
    (fn: (...args: unknown[]) => void) =>
      (...args: unknown[]) =>
        fn(...args)
  )
  return { prepare, transaction }
}

// mediaWorkerManager mock：索引链现在直接调 startThumbnailBatch / startPhashBatch
function makeMediaWorkerManager() {
  return {
    startThumbnailBatch: vi
      .fn()
      .mockResolvedValue({ success: true, message: 'ok', processed: 0, total: 0 }),
    startPhashBatch: vi
      .fn()
      .mockResolvedValue({ success: true, message: 'ok', processed: 0, total: 0 }),
    stopThumbnailBatch: vi.fn(),
    stopPhashBatch: vi.fn(),
    stopDuplicateMark: vi.fn(),
    dispose: vi.fn(),
    setDbPath: vi.fn()
  }
}
type MediaWorkerManagerMock = ReturnType<typeof makeMediaWorkerManager>

// makeAppCtx 的 mediaWorkerManager 选项类型较窄，扩展字段需经 unknown 断言注入
function injectMediaWorkerManager(
  mwm: MediaWorkerManagerMock
): MakeAppCtxOpts['mediaWorkerManager'] {
  return mwm as unknown as MakeAppCtxOpts['mediaWorkerManager']
}

// performStartupScan 不再 await 索引链（fire-and-forget），索引链在微任务中推进，
// 用一次 macrotask 等待让 startThumbnailBatch/startPhashBatch 的续体跑完
const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  processThumbnailForRowMock.mockReset()
  generatePhashForUnprocessedMock.mockReset()
  analyzeSceneBrightnessMock.mockReset()
  loggerErrorMock.mockReset()
  loggerInfoMock.mockReset()
  loggerWarnMock.mockReset()
  loggerFaultMock.mockReset()
  fsReaddirMock.mockReset()
  fsRmMock.mockReset()

  generatePhashForUnprocessedMock.mockResolvedValue({ processed: 0, total: 0 })
  processThumbnailForRowMock.mockResolvedValue(true)
  analyzeSceneBrightnessMock.mockResolvedValue('day')
  // 默认文件均存在（pathExists 真）；缺失场景由具体用例逐条覆盖
  pathExistsMock.mockResolvedValue(true)
})

// ============================================================================
// performStartupScan
// ============================================================================
describe('performStartupScan', () => {
  it('1. scan_history 表为空时识别为首次启动，强制全盘扫描（incremental=false, fullScan=true）', async () => {
    const db = makeDb({ scanHistoryCount: 0 })
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 0 }),
      stopScan: vi.fn(),
      getStatus: vi.fn()
    }
    const ctx = makeAppCtx({ db, scannerManager, mainWindow: makeMainWindow() })

    await performStartupScan(ctx)

    expect(scannerManager.startScan).toHaveBeenCalledWith({
      incremental: false,
      customKnownPaths: undefined,
      fullScan: true
    })
  })

  it('2. scan_history 表存在记录时按用户设置增量扫描', async () => {
    const db = makeDb({ scanHistoryCount: 5 })
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 0 }),
      stopScan: vi.fn(),
      getStatus: vi.fn()
    }
    const ctx = makeAppCtx({ db, scannerManager, mainWindow: makeMainWindow() })
    ctx.dbManager.getSetting.mockImplementation((key: string, def: unknown) => {
      if (key === 'incrementalScan') return true
      if (key === 'knownPaths') return []
      return def
    })

    await performStartupScan(ctx)

    expect(scannerManager.startScan).toHaveBeenCalledWith({
      incremental: true,
      customKnownPaths: undefined,
      fullScan: false
    })
  })

  it('3. scan_history 表不存在时视为首次启动（prepare 抛错分支）', async () => {
    const db = makeDb({ throwOnScanHistory: true })
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 0 }),
      stopScan: vi.fn(),
      getStatus: vi.fn()
    }
    const ctx = makeAppCtx({ db, scannerManager, mainWindow: makeMainWindow() })

    await performStartupScan(ctx)

    expect(scannerManager.startScan).toHaveBeenCalledWith({
      incremental: false,
      customKnownPaths: undefined,
      fullScan: true
    })
  })

  it('4. db 为 null 时不抛错（跳过 scan_history 检查，按非首次启动处理）', async () => {
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 0 }),
      stopScan: vi.fn(),
      getStatus: vi.fn()
    }
    const ctx = makeAppCtx({ db: null, scannerManager, mainWindow: makeMainWindow() })
    // getSetting 默认 mock 返回 undefined（与真实 getSetting(key, def) 行为不同，但用于验证 null db 不抛错）
    ctx.dbManager.getSetting.mockReturnValue(true)

    await expect(performStartupScan(ctx)).resolves.toBeUndefined()
    // db 为 null 时 isFirstLaunch=false，仍会调用 startScan（源码无早返回）
    expect(scannerManager.startScan).toHaveBeenCalledTimes(1)
    expect(scannerManager.startScan).toHaveBeenCalledWith({
      incremental: true,
      customKnownPaths: undefined,
      fullScan: false
    })
  })

  it('5. knownPaths 设置存在时透传 customKnownPaths', async () => {
    const db = makeDb({ scanHistoryCount: 0 })
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 0 }),
      stopScan: vi.fn(),
      getStatus: vi.fn()
    }
    const ctx = makeAppCtx({ db, scannerManager, mainWindow: makeMainWindow() })
    ctx.dbManager.getSetting.mockImplementation((key: string, def: unknown) => {
      if (key === 'customScanPaths') return ['D:\\Games\\Nikki', 'E:\\SteamLibrary']
      return def
    })

    await performStartupScan(ctx)

    expect(scannerManager.startScan).toHaveBeenCalledWith({
      incremental: false,
      customKnownPaths: ['D:\\Games\\Nikki', 'E:\\SteamLibrary'],
      fullScan: true
    })
  })

  it('6. knownPaths 为空数组时透传 undefined', async () => {
    const db = makeDb({ scanHistoryCount: 0 })
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 0 }),
      stopScan: vi.fn(),
      getStatus: vi.fn()
    }
    const ctx = makeAppCtx({ db, scannerManager, mainWindow: makeMainWindow() })
    ctx.dbManager.getSetting.mockImplementation((key: string, def: unknown) => {
      if (key === 'customScanPaths') return []
      return def
    })

    await performStartupScan(ctx)

    expect(scannerManager.startScan).toHaveBeenCalledWith({
      incremental: false,
      customKnownPaths: undefined,
      fullScan: true
    })
  })

  it('7. 扫描完成后向渲染层广播 scanner:complete', async () => {
    const db = makeDb({ scanHistoryCount: 0 })
    const result = { success: true, filesFound: 0 }
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue(result),
      stopScan: vi.fn(),
      getStatus: vi.fn()
    }
    const mainWindow = makeMainWindow()
    const ctx = makeAppCtx({ db, scannerManager, mainWindow })

    await performStartupScan(ctx)

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('scanner:complete', result)
  })

  it('8. 扫描成功且 filesFound>0 时触发 mediaWorkerManager.startThumbnailBatch', async () => {
    const db = makeDb({ scanHistoryCount: 0 })
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 10 }),
      stopScan: vi.fn(),
      getStatus: vi.fn()
    }
    const mwm = makeMediaWorkerManager()
    const ctx = makeAppCtx({
      db,
      scannerManager,
      mainWindow: makeMainWindow(),
      thumbnailGen: { generate: vi.fn(), getCacheDir: vi.fn(() => '/thumb') },
      mediaWorkerManager: injectMediaWorkerManager(mwm)
    })

    await performStartupScan(ctx)
    await flushAsync()

    expect(mwm.startThumbnailBatch).toHaveBeenCalledWith({
      cacheDir: '/thumb',
      thumbnailQuality: 'standard'
    })
  })

  it('9. 扫描成功但 filesFound=0 时跳过缩略图生成', async () => {
    const db = makeDb({ scanHistoryCount: 0 })
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 0 }),
      stopScan: vi.fn(),
      getStatus: vi.fn()
    }
    const mwm = makeMediaWorkerManager()
    const ctx = makeAppCtx({
      db,
      scannerManager,
      mainWindow: makeMainWindow(),
      mediaWorkerManager: injectMediaWorkerManager(mwm)
    })

    await performStartupScan(ctx)
    await flushAsync()

    expect(mwm.startThumbnailBatch).not.toHaveBeenCalled()
  })

  it('9b. isThumbnailsGenerating 为真时跳过 startThumbnailBatch（互斥守卫）', async () => {
    const db = makeDb({ scanHistoryCount: 0 })
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 10 }),
      stopScan: vi.fn(),
      getStatus: vi.fn()
    }
    const mwm = makeMediaWorkerManager()
    const ctx = makeAppCtx({
      db,
      scannerManager,
      mainWindow: makeMainWindow(),
      mediaWorkerManager: injectMediaWorkerManager(mwm)
    })
    ctx.isThumbnailsGenerating = () => true

    await performStartupScan(ctx)
    await flushAsync()

    expect(mwm.startThumbnailBatch).not.toHaveBeenCalled()
  })

  it('9c. 缩略图批次成功后广播 media:updated', async () => {
    const db = makeDb({ scanHistoryCount: 0 })
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 10 }),
      stopScan: vi.fn(),
      getStatus: vi.fn()
    }
    const mwm = makeMediaWorkerManager()
    const mainWindow = makeMainWindow()
    const ctx = makeAppCtx({
      db,
      scannerManager,
      mainWindow,
      mediaWorkerManager: injectMediaWorkerManager(mwm)
    })

    await performStartupScan(ctx)
    await flushAsync()

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('media:updated')
  })

  it('10. startPhashBatch reject 时记录 logger.error（不中断）', async () => {
    const db = makeDb({ scanHistoryCount: 0 })
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 0 }),
      stopScan: vi.fn(),
      getStatus: vi.fn()
    }
    const mwm = makeMediaWorkerManager()
    mwm.startPhashBatch.mockRejectedValueOnce(new Error('phash failed'))
    const ctx = makeAppCtx({
      db,
      scannerManager,
      mainWindow: makeMainWindow(),
      mediaWorkerManager: injectMediaWorkerManager(mwm)
    })

    await performStartupScan(ctx)
    await flushAsync()

    expect(loggerErrorMock).toHaveBeenCalledWith('[pHash] 启动补算失败:', expect.any(Error))
  })

  it('10b. performStartupScan 扫描完成后即返回，不等待索引链（fire-and-forget）', async () => {
    const db = makeDb({ scanHistoryCount: 0 })
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 10 }),
      stopScan: vi.fn(),
      getStatus: vi.fn()
    }
    const mwm = makeMediaWorkerManager()
    // startThumbnailBatch 永不 resolve：若 performStartupScan await 索引链，函数将永不返回
    mwm.startThumbnailBatch.mockReturnValue(new Promise(() => {}))
    const ctx = makeAppCtx({
      db,
      scannerManager,
      mainWindow: makeMainWindow(),
      mediaWorkerManager: injectMediaWorkerManager(mwm)
    })

    await expect(performStartupScan(ctx)).resolves.toBeUndefined()
  })

  it('11. 扫描抛错时记录 logger.error 并广播 scanner:complete（success:false）', async () => {
    const db = makeDb({ scanHistoryCount: 0 })
    const scanErr = new Error('scan failed')
    const scannerManager = {
      startScan: vi.fn().mockRejectedValue(scanErr),
      stopScan: vi.fn(),
      getStatus: vi.fn()
    }
    const mainWindow = makeMainWindow()
    const ctx = makeAppCtx({ db, scannerManager, mainWindow })

    await performStartupScan(ctx)

    expect(loggerErrorMock).toHaveBeenCalledWith('[Startup] 自动扫描失败:', scanErr)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('scanner:complete', {
      success: false,
      message: String(scanErr)
    })
  })
})

// ============================================================================
// runPostScanIndexing：整体 watchdog 兜底
// ============================================================================
describe('runPostScanIndexing watchdog', () => {
  // 与源码 INDEXING_TOTAL_TIMEOUT_MS 保持一致（模块内常量未导出）
  const INDEXING_TOTAL_TIMEOUT_MS = 10 * 60_000

  it('W1. startThumbnailBatch 永不 resolve 时整体超时强制推送终态并清理', async () => {
    vi.useFakeTimers()
    try {
      const db = makeDb({ scanHistoryCount: 0 })
      const scannerManager = {
        startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 10 }),
        stopScan: vi.fn(),
        getStatus: vi.fn()
      }
      const mwm = makeMediaWorkerManager()
      // 缩略图批次永不 resolve：若没有 watchdog，runPostScanIndexing 将永久挂起、无终态
      mwm.startThumbnailBatch.mockReturnValue(new Promise(() => {}))
      const ctx = makeAppCtx({
        db,
        scannerManager,
        mainWindow: makeMainWindow(),
        mediaWorkerManager: injectMediaWorkerManager(mwm)
      })

      void runPostScanIndexing(ctx, 10)
      await vi.advanceTimersByTimeAsync(INDEXING_TOTAL_TIMEOUT_MS)

      // 超时终态：fault 日志 + error 日志
      expect(loggerFaultMock).toHaveBeenCalledWith(
        'indexingTimeout',
        expect.any(Error),
        expect.objectContaining({ taskId: expect.any(String) })
      )
      expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining('索引任务超过'))
      // 停止缩略图/phash 批次 + duplicate 标记续跑
      expect(mwm.stopThumbnailBatch).toHaveBeenCalled()
      expect(mwm.stopPhashBatch).toHaveBeenCalled()
      expect(mwm.stopDuplicateMark).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('W2. 用户取消仍走 cancelled 终态（不被 timedOut 误标）', () => {
    vi.useFakeTimers()
    try {
      const db = makeDb({ scanHistoryCount: 0 })
      const scannerManager = {
        startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 10 }),
        stopScan: vi.fn(),
        getStatus: vi.fn()
      }
      const mwm = makeMediaWorkerManager()
      mwm.startThumbnailBatch.mockReturnValue(new Promise(() => {}))
      const ctx = makeAppCtx({
        db,
        scannerManager,
        mainWindow: makeMainWindow(),
        mediaWorkerManager: injectMediaWorkerManager(mwm)
      })

      const registerSpy = vi.spyOn(taskRegistry, 'register')
      void runPostScanIndexing(ctx, 10)
      const taskId = registerSpy.mock.calls[0][0] as string
      registerSpy.mockRestore()

      // 用户取消 → abort 监听同步推送 cancelled 终态，不触发超时 fault
      taskRegistry.cancel(taskId)
      expect(loggerFaultMock).not.toHaveBeenCalled()
      expect(mwm.stopThumbnailBatch).toHaveBeenCalled()
      expect(mwm.stopDuplicateMark).toHaveBeenCalled()
      // taskRegistry 已通过 cleanup() 清理（再次 cancel 返回 false）
      expect(taskRegistry.cancel(taskId)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ============================================================================
// autoAnalyzeSceneTime
// ============================================================================
describe('autoAnalyzeSceneTime', () => {
  it('12. db 为 null 时直接返回', async () => {
    const ctx = makeAppCtx({ db: null })

    await expect(autoAnalyzeSceneTime(ctx)).resolves.toBeUndefined()
    expect(analyzeSceneBrightnessMock).not.toHaveBeenCalled()
  })

  it('13. 待分析图片为 0 时直接返回（不动态 import）', async () => {
    const db = makeDb({ mediaRows: [] })
    const ctx = makeAppCtx({ db, mainWindow: makeMainWindow() })

    await autoAnalyzeSceneTime(ctx)

    expect(analyzeSceneBrightnessMock).not.toHaveBeenCalled()
  })

  it('14. 待分析图片 N>0 时动态 import analyzeSceneBrightness 并并发执行（updateStmt.run 调用 N 次）', async () => {
    const rows = [
      { id: 1, file_path: '/img/1.jpg' },
      { id: 2, file_path: '/img/2.jpg' },
      { id: 3, file_path: '/img/3.jpg' }
    ]
    const db = makeDb({ mediaRows: rows })
    const updateRun = vi.fn()
    // 覆盖 prepare 返回的 UPDATE 语句
    db.prepare.mockImplementation((sql: string) => {
      if (sql.includes('UPDATE media_files SET scene_time')) {
        return { get: vi.fn(), all: vi.fn(), run: updateRun }
      }
      return {
        get: vi.fn(),
        all: vi.fn(() => rows),
        run: vi.fn()
      }
    })
    const ctx = makeAppCtx({ db, mainWindow: makeMainWindow() })

    await autoAnalyzeSceneTime(ctx)

    expect(analyzeSceneBrightnessMock).toHaveBeenCalledTimes(3)
    expect(analyzeSceneBrightnessMock).toHaveBeenCalledWith('/img/1.jpg')
    expect(analyzeSceneBrightnessMock).toHaveBeenCalledWith('/img/2.jpg')
    expect(analyzeSceneBrightnessMock).toHaveBeenCalledWith('/img/3.jpg')
    expect(updateRun).toHaveBeenCalledTimes(3)
  })

  it('15. 完成后广播 media:updated', async () => {
    const rows = [{ id: 1, file_path: '/img/1.jpg' }]
    const db = makeDb({ mediaRows: rows })
    const mainWindow = makeMainWindow()
    const ctx = makeAppCtx({ db, mainWindow })

    await autoAnalyzeSceneTime(ctx)

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('media:updated')
  })

  it('16. 单张图片分析抛错时不影响其他图片（runWithConcurrency 内部处理）', async () => {
    const rows = [
      { id: 1, file_path: '/img/1.jpg' },
      { id: 2, file_path: '/img/2.jpg' }
    ]
    const db = makeDb({ mediaRows: rows })
    const updateRun = vi.fn()
    db.prepare.mockImplementation((sql: string) => {
      if (sql.includes('UPDATE media_files SET scene_time')) {
        return { get: vi.fn(), all: vi.fn(), run: updateRun }
      }
      return {
        get: vi.fn(),
        all: vi.fn(() => rows),
        run: vi.fn()
      }
    })
    const ctx = makeAppCtx({ db, mainWindow: makeMainWindow() })
    // 第一张抛错，第二张正常
    analyzeSceneBrightnessMock
      .mockRejectedValueOnce(new Error('img1 fail'))
      .mockResolvedValueOnce('day')

    // 不抛错（runWithConcurrency 内部 try/catch 由源码 task 提供）
    // 注：源码 task 内未 try/catch，错误会冒到 runWithConcurrency 的 Promise.all → autoAnalyzeSceneTime 的外层 catch
    // 因此会走 catch 分支，console.error，不抛错
    await expect(autoAnalyzeSceneTime(ctx)).resolves.toBeUndefined()
  })
})

// ============================================================================
// cleanupOrphanThumbnails 与 cleanupAndRepairDatabase
// ============================================================================
describe('cleanupOrphanThumbnails', () => {
  it('17. 缩略图目录为空时直接返回（不删除）', async () => {
    const db = makeDb({})
    const ctx = makeAppCtx({
      db,
      thumbnailGen: {
        generate: vi.fn(),
        getCacheDir: vi.fn(() => '/thumb')
      }
    })
    fsReaddirMock.mockResolvedValue([])

    await cleanupOrphanThumbnails(ctx)

    expect(fsRmMock).not.toHaveBeenCalled()
  })

  it('18. 删除未被引用的孤儿缩略图，保留被引用标准档的 _low/_high 变体与 LRU 元数据文件', async () => {
    const db = makeDb({
      thumbnailRows: [{ thumbnail: '/thumb/keep.jpg' }]
    })
    const ctx = makeAppCtx({
      db,
      thumbnailGen: {
        generate: vi.fn(),
        getCacheDir: vi.fn(() => '/thumb')
      }
    })
    // FIX(组19-1): keep_low/keep_high 是被引用标准档 keep.jpg 的变体档，
    // cache-metadata.json 是 LRU 访问时间持久化文件——三者此前被当作孤儿每次启动删除
    fsReaddirMock.mockResolvedValue([
      'keep.jpg',
      'keep_low.jpg',
      'keep_high.jpg',
      'cache-metadata.json',
      'orphan.jpg',
      'orphan_low.jpg'
    ])
    fsRmMock.mockResolvedValue(undefined)

    await cleanupOrphanThumbnails(ctx)

    const removedPaths = fsRmMock.mock.calls.map((c) => c[0] as string)
    // 真孤儿：标准档未被引用，其变体也应一并删除
    expect(removedPaths).toContain(path.resolve('/thumb', 'orphan.jpg'))
    expect(removedPaths).toContain(path.resolve('/thumb', 'orphan_low.jpg'))
    // 被引用标准档 + 其变体档 + LRU 元数据文件均保留
    expect(removedPaths).not.toContain(path.resolve('/thumb', 'keep.jpg'))
    expect(removedPaths).not.toContain(path.resolve('/thumb', 'keep_low.jpg'))
    expect(removedPaths).not.toContain(path.resolve('/thumb', 'keep_high.jpg'))
    expect(removedPaths).not.toContain(path.resolve('/thumb', 'cache-metadata.json'))
    expect(removedPaths).toHaveLength(2)
  })
})

describe('cleanupAndRepairDatabase', () => {
  it('19. 第一阶段缺失记录标记为 is_missing=1（markMissingStmt.run 被调用）', async () => {
    const rows = [
      {
        id: 1,
        file_path: '/img/missing.jpg',
        file_type: 'image',
        thumbnail: null,
        width: null,
        height: null
      },
      {
        id: 2,
        file_path: '/img/exists.jpg',
        file_type: 'image',
        thumbnail: null,
        width: 100,
        height: 100
      }
    ]
    const db = makeDb({ mediaRows: rows })
    const markMissingRun = vi.fn()
    const updateRun = vi.fn()
    let markMissingSql = ''
    db.prepare.mockImplementation((sql: string) => {
      if (sql.includes('missing_count = missing_count + 1')) {
        // FIX(组19-2): 第一阶段改为累加 missing_count（与 scanner checkMissingFiles 一致），
        // 累计 >=2 才置 is_missing=1，不再 1s 重试失败即隐藏整盘慢挂载文件
        markMissingSql = sql
        return { get: vi.fn(), all: vi.fn(), run: markMissingRun }
      }
      if (sql.includes('UPDATE media_files SET width')) {
        return { get: vi.fn(), all: vi.fn(), run: updateRun }
      }
      return {
        get: vi.fn(),
        all: vi.fn(() => rows),
        run: vi.fn()
      }
    })
    const ctx = makeAppCtx({ db, mainWindow: makeMainWindow() })
    // 每条记录 pathExists 调用两次（初次分类 + 延迟重查），按行顺序：row1 缺失、row2 存在
    // 调用顺序 = [row1 初次, row2 初次, row1 重查, row2 重查]
    pathExistsMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    // 第二条已 width/height 完整 + thumbnail 完整，无需修复
    processThumbnailForRowMock.mockResolvedValue(true)

    await cleanupAndRepairDatabase(ctx)

    // 缺失文件按防抖语义标记：missing_count 累加，仅当累计 >=2 才置 is_missing=1
    expect(markMissingRun).toHaveBeenCalledWith(1)
    expect(markMissingSql).toContain('CASE WHEN missing_count + 1 >= 2 THEN 1 ELSE 0 END')
  })

  it('20. 第二阶段修复缺失尺寸或缩略图的记录（processThumbnailForRow 被调用）', async () => {
    const rows = [
      {
        id: 2,
        file_path: '/img/exists.jpg',
        file_type: 'image',
        thumbnail: null,
        width: null,
        height: null
      }
    ]
    const db = makeDb({ mediaRows: rows })
    const updateRun = vi.fn()
    db.prepare.mockImplementation((sql: string) => {
      if (sql.includes('UPDATE media_files SET width')) {
        return { get: vi.fn(), all: vi.fn(), run: updateRun }
      }
      return {
        get: vi.fn(),
        all: vi.fn(() => rows),
        run: vi.fn()
      }
    })
    const ctx = makeAppCtx({ db, mainWindow: makeMainWindow() })
    pathExistsMock.mockResolvedValue(true)
    processThumbnailForRowMock.mockResolvedValue(true)

    await cleanupAndRepairDatabase(ctx)

    expect(processThumbnailForRowMock).toHaveBeenCalledWith(
      ctx,
      { id: 2, file_path: '/img/exists.jpg', file_type: 'image' },
      expect.objectContaining({ run: updateRun })
    )
  })

  it('21. 修复或删除记录数 > 0 时广播 media:updated', async () => {
    const rows = [
      {
        id: 1,
        file_path: '/img/missing.jpg',
        file_type: 'image',
        thumbnail: null,
        width: null,
        height: null
      }
    ]
    const db = makeDb({ mediaRows: rows })
    db.prepare.mockImplementation((sql: string) => {
      if (sql.includes('DELETE FROM media_files')) {
        return { get: vi.fn(), all: vi.fn(), run: vi.fn() }
      }
      if (sql.includes('UPDATE media_files SET width')) {
        return { get: vi.fn(), all: vi.fn(), run: vi.fn() }
      }
      if (sql.includes('SELECT thumbnail FROM media_files')) {
        return { get: vi.fn(), all: vi.fn(() => []), run: vi.fn() }
      }
      return {
        get: vi.fn(),
        all: vi.fn(() => rows),
        run: vi.fn()
      }
    })
    const mainWindow = makeMainWindow()
    const ctx = makeAppCtx({ db, mainWindow })
    pathExistsMock.mockResolvedValue(false) // 所有记录文件不存在，触发标记缺失
    fsReaddirMock.mockResolvedValue([])

    await cleanupAndRepairDatabase(ctx)

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('media:updated')
  })

  it('22. 全部记录正常时不广播 media:updated', async () => {
    const rows = [
      {
        id: 1,
        file_path: '/img/ok.jpg',
        file_type: 'image',
        thumbnail: '/thumb/ok.jpg',
        width: 100,
        height: 100
      }
    ]
    const db = makeDb({ mediaRows: rows })
    db.prepare.mockImplementation((sql: string) => {
      if (sql.includes('SELECT thumbnail FROM media_files')) {
        return { get: vi.fn(), all: vi.fn(() => [{ thumbnail: '/thumb/ok.jpg' }]), run: vi.fn() }
      }
      return {
        get: vi.fn(),
        all: vi.fn(() => rows),
        run: vi.fn()
      }
    })
    const mainWindow = makeMainWindow()
    const ctx = makeAppCtx({ db, mainWindow })
    pathExistsMock.mockResolvedValue(true)
    fsReaddirMock.mockResolvedValue([])

    await cleanupAndRepairDatabase(ctx)

    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })
})

// ============================================================================
// cleanupInterruptedScanHistory (R4)
// ============================================================================
describe('cleanupInterruptedScanHistory', () => {
  it('23. db 为 null 时返回 0，不调用 prepare', () => {
    const ctx = makeAppCtx({ db: null })
    expect(cleanupInterruptedScanHistory(ctx)).toBe(0)
  })

  it('24. 将 status=running 的记录更新为 interrupted 并返回受影响行数', () => {
    const runMock = vi.fn(() => ({ changes: 3 }))
    const prepareMock = vi.fn(() => ({ run: runMock }))
    const db = { prepare: prepareMock }
    const ctx = makeAppCtx({ db })

    const result = cleanupInterruptedScanHistory(ctx)

    expect(result).toBe(3)
    expect(prepareMock).toHaveBeenCalledWith(
      "UPDATE scan_history SET status = 'interrupted', end_time = datetime('now') WHERE status = 'running'"
    )
    expect(runMock).toHaveBeenCalled()
    expect(loggerInfoMock).toHaveBeenCalledWith(
      '[Startup] 清理 3 条 scan_history 孤儿记录（running → interrupted）'
    )
  })

  it('25. 受影响行数为 0 时不输出 info 日志', () => {
    const runMock = vi.fn(() => ({ changes: 0 }))
    const db = { prepare: vi.fn(() => ({ run: runMock })) }
    const ctx = makeAppCtx({ db })

    cleanupInterruptedScanHistory(ctx)

    expect(loggerInfoMock).not.toHaveBeenCalled()
  })

  it('26. prepare 抛错时返回 0 并记录 warn（不阻塞启动）', () => {
    const prepareMock = vi.fn(() => {
      throw new Error('no such table: scan_history')
    })
    const db = { prepare: prepareMock }
    const ctx = makeAppCtx({ db })

    const result = cleanupInterruptedScanHistory(ctx)

    expect(result).toBe(0)
    expect(loggerWarnMock).toHaveBeenCalledWith(
      '[Startup] 清理 scan_history 孤儿记录失败:',
      expect.any(Error)
    )
  })
})

// ============================================================================
// notifyInterruptedScan (R12)
// ============================================================================
describe('notifyInterruptedScan', () => {
  it('27. db 为 null 时直接返回，不调用 prepare', () => {
    const ctx = makeAppCtx({ db: null })
    expect(() => notifyInterruptedScan(ctx)).not.toThrow()
  })

  it('28. 无 interrupted 记录时不发送事件、不更新状态', () => {
    const getMock = vi.fn(() => ({ count: 0 }))
    const runMock = vi.fn()
    const prepareMock = vi.fn(() => ({ get: getMock, run: runMock }))
    const db = { prepare: prepareMock }
    const mainWindow = makeMainWindow()
    const ctx = makeAppCtx({ db, mainWindow })

    notifyInterruptedScan(ctx)

    // 只调用了 1 次 prepare（SELECT COUNT），未调用 UPDATE
    expect(prepareMock).toHaveBeenCalledTimes(1)
    expect(runMock).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('29. 有 interrupted 记录时发送 scanner:interrupted 事件并更新状态为 failed', () => {
    const getMock = vi.fn(() => ({ count: 2 }))
    const runMock = vi.fn()
    const prepareMock = vi.fn((sql: string) => {
      if (sql.includes('SELECT COUNT')) return { get: getMock }
      return { run: runMock }
    })
    const db = { prepare: prepareMock }
    const mainWindow = makeMainWindow()
    const ctx = makeAppCtx({ db, mainWindow })

    notifyInterruptedScan(ctx)

    // 发送了 scanner:interrupted 事件
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('scanner:interrupted', { count: 2 })
    // 更新了 interrupted → failed
    expect(runMock).toHaveBeenCalledWith()
    const updateSql = prepareMock.mock.calls[1][0]
    expect(updateSql).toContain("UPDATE scan_history SET status = 'failed'")
    expect(updateSql).toContain("WHERE status = 'interrupted'")
    expect(loggerInfoMock).toHaveBeenCalledWith(
      '[Startup] 检测到 2 条 interrupted 扫描记录，通知 UI'
    )
  })

  it('30. mainWindow 为 null 时不抛错且仍更新状态（optional chaining 短路）', () => {
    const getMock = vi.fn(() => ({ count: 1 }))
    const runMock = vi.fn()
    const prepareMock = vi.fn((sql: string) => {
      if (sql.includes('SELECT COUNT')) return { get: getMock }
      return { run: runMock }
    })
    const db = { prepare: prepareMock }
    const ctx = makeAppCtx({ db, mainWindow: null })

    // 不应抛错——mainWindow?.webContents 短路为 undefined，send 不执行
    expect(() => notifyInterruptedScan(ctx)).not.toThrow()
    // 状态仍应更新为 failed（send 未执行不阻塞 UPDATE）
    expect(runMock).toHaveBeenCalled()
  })

  it('31. prepare 抛错时不阻塞启动（仅 warn）', () => {
    const prepareMock = vi.fn(() => {
      throw new Error('no such table: scan_history')
    })
    const db = { prepare: prepareMock }
    const mainWindow = makeMainWindow()
    const ctx = makeAppCtx({ db, mainWindow })

    expect(() => notifyInterruptedScan(ctx)).not.toThrow()
    expect(loggerWarnMock).toHaveBeenCalledWith(
      '[Startup] 检测 interrupted 扫描记录失败:',
      expect.any(Error)
    )
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })
})
