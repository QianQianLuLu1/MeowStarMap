import { app, protocol } from 'electron'
import path from 'path'
import fs from 'fs'
import { diagLog, logStartupError, getStartupLogPathValue } from './utils/startup-diagnostic'
import { verifyCriticalNativeModules, showFatalStartupErrorBox } from './app/native-load-guard'
import { reportEarlyFatal, getUserFacingDiagDir } from './utils/early-crash-guard'
import { verifyStartupEnvironment } from './app/startup-environment'
import { electronLogger } from './utils/logger'
import { registerRendererProtocol } from './app/renderer-protocol'
import {
  recordBootDecision,
  markBootAttempt,
  setupGpuProcessWatcher,
  requestSelfHeal,
  wasBootInCompatMode
} from './app/gpu-fallback'
import { initExitForensics, markExitStage } from './app/exit-forensics'
import { t } from './i18n'

// 捕获未处理异常和未处理的 Promise 拒绝。
// 必须放在任何可能抛错的模块级代码（registerSchemesAsPrivileged 等）之前：
// 若在模块加载期抛错但处理器未注册，Electron 会弹阻塞式模态框导致启动挂起。
// 提前注册可将"挂起"变成"记录诊断日志"。
// 启动最早期全局异常捕获：error-handlers.ts 在 app.initialize() 阶段才注册，
// 此前（含原生模块加载、环境检测、窗口创建前）任何崩溃都在此兜底——同步落盘 +
// 不依赖 i18n / 渲染进程的原生弹框 + 退出进程。中心化到 early-crash-guard.reportEarlyFatal，
// 与 error-handlers 共用去重守卫，避免重复弹窗 / 退出。
process.on('uncaughtException', (err) => {
  reportEarlyFatal(err, { stage: 'index.uncaughtException' })
})
process.on('unhandledRejection', (reason) => {
  diagLog('INDEX', `unhandledRejection: ${String(reason)}`)
  // electron-log 统一落盘原始 reason，便于崩溃诊断
  electronLogger.error('unhandledRejection:', reason)
  // 不再直接 app.exit(1)：非致命的游离 rejection 不应杀死整个应用，
  // 避免一条边缘异步路径导致扫描进度/用户数据丢失。
})

// 崩溃转储目录用户友好化：文档/NikkiGallery/Diagnostics（须在 crashReporter.start 前设定）
try {
  app.setPath('crashDumps', getUserFacingDiagDir())
} catch {
  // crashDumps 路径不可用时沿用 electron 默认
}

// Chromium 原生日志落盘（ready 前 appendSwitch 才生效）：
// 捕获 Chromium FATAL（如 "GPU process isn't usable. Goodbye."）等原生层退出原因——
// 此类退出不经过 Node（无 uncaughtException、无崩溃转储），只能靠原生日志取证。
try {
  const chromiumLogPath = path.join(getUserFacingDiagDir(), 'chromium-debug.log')
  // 轮转：超过 10MB 重命名为 .old（单文件保留一份，防无限增长）
  try {
    if (fs.existsSync(chromiumLogPath) && fs.statSync(chromiumLogPath).size > 10 * 1024 * 1024) {
      fs.rmSync(chromiumLogPath + '.old', { force: true })
      fs.renameSync(chromiumLogPath, chromiumLogPath + '.old')
    }
  } catch {
    // 轮转失败不影响日志写入
  }
  app.commandLine.appendSwitch('enable-logging', 'file')
  app.commandLine.appendSwitch('log-file', chromiumLogPath)
} catch {
  // 诊断目录不可用时静默降级：不影响启动
}

// 验证专用：模拟启动最早期崩溃，验证 reportEarlyFatal 弹框+日志（仅 === '1'，默认关闭）
if (process.env.NIKKI_EARLY_CRASH_SIM === '1') {
  throw new Error('NIKKI_EARLY_CRASH_SIM triggered simulated early crash')
}

diagLog('INDEX', '=== index.ts loaded ===')

