import { app, BrowserWindow, dialog, shell, crashReporter } from 'electron'
import path from 'path'
import { execFileSync, exec } from 'child_process'
import type { AppContext } from './app-context'
import { backupService } from '../services/backup-service'
import { editorService } from '../services/editor-service'
import { STARTUP_SCAN_DELAY_MS } from '../utils/constants'
import { initLogger, logger } from '../utils/logger'
import { initCrashDir, enforceCrashLimit, getCrashDirectory } from '../services/crash-service'
import { logStartupError, diagLog } from '../utils/startup-diagnostic'
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
// 自动更新：复用 electron-updater，仅生产环境初始化
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

/**
 * 应用启动主流程：单实例锁 → whenReady → 阶段 1-8 → 生命周期事件注册。
 * 启动失败兜底：任何阶段抛错都走 fatal catch，确保进程退出 + 释放单实例锁。
 *
 * 阶段 2.5：从 Application.initialize() 迁移而来，零逻辑改动，
 * 所有原 this.xxx 字段通过 ctx 访问。
 */
export async function bootstrapApplication(ctx: AppContext): Promise<void> {
  // 启动失败兜底：任何阶段抛错都走 failStartup，确保进程退出 + 释放单实例锁
  // 修复"前几次正常，后续无法启动"的核心问题：原实现 initialize 失败后只 .catch(console.error)，
  // 进程不退出、持单实例锁、无窗口、无日志，变僵尸；后续启动全部 gotLock=false 静默退出
  let lockAcquired = false
  try {
    diagLog('BOOT', 'bootstrapApplication start')
    // 单实例锁：防止多实例并发操作同一 SQLite 数据库导致竞争
    let gotLock = app.requestSingleInstanceLock()
    diagLog('BOOT', 'requestSingleInstanceLock returned: ' + gotLock)
    if (!gotLock) {
      // P0 修复：旧实例可能正在 before-quit 清理流程中（DB WAL checkpoint 耗时 2-5s），
      // 锁尚未释放。等待 1s 后重试，最多 3 次，避免频繁弹出"已有实例运行"对话框。
      // 场景：用户关闭应用后立即重新打开，旧进程仍在 cleanup 中持锁。
      for (let retry = 0; retry < 3 && !gotLock; retry++) {
        diagLog('BOOT', `retry ${retry + 1}/3 waiting 1s for lock...`)
        await new Promise((resolve) => setTimeout(resolve, 1000))
        gotLock = app.requestSingleInstanceLock()
        diagLog('BOOT', `retry ${retry + 1} gotLock=` + gotLock)
      }
    }
    if (!gotLock) {
      // P0-5：已有实例运行（可能是僵尸进程持锁），提供三选项对话框
      // 修复：原实现静默退出，用户完全不知道为何软件没启动
      // 改用 showMessageBox 提供"清理并重启 / 手动处理 / 退出"三个选项
      diagLog('BOOT', '!gotLock branch: awaiting app.whenReady() before dialog')
      await app.whenReady()
      diagLog('BOOT', '!gotLock branch: app.whenReady() ok, showing dialog')
      try {
        // 诊断：记录 i18n 文本是否成功获取（i18n 在此阶段可能未初始化）
        const titleText = t('main.dialog.instanceRunning.title')
        const msgText = t('main.dialog.instanceRunning.message')
        diagLog('BOOT', `!gotLock dialog i18n: title="${titleText}" msg="${msgText}"`)
        const result = await dialog.showMessageBox({
          type: 'warning',
          title: titleText,
          message: msgText,
          detail: t('main.dialog.instanceRunning.detail'),
          buttons: [
            t('main.dialog.instanceRunning.cleanupButton'),
            t('main.dialog.instanceRunning.manualButton'),
            t('main.dialog.instanceRunning.exitButton')
          ],
          defaultId: 0,
          cancelId: 2,
          noLink: true
        })
        diagLog('BOOT', `!gotLock dialog response: ${result.response}`)

        if (result.response === 0) {
          // 清理并重启：结束除当前进程外的所有同名进程，然后重启
          // 修复1：原 wmic 在 Win11 24H2+ 已移除，回退分支 taskkill /F /IM 会杀死自己
          // 修复2：中文进程名在 PowerShell 5.1 -Command 模式下编码错误，改用 -EncodedCommand
          // 修复3：taskkill 不带 /T 无法杀死 crashpad_handler 子进程，子进程可能持锁
          //        改用 taskkill /F /T /PID 递归杀整个进程树
          // 修复4：延长等待到 2000ms，给 OS 更多时间释放 named mutex
          const appName = path.basename(app.getPath('exe'))
          const currentPid = process.pid
          let killedAny = false
          try {
            // 用 -EncodedCommand 避免 PowerShell 5.1 的中文编码问题
            const psCommand = `Get-CimInstance Win32_Process -Filter "Name='${appName}'" | Where-Object { $_.ProcessId -ne ${currentPid} } | Select-Object -ExpandProperty ProcessId`
            const encoded = Buffer.from(psCommand, 'utf16le').toString('base64')
            const output = execFileSync('powershell', ['-NoProfile', '-EncodedCommand', encoded], {
              windowsHide: true,
              encoding: 'utf8',
              timeout: 10000
            })
            const pids = output
              .split('\n')
              .map((line: string) => line.trim())
              .filter((p: string) => /^\d+$/.test(p))
              .map((p: string) => parseInt(p, 10))

            for (const pid of pids) {
              try {
                // /T 递归杀整个进程树（含 crashpad_handler 等子进程）
                execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true })
                killedAny = true
              } catch {
                // 单个进程杀失败忽略（可能已自行退出）
              }
            }
          } catch {
            // 回退：用 -EncodedCommand 调用 Stop-Process，排除当前 PID
            try {
              const psCommand2 = `Get-Process -Name '${appName.replace('.exe', '')}' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne ${currentPid} } | Stop-Process -Force`
              const encoded2 = Buffer.from(psCommand2, 'utf16le').toString('base64')
              execFileSync('powershell', ['-NoProfile', '-EncodedCommand', encoded2], {
                windowsHide: true,
                timeout: 10000
              })
              killedAny = true
            } catch {
              // 两种方案都失败，跳过杀进程，直接重启（新实例会再次尝试获取锁）
            }
          }
          // 等待旧进程完全退出后重启
          // 修复：延长到 2000ms，给 OS 足够时间释放 named mutex 和清理子进程
          // P1 修复：若 taskkill 未杀死任何进程（killedAny=false），不重启
          // 避免新实例再次拿不到锁 → 再次弹窗 → 用户再点"清理并重启" → 无限循环
          if (!killedAny) {
            try {
              await dialog
                .showMessageBox({
                  type: 'warning',
                  title: t('main.dialog.cleanupFailed.title'),
                  message: t('main.dialog.cleanupFailed.message'),
                  detail: t('main.dialog.cleanupFailed.detail'),
                  buttons: [
                    t('main.dialog.cleanupFailed.openTaskManager'),
                    t('main.dialog.instanceRunning.exitButton')
                  ],
                  defaultId: 0,
                  cancelId: 1,
                  noLink: true
                })
                .then((r) => {
                  if (r.response === 0) {
                    try {
                      exec('taskmgr', { windowsHide: false })
                    } catch {}
                  }
                })
            } catch {}
            app.quit()
            return
          }
          setTimeout(() => {
            // 当前进程没有锁（gotLock=false），但安全起见仍尝试释放
            try {
              app.releaseSingleInstanceLock?.()
            } catch {}
            app.relaunch()
            app.exit(0)
          }, 2000)
          return
        } else if (result.response === 1) {
          // 手动处理：打开任务管理器
          try {
            exec('taskmgr', { windowsHide: false })
          } catch {}
        }
      } catch (err) {
        // 对话框显示失败时记录到诊断日志
        logStartupError('gotLock-false-dialog', err)
      }
      app.quit()
      return
    }
    lockAcquired = true
    diagLog('BOOT', 'lockAcquired = true')
    // 第二实例尝试启动时，聚焦到已有窗口
    app.on('second-instance', () => {
      const windows = BrowserWindow.getAllWindows()
      if (windows.length > 0) {
        const win = windows[0]
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    })

    diagLog('BOOT', 'before app.whenReady()')
    await app.whenReady()
    diagLog('BOOT', 'after app.whenReady()')

    // 提前注册全局异常捕获（在 dbManager.initialize 之前）
    // 修复：原实现注册时机太晚，dbManager.initialize 抛错时此处理器未注册
    // 即便此处 logFault 不可用（logDir 未设置），logStartupError 仍能写入独立文件
    registerGlobalErrorHandlers()
    diagLog('BOOT', 'registerGlobalErrorHandlers done')

    // 阶段 1：数据库初始化（最可能失败的阶段）
    // 修复：包裹 try/catch，失败时记录到独立诊断日志（不依赖 logger 系统）
    // 注册恢复 / 崩溃监听器：在 dbManager.initialize() 之前注册，确保 initialize 期间的恢复事件能被捕获
    // 阶段 2.2：ctx 在此处提前构造（由 Application 注入），实现迁移到 app/recovery.ts
    registerRecoveryListeners(ctx)
    diagLog('BOOT', 'registerRecoveryListeners done')
    try {
      diagLog('BOOT', 'before dbManager.initialize()')
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
    diagLog('BOOT', 'dbManager.initialize done')
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
    // dbPath 与 DatabaseManager 内部计算保持一致（userData/database/wxnn_photo_manager.db）
    ctx.scannerManager.setDbPath(
      path.join(app.getPath('userData'), 'database', 'wxnn_photo_manager.db')
    )
    // 缩略图 / pHash / 重复检测进程拆分：media worker 独立打开同一 db 文件（WAL 多连接并发）
    ctx.mediaWorkerManager.setDbPath(
      path.join(app.getPath('userData'), 'database', 'wxnn_photo_manager.db')
    )
    // 阶段 2.4：setupIPC 迁移到 app/ipc-setup.ts
    setupIPC(ctx)
    // 损坏文件容错：注入 markCorrupted / clearCorrupted 回调到 ThumbnailGenerator 与 VideoService
    // 必须在 setupIPC 之后调用：依赖 dbManager.getDatabase() 与 workerBridge 已就绪
    // 阶段 2.4：实现迁移到 app/ipc-setup.ts
    injectCorruptedMarkers(ctx)
    // 插件系统初始化：在 createMainWindow 之前完成，确保窗口加载时 facade 可用
    // 失败不阻塞应用启动（init 内部已捕获异常并记录日志）
    await pluginHost.init()
    // 阶段 2.4：createMainWindow 迁移到 app/window-manager.ts
    diagLog('BOOT', 'before createMainWindow()')
    await createMainWindow(ctx)
    diagLog('BOOT', 'after createMainWindow()')
    // 主窗口就绪后注入引用，供 confirmInstall 弹窗作为父级
    // 阶段 2.4：使用 window-manager 的 getMainWindow 抛错版本（确保窗口存在）
    pluginHost.setMainWindow(getMainWindow(ctx))
    // 主窗口创建后，弹出暂存的数据库恢复 / worker 崩溃事件提示
    // 放在 pluginHost.setMainWindow 之后，确保 dialog 有正确的父级
    flushPendingRecoveryEvents(ctx)

    // 阶段 6.5：初始化自动更新（仅生产环境；dev 下 initAutoUpdater 内部直接跳过）
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
        }, STARTUP_SCAN_DELAY_MS)
      )
    }
    // 启动性能优化：上次非干净退出时，全量 integrity_check 延后到低优先级队列后台执行
    // （initialize 内的 quick_check 快速路径已同步完成；此处仅「双保险」复核，
    // 与启动扫描同为 low 队列 FIFO 串行，不阻塞窗口出现；同步 PRAGMA 不可被抢占中断，
    // 取舍见 docs/plans/startup-perf.md §2）
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

    // 退出清理：确保数据库正确关闭并执行 WAL checkpoint
    // 修复：原实现同步 before-quit 中调用异步清理且未 await，异步清理来不及完成；
    // 且未 kill ffmpeg/ffprobe 子进程，这些子进程保持事件循环活跃 → 进程不退出 → 持有单实例锁 → 下次启动失败
    // 改为 event.preventDefault + 异步清理 + app.exit(0) 强制退出兜底
    // P1-8：增加超时强制退出兜底，防止 performCleanup 卡住（如 db.close 阻塞）
    // P1-A8：根据 WAL 文件大小动态调整超时——WAL 较大时延长到 5s，避免强制退出时 WAL 未合并
    //        （配合 dbManager.close() 改用 PASSIVE 非阻塞 checkpoint，正常情况下 2s 足够）
    app.on('before-quit', (event) => {
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
  } catch (fatalErr) {
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
      const startupLogPath = path.join(app.getPath('userData'), 'startup-errors.log')
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
    } catch {}

    // 释放资源并退出
    try {
      ctx.dbManager?.close?.()
    } catch {}
    if (lockAcquired) {
      try {
        app.releaseSingleInstanceLock?.()
      } catch {}
      // 修复：直接 app.exit 而非 app.quit，避免触发 before-quit 异步清理流程
      // 启动失败时 performCleanup 中的 dbManager.close 可能再次抛错（已关闭）
      // P0 根因修复：原用 setTimeout(100ms)，改为直接 app.exit(1) 立即终止
      try {
        app.exit(1)
      } catch {}
    } else {
      app.quit()
    }
  }
}
