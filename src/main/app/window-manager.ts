import { app, BrowserWindow, dialog, session, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import type { AppContext } from './app-context'
import { logger } from '../utils/logger'
import { logFault } from '../utils/logger'
import { logStartupError, diagLog } from '../utils/startup-diagnostic'
import { markBootSuccess, requestSelfHeal, isStartupPhase } from './gpu-fallback'
import { logGpuStatusSummary } from './gpu-status'
import { guardNavigation } from './navigation-guard'
import { t } from '../i18n'

// 与 src/renderer/index.html 的 meta CSP 必须逐字一致，改一处要同步改另一处。
// 单独一处都能被绕过：响应头缺失时靠 meta，HTML 被替换时靠响应头。
const CSP_POLICY =
  "default-src 'self'; script-src 'self'; object-src 'none'; " +
  "img-src 'self' media: data:; media-src 'self' media:; style-src 'self' 'unsafe-inline'"

// D1 保险丝：ready-to-show 与 did-finish-load 双兜底均失效的极端情况下，
// 15s 后强制恢复调度器，避免启动扫描任务因调度器永久暂停而静默不触发
const SCHEDULER_RESUME_FUSE_MS = 15_000

/**
 * 给默认 session 的所有响应挂上 CSP 响应头。
 * 必须在窗口 loadURL/loadFile 之前调用，否则首个文档请求收不到该头。
 * onHeadersReceived 每个 session 只保留一个监听器，重复调用即覆盖，故窗口重建时无需清理。
 */
function applyContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP_POLICY]
      }
    })
  })
}

/**
 * 创建主窗口并注册渲染进程事件监听器。
 * - ready-to-show：显示窗口 + 恢复 taskScheduler
 * - render-process-gone：记录故障 + 询问用户重新加载/关闭 + 重建兜底
 * - console-message：捕获 error 级别日志写入故障日志
 *
 * 创建完成后通过 ctx.setMainWindow 注入回 AppContext，供其他模块使用。
 */
