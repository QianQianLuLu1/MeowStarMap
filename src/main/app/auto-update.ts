import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { AppContext } from './app-context'
import { sendToRenderer } from './renderer-bridge'
import { classifyUpdateError } from './update-error-class'
import { AppError } from '../../shared/errors/app-error'
import { logger } from '../utils/logger'
import { t } from '../i18n'

/**
 * 自动更新状态机：复用 electron-updater（不自研下载/校验）。
 *
 * 设计取舍：
 *   - autoDownload = false → 发现新版本先问用户，避免静默占用带宽/磁盘
 *   - 主进程只负责「检查 / 下载 / 安装」三件事，状态通过 webContents 推给渲染端
 *   - 渲染端弹窗决定何时下载、何时重启，主进程不主动 quitAndInstall
 */

// 更新事件契约的单一来源已上移至 shared（preload 桥接层同样引用），此处 re-export 保持既有导入路径稳定
import type { UpdatePayload, UpdateStage } from '../../shared/types/electron-api'

export type { UpdatePayload, UpdateStage }

// 模块级单例：listeners 注册后由 checkForUpdates/quitAndInstall 复用同一 autoUpdater 实例
let ctxRef: AppContext | null = null
let initialized = false

/** 把归一化后的发布说明统一成字符串（electron-updater 两种形态兼容） */
function normalizeReleaseNotes(
  notes: string | Array<{ version?: string; note?: string | null }> | null | undefined
): string | undefined {
  if (!notes) return undefined
  if (typeof notes === 'string') return notes
  // ReleaseNoteInfo[]：逐条拼成 "vX.X.X: 说明" 形式
  return notes.map((n) => (n.version ? `v${n.version}: ` : '') + (n.note ?? '')).join('\n')
}

/** 向渲染端推送更新事件；主窗口不存在时静默丢弃（如更新先于窗口创建到达） */
function pushUpdate(payload: UpdatePayload): void {
  if (!ctxRef) return
  sendToRenderer(ctxRef, 'app:update', payload)
}

/**
 * 初始化自动更新（生产环境生效；开发环境仅在显式打开假更新源时生效）。
 * dev 默认跳过，避免开发版误连线上更新源；需要验更新流程时用 dev-app-update.yml +
 * MEOW_DEV_UPDATE_FEED=1 双条件显式打开。
 */
export function initAutoUpdater(ctx: AppContext): void {
  const devFeedForced = !app.isPackaged && process.env.MEOW_DEV_UPDATE_FEED === '1'
  if (!app.isPackaged && !devFeedForced) {
    logger.info(t('main.autoUpdate.log.devSkip'))
    return
  }
  ctxRef = ctx
  autoUpdater.autoDownload = false
  // 下载完成不自动安装，交还给用户「安装并重启」确认
  autoUpdater.autoInstallOnAppQuit = false
  // electron-updater 构造期按当前版本推断 allowPrerelease（AppUpdater.js:218），`2.5.7-beta` 这类
  // 版本号会把检查带进 prerelease 分支：GitHubProvider 在 releases.atom 里逐条 semver.valid 筛 tag，
  // 而本项目历史 tag（MeowStarMap-Setup-2.5.6 等）全不是合法 semver ⇒ 跳过全部新版、命中远古 tag，
  // 最终仍取不到 latest.yml。显式钉回 false 让它走 /releases/latest。不靠设 channel 解决：
  // channel 的 setter 会连带把 allowDowngrade 置 true（AppUpdater.js:33-45）。
  autoUpdater.allowPrerelease = false
  autoUpdater.forceDevUpdateConfig = devFeedForced

  autoUpdater.on('update-available', (info) => {
    pushUpdate({
      stage: 'available',
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      releaseName: info.releaseName ?? undefined
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    pushUpdate({ stage: 'not-available', version: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    // progress.percent 可能为 NaN（无 Content-Length），用 0 兜底
    const percent = Number.isFinite(progress.percent) ? progress.percent : 0
    pushUpdate({ stage: 'downloading', percent })
  })

  autoUpdater.on('update-downloaded', (info) => {
    pushUpdate({
      stage: 'downloaded',
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      releaseName: info.releaseName ?? undefined,
      readyToInstall: true
    })
  })

  autoUpdater.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err)
    // 归类决定渲染端文案：只有真的连不上更新源才配得上「当前网络繁忙」
    const errorKind = classifyUpdateError(err)
    logger.error(`${t('main.autoUpdate.log.updateError')} errorKind=${errorKind}`, message)
    pushUpdate({ stage: 'error', errorKind, errorMessage: message })
  })

  initialized = true
  logger.info(t('main.autoUpdate.log.initialized'))
}

/** 是否已初始化（生产环境且已注册监听器） */
export function isAutoUpdaterEnabled(): boolean {
  return initialized
}

/**
 * 触发一次更新检查。
 * 结果通过事件异步推送给渲染端；检查本身失败（如离线）由 error 事件兜底。
 * 未初始化（典型为开发版未开假源）必须让调用方拿到失败：此前静默 return，而 handler 仍返回
 * `{checking:true}`，渲染层 about-sections 里那条「接口不可用时兜底打开仓库」的 catch 永远走不到，
 * 用户点「检查更新」毫无反应。抛 AppError 经 wrapHandler 转 IpcError，渲染层 catch 随即生效。
 */
export async function checkForUpdates(): Promise<void> {
  if (!initialized) throw AppError.preconditionFailed(t('main.error.updaterNotInit'))
  pushUpdate({ stage: 'checking' })
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    // 离线 / 404 等：error 事件通常已触发；此处仅补一道日志，不重复推 error
    logger.warn(t('main.autoUpdate.log.checkFailed'), err)
  }
}

/** 用户确认下载后调用：开始下载（autoDownload=false 时需显式触发） */
export async function downloadUpdate(): Promise<void> {
  if (!initialized) return
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    // 下载期的失败同样要归类（断网导致的 ECONNRESET 不能兜底成「源未就绪」），但**不重复推**：
    // 上游 downloadUpdate 的 errorHandler 先 dispatchError 再 rethrow（AppUpdater.js:650-672），
    // on('error') 已经带 errorKind 推过一条；这里再推一条会让刚被关闭的模态被 setDismissed(false) 弹回。
    // 与 checkForUpdates() 的 catch 同口径：error 由事件唯一负责，本 catch 只补日志。
    const errorKind = classifyUpdateError(err)
    logger.error(`${t('main.autoUpdate.log.downloadFailed')} errorKind=${errorKind}`, err)
  }
}

/** 用户确认安装并重启后调用 */
export function quitAndInstall(): void {
  // isSilent=false 显示原生安装进度；isForceRunAfter=true 安装后自动重启
  autoUpdater.quitAndInstall(false, true)
}
