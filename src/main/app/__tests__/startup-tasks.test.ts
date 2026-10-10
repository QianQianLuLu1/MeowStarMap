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
  fsConstantsMock,
  isBlankCachedThumbnailMock,
  clearCacheMock,
  markExitStageMock
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
  fsConstantsMock: { F_OK: 0, R_OK: 4, W_OK: 2 },
  // 存量纯白视频缩略图自愈判定（fix-video-thumbnail-white-frame 收尾）
  isBlankCachedThumbnailMock: vi.fn(),
  // media:// 一年强缓存击穿：session.defaultSession.clearCache
  clearCacheMock: vi.fn(),
  // [DEBUG-a4f2] 退出取证阶段打点：扫描/索引窗口的精细阶段（崩溃定位用）
  markExitStageMock: vi.fn()
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

// 存量纯白视频缩略图自愈：cleanupAndRepairDatabase 用 isBlankCachedThumbnail 判定磁盘白帧
vi.mock('../../utils/video-frame', () => ({
  isBlankCachedThumbnail: isBlankCachedThumbnailMock
}))

// 退出取证：markExitStage 阶段打点（崩溃时 heartbeat.json 的 stage 字段来源）
vi.mock('../exit-forensics', () => ({
  markExitStage: markExitStageMock
}))

