import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { AppContext } from './app-context'
import { sendToRenderer } from './renderer-bridge'
import { classifyUpdateError, missingChannelUpToDateVersion } from './update-error-class'
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

// P6：feed 地址缓存，供生命周期日志携带（init 时异步回填；取不到保持 unknown）
let feedUrlForLog = 'unknown'

/** P6：生命周期留痕 fail-open——logger 故障不得影响更新状态机与事件分发 */
function logUpdate(message: string): void {
  try {
    logger.info(message)
  } catch {
    // 静默降级
  }
}

// F8：按「调用代」归属 error 事件，替代旧的模块级共享布尔。checkForUpdates / downloadUpdate
// 并发交错时（download 在途又发起 check，反向同理），共享布尔会把 A 调用的 error 事件错记
// 到 B 头上——B 失败时误判「已推过」而跳过兜底（渲染端停在 checking/downloading 无声收场），
// 反向交错则可能双推弹回模态。现行口径：每次调用登记一代；error 事件归属到「当时最旧的一条
// 在途调用」（单一在途时即命中正确归属）；失败 catch 只在**自己这一代**没收到事件时兜底补推
// ——保证每次失败至少 1 条 error、且同一失败不双推（上游先 dispatchError 再 rethrow 的形状）。
let callSeq = 0
const inFlightUpdateCalls = new Map<number, { eventPushed: boolean }>()

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
 * 失败 → 渲染端载荷的统一决策点（error 事件与两处 catch 兜底共用）。
 * 2026-11-21 二轮：缺通道文件（ERR_UPDATER_CHANNEL_FILE_NOT_FOUND）且远端发布版本 ≤ 当前版本时，
 * 发布源上并没有比用户更装的版本（线上实况：MeowStarMap-Setup-2.5.6 只传了 exe、缺 latest.yml），
 * 此时弹「未获取到可用的更新信息」对用户是误导——改推 not-available，渲染层复用既有
 * 「当前已是最新版本」视图（UpdateDialog not-available 分支，零渲染层改动）。
 * 确有更新版本（tag > 当前）才维持归类后的 error 载荷；提取失败一律保守走错误。
 */