export async function createMainWindow(ctx: AppContext): Promise<void> {
  // 开发模式加载 vite dev server，其注入的 react-refresh preamble 是 inline script，
  // 严格 script-src 会挡掉热更新。发布产物走 loadFile 分支，CSP 始终生效。
  const isDev = process.env.NODE_ENV === 'development'
  if (!isDev) {
    applyContentSecurityPolicy()
  }

  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: 'rgba(0,0,0,0)',
      symbolColor: '#1A1A1A',
      height: 40
    },
    backgroundColor: '#F5F5F5',
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    show: false,
    roundedCorners: true
  })

  // 通过 ctx 注入回 AppContext，供其他模块访问最新窗口引用
  ctx.setMainWindow(mainWindow)
  // 窗口关闭后立即清空 ctx 引用：closed 后窗口对象虽在但底层 webContents 已销毁，
  // sendToRenderer 的 isDestroyed 检查依赖此处置 null 才能可靠短路
  mainWindow.on('closed', () => {
    ctx.setMainWindow(null)
  })

  // 导航防护：阻断任意新窗口，并拦截主框架/子帧被导向非应用文档。
  // setWindowOpenHandler 拒绝所有 window.open / target=_blank，避免弹出不受信窗口带走 preload 能力；
  // will-navigate 只针对顶层导航，SPA 路由切换不发该事件，故拦截不影响应用内路由。
  // 放行集合见 navigation-guard.ts：file:// 一律拒绝，http://localhost 仅 dev 且限 5173 端口。
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    guardNavigation(event, url, { source: 'will-navigate', isDev })
  })
  // 子帧（iframe 等）同样会执行 preload，必须一并拦截；will-frame-navigate 覆盖全部帧，
  // 主帧事件已由上面的 will-navigate 处理，此处短路避免同一导航记两条故障（日志放大）。
  // 注意签名：该事件只给一个 Event 参数（url / isMainFrame 都挂在它上面），
  // 与 will-navigate 的 (event, url) 双参数不同——按双参数写会在 tsc 下报 TS2769。
  mainWindow.webContents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return
    guardNavigation(details, details.url, { source: 'will-frame-navigate', isDev })
  })

  // D1 竞态修复：ready-to-show 监听必须在 loadURL 之前注册（Electron 官方要求）。
  // 打包版经 app:// 本地协议加载极快，事件可能在 loadURL 的 promise resolve 前已发出，
  // 晚注册会永久错过 → 调度器永不 resume → 启动扫描静默不触发（dev 走 vite 首绘慢，几乎不输掉竞态）。
  // 首次可见统一入口：done 标志保证 ready-to-show / did-finish-load 兜底两条路径只执行一次
  let firstVisibleDone = false
  const resumeFuse = setTimeout(() => {
    // 触发前检查暂停状态：正常路径已被 resume 时此处为 no-op，避免误报 fault
    if (!ctx.taskScheduler.isPaused()) return
    ctx.taskScheduler.resume()
    logFault(
      'schedulerStuckPaused',
      // eslint-disable-next-line no-restricted-syntax -- 诊断错误消息，故障上报用途，无需 i18n
      new Error('调度器在窗口加载 15s 后仍处于暂停状态，已强制恢复'),
      { source: 'createMainWindow.resumeFuse' }
    ).catch(() => {})
  }, SCHEDULER_RESUME_FUSE_MS)
  // unref：兜底定时器不应持有事件循环（应用退出不被拖延）
  resumeFuse.unref?.()
  const onFirstVisible = (via: string): void => {
    if (firstVisibleDone) return
    firstVisibleDone = true
    clearTimeout(resumeFuse)
    mainWindow.show()
    // 分级调度：主窗口显示后恢复调度器，启动期入队的低优先级任务开始执行
    ctx.taskScheduler.resume()
    diagLog('WIN', `scheduler resumed via ${via}`)
  }
  mainWindow.once('ready-to-show', () => onFirstVisible('ready-to-show'))

  // GPU 状态可观测：首帧加载完成后异步记一行摘要（hwAccel 开关态/活动显卡/回退/独显偏好）。
  // getGPUInfo 在 GPU 进程就绪后才有数据，故挂 did-finish-load；fire-and-forget 不影响窗口流程。
  mainWindow.webContents.once('did-finish-load', () => {
    void logGpuStatusSummary()
  })

  // 加载渲染进程
  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    // 加载方式：app:// 特权协议（app://renderer/index.html）。
    // __dirname 在打包后为 app.asar/dist/main/main/app/（双层 main 因 tsconfig rootDir:'../' 导致，
    // 多出的 app/ 因源码位于 src/main/app/ 下）；renderer-protocol.ts 已按同一相对基准映射到 dist/renderer。
    // preload.js 在 dist/main/main/preload.js，需回退 1 层。
    const preloadPath = path.join(__dirname, '../preload.js')
    // 诊断：输出关键路径 + 文件存在性检查，定位渲染异常
    diagLog('WIN', `__dirname=${__dirname}`)
    diagLog('WIN', `preloadPath=${preloadPath}`)
    try {
      const preloadExists = fs.existsSync(preloadPath)
      diagLog('WIN', `file exists check: preload=${preloadExists}`)
    } catch (e) {
      diagLog('WIN', `file exists check FAILED: ${e instanceof Error ? e.message : String(e)}`)
    }
    // 加载失败事件监听
    mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
      diagLog(
        'WIN',
        `did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`
      )
    })
    mainWindow.webContents.on('did-finish-load', () => {
      diagLog('WIN', 'did-finish-load: page loaded successfully')
      // GPU 回退状态机：页面成功渲染即清零连续启动失败计数（fallbackActive 保留）
      markBootSuccess()
      // D1 兜底：ready-to-show 极端未触发时，页面加载完成即显示窗口并恢复调度器
      if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        onFirstVisible('did-finish-load')
      }
    })
    mainWindow.webContents.on('console-message', (details) => {
      // Electron v35+ 改为单一事件对象，level 由数字改为字符串枚举
      // 仅处理非 error 级别：error 已由下方 196 行监听器统一写入故障日志，避免重复记录
      if (details.level !== 'error') {
        diagLog(
          'WIN',
          `renderer console[${details.level}]: ${details.message} (line ${details.lineNumber} ${details.sourceId})`
        )
      }
    })
    // P0-白屏修复·诊断：打包分支下，若 8s 内渲染进程未上报 ready，
    // 判定为疑似白屏（CORS/crossorigin 或模块加载失败），自动开 DevTools + 弹窗提示。
    let readyTimer: ReturnType<typeof setTimeout> | undefined
    const onRendererReady = () => {
      ipcMain.removeListener('renderer:ready', onRendererReady)
      if (readyTimer) {
        clearTimeout(readyTimer)
        readyTimer = undefined
      }
    }
    ipcMain.on('renderer:ready', onRendererReady)
    readyTimer = setTimeout(() => {
      ipcMain.removeListener('renderer:ready', onRendererReady)
      if (readyTimer) {
        clearTimeout(readyTimer)
        readyTimer = undefined
      }
      if (mainWindow.isDestroyed()) return
      const reason = t('main.window.reason.rendererNotReady')
      diagLog('WIN', reason)
      logFault('renderer-not-ready', new Error(reason), {
        source: 'createMainWindow.readyTimeout'
      }).catch(() => {})
      mainWindow.webContents.openDevTools()
      dialog
        .showMessageBox(mainWindow, {
          type: 'error',
          title: t('main.window.dialog.diagTitle'),
          message: t('main.window.dialog.rendererFailed'),
          detail: t('main.window.dialog.rendererFailedDetail', { reason }),
          buttons: [t('main.window.dialog.gotIt')]
        })
        .catch(() => {})
    }, 8000)
    // 改用特权协议加载：app:// 资源同源、带正确 Content-Type，ES Module 不再被 file:// CORS 拒执行
    diagLog('WIN', 'before loadURL app://renderer/index.html')
    try {
      await mainWindow.loadURL('app://renderer/index.html')
      diagLog('WIN', 'loadURL resolved successfully')
    } catch (loadErr) {
      diagLog(
        'WIN',
        `loadURL REJECTED: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`
      )
      throw loadErr
    }
  }

  // 渲染进程崩溃捕获：P1-6 增强——记录故障日志 + 弹出用户选择对话框
  // 原实现仅记录日志，用户面对白屏毫无感知；改为询问用户是否重新加载
  mainWindow.webContents.on('render-process-gone', async (_event, details) => {
    const err = new Error(`Renderer process gone: ${details.reason}`)
    logFault('rendererCrash', err, {
      reason: details.reason,
      exitCode: details.exitCode,
      source: 'webContents.render-process-gone'
    }).catch(() => {})
    try {
      logger?.error?.(t('main.window.log.rendererCrashed'), details)
    } catch {}

    // 启动期（首绘前）渲染进程崩溃：接入 GPU 降级自愈链，自动重启进入软件渲染，
    // 直接解决"双击无窗口、无弹窗直接退出"——无需用户手动重开或点对话框。
    if (isStartupPhase()) {
      const healed = requestSelfHeal(details.reason ?? 'unknown', details.exitCode ?? -1)
      if (healed) return // 已自动重启进入兼容模式，跳过对话框
      // 已兼容模式仍崩：fallback 失败，继续走错误对话框（避免死循环）
    }

    // P1-6：弹窗询问用户是否重新加载（崩溃后窗口可能已不可用，需先销毁重建）
    if (!mainWindow || mainWindow.isDestroyed()) return
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: t('main.window.dialog.crashTitle'),
      message: t('main.window.dialog.crashMessage'),
      detail: t('main.window.dialog.crashDetail', {
        reason: details.reason,
        exitCode: details.exitCode
      }),
      buttons: [t('main.window.dialog.reload'), t('main.window.dialog.closeApp')],
      defaultId: 0,
      cancelId: 1
    })

    if (result.response === 0) {
      // 重新加载：reload 之前先确保 webContents 仍可用
      try {
        if (!mainWindow?.isDestroyed()) {
          mainWindow?.webContents.reload()
        }
      } catch (reloadErr) {
        logStartupError('renderer-reload-failed', reloadErr)
        // reload 失败时重建窗口作为最后兜底
        try {
          await createMainWindow(ctx)
        } catch {}
      }
    } else {
      app.quit()
    }
  })

  // 渲染层 console.error 捕获：将前端错误同步记录到故障日志
  // 仅捕获 error 级别，避免 info/warn 日志噪音
  mainWindow.webContents.on('console-message', (details) => {
    // Electron v35+ 改为单一事件对象，level 由数字改为字符串枚举
    if (details.level !== 'error') return
    const err = new Error(details.message)
    logFault('rendererError', err, {
      source: 'renderer.console.error',
      location: `${details.sourceId}:${details.lineNumber}`
    }).catch(() => {})
  })
}

/**
 * 获取主窗口（优先 ctx.mainWindow，回退 focusedWindow，无则抛错）。
 * 供需要确定性窗口引用的调用方使用（如 pluginHost.setMainWindow）。
 */
export function getMainWindow(ctx: AppContext): BrowserWindow {
  const win = ctx.mainWindow ?? BrowserWindow.getFocusedWindow()
  if (!win) {
    throw new Error(t('main.error.mainWindowNotInit'))
  }
  return win
}