// GPU 崩溃自动回退（VS Code 模式）：部分机器 GPU 进程无法运行时，Chromium 会以
// FATAL "GPU process isn't usable. Goodbye." 自杀主进程，表现为 loadURL 报
// ERR_FAILED(-2) 白屏（app:// 协议层无关，2026-08-19 用户机 54 个 dump 裁决）。
// 上次已激活回退（GPU 崩溃标记或连续启动失败≥2）→ 本次启动禁用硬件加速。
// 必须在 app ready 之前调用 disableHardwareAcceleration 才生效。
if (recordBootDecision()) {
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

  // 退出取证（心跳 + 退出码落盘 + 异常终止检测）：userData 在 ready 后才可用，
  // 此处为最早可写时机；后续任何退出路径（含 app.exit/外部终止）都有迹可循
  try {
    initExitForensics()
    markExitStage('when-ready')
  } catch {
    // 取证初始化失败绝不阻塞启动
  }

  // 原生模块加载预检：在加载 Application 之前确保 better-sqlite3 / koffi / sharp 可在本环境加载。
  // 缺失 VC++ 运行库 / ABI 不匹配 / 解包缺失都会在此被捕获并弹出可操作提示，避免静默崩溃（双击无响应、无弹窗）。
  if (!verifyCriticalNativeModules()) {
    try {
      app.releaseSingleInstanceLock?.()
    } catch {}
    app.exit(1)
    return
  }

  // 启动期环境检测：安装路径特殊字符（仅提示）+ userData 可写性（阻塞）。
  // 不可写（权限不足 / 杀毒软件拦截）时弹双语友好引导并终止启动，替代静默失败。
  if (
    !verifyStartupEnvironment({
      getExecPath: () => process.execPath,
      getUserDataPath: () => app.getPath('userData')
    })
  ) {
    try {
      app.releaseSingleInstanceLock?.()
    } catch {}
    app.exit(1)
    return
  }

  // 首个窗口导航前注册 app:// 处理器（此时 session 已可用）
  registerRendererProtocol()
  diagLog('INDEX', 'registerRendererProtocol done')

  // GPU 回退：登记本次启动尝试（失败计数+1，did-finish-load 时清零），
  // 并注册 GPU 子进程崩溃观测（须在窗口创建前，抢在 Chromium FATAL 前落盘回退标记）
  markBootAttempt()
  setupGpuProcessWatcher()
  diagLog('INDEX', 'gpu-fallback attempt marked, watcher registered')

  // 开发/测试：模拟 GPU 崩溃以演示"崩溃→自动降级→重启自愈"链路。
  // 仅当本次为硬件加速启动（未禁用）时触发一次；进入兼容模式后的启动不再触发，避免死循环。
  if (process.env.NIKKI_GPU_SIMULATE_CRASH === '1' && !wasBootInCompatMode()) {
    diagLog('INDEX', 'NIKKI_GPU_SIMULATE_CRASH=1 → simulate GPU crash to exercise self-heal')
    requestSelfHeal('simulated-gpu-crash', 1)
    return
  }

  try {
    diagLog('INDEX', 'before import Application')
    const { Application } = await import('./app/application')
    diagLog('INDEX', 'Application module imported, before new Application()')
    const application = new Application()
    diagLog('INDEX', 'Application constructed, before initialize()')
    await application.initialize()
    diagLog('INDEX', 'Application.initialize() completed')
    markExitStage('initialized')
    // 启动成功标记：供纯净系统 / CI 断言启动成功
    try {
      fs.writeFileSync(path.join(app.getPath('userData'), 'boot-ok.marker'), 'ok')
    } catch {}
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : ''
    diagLog('INDEX', `FATAL ERROR in startup: ${msg}\n${stack}`)
    logStartupError('index.ts app.whenReady', err)
    // 崩溃发生在 registerGlobalErrorHandlers 注册之前，必须在此兜底。
    // 改用不依赖 i18n 的同步弹窗（修复原 t() 在 i18n 未就绪时二次抛错 → 无弹窗）。
    // 日志路径统一到用户友好目录（文档/NikkiGallery/Diagnostics），普通用户易查找
    const logPath = getStartupLogPathValue()
    showFatalStartupErrorBox(err, logPath)
    try {
      app.releaseSingleInstanceLock?.()
    } catch {
      // 释放锁失败时忽略
    }
    app.exit(1)
  }
})