function buildErrorPayload(err: unknown): UpdatePayload {
  const upToDate = missingChannelUpToDateVersion(err, app.getVersion())
  if (upToDate) {
    logUpdate(`[Update] missing channel file → not-available v${upToDate} (≤ current)`)
    return { stage: 'not-available', version: upToDate }
  }
  const message = err instanceof Error ? err.message : String(err)
  const errorKind = classifyUpdateError(err)
  logger.error(`${t('main.autoUpdate.log.updateError')} errorKind=${errorKind}`, message)
  return { stage: 'error', errorKind, errorMessage: message }
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

  // P6：缓存 feed 地址供生命周期日志（fail-open；取不到保持 unknown）。
  // 真实 AppUpdater.getFeedURL() 为同步返回（string|null|undefined）；
  // 同时容忍 Promise 形态返回（测试替身），统一收敛为字符串。
  try {
    const feed: unknown = autoUpdater.getFeedURL()
    if (typeof feed === 'string') {
      feedUrlForLog = feed
    } else if (feed && typeof (feed as { then?: unknown }).then === 'function') {
      void (feed as Promise<string | null | undefined>)
        .then((url) => {
          feedUrlForLog = url ?? 'default'
        })
        .catch(() => {})
    }
  } catch {
    // fail-open：feed 信息只服务诊断，绝不影响初始化
  }

  autoUpdater.on('checking-for-update', () => {
    logUpdate(`[Update] checking-for-update feed=${feedUrlForLog}`)
  })

  autoUpdater.on('update-available', (info) => {
    logUpdate(`[Update] update-available version=${info.version} feed=${feedUrlForLog}`)
    pushUpdate({
      stage: 'available',
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      releaseName: info.releaseName ?? undefined
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    logUpdate(`[Update] update-not-available version=${info.version} feed=${feedUrlForLog}`)
    pushUpdate({ stage: 'not-available', version: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    // progress.percent 可能为 NaN（无 Content-Length），用 0 兜底
    const percent = Number.isFinite(progress.percent) ? progress.percent : 0
    pushUpdate({ stage: 'downloading', percent })
  })

  autoUpdater.on('update-downloaded', (info) => {
    logUpdate(`[Update] update-downloaded version=${info.version} feed=${feedUrlForLog}`)
    pushUpdate({
      stage: 'downloaded',
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      releaseName: info.releaseName ?? undefined,
      readyToInstall: true
    })
  })

  autoUpdater.on('error', (err) => {
    // F8：事件归属到当时最旧的一条在途调用（Map 保持插入序，首个键即最旧）；
    // 无在途调用（自发性错误）则只推送不登记。
    const oldest = inFlightUpdateCalls.keys().next()
    if (!oldest.done) {
      const state = inFlightUpdateCalls.get(oldest.value)
      if (state) state.eventPushed = true
    }
    // 归类决定渲染端文案：只有真的连不上更新源才配得上「当前网络繁忙」；
    // 缺通道文件且无更新版本时转 not-available（决策细节见 buildErrorPayload）
    pushUpdate(buildErrorPayload(err))
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
  const myToken = ++callSeq
  const callState = { eventPushed: false }
  inFlightUpdateCalls.set(myToken, callState)
  pushUpdate({ stage: 'checking' })
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    logger.warn(t('main.autoUpdate.log.checkFailed'), err)
    // 本次未收到归属到自己这一代的 error 事件 ⇒ 兜底推 1 条（否则调用方只看到 checking 便
    // 无声收场）。已由事件推过就绝不再推，否则刚被关闭的模态会被 setDismissed(false) 弹回。
    if (!callState.eventPushed) {
      pushUpdate(buildErrorPayload(err))
    }
  } finally {
    inFlightUpdateCalls.delete(myToken)
  }
}

/** 用户确认下载后调用：开始下载（autoDownload=false 时需显式触发） */
export async function downloadUpdate(): Promise<void> {
  // 与 checkForUpdates 同口径：未初始化必须让调用方拿到失败，否则 handler 仍返回
  // {downloading:true}，渲染层 catch 永远走不到，用户点「下载更新」毫无反应。
  if (!initialized) throw AppError.preconditionFailed(t('main.error.updaterNotInit'))
  const myToken = ++callSeq
  const callState = { eventPushed: false }
  inFlightUpdateCalls.set(myToken, callState)
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    // 下载期的失败同样要归类（断网导致的 ECONNRESET 不能兜底成「源未就绪」），但**不重复推**：
    // 上游 downloadUpdate 的 errorHandler 先 dispatchError 再 rethrow（AppUpdater.js:650-672），
    // on('error') 已经带 errorKind 推过一条；这里再推一条会让刚被关闭的模态被 setDismissed(false) 弹回。
    // 因此只有自己这一代未收到事件时才兜底推 1 条（缺通道文件且无更新版本的转换见 buildErrorPayload），
    // 已由事件推过则只补日志。
    logger.error(
      `${t('main.autoUpdate.log.downloadFailed')} errorKind=${classifyUpdateError(err)}`,
      err
    )
    if (!callState.eventPushed) {
      pushUpdate(buildErrorPayload(err))
    }
  } finally {
    inFlightUpdateCalls.delete(myToken)
  }
}

/** 用户确认安装并重启后调用 */
export function quitAndInstall(): void {
  // P6：生命周期终点留痕（此后进程即退出，这条日志是「用户确认安装」的唯一证据）
  logUpdate(`[Update] quitAndInstall (isSilent=false, forceRunAfter=true) feed=${feedUrlForLog}`)
  // isSilent=false 显示原生安装进度；isForceRunAfter=true 安装后自动重启
  autoUpdater.quitAndInstall(false, true)
}