// progress-throttle 经电子 BrowserWindow.getAllWindows 推送；测试中无窗口，返回空数组即可
// session.defaultSession.clearCache：自愈发生后击穿 media:// 一年强缓存
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: { clearCache: clearCacheMock } }
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
  // 默认非纯白（自愈不触发）；白帧场景由具体用例逐条覆盖
  isBlankCachedThumbnailMock.mockReset()
  isBlankCachedThumbnailMock.mockResolvedValue(false)
  clearCacheMock.mockReset()
  clearCacheMock.mockResolvedValue(undefined)
  markExitStageMock.mockReset()

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

  it('W3. 缩略图进度分母统计 SQL 含 GamePlayPhotos 归一化排除条件（与 media-worker 口径一致）', () => {
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

    // countUnprocessed 在索引链入口同步执行，THUMB_QUERY 可直接从 prepare 桩捕获；
    // 排除条件与 media-worker/worker-entry.ts 缩略图批次查询完全同口径，
    // 避免永不处理的 GamePlayPhotos 行计入总量导致进度条虚高
    const sqls = db.prepare.mock.calls.map((c) => String(c[0]))
    const thumbCount = sqls.find((s) => s.includes('COUNT') && s.includes('thumbnail IS NULL'))
    expect(thumbCount).toBeDefined()
    expect(thumbCount).toContain('(thumbnail IS NULL OR width IS NULL OR height IS NULL)')
    expect(thumbCount).toContain(
      "LOWER(REPLACE(file_path, '\\', '/')) NOT LIKE '%/x6game/saved/gameplayphotos/%'"
    )

    // 取消任务清理 watchdog，避免遗留定时器污染后续用例
    taskRegistry.cancel(taskId)
  })

  it('W4. 缩略图进度分母统计 SQL 放行 GamePlayPhotos 视频行（与 media-worker 批量口径一致）', () => {
    // fix-gameplayphotos-video-thumbnail-null 节点3：NOT LIKE 豁免仅适用于「已有原生 LQ 缩略图」
    // 的图片，Videos/ 子树的视频（thumbnail 为 NULL）必须计入分母并被批量任务实际处理，
    // 否则进度条与实际可处理行不一致，且视频缩略图永远补不上。
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

    const sqls = db.prepare.mock.calls.map((c) => String(c[0]))
    const thumbCount = sqls.find((s) => s.includes('COUNT') && s.includes('thumbnail IS NULL'))
    expect(thumbCount).toBeDefined()
    expect(thumbCount).toContain(
      "(LOWER(REPLACE(file_path, '\\', '/')) NOT LIKE '%/x6game/saved/gameplayphotos/%' OR file_type = 'video')"
    )
    expect(thumbCount).toContain(
      "(LOWER(REPLACE(file_path, '\\', '/')) NOT LIKE '%/x6game/gameplayphotos/%' OR file_type = 'video')"
    )

    // 取消任务清理 watchdog，避免遗留定时器污染后续用例
    taskRegistry.cancel(taskId)
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

  it('20b. 第二阶段修复纳入 thumbnail 为 NULL 的视频行（存量补算兜底，filesFound=0 时批量不跑）', async () => {
    // fix-gameplayphotos-video-thumbnail-null 节点3b：GamePlayPhotos 下 Videos/ 的游戏视频
    // 扫描入库时 thumbnail 即为 NULL、尺寸齐全——原 rowsToRepair 条件（缺尺寸/悬空缩略图）
    // 不覆盖；批量补算又被 runPostScanIndexing 的 filesFound>0 门控跳过（增量扫描 0 新增），
    // 导致永远无人补算、「缓存/重复文件」板块纯白占位。启动必跑的修复路径必须接管这类行。
    // 图片行 thumbnail NULL 但尺寸齐全维持原状（GamePlayPhotos 原生 LQ 缺失的图片不应每次启动重试）。
    const rows = [
      {
        id: 31,
        file_path: 'H:/game/X6Game/Saved/GamePlayPhotos/1/Videos/a/a.Mp4',
        file_type: 'video',
        thumbnail: null,
        width: 3840,
        height: 2160
      },
      {
        id: 32,
        file_path: 'H:/game/X6Game/Saved/GamePlayPhotos/1/NikkiPhotos_HighQuality/p.jpg',
        file_type: 'image',
        thumbnail: null,
        width: 3840,
        height: 2160
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
      {
        id: 31,
        file_path: 'H:/game/X6Game/Saved/GamePlayPhotos/1/Videos/a/a.Mp4',
        file_type: 'video'
      },
      expect.objectContaining({ run: updateRun })
    )
    expect(processThumbnailForRowMock).not.toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ id: 32 }),
      expect.anything()
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

  // ==========================================================================
  // 存量纯白视频缩略图启动自愈（fix-video-thumbnail-white-frame 收尾）
  // 白帧 thumbnail 非空、尺寸齐全、源文件存在 → 既不进 rowsToRepair 也非悬空，
  // 原实现永远不会对其调用 generate()，白帧永久留存。以下用例锁定自愈阶段。
  // ==========================================================================
  it('V1. video 行 + isBlankCachedThumbnail=true → 自愈调用 generate(file_path)', async () => {
    const rows = [
      {
        id: 10,
        file_path: '/videos/a.mp4',
        file_type: 'video',
        thumbnail: '/cache/abc.jpg',
        width: 1920,
        height: 1080
      }
    ]
    const db = makeDb({ mediaRows: rows })
    const generateMock = vi.fn().mockResolvedValue('/cache/abc.jpg')
    const ctx = makeAppCtx({
      db,
      mainWindow: makeMainWindow(),
      thumbnailGen: { generate: generateMock, getCacheDir: vi.fn(() => '/thumb') }
    })
    // 源文件与缩略图均存在 → 尺寸齐全不进 rowsToRepair、thumbnail 非悬空
    pathExistsMock.mockResolvedValue(true)
    // 首检 true（判定为白帧触发自愈）、复检 false（白→真帧转换成功）
    isBlankCachedThumbnailMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    fsReaddirMock.mockResolvedValue([])

    await cleanupAndRepairDatabase(ctx)

    // 自愈阶段直接以源文件路径调用 generate()，命中 doGenerate 缓存自愈分支
    expect(generateMock).toHaveBeenCalledWith('/videos/a.mp4')
    expect(generateMock).toHaveBeenCalledTimes(1)
    // 白帧行走自愈而非 rowsToRepair，不应经 processThumbnailForRow
    expect(processThumbnailForRowMock).not.toHaveBeenCalled()
  })

  it('V2. image 行不进入自愈候选（即使 isBlankCachedThumbnail=true 也不调 generate）', async () => {
    const rows = [
      {
        id: 11,
        file_path: '/img/x.jpg',
        file_type: 'image',
        thumbnail: '/cache/x.jpg',
        width: 100,
        height: 100
      }
    ]
    const db = makeDb({ mediaRows: rows })
    const generateMock = vi.fn().mockResolvedValue('/cache/x.jpg')
    const ctx = makeAppCtx({
      db,
      mainWindow: makeMainWindow(),
      thumbnailGen: { generate: generateMock, getCacheDir: vi.fn(() => '/thumb') }
    })
    pathExistsMock.mockResolvedValue(true)
    isBlankCachedThumbnailMock.mockResolvedValue(true)
    fsReaddirMock.mockResolvedValue([])

    await cleanupAndRepairDatabase(ctx)

    expect(generateMock).not.toHaveBeenCalled()
  })

  it('V3. video 行但 isBlankCachedThumbnail=false → 不调用 generate', async () => {
    const rows = [
      {
        id: 12,
        file_path: '/videos/b.mp4',
        file_type: 'video',
        thumbnail: '/cache/b.jpg',
        width: 1920,
        height: 1080
      }
    ]
    const db = makeDb({ mediaRows: rows })
    const generateMock = vi.fn().mockResolvedValue('/cache/b.jpg')
    const ctx = makeAppCtx({
      db,
      mainWindow: makeMainWindow(),
      thumbnailGen: { generate: generateMock, getCacheDir: vi.fn(() => '/thumb') }
    })
    pathExistsMock.mockResolvedValue(true)
    isBlankCachedThumbnailMock.mockResolvedValue(false)
    fsReaddirMock.mockResolvedValue([])

    await cleanupAndRepairDatabase(ctx)

    expect(generateMock).not.toHaveBeenCalled()
  })

  it('V4. video 行 thumbnail=null → 不进入自愈候选', async () => {
    const rows = [
      {
        id: 13,
        file_path: '/videos/c.mp4',
        file_type: 'video',
        thumbnail: null,
        width: 1920,
        height: 1080
      }
    ]
    const db = makeDb({ mediaRows: rows })
    const generateMock = vi.fn().mockResolvedValue('/cache/c.jpg')
    const ctx = makeAppCtx({
      db,
      mainWindow: makeMainWindow(),
      thumbnailGen: { generate: generateMock, getCacheDir: vi.fn(() => '/thumb') }
    })
    pathExistsMock.mockResolvedValue(true)
    isBlankCachedThumbnailMock.mockResolvedValue(true)
    fsReaddirMock.mockResolvedValue([])

    await cleanupAndRepairDatabase(ctx)

    expect(generateMock).not.toHaveBeenCalled()
  })

  it('V5. generate() 抛错 → 被捕获、函数不 reject、logger.warn 记录自愈失败', async () => {
    const rows = [
      {
        id: 14,
        file_path: '/videos/d.mp4',
        file_type: 'video',
        thumbnail: '/cache/d.jpg',
        width: 1920,
        height: 1080
      }
    ]
    const db = makeDb({ mediaRows: rows })
    const generateMock = vi.fn().mockRejectedValue(new Error('ffmpeg boom'))
    const ctx = makeAppCtx({
      db,
      mainWindow: makeMainWindow(),
      thumbnailGen: { generate: generateMock, getCacheDir: vi.fn(() => '/thumb') }
    })
    pathExistsMock.mockResolvedValue(true)
    isBlankCachedThumbnailMock.mockResolvedValue(true)
    fsReaddirMock.mockResolvedValue([])

    await expect(cleanupAndRepairDatabase(ctx)).resolves.toBeUndefined()
    expect(generateMock).toHaveBeenCalledWith('/videos/d.mp4')
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('视频纯白缩略图自愈失败'),
      expect.any(Error)
    )
  })

  it('C1. 自愈发生（healedBlankCount>0）→ 不再清理 HTTP 缓存（ETag 协商缓存取代），仍广播 media:updated', async () => {
    const rows = [
      {
        id: 15,
        file_path: '/videos/e.mp4',
        file_type: 'video',
        thumbnail: '/cache/e.jpg',
        width: 1920,
        height: 1080
      }
    ]
    const db = makeDb({ mediaRows: rows })
    const generateMock = vi.fn().mockResolvedValue('/cache/e.jpg')
    const mainWindow = makeMainWindow()
    const ctx = makeAppCtx({
      db,
      mainWindow,
      thumbnailGen: { generate: generateMock, getCacheDir: vi.fn(() => '/thumb') }
    })
    pathExistsMock.mockResolvedValue(true)
    // 首检 true、复检 false → healedBlankCount=1，触发广播
    isBlankCachedThumbnailMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    fsReaddirMock.mockResolvedValue([])

    await cleanupAndRepairDatabase(ctx)

    // fix-thumbnail-loading-latency 节点2：media:// 缩略图已改 ETag 协商缓存（media-protocol.ts），
    // 自愈覆盖同名文件后渲染层 revalidate 即可拿到新字节；clearCache 会清空整个会话缓存
    // 造成启动后请求风暴，故必须移除，任何自愈场景都不得调用。
    expect(clearCacheMock).not.toHaveBeenCalled()
    // 自愈后仍需驱动渲染层刷新
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('media:updated')
  })

  it('C2. 无白帧（isBlankCachedThumbnail 全 false）→ clearCache 不被调用', async () => {
    const rows = [
      {
        id: 16,
        file_path: '/videos/f.mp4',
        file_type: 'video',
        thumbnail: '/cache/f.jpg',
        width: 1920,
        height: 1080
      }
    ]
    const db = makeDb({ mediaRows: rows })
    const generateMock = vi.fn().mockResolvedValue('/cache/f.jpg')
    const ctx = makeAppCtx({
      db,
      mainWindow: makeMainWindow(),
      thumbnailGen: { generate: generateMock, getCacheDir: vi.fn(() => '/thumb') }
    })
    pathExistsMock.mockResolvedValue(true)
    isBlankCachedThumbnailMock.mockResolvedValue(false)
    fsReaddirMock.mockResolvedValue([])

    await cleanupAndRepairDatabase(ctx)

    expect(generateMock).not.toHaveBeenCalled()
    expect(clearCacheMock).not.toHaveBeenCalled()
  })

  // 说明：原 C3「clearCache() 抛错被捕获」与 N4「clearCache 早于 media:updated 时序」
  // 随 fix-thumbnail-loading-latency 节点2 移除 clearCache 一并删除——被测代码路径已不存在，
  // 自愈链路不再有任何缓存清理调用（C1/C2/N1/N2/N3 的 not.toHaveBeenCalled 断言继续守住该约束）。

  // ==========================================================================
  // M1 收敛：healedBlankCount 仅在“白→非白”真正发生时计数（复检 DB 实际指向的缩略图）
  // 覆盖三种“未真正自愈”：generate 返回 null、三位点全白仍保留白帧、内容 hash 漂移。
  // ==========================================================================
  it('N1. 首检白、复检仍白（generate 返回 null 未真正修复）→ 不计数、不击穿缓存、不广播', async () => {
    const rows = [
      {
        id: 18,
        file_path: '/videos/h.mp4',
        file_type: 'video',
        thumbnail: '/cache/h.jpg',
        width: 1920,
        height: 1080
      }
    ]
    const db = makeDb({ mediaRows: rows })
    // generate 返回 null（源不可读 / GamePlayPhotos 早退 / 解码失败）
    const generateMock = vi.fn().mockResolvedValue(null)
    const mainWindow = makeMainWindow()
    const ctx = makeAppCtx({
      db,
      mainWindow,
      thumbnailGen: { generate: generateMock, getCacheDir: vi.fn(() => '/thumb') }
    })
    pathExistsMock.mockResolvedValue(true)
    // 首检 true 触发自愈；复检仍 true → DB 指向的缩略图仍为白帧，未真正自愈
    isBlankCachedThumbnailMock.mockResolvedValue(true)
    fsReaddirMock.mockResolvedValue([])

    await cleanupAndRepairDatabase(ctx)

    expect(generateMock).toHaveBeenCalledTimes(1)
    // healedBlankCount 未自增 → 不触发全局 clearCache、不因 heal 广播 media:updated
    expect(clearCacheMock).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('media:updated')
  })

  it('N2. 首检白、generate 返回路径但复检仍白（三位点全白 / hash 漂移）→ 不计数、不击穿缓存', async () => {
    const rows = [
      {
        id: 19,
        file_path: '/videos/i.mp4',
        file_type: 'video',
        thumbnail: '/cache/i.jpg',
        width: 1920,
        height: 1080
      }
    ]
    const db = makeDb({ mediaRows: rows })
    // generate 返回非 null 新 hash 路径，但复检 DB 指向的旧缩略图仍为白帧（全白视频 / hash 漂移）
    const generateMock = vi.fn().mockResolvedValue('/cache/i_newhash.jpg')
    const mainWindow = makeMainWindow()
    const ctx = makeAppCtx({
      db,
      mainWindow,
      thumbnailGen: { generate: generateMock, getCacheDir: vi.fn(() => '/thumb') }
    })
    pathExistsMock.mockResolvedValue(true)
    isBlankCachedThumbnailMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true)
    fsReaddirMock.mockResolvedValue([])

    await cleanupAndRepairDatabase(ctx)

    expect(generateMock).toHaveBeenCalledTimes(1)
    expect(clearCacheMock).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('media:updated')
  })

  it('N3. isBlankCachedThumbnail 首检 reject → 被 try/catch 吞掉、函数不 reject、不中断、logger.warn', async () => {
    const rows = [
      {
        id: 20,
        file_path: '/videos/j.mp4',
        file_type: 'video',
        thumbnail: '/cache/j.jpg',
        width: 1920,
        height: 1080
      }
    ]
    const db = makeDb({ mediaRows: rows })
    const generateMock = vi.fn().mockResolvedValue('/cache/j.jpg')
    const ctx = makeAppCtx({
      db,
      mainWindow: makeMainWindow(),
      thumbnailGen: { generate: generateMock, getCacheDir: vi.fn(() => '/thumb') }
    })
    pathExistsMock.mockResolvedValue(true)
    isBlankCachedThumbnailMock.mockRejectedValue(new Error('stat boom'))
    fsReaddirMock.mockResolvedValue([])

    await expect(cleanupAndRepairDatabase(ctx)).resolves.toBeUndefined()
    // 判定异常 → 未触发自愈、未计数
    expect(generateMock).not.toHaveBeenCalled()
    expect(clearCacheMock).not.toHaveBeenCalled()
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('视频纯白缩略图自愈失败'),
      expect.any(Error)
    )
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

// ============================================================================
// exit-forensics 阶段打点（2026-09-27 打包版闪退取证：崩溃发生在启动扫描/索引窗口，
// 但 markExitStage 仅有 boot/when-ready/initialized/cleanup 四个里程碑，
// heartbeat.json 的 stage 停留在 'initialized'，无法定位崩溃处于哪个子阶段）
// ============================================================================
describe('exit-forensics 阶段打点', () => {
  it('32. performStartupScan 开始时标记 startup-scan 阶段', async () => {
    const db = makeDb({ scanHistoryCount: 5 })
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 0 }),
      stopScan: vi.fn(),
      getStatus: vi.fn()
    }
    const ctx = makeAppCtx({ db, scannerManager, mainWindow: makeMainWindow() })

    await performStartupScan(ctx)

    expect(markExitStageMock).toHaveBeenCalledWith('startup-scan')
  })

  it('33. 索引链启动时标记 post-scan-indexing 阶段', async () => {
    const ctx = makeAppCtx({ db: makeDb({}), mainWindow: makeMainWindow() })
    const mwm = makeMediaWorkerManager()
    ;(ctx as unknown as { mediaWorkerManager: unknown }).mediaWorkerManager = mwm

    await runPostScanIndexing(ctx, 0)

    expect(markExitStageMock).toHaveBeenCalledWith('post-scan-indexing')
  })

  it('34. 场景时段分析启动时标记 scene-analysis 阶段', async () => {
    const db = makeDb({
      mediaRows: [
        { id: 1, file_path: 'C:\\img\\a.jpeg' },
        { id: 2, file_path: 'C:\\img\\b.jpeg' }
      ]
    })
    const ctx = makeAppCtx({ db, mainWindow: makeMainWindow() })

    await autoAnalyzeSceneTime(ctx)

    expect(markExitStageMock).toHaveBeenCalledWith('scene-analysis')
    expect(analyzeSceneBrightnessMock).toHaveBeenCalledTimes(2)
  })
})

