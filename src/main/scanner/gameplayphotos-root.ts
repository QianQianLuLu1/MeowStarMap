/**
 * GamePlayPhotos 扫描根解析。
 *
 * 子任务3：将游戏安装根目录统一拼接为 [根]/X6Game/Saved/GamePlayPhotos 作为唯一扫描根，
 * 对齐 nikki_albums（installPath 访问其下的 GamePlayPhotos，不做全盘递归/整盘遍历）。
 */
import path from 'path'
import fsp from 'fs/promises'
import { logger } from '../utils/logger'

export const GAMEPLAYPHOTOS_RELATIVE = path.join('X6Game', 'Saved', 'GamePlayPhotos')

type LogLevel = 'warn' | 'info' | 'error' | 'debug'
type Logger = (level: LogLevel, message: string) => void

const defaultLogger: Logger = (level, message) => {
  if (level === 'warn') logger.warn(message)
  else if (level === 'error') logger.error(message)
  else logger.info(message)
}

/**
 * 将游戏安装根目录解析为唯一扫描根 GamePlayPhotos（该子目录不存在则跳过）。
 * @param roots 游戏安装根目录数组（如 `D:\Games\InfinityNikki Launcher\InfinityNikki`）
 * @param logger 可选日志回调，默认 console。worker-entry 传入自身 workerLog
 */
export async function resolveGamePlayPhotosScanRoots(
  roots: string[],
  logger: Logger = defaultLogger
): Promise<string[]> {
  const out: string[] = []
  for (const root of roots) {
    if (!root || typeof root !== 'string') continue
    const gpp = path.join(root, GAMEPLAYPHOTOS_RELATIVE)
    try {
      await fsp.access(gpp)
      out.push(gpp)
    } catch {
      logger('warn', `[Scanner] 游戏根下未找到 GamePlayPhotos 目录，跳过: ${root}`)
    }
  }
  return out
}
