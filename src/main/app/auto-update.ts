import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { AppContext } from './app-context'
import { sendToRenderer } from './renderer-bridge'
import { logger } from '../utils/logger'

/**
 * 自动更新状态机：复用 electron-updater（不自研下载/校验）。
 *
 * 设计取舍：
 *   - autoDownload = false → 发现新版本先问用户，避免静默占用带宽/磁盘
 *   - 主进程只负责「检查 / 下载 / 安装」三件事，状态通过 webContents 推给渲染端
 *   - 渲染端弹窗决定何时下载、何时重启，主进程不主动 quitAndInstall
 */

/** 推送给渲染端的更新事件阶段 */
export type UpdateStage =
  | 'checking' // 正在检查（手动/启动触发）
  | 'available' // 发现新版本，待用户确认下载
  | 'not-available' // 已是最新
  | 'downloading' // 下载中
  | 'downloaded' // 下载完成，待用户确认安装并重启
  | 'error' // 出错

/** 主进程 → 渲染端 的更新事件载荷 */
export interface UpdatePayload {
  stage: UpdateStage
  /** 目标版本号（available/downloaded 时存在） */
  version?: string
  /** 下载进度百分比 0-100（downloading 时存在） */
  percent?: number
  /** 发布说明：electron-updater 可能是字符串或对象数组，归一成字符串展示 */
  releaseNotes?: string
  /** 发布标题（releaseName） */
  releaseName?: string
  /** 错误信息（error 时存在） */
  errorMessage?: string
  /** 下载完成后为 true，渲染端据此展示「安装并重启」按钮 */
  readyToInstall?: boolean
}

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
 * 初始化自动更新（仅生产环境生效）。
 * 开发模式（app.isPackaged === false）直接跳过，避免 dev 下误连 GitHub 更新源。
 */
export function initAutoUpdater(ctx: AppContext): void {
  if (!app.isPackaged) {
    logger.info('[AutoUpdate] 开发模式跳过初始化') // TODO: i18n: internal log
    return
  }
  ctxRef = ctx
  autoUpdater.autoDownload = false
  // 下载完成不自动安装，交还给用户「安装并重启」确认
  autoUpdater.autoInstallOnAppQuit = false

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
    logger.error('[AutoUpdate] 更新出错:', message) // TODO: i18n: internal log
    pushUpdate({ stage: 'error', errorMessage: message })
  })

  initialized = true
  logger.info('[AutoUpdate] 初始化完成，provider 由 electron-builder publish 配置决定') // TODO: i18n: internal log
}

/** 是否已初始化（生产环境且已注册监听器） */
export function isAutoUpdaterEnabled(): boolean {
  return initialized
}

/**
 * 触发一次更新检查。
 * 结果通过事件异步推送给渲染端；检查本身失败（如离线）由 error 事件兜底。
 */
export async function checkForUpdates(): Promise<void> {
  if (!initialized) return
  pushUpdate({ stage: 'checking' })
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    // 离线 / 404 等：error 事件通常已触发；此处仅补一道日志，不重复推 error
    logger.warn('[AutoUpdate] checkForUpdates 失败:', err) // TODO: i18n: internal log
  }
}

/** 用户确认下载后调用：开始下载（autoDownload=false 时需显式触发） */
export async function downloadUpdate(): Promise<void> {
  if (!initialized) return
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    logger.error('[AutoUpdate] downloadUpdate 失败:', err) // TODO: i18n: internal log
    pushUpdate({
      stage: 'error',
      errorMessage: err instanceof Error ? err.message : String(err)
    })
  }
}

/** 用户确认安装并重启后调用 */
export function quitAndInstall(): void {
  // isSilent=false 显示原生安装进度；isForceRunAfter=true 安装后自动重启
  autoUpdater.quitAndInstall(false, true)
}
