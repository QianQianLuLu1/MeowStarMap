import { app, BrowserWindow, dialog, shell, crashReporter } from 'electron'
import path from 'path'
import type { AppContext } from './app-context'
import { backupService } from '../services/backup-service'
import { editorService } from '../services/editor-service'
import { STARTUP_SCAN_DELAY_MS } from '../utils/constants'
import { initLogger, logger } from '../utils/logger'
import { initCrashDir, enforceCrashLimit, getCrashDirectory } from '../services/crash-service'
import {
  logStartupError,
  diagLog,
  getStartupLogPathValue,
  chromiumLogPresenceLine
} from '../utils/startup-diagnostic'
import { getForensicsRoot } from '../utils/forensics-dir'
import { getProcessRegistryStats } from '../utils/process-registry'
import { pluginHost } from '../plugins/plugin-host'
// 阶段 2.2：app 内部模块
import { registerGlobalErrorHandlers } from './error-handlers'
import {
  registerRecoveryListeners,
  checkPendingDatabaseRecovery,
  flushPendingRecoveryEvents
} from './recovery'
import { performCleanup } from './cleanup'
import { applyCustomDirectories } from './custom-dirs'
import { ensureDesktopShortcut } from './desktop-shortcut'
import { registerMediaProtocol } from './media-protocol'
import { createMainWindow, getMainWindow } from './window-manager'
import { setupIPC, injectCorruptedMarkers } from './ipc-setup'
import { applyUITheme, setupThemeListener } from './theme'
// sync-integration 阶段 4：NikkiSync HTTPS 同步服务器装配与自启
import { initSyncServer } from './sync-server-setup'
import { initNikkiSyncRuntime } from './nikkisync-runtime-setup'
import {
  syncLoginItemSetting,
  readLoginItemOpenAtLogin,
  cleanupLegacyLoginItems,
  SETTING_LAUNCH_AT_LOGIN,
  LAUNCH_AT_LOGIN_DEFAULT,
  normalizeLaunchAtLogin
} from './login-item'
import { checkForUpdate } from '../services/reference-data-service'
import { REFERENCE_DATA_CHECK_DELAY_MS } from '../utils/constants'
// 自动更新：复用 electron-updater，生产环境初始化（dev 仅在 MEOW_DEV_UPDATE_FEED=1 时按假源初始化）
import { initAutoUpdater } from './auto-update'
import {
  performStartupScan,
  cleanupAndRepairDatabase,
  retryPendingRenames,
  cleanupInterruptedScanHistory,
  notifyInterruptedScan,
  runPostRestoreRepair
} from './startup-tasks'
import { t, initMainI18n } from '../i18n'
// F2+F5（2026-11-15）：赢家专属启动打点——从 index.ts whenReady 内（锁检查之前）后移至此
import { initExitForensics, markExitStage } from './exit-forensics'
import { markBootAttempt, setupGpuProcessWatcher } from './gpu-fallback'
import { verifyCriticalNativeModules, showStartupFailureWithFallback } from './native-load-guard'
// 启动 settled 闸门：启动未完成时不重建窗口，避免与 8 阶段启动链重入
import { isStartupSettled, markStartupSettled } from '../utils/early-crash-guard'
import { clearSecondInstanceAck } from './single-instance'

// P4：启动阶段耗时打点——每个 BOOT 标记携带距上一标记的毫秒差，
// 诊断包可直接读出各阶段耗时，无需靠时间戳差推算
let lastBootMarkAt = 0
function bootMark(msg: string): void {
  const now = performance.now()
  const delta = lastBootMarkAt === 0 ? 0 : Math.round(now - lastBootMarkAt)
  lastBootMarkAt = now
  diagLog('BOOT', `${msg} (+${delta}ms)`)
}

/**
 * 应用启动主流程（赢家路径）：whenReady → 阶段 1-8 → 生命周期事件注册。
 * 启动失败兜底：任何阶段抛错都走 fatal catch，确保进程退出 + 释放单实例锁。
 *
 * R1（2026-11-15）：单实例锁获取已前移到 index.ts whenReady 首行（single-instance.ts），
 * bootstrapApplication 仅由拿到锁的赢家执行；此处原先内联的重复锁逻辑是死代码，已删除。
 *
 * 阶段 2.5：从 Application.initialize() 迁移而来，零逻辑改动，
 * 所有原 this.xxx 字段通过 ctx 访问。
 */
