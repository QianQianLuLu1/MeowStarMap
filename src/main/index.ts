import { app, protocol, dialog, shell } from 'electron'
import path from 'path'
import { diagLog, logStartupError } from './utils/startup-diagnostic'
import { electronLogger } from './utils/logger'
import { registerRendererProtocol } from './app/renderer-protocol'

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
        title: '应用启动失败',
        message: '应用启动失败，请将日志反馈给开发者',
        detail: `错误：${msg}\n\n日志路径：${logPath}`,
        buttons: ['打开日志目录', '退出']
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