/**
 * round2 N3：缩略图引用重绑定（只绑不生成）
 *
 * 取证（本机真实库，round2 实施记录 §1/§12 已更正早期读数）：62 个 thumbnail=NULL 的图片行里
 * 只有 2 行的缓存文件在**现行**缓存目录上（33 行只命中迁盘前的旧目录，generator 不读那里，
 * 见 DEBT-031），但原 rowsToRepair 只覆盖「缺尺寸 / 悬空缩略图 / NULL 视频」，这类「尺寸齐全、
 * 缓存现成、仅缺引用」的行无人接管，进入板块只能重走按需生成 → 卡片长期停在骨架。
 * 重绑定必须零解码：每行只读前 1MB 算 hash、不进 sharp，否则启动任务会变成全库解码风暴
 * （DEBT-026 长期未做掉的原因）。
 */
describe('cleanupAndRepairDatabase 缩略图引用重绑定（round2 N3）', () => {
  beforeEach(() => {
    pathExistsMock.mockReset()
    processThumbnailForRowMock.mockReset()
    isBlankCachedThumbnailMock.mockReset()
    loggerWarnMock.mockReset()
    loggerInfoMock.mockReset()
  })

  /** image + thumbnail=NULL + 尺寸齐全 的行：原 rowsToRepair 不覆盖（本轮取证缺口） */
  const NULL_IMAGE_ROW = {
    id: 7001,
    file_path: 'H:/InfinityNikki/GamePlayPhotos/a.jpeg',
    file_type: 'image',
    thumbnail: null,
    width: 3311,
    height: 1485
  }

  function setupCleanup(rows: Array<Record<string, unknown>>, resolveResult: string | null) {
    const db = makeDb({ mediaRows: rows })
    const updateRun = vi.fn(() => ({ changes: 1, lastInsertRowid: 1 }))
    const rebindRun = vi.fn(() => ({ changes: 1, lastInsertRowid: 1 }))
    const sqlSeen: string[] = []
    const resolveExistingThumbnail = vi.fn(async () => resolveResult)
    db.prepare.mockImplementation((sql: string) => {
      sqlSeen.push(sql)
      if (sql.includes('UPDATE media_files SET width')) {
        return { get: vi.fn(), all: vi.fn(), run: updateRun }
      }
      if (sql.includes('AND thumbnail IS NULL')) {
        return { get: vi.fn(), all: vi.fn(), run: rebindRun }
      }
      return { get: vi.fn(), all: vi.fn(() => rows), run: vi.fn() }
    })
    const ctx = makeAppCtx({
      db,
      mainWindow: makeMainWindow(),
      thumbnailGen: {
        generate: vi.fn(),
        getCacheDir: vi.fn(() => 'H:/mock/thumbnails'),
        resolveExistingThumbnail
      }
    })
    pathExistsMock.mockResolvedValue(true)
    processThumbnailForRowMock.mockResolvedValue(true)
    isBlankCachedThumbnailMock.mockResolvedValue(false)
    return { ctx, updateRun, rebindRun, rebindSql: sqlSeen, resolveExistingThumbnail }
  }

  it('T2 正常：缓存已存在的 NULL 图片行 → 写回引用，且不触发生成', async () => {
    const cached = 'H:/mock/thumbnails/a62d7f95b24818c2.jpg'
    const { ctx, rebindRun, rebindSql, updateRun, resolveExistingThumbnail } = setupCleanup(
      [NULL_IMAGE_ROW],
      cached
    )

    await cleanupAndRepairDatabase(ctx)

    expect(resolveExistingThumbnail).toHaveBeenCalledWith(NULL_IMAGE_ROW.file_path)
    expect(rebindRun).toHaveBeenCalledWith(cached, NULL_IMAGE_ROW.id)
    // 防覆写：重绑定只在 thumbnail 仍为 NULL 时写入，不得覆盖扫描/批量并发写入的有效值
    const sql = rebindSql.find((s) => s.includes('AND thumbnail IS NULL')) ?? ''
    expect(sql).toContain('thumbnail IS NULL')
    // 走的是专用语句，不是缺尺寸修复语句
    expect(updateRun).not.toHaveBeenCalled()
    // 只绑不生成：共享修复服务一次都不该被调用
    expect(processThumbnailForRowMock).not.toHaveBeenCalled()
  })

  it('T3 边界：缓存不存在 → 零写库、零生成（绝不在启动期解码）', async () => {
    const { ctx, rebindRun, resolveExistingThumbnail } = setupCleanup([NULL_IMAGE_ROW], null)

    await cleanupAndRepairDatabase(ctx)

    expect(resolveExistingThumbnail).toHaveBeenCalledTimes(1)
    expect(rebindRun).not.toHaveBeenCalled()
    expect(processThumbnailForRowMock).not.toHaveBeenCalled()
  })

  it('T4 兼容：缺尺寸行仍走 processThumbnailForRow，且不进重绑定候选', async () => {
    const needsDims = { ...NULL_IMAGE_ROW, id: 7002, width: null, height: null }
    const { ctx, resolveExistingThumbnail } = setupCleanup([needsDims], 'ignored.jpg')

    await cleanupAndRepairDatabase(ctx)

    expect(processThumbnailForRowMock).toHaveBeenCalledTimes(1)
    expect(resolveExistingThumbnail).not.toHaveBeenCalled()
  })

  it('T5 兼容：thumbnail=NULL 的视频行走原修复分支（重绑定只管图片）', async () => {
    const videoRow = { ...NULL_IMAGE_ROW, id: 7003, file_type: 'video' }
    const { ctx, resolveExistingThumbnail } = setupCleanup([videoRow], 'ignored.jpg')

    await cleanupAndRepairDatabase(ctx)

    expect(processThumbnailForRowMock).toHaveBeenCalledTimes(1)
    expect(resolveExistingThumbnail).not.toHaveBeenCalled()
  })

  it('边界：重绑定单行抛错只告警，不中断启动任务', async () => {
    const resolveExistingThumbnail = vi.fn(async () => {
      throw new Error('ENOENT: metadata locked')
    })
    const db = makeDb({ mediaRows: [NULL_IMAGE_ROW] })
    const rebindRun = vi.fn(() => ({ changes: 1, lastInsertRowid: 1 }))
    db.prepare.mockImplementation((sql: string) => {
      if (sql.includes('AND thumbnail IS NULL')) {
        return { get: vi.fn(), all: vi.fn(), run: rebindRun }
      }
      return { get: vi.fn(), all: vi.fn(() => [NULL_IMAGE_ROW]), run: vi.fn() }
    })
    const ctx = makeAppCtx({
      db,
      mainWindow: makeMainWindow(),
      thumbnailGen: {
        generate: vi.fn(),
        getCacheDir: vi.fn(() => 'H:/mock/thumbnails'),
        resolveExistingThumbnail
      }
    })
    pathExistsMock.mockResolvedValue(true)
    isBlankCachedThumbnailMock.mockResolvedValue(false)

    await expect(cleanupAndRepairDatabase(ctx)).resolves.toBeUndefined()
    // 单行异常不得中断启动任务，也不得留下半截引用
    expect(rebindRun).not.toHaveBeenCalled()
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('缩略图引用重绑定失败'),
      expect.any(Error)
    )
  })
})
