import { app, protocol, dialog, shell } from 'electron'
import path from 'path'
import { diagLog, logStartupError } from './utils/startup-diagnostic'
import { electronLogger } from './utils/logger'
import { registerRendererProtocol } from './app/renderer-protocol'
import {
  shouldDisableHardwareAcceleration,
  markBootAttempt,
  setupGpuProcessWatcher
} from './app/gpu-fallback'
import { t } from './i18n'

// 捕获未处理异常和未处理的 Promise 拒绝。
// 必须放在任何可能抛错的模块级代码（registerSchemesAsPrivileged 等）之前：
// 若在模块加载期抛错但处理器未注册，Electron 会弹阻塞式模态框导致启动挂起。
// 提前注册可将"挂起"变成"记录诊断日志"。
// 注意：此处只记 diagLog、不退出进程——真正的处理（弹窗 + logFault + 退出兜底）
// 由 src/main/app/error-handlers.ts 统一负责（单一入口，在 lifecycle 中注册）。
// 若在此提前 app.exit(1)，会抢在诊断处理器之前杀死进程，使 logFault 诊断链路成为死代码。
process.on('uncaughtException', (err) => {
  diagLog('INDEX', `uncaughtException: ${err.message}\n${err.stack}`)
})
process.on('unhandledRejection', (reason) => {
  diagLog('INDEX', `unhandledRejection: ${String(reason)}`)
  // electron-log 统一落盘原始 reason，便于崩溃诊断
  electronLogger.error('unhandledRejection:', reason)
  // 不再直接 app.exit(1)：非致命的游离 rejection 不应杀死整个应用，
  // 避免一条边缘异步路径导致扫描进度/用户数据丢失。
})

diagLog('INDEX', '=== index.ts loaded ===')

// GPU 崩溃自动回退（VS Code 模式）：部分机器 GPU 进程无法运行时，Chromium 会以
// FATAL "GPU process isn't usable. Goodbye." 自杀主进程，表现为 loadURL 报
// ERR_FAILED(-2) 白屏（app:// 协议层无关，2026-08-19 用户机 54 个 dump 裁决）。
// 上次已激活回退（GPU 崩溃标记或连续启动失败≥2）→ 本次启动禁用硬件加速。
// 必须在 app ready 之前调用 disableHardwareAcceleration 才生效。
if (shouldDisableHardwareAcceleration()) {
  app.disableHardwareAcceleration()
  diagLog('INDEX', 'gpu-fallback active: hardware acceleration DISABLED for this boot')
  try {
    electronLogger.info(t('main.index.log.gpuFallbackActive'))
  } catch {
    // electronLogger 未就绪时仅依赖 diagLog
  }
}

// 注册自定义协议，使渲染进程可以安全访问本地媒体文件
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      secure: true,
      standard: true,
      // 渲染进程以 crossOrigin='anonymous' 加载 media:// 图片绘制 canvas，
      // 需声明 CORS 特权，否则请求在网络层被拒
      corsEnabled: true,
      supportFetchAPI: true,
      stream: true
    }
  },
  // 渲染进程产物协议：替代 file:// 加载，规避 ES Module 经 file:// 触发的 CORS 白屏
  {
    scheme: 'app',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])

diagLog('INDEX', 'protocol.registerSchemesAsPrivileged done')

// 注意：protocol.handle 内部会访问 session.defaultSession，必须在 app.whenReady() 之后调用，
// 否则抛出 "Session can only be received when app is ready"。scheme 特权声明已在上方 ready 前完成。

// 修复：Application 构造函数中的 DatabaseManager 和 ThumbnailGenerator
// 都调用了 app.getPath('userData')，这在 app.whenReady() 之前会抛错
// （打包环境下错误为 "Cannot create app data folder before app.whenReady()"）
// 因此必须将 new Application() 延迟到 app.whenReady() 之后执行
app.whenReady().then(async () => {
  diagLog('INDEX', 'app.whenReady() fired')

  // 首个窗口导航前注册 app:// 处理器（此时 session 已可用）
  registerRendererProtocol()
  diagLog('INDEX', 'registerRendererProtocol done')

  // GPU 回退：登记本次启动尝试（失败计数+1，did-finish-load 时清零），
  // 并注册 GPU 子进程崩溃观测（须在窗口创建前，抢在 Chromium FATAL 前落盘回退标记）
  markBootAttempt()
  setupGpuProcessWatcher()
  diagLog('INDEX', 'gpu-fallback attempt marked, watcher registered')

  try {
    diagLog('INDEX', 'before import Application')
    const { Application } = await import('./app/application')
    diagLog('INDEX', 'Application module imported, before new Application()')
    const application = new Application()
    diagLog('INDEX', 'Application constructed, before initialize()')
    await application.initialize()
    diagLog('INDEX', 'Application.initialize() completed')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : ''
    diagLog('INDEX', `FATAL ERROR in startup: ${msg}\n${stack}`)
    logStartupError('index.ts app.whenReady', err)
    // 崩溃发生在 registerGlobalErrorHandlers 注册之前，必须在此兜底
    const logPath = path.join(app.getPath('userData'), 'startup-errors.log')
    try {
      const result = await dialog.showMessageBox({
        type: 'error',
        title: t('main.index.dialog.startupFailedTitle'),
        message: t('main.index.dialog.startupFailedMessage'),
        detail: t('main.index.dialog.startupFailedDetail', { message: msg, logPath }),
        buttons: [t('main.dialog.startupFailed.openLogDir'), t('main.index.dialog.exit')]
      })
      if (result.response === 0) {
        await shell.openPath(path.dirname(logPath))
      }
    } catch {
      // 弹窗失败时忽略
    }
    try {
      app.releaseSingleInstanceLock?.()
    } catch {
      // 释放锁失败时忽略
    }
    app.exit(1)
  }
})