export async function bootstrapApplication(ctx: AppContext): Promise<void> {
  // 启动失败兜底：任何阶段抛错都走 failStartup，确保进程退出 + 释放单实例锁
  // 修复"前几次正常，后续无法启动"的核心问题：原实现 initialize 失败后只 .catch(console.error)，
  // 进程不退出、持单实例锁、无窗口、无日志，变僵尸；后续启动全部 gotLock=false 静默退出
  try {
    lastBootMarkAt = performance.now()
    diagLog('BOOT', 'bootstrapApplication start')
    // R1（2026-11-15）：单实例锁获取已前移到 index.ts whenReady 首行（single-instance.ts），
    // 本函数仅由拿到锁的赢家执行。此处原先内联的重复锁逻辑是死代码（同进程二次调用
    // 恒 true，!gotLock 分支生产不可达），已删除——由 lifecycle.test.ts 守护用例防回退。

    // 第二实例尝试启动时，让已有窗口真正可见（补 show()），并按启动状态兜底 0 窗口。
    // 注册前移到赢家打点之前：主实例还在 8 阶段初始化时二次双击也应能亮窗/留痕，
    // 而不是等下一个实例走完 6s 重试才弹「已有实例运行」。
    app.on('second-instance', () => {
      try {
        const windows = BrowserWindow.getAllWindows()
        const win = Array.isArray(windows)
          ? windows.find((w) => w && typeof w.isDestroyed === 'function' && !w.isDestroyed())
          : undefined
        if (win) {
          if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore()
          // 隐藏（非最小化）窗口也必须显示，否则用户感知为「双击没反应」
          win.show()
          win.focus()
          return
        }
        if (isStartupSettled() && !ctx.isCleaningUp) {
          // 启动已完成但无窗口（托盘/隐藏）：复用 activate 的既有重建语义
          void Promise.resolve(createMainWindow(ctx)).catch((err) =>
            logStartupError('second-instance-recreate', err)
          )
        } else {
          // 启动链仍在创建首窗，重建会重入；只留痕，由启动链自己完成
          diagLog('BOOT', 'second-instance during startup: deferred to bootstrap')
        }
      } catch (err) {
        logStartupError('second-instance-handler', err)
      }
    })

    // G1-F3（审查修复轮）：退出链注册必须先于 initNikkiSyncRuntime 的长 await（~14s）——
    // 否则首窗刚现即关窗走 Electron 默认 quit，跳过 performCleanup（worker 不 dispose、WAL 不 checkpoint）。
    // 退出清理：确保数据库正确关闭并执行 WAL checkpoint
    // 修复：原实现同步 before-quit 中调用异步清理且未 await，异步清理来不及完成；
    // 且未 kill ffmpeg/ffprobe 子进程，这些子进程保持事件循环活跃 → 进程不退出 → 持有单实例锁 → 下次启动失败
    // 改为 event.preventDefault + 异步清理 + app.exit(0) 强制退出兜底
    // P1-8：增加超时强制退出兜底，防止 performCleanup 卡住（如 db.close 阻塞）
    // P1-A8：根据 WAL 文件大小动态调整超时——WAL 较大时延长到 5s，避免强制退出时 WAL 未合并
    //        （配合 dbManager.close() 改用 PASSIVE 非阻塞 checkpoint，正常情况下 2s 足够）
    app.on('before-quit', (event) => {
      // G1-F5（审查修复轮）：赢家开始退出即删除 ack——慢退（清理 >6s）时输家不得
      // 再按陈旧新鲜 ack 静默让位，否则双双消失无提示；删后输家回退三选项框。
      clearSecondInstanceAck()
      if (ctx.isCleaningUp) return
      ctx.setCleaningUp(true)
      event.preventDefault()

      // P1-A8：根据 WAL 文件大小动态计算超时
      // 默认 2s；WAL > 10MB 时延长到 5s（万级日志场景兜底）
      let forceExitTimeoutMs = 2000
      try {
        const walSize = ctx.dbManager.getWalFileSize()
        if (walSize > 10 * 1024 * 1024) {
          forceExitTimeoutMs = 5000
        }
      } catch {}
      const forceExitReason =
        forceExitTimeoutMs > 2000
          ? t('main.lifecycle.log.forceExitReasonWal')
          : t('main.lifecycle.log.forceExitReasonDefault')

      // P1-8：超时强制退出定时器——清理逻辑超时则 app.exit(1)
      // 用 logStartupError 记录超时诊断信息，便于排查卡死原因
      const forceExitTimer = setTimeout(() => {
        try {
          logStartupError(
            'force-exit-timeout',
            new Error(
              `performCleanup 超过 ${forceExitTimeoutMs}ms 未完成，强制退出（${forceExitReason}）`
            )
          )
          const stats = getProcessRegistryStats()
          logStartupError(
            'force-exit-stats',
            new Error(
              JSON.stringify({
                childProcessCount: stats.childProcessCount,
                ffmpegCommandCount: stats.ffmpegCommandCount,
                startupTimers: ctx.startupTimers.length,
                hasMediaUpdateTimer: !!ctx.getMediaUpdateTimer(),
                forceExitTimeoutMs
              })
            )
          )
        } catch {}
        // P0 修复：强制退出前显式释放单实例锁
        // 原用 setTimeout(100ms) 延迟 app.exit(1)，但 I/O 活跃时 setTimeout 会被延迟
        // 改为直接 app.exit(1)，确保进程立即终止
        try {
          app.releaseSingleInstanceLock?.()
        } catch {}
        try {
          app.exit(1)
        } catch {}
      }, forceExitTimeoutMs)

      // 异步清理后清除超时定时器并正常退出
      // 阶段 2.2：实现迁移到 app/cleanup.ts
      performCleanup(ctx).finally(() => {
        try {
          clearTimeout(forceExitTimer)
        } catch {}
        // P0 修复：锁已在 performCleanup 中 DB 关闭后释放
        // 此处仅兜底：若 performCleanup 在 DB 关闭前异常退出，确保锁被释放
        try {
          app.releaseSingleInstanceLock?.()
        } catch {}
        // P0 根因修复：原用 setTimeout(100ms) 延迟 app.exit(0)，但 performCleanup 末尾的
        // logFault 产生 FileHandleCloseReq 活跃请求，保持事件循环活跃，setTimeout 回调
        // 被 I/O 操作延迟，进程挂着不退出。现在 logFault 已改为同步写入，直接 app.exit(0)
        // app.exit 立即终止进程，不触发 before-quit/will-quit，不等事件循环清空
        try {
          app.exit(0)
        } catch {}
      })
    })

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit()
      }
    })

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        // 阶段 2.4：createMainWindow 迁移到 app/window-manager.ts
        await createMainWindow(ctx)
      }
    })

    // F2+F5（2026-11-15）：赢家专属启动打点，从 index.ts whenReady 内后移至此。
    // 此前这些步骤在单实例锁检查之前执行，锁失败实例（第二双击）也会：
    // ① markBootAttempt 给共享 gpu-fallback.json 的 consecutiveFailures +1
    //   （FAILURE_THRESHOLD=2：对运行中实例双击两次，下次真实启动即被静默打进
    //   软件渲染兼容模式，且锁失败实例永远走不到 markBootSuccess 清零）；
    // ② initExitForensics 覆写/删除运行实例的 heartbeat.json，污染 GPU 自愈证据链；
    // ③ verifyCriticalNativeModules 白白加载 better-sqlite3/koffi/sharp（数百 ms），
    //   拖慢"已有实例运行"弹窗，坏环境下还可能以"启动失败"误导用户。
    // 现在只有真正拿到锁的赢家才做预检与打点；顺序沿用原 index.ts（取证 → 预检 → 打点）。
    try {
      initExitForensics()
      markExitStage('when-ready')
    } catch {
      // 取证初始化失败绝不阻塞启动
    }
    // 原生模块加载预检：在加载 Application 之前确保 better-sqlite3 / koffi / sharp 可在本环境加载。
    // 缺失 VC++ 运行库 / ABI 不匹配 / 解包缺失都会在此被捕获并弹出可操作提示，避免静默崩溃。
    // （失败时已持锁，显式释放后再退出。）
    if (!verifyCriticalNativeModules()) {
      try {
        app.releaseSingleInstanceLock?.()
      } catch {}
      app.exit(1)
      return
    }
    // GPU 回退：登记本次启动尝试（失败计数+1，did-finish-load 时清零），
    // 并注册 GPU 子进程崩溃观测（须在窗口创建前，抢在 Chromium FATAL 前落盘回退标记）
    markBootAttempt()
    setupGpuProcessWatcher()
    bootMark('winner-only startup marks done (forensics / native check / gpu watcher)')

    bootMark('before app.whenReady()')
    await app.whenReady()
    bootMark('after app.whenReady()')

    // 提前注册全局异常捕获（在 dbManager.initialize 之前）
    // 修复：原实现注册时机太晚，dbManager.initialize 抛错时此处理器未注册
    // 即便此处 logFault 不可用（logDir 未设置），logStartupError 仍能写入独立文件
    registerGlobalErrorHandlers()
    bootMark('registerGlobalErrorHandlers done')

    // 阶段 1：数据库初始化（最可能失败的阶段）
    // 修复：包裹 try/catch，失败时记录到独立诊断日志（不依赖 logger 系统）
    // 注册恢复 / 崩溃监听器：在 dbManager.initialize() 之前注册，确保 initialize 期间的恢复事件能被捕获
    // 阶段 2.2：ctx 在此处提前构造（由 Application 注入），实现迁移到 app/recovery.ts
    registerRecoveryListeners(ctx)
    bootMark('registerRecoveryListeners done')
    // 自恢复（attemptRecovery）前注入 scanner / media worker bridge：
    // 让数据库自恢复在 rename 覆盖在线库前能显式停止这些持有 dbPath 连接的 worker，
    // 避免 Windows EPERM 共享冲突（databaseWorkerBridge 在 initialize 后才注入，启动期其为 null → 安全 no-op）。
    // scanner / media worker 为惰性启动，启动期 worker 为 null，stopWorkerForRestore 同样是安全的 no-op。
    ctx.dbManager.setScannerWorkerBridge(ctx.scannerWorkerBridge)
    ctx.dbManager.setMediaWorkerBridge(ctx.mediaWorkerBridge)
    try {
      bootMark('before dbManager.initialize()')
      await ctx.dbManager.initialize()
      // 数据库写操作进程拆分：initialize 完成后注入 worker bridge，
      // MediaRepository 通过 getWorkerBridge() 走 worker 进程执行写操作
      ctx.dbManager.setWorkerBridge(ctx.databaseWorkerBridge)
    } catch (dbErr) {
      diagLog(
        'BOOT',
        'dbManager.initialize FAILED: ' + (dbErr instanceof Error ? dbErr.message : String(dbErr))
      )
      logStartupError('dbManager.initialize', dbErr)
      // 数据库初始化失败属于致命错误，无法继续
      throw dbErr
    }
    bootMark('dbManager.initialize done')
    // 补查 dbManager.initialize() 期间的恢复事件（监听器已注册，但 initialize 内部触发的事件已存入 lastRecovery）
    checkPendingDatabaseRecovery(ctx)

    // 阶段 2：自定义目录迁移（每个目录独立 try/catch，避免单点失败阻塞全部）
    // 修复：原实现 4 个 ensureDir 任一抛错会阻塞后续 initLogger / crashReporter
    // P1-C6：migrateDirFiles 已改为 async，避免 GB 级文件迁移阻塞主进程事件循环
    // 阶段 2.3：实现迁移到 app/custom-dirs.ts
    try {
      await applyCustomDirectories(ctx)
    } catch (dirErr) {
      logStartupError('applyCustomDirectories', dirErr)
      // 自定义目录失败不应阻塞启动，继续使用默认目录
    }

    // 阶段 3：日志系统初始化（即便阶段 2 失败也要尝试）
    try {
      initLogger()
    } catch (logErr) {
      logStartupError('initLogger', logErr)
      // 日志失败不阻塞启动
    }

    // 阶段 3.5：主进程 i18n 初始化（与 initLogger 同期，不阻塞启动）
    // 必须在 app.whenReady() 之后调用，读取持久化语言设置并预加载非 zh-CN 语言
    // 失败静默回退到 zh-CN（i18n/index.ts 内部已有兜底，此处 try/catch 为额外保护）
    try {
      await initMainI18n()
    } catch (err) {
      logger.warn('[MainI18n] init failed, fallback to zh-CN:', err)
    }

    // 阶段 4：崩溃报告系统
    try {
      crashReporter.start({ uploadToServer: false, compress: true })
      initCrashDir()
      logger.info(t('main.lifecycle.log.crashReporterStarted', { dir: getCrashDirectory() }))
    } catch (err) {
      logStartupError('crashReporter.start', err)
      try {
        logger.error(t('main.lifecycle.log.crashReporterFailed'), err)
      } catch {}
    }

    // 阶段 5：备份服务
    try {
      backupService.init(ctx.dbManager)
      // 分级调度：注入 scheduler，启动备份通过低优先级队列执行
      backupService.setScheduler(ctx.taskScheduler)
      backupService.scheduleStartupBackup()
      // P1-M：编辑器服务初始化（注入 dbManager）
      editorService.init(ctx.dbManager)
      // 分级调度：注入 scheduler，pruneOldSnapshots 通过低优先级队列执行
      editorService.setScheduler(ctx.taskScheduler)
    } catch (err) {
      logStartupError('backupService.init', err)
      try {
        logger.error(t('main.lifecycle.log.backupInitFailed'), err)
      } catch {}
    }

    // 阶段 6：协议注册 + IPC + 窗口
    // 阶段 2.3：实现迁移到 app/media-protocol.ts
    registerMediaProtocol(ctx)
    // 全盘扫描模块进程拆分：worker 进程独立打开同一 db 文件（WAL 多连接并发）
    // 不再向 ScannerManager 注入主进程的 Database / DatabaseManager
    // dbPath 与 DatabaseManager 内部计算保持一致（userData/database/meow_star_map.db）
    ctx.scannerManager.setDbPath(path.join(app.getPath('userData'), 'database', 'meow_star_map.db'))
    // 缩略图 / pHash / 重复检测进程拆分：media worker 独立打开同一 db 文件（WAL 多连接并发）
    ctx.mediaWorkerManager.setDbPath(
      path.join(app.getPath('userData'), 'database', 'meow_star_map.db')
    )
    // 阶段 2.4：setupIPC 迁移到 app/ipc-setup.ts
    setupIPC(ctx)
    // 损坏文件容错：注入 markCorrupted / clearCorrupted 回调到 ThumbnailGenerator 与 VideoService
    // 必须在 setupIPC 之后调用：依赖 dbManager.getDatabase() 与 workerBridge 已就绪
    // 阶段 2.4：实现迁移到 app/ipc-setup.ts
    injectCorruptedMarkers(ctx)
    // sync-integration 阶段 4：NikkiSync HTTPS 同步服务器组装与自启
    // 必须在 dbManager.initialize 之后（读 sync.* 设置与打开 sync_* 表）；
    // 失败不阻塞应用启动（日志留证，状态经 IPC sync:getStatus 可见）
    try {
      await initSyncServer(ctx)
    } catch (err) {
      logStartupError('initSyncServer', err)
    }
    // 插件系统初始化：在 createMainWindow 之前完成，确保窗口加载时 facade 可用
    // 失败不阻塞应用启动（init 内部已捕获异常并记录日志）
    await pluginHost.init()
    // 阶段 2.4：createMainWindow 迁移到 app/window-manager.ts
    bootMark('before createMainWindow()')
    await createMainWindow(ctx)
    bootMark('after createMainWindow()')
    // G1-F3（审查修复轮）：首窗可用即退出启动期——NikkiSync 长初始化（~14s）期间的
    // 游离 rejection 不得再被致命化弹框退出（窗口已可用，应用事实上已就绪）。
    markStartupSettled()
    // chromium-debug.log 在位探测：原生 FATAL 取证载体缺席与否在此可判定（T11）
    try {
      diagLog('BOOT', chromiumLogPresenceLine(getForensicsRoot()))
    } catch {
      // 探测失败不阻塞启动
    }
    // 主窗口就绪后注入引用，供 confirmInstall 弹窗作为父级
    // 阶段 2.4：使用 window-manager 的 getMainWindow 抛错版本（确保窗口存在）
    pluginHost.setMainWindow(getMainWindow(ctx))
    // 主窗口创建后，弹出暂存的数据库恢复 / worker 崩溃事件提示
    // 放在 pluginHost.setMainWindow 之后，确保 dialog 有正确的父级
    flushPendingRecoveryEvents(ctx)

    // sync-integration 阶段 2：内嵌 NikkiSync PcCompanion Runtime（库+发现+扫描，不起 LAN 服务）
    // 独立 try/catch：未建链 / 无游戏目录 / 装载失败都只能降级，绝不阻塞启动。
    // F6（2026-11-15）：从 createMainWindow 之前移到之后——运行时启动含游戏目录全盘
    // 发现（未装游戏的机器实测 ~14s，慢盘/多盘更久），原在位会把首窗出现时间整个
    // 拖住，是"双击后软件无响应"的直接机制之一。窗口先行，运行时后台就位，
    // 状态经 IPC sync:getStatus 对渲染层可见。
    try {
      await initNikkiSyncRuntime(ctx)
    } catch (err) {
      logStartupError('initNikkiSyncRuntime', err)
    }

    // 阶段 6.5：初始化自动更新（生产环境；dev 下仅 MEOW_DEV_UPDATE_FEED=1 时按 dev-app-update.yml
    // 的假更新源初始化，其余 dev 场景由 initAutoUpdater 内部直接跳过 ⇒ app:update:check 抛错）
    // 仅注册监听器与 IPC 通道，不自动检查更新——由用户手动触发（设置页 → 检查更新）
    try {
      initAutoUpdater(ctx)
    } catch (err) {
      logStartupError('initAutoUpdater', err)
    }

    // 阶段 7：主题 + 数据库修复
    try {
      const savedUITheme = ctx.dbManager.getSetting('uiTheme', 'default') as
        'default' | 'soft-pink-luxury'
      applyUITheme(ctx, savedUITheme)
      // R4：清理 scan_history 中 status='running' 的孤儿记录（进程崩溃/断电后未更新终态）
      // 放在 cleanupAndRepairDatabase 之前：先标记 interrupted，避免 UI 显示"扫描中"假象
      try {
        cleanupInterruptedScanHistory(ctx)
        // R12：检测 interrupted 记录并通知 UI（必须在 R4 之后，读取 R4 标记的 interrupted 记录）
        notifyInterruptedScan(ctx)
      } catch (err) {
        logStartupError('cleanupInterruptedScanHistory', err)
      }
      await cleanupAndRepairDatabase(ctx)
      // R2：重试 pending_renames 补偿表（batchRename DB 失败 + 反向回滚磁盘失败时写入）
      // 放在 cleanupAndRepairDatabase 之后：先清理失效记录再回放补偿，避免冲突
      try {
        await retryPendingRenames(ctx)
      } catch (err) {
        logStartupError('retryPendingRenames', err)
      }
      // R9：备份恢复后置修复——检测 restored_at 标志，触发 phash 重算 + duplicate 重新标记
      // 放在 retryPendingRenames 之后、performStartupScan 之前：先消费恢复标志，再进入正常扫描流程
      try {
        await runPostRestoreRepair(ctx)
      } catch (err) {
        logStartupError('runPostRestoreRepair', err)
      }
      setupThemeListener(ctx)
    } catch (err) {
      logStartupError('cleanup', err)
      try {
        logger?.error?.(t('main.lifecycle.log.themeCleanupFailed'), err)
      } catch {}
    }

    // 阶段 7.5：确保桌面快捷方式存在（NSIS 覆盖安装时可能未创建）
    // F5 修复：改为 fire-and-forget 异步调用，避免注册表查询阻塞启动流程
    // 阶段 2.3：实现迁移到 app/desktop-shortcut.ts
    void ensureDesktopShortcut().catch((err) => logStartupError('ensureDesktopShortcut', err))

    // 阶段 8：启动后延迟任务（非关键，失败不阻塞）
    // 分级调度改造：启动期任务通过 taskScheduler.enqueueLow 入队，等主窗口 ready-to-show 后 resume 才执行
    // 修复：保存定时器引用，退出时清理，避免回调在数据库关闭后访问或启动新子进程
    // 开机自启动：先比对 OS 实际状态，一致则跳过写入（不再每次启动无条件重写）
    try {
      const saved = ctx.dbManager.getSetting<unknown>(
        SETTING_LAUNCH_AT_LOGIN,
        LAUNCH_AT_LOGIN_DEFAULT
      )
      const openAtLogin = normalizeLaunchAtLogin(saved)
      diagLog('LOGIN', `launchAtLogin resolved: openAtLogin=${openAtLogin}`)
      const osState = readLoginItemOpenAtLogin()
      if (osState === openAtLogin) {
        diagLog('LOGIN', `login item unchanged, skip write: openAtLogin=${openAtLogin}`)
        // 一致跳过写入 ≠ 无残留：残留项按当前名回读恰为 false，正好落进本分支；
        // 不在这里做残留清理，旧值名残留项将永久存活并继续开机拉起应用（2026-11-22 取证）
        cleanupLegacyLoginItems()
      } else {
        // 读失败（undefined）保守仍同步一次，不静默跳过
        if (osState === undefined) {
          diagLog('LOGIN', 'login item read failed, fallback to sync')
        }
        syncLoginItemSetting(openAtLogin)
      }
    } catch (err) {
      logStartupError('launchAtLoginSync', err)
    }
    const autoScan = ctx.dbManager.getSetting('autoScanOnStartup', true)
    if (autoScan) {
      ctx.startupTimers.push(
        setTimeout(() => {
          // 分级调度：启动扫描作为低优先级任务入队，等空闲时执行
          void ctx.taskScheduler
            .enqueueLow(() => performStartupScan(ctx), {
              id: 'startup-scan',
              cancel: () => void ctx.scannerManager.stopScan()
            })
            .catch((err) => {
              logStartupError('performStartupScan', err)
            })
          // D4 埋点：入队时调度器若仍暂停，说明窗口 resume 尚未发生（正常时序）；
          // 打包版现场曾因 resume 竞态导致扫描永不执行，此日志用于链路取证
          logger.info(
            `[Startup] startup-scan 已入队 (scheduler paused=${ctx.taskScheduler.isPaused()})`
          )
        }, STARTUP_SCAN_DELAY_MS)
      )
    }
    // 启动性能优化：上次非干净退出时，全量 integrity_check 延后到低优先级队列后台执行
    // （initialize 内的 quick_check 快速路径已同步完成；此处仅「双保险」复核，
    // 与启动扫描同为 low 队列 FIFO 串行，不阻塞窗口出现；同步 PRAGMA 不可被抢占中断，
    // 取舍见 docs/archive/plans/startup-perf.md §2）
    if (ctx.dbManager.shouldRunFullIntegrityCheck()) {
      ctx.startupTimers.push(
        setTimeout(() => {
          void ctx.taskScheduler
            .enqueueLow(
              async () => {
                const result = ctx.dbManager.runFullIntegrityCheck()
                if (!result.ok) {
                  logStartupError(
                    'startup-integrity-check',
                    new Error(
                      t('main.lifecycle.log.selfCheckFailed', {
                        reason: result.reason ?? t('main.lifecycle.log.unknownReason')
                      })
                    )
                  )
                }
              },
              { id: 'startup-integrity-check' }
            )
            .catch((err) => logStartupError('runFullIntegrityCheck', err))
        }, STARTUP_SCAN_DELAY_MS)
      )
    }
    ctx.startupTimers.push(
      setTimeout(() => {
        // 分级调度：LRU 强制校准作为低优先级任务入队
        void ctx.taskScheduler
          .enqueueLow(() => ctx.thumbnailGen.enforceLimitNow(), { id: 'startup-lru-enforce' })
          .catch((err) => {
            logStartupError('enforceLimitNow', err)
          })
      }, STARTUP_SCAN_DELAY_MS + 5000)
    )
    // F-S5：启动后台 LRU 定时校准任务（每 5 分钟）
    ctx.thumbnailGen.startLruBackgroundTask()
    ctx.startupTimers.push(
      setTimeout(() => {
        // 分级调度：崩溃文件清理作为低优先级任务入队
        void ctx.taskScheduler
          .enqueueLow(() => enforceCrashLimit(), { id: 'startup-crash-cleanup' })
          .catch((err) => {
            logger?.warn?.(t('main.lifecycle.log.crashCleanFailed'), err)
          })
      }, STARTUP_SCAN_DELAY_MS + 6000)
    )
    // 外部参考数据（总计划阶段 1）：启动后延迟检查版本（≥10s，不阻塞 8 阶段启动）。
    // fail-soft：checkForUpdate 永不 reject、失败降级旧缓存，仅记诊断日志与 lastError；
    // 镜像地址经设置键 referenceData.manifestBaseUrl（settings:set 已校验 URL/SSRF）。
    // autoUpdate 开关（默认 true 保持既有行为）：显式 false 时不注册定时器；
    // 非 boolean 的脏值按安全默认关闭并记明确诊断，禁止静默当成"开启"。
    const storedAutoUpdate = ctx.dbManager.getSetting('referenceData.autoUpdate', true)
    // 外部输入不可信：只有 true（含键缺省回落）才开机检查；显式 false 是用户主动关闭；
    // 其余脏值按安全默认关闭并记明确诊断，不静默当成「开启」。
    const autoUpdateEnabled = storedAutoUpdate === undefined || storedAutoUpdate === true
    if (!autoUpdateEnabled && storedAutoUpdate !== false) {
      logger?.warn?.(
        '[referenceData] invalid autoUpdate value, skipping startup check',
        storedAutoUpdate
      )
    }
    if (autoUpdateEnabled) {
      ctx.startupTimers.push(
        setTimeout(() => {
          void ctx.taskScheduler
            .enqueueLow(
              () => {
                const manifestBaseUrl = ctx.dbManager.getSetting(
                  'referenceData.manifestBaseUrl',
                  ''
                )
                return checkForUpdate({ manifestBaseUrl })
              },
              { id: 'startup-reference-data-check' }
            )
            .catch((err) => {
              logStartupError('referenceDataCheck', err)
            })
        }, REFERENCE_DATA_CHECK_DELAY_MS)
      )
    }
  } catch (fatalErr) {
    // G1-F8（审查修复轮）：fatal 对话框 await 期间游离 rejection 不得再触发第二张致命框
    // 抢先 exit 截断用户交互——进入 fatal 即视为启动已终结。
    markStartupSettled()
    // 启动失败兜底：记录错误 + 显示用户可见错误对话框 + 释放锁 + 退出
    logStartupError('initialize-fatal', fatalErr)
    try {
      // 尝试用 logger 记录（如果已初始化）
      if (logger) logger.error(t('main.lifecycle.log.startupFailed'), fatalErr)
    } catch {}

    // P1-7：用 dialog.showMessageBox 替代 showErrorBox，提供"打开日志目录"操作按钮
    // 原实现仅能"确定"关闭，用户拿到错误后还得手动去找日志路径，体验差
    try {
      const errMsg = fatalErr instanceof Error ? fatalErr.message : String(fatalErr)
      // 与 logStartupError 真实落盘路径同源（此前指向 userData，与弹窗/实际写入不一致）
      const startupLogPath = getStartupLogPathValue()
      const result = await dialog.showMessageBox({
        type: 'error',
        title: t('main.dialog.startupFailed.title'),
        message: t('main.dialog.startupFailed.message'),
        detail: t('main.dialog.startupFailed.detail', {
          message: errMsg,
          logPath: startupLogPath
        }),
        buttons: [
          t('main.dialog.startupFailed.openLogDir'),
          t('main.dialog.instanceRunning.exitButton')
        ],
        defaultId: 1,
        cancelId: 1
      })
      if (result.response === 0) {
        // 打开日志所在目录（startup-errors.log 在 userData 根目录）
        try {
          await shell.openPath(path.dirname(startupLogPath))
        } catch {}
      }
    } catch (err) {
      // 启动失败对话框自身抛错时仍要有一次可见提示，绝不静默退出
      showStartupFailureWithFallback(err, { stage: 'initialize-fatal-dialog-fallback' })
    }

    // 释放资源并退出（bootstrap 仅由锁赢家执行——index.ts 已保证，锁必持）
    try {
      ctx.dbManager?.close?.()
    } catch {}
    try {
      app.releaseSingleInstanceLock?.()
    } catch {}
    // 修复：直接 app.exit 而非 app.quit，避免触发 before-quit 异步清理流程
    // 启动失败时 performCleanup 中的 dbManager.close 可能再次抛错（已关闭）
    // P0 根因修复：原用 setTimeout(100ms)，改为直接 app.exit(1) 立即终止
    try {
      app.exit(1)
    } catch {}
  }
}
