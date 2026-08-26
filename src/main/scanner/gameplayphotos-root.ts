/**
 * GamePlayPhotos 扫描根解析。
 *
 * 子任务3：将游戏安装根目录统一拼接为 [根]/X6Game/Saved/GamePlayPhotos 作为唯一扫描根，
 * 对齐 nikki_albums（installPath 访问其下的 GamePlayPhotos，不做全盘递归/整盘遍历）。
 */
import path from 'path'
import fsp from 'fs/promises'
import { logger } from '../utils/logger'
import { classifyFsError } from './scan-log-store'
import { sendScanLogEntry } from './scan-logger'

export const GAMEPLAYPHOTOS_RELATIVE = path.join('X6Game', 'Saved', 'GamePlayPhotos')

type LogLevel = 'warn' | 'info' | 'error' | 'debug'
type Logger = (level: LogLevel, message: string) => void

const defaultLogger: Logger = (level, message) => {
  if (level === 'warn') logger.warn(message)
  else if (level === 'error') logger.error(message)
  else logger.info(message)
}

/**
 * 判断给定目录是否已经是 GamePlayPhotos 目录（手动兜底场景：用户直接选中了相册文件夹）。
 * 命中条件：目录名即为 GamePlayPhotos，或目录下存在 NikkiPhotos_HighQuality / NikkiPhotos_LowQuality 子目录。
 */
async function isDirectGamePlayPhotosDir(p: string): Promise<boolean> {
  if (path.basename(p) === 'GamePlayPhotos') return true
  try {
    const entries = await fsp.readdir(p, { withFileTypes: true })
    return entries.some(
      (e) =>
        e.isDirectory() &&
        (e.name === 'NikkiPhotos_HighQuality' || e.name === 'NikkiPhotos_LowQuality')
    )
  } catch {
    return false
  }
}

/**
 * 将游戏安装根目录（或手动指定的 GamePlayPhotos 目录）解析为唯一扫描根 GamePlayPhotos。
 *
 * 双重兼容（需求三·手动兜底）：
 * - 传入游戏根（如 `D:\Games\...\InfinityNikki`）→ 拼接 X6Game/Saved/GamePlayPhotos。
 * - 传入已是 GamePlayPhotos 的目录（用户直接选中相册文件夹）→ 直接作为扫描根，不再重复拼接。
 *
 * @param roots 游戏安装根目录数组（如 `D:\Games\InfinityNikki Launcher\InfinityNikki`）
 *   或手动指定的 GamePlayPhotos 目录。
 * @param logger 可选日志回调，默认 console。worker-entry 传入自身 workerLog
 * @param onPermissionDenied 当访问 GamePlayPhotos 返回权限不足（EACCES/EPERM）时回调，
 *   供上层弹窗提示用户以管理员身份重启（需求四.4）。
 */
export async function resolveGamePlayPhotosScanRoots(
  roots: string[],
  logger: Logger = defaultLogger,
  onPermissionDenied?: (root: string) => void
): Promise<string[]> {
  const out: string[] = []
  for (const root of roots) {
    if (!root || typeof root !== 'string') continue
    // 手动兜底：用户直接选中 GamePlayPhotos 文件夹时，跳过拼接直接作为扫描根
    const direct = await isDirectGamePlayPhotosDir(root)
    const gpp = direct ? root : path.join(root, GAMEPLAYPHOTOS_RELATIVE)
    try {
      await fsp.access(gpp)
      if (!direct) {
        sendScanLogEntry({
          stage: 'manual-fallback',
          level: 'info',
          kind: 'ok',
          message: `使用手动指定目录（已拼接 GamePlayPhotos）：${gpp}`
        })
      } else {
        sendScanLogEntry({
          stage: 'manual-fallback',
          level: 'info',
          kind: 'ok',
          message: `使用手动指定目录（直接 GamePlayPhotos 根）：${gpp}`
        })
      }
      out.push(gpp)
    } catch (err) {
      const kind = classifyFsError(err)
      if (kind === 'permission') {
        // 全链路诊断：权限不足节点
        sendScanLogEntry({
          stage: 'permission-check',
          level: 'error',
          kind: 'permission',
          message: `访问 GamePlayPhotos 被拒绝（权限不足）：${gpp}`,
          detail: String(err)
        })
        logger('error', `[Scanner] 访问 GamePlayPhotos 权限不足，跳过: ${root}`)
        onPermissionDenied?.(root)
      } else {
        sendScanLogEntry({
          stage: 'permission-check',
          level: 'warn',
          kind: 'path-missing',
          message: `游戏根下未找到 GamePlayPhotos 目录，跳过: ${root}`
        })
        logger('warn', `[Scanner] 游戏根下未找到 GamePlayPhotos 目录，跳过: ${root}`)
      }
    }
  }
  return out
}
