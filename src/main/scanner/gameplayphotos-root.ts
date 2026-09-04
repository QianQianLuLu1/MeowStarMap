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

/**
 * 需求二.2 兼容变体：部分安装/迁移场景下官方相册位于 [游戏根]\X6Game\GamePlayPhotos（无 Saved 段）。
 * 仅在 Saved 变体不存在时降级使用。
 */
export const GAMEPLAYPHOTOS_RELATIVE_FALLBACK = path.join('X6Game', 'GamePlayPhotos')

/**
 * 将单个游戏安装根目录解析为存在的 GamePlayPhotos 目录。
 *
 * 优先级：X6Game\Saved\GamePlayPhotos（标准）→ X6Game\GamePlayPhotos（变体兜底）。
 * 两者均不存在（或入参非法）时返回 null，不抛异常（调用方据此记 E002 并继续下一个根）。
 *
 * @param gameRoot 游戏安装根目录
 * @returns 存在的 GamePlayPhotos 目录路径；不存在返回 null
 */
export async function resolveGamePlayPhotosDir(gameRoot: string): Promise<string | null> {
  if (!gameRoot || typeof gameRoot !== 'string') return null
  for (const rel of [GAMEPLAYPHOTOS_RELATIVE, GAMEPLAYPHOTOS_RELATIVE_FALLBACK]) {
    const candidate = path.join(gameRoot, rel)
    try {
      await fsp.access(candidate)
      return candidate
    } catch {
      // 该变体不存在，尝试下一个
    }
  }
  return null
}

type LogLevel = 'warn' | 'info' | 'error' | 'debug'
type Logger = (level: LogLevel, message: string) => void

const defaultLogger: Logger = (level, message) => {
  if (level === 'warn') logger.warn(message)
  else if (level === 'error') logger.error(message)
  else logger.info(message)
}

// UID 目录名正则（对齐 uid-discovery：纯数字、任意位数）
const UID_DIR_REGEX = /^\d+$/
// 官方相册目录指纹：存在原生高清/低清相册子目录
const ALBUM_FINGERPRINT_DIRS = new Set(['nikkiphotos_highquality', 'nikkiphotos_lowquality'])

function toDirNames(entries: unknown): string[] {
  if (!Array.isArray(entries)) return []
  return (entries as Array<{ name?: unknown; isDirectory?: () => boolean }>)
    .filter((e) => typeof e?.isDirectory === 'function' && e.isDirectory() === true)
    .map((e) => String(e.name ?? ''))
}

/**
 * 判定目录是否为「游戏官方相册目录」（需求一：隐藏目录强制豁免的指纹判据）。
 *
 * 命中条件（需求一「目标目录名称匹配 GamePlayPhotos 时强制进入并递归遍历」）：
 * 目录名为 `GamePlayPhotos`（大小写不敏感），且首层存在下列任一子目录：
 * - 纯数字 UID 目录（`GamePlayPhotos\{uid}\NikkiPhotos_*` 的标准布局）；
 * - `NikkiPhotos_HighQuality` / `NikkiPhotos_LowQuality`（用户直接选中了某个 UID 目录）。
 *
 * 刻意不加「仅凭存在 HQ/LQ 子目录即命中」的宽松规则：那会让任意自建的
 * `...\InfinityNikki\NikkiPhotos_HighQuality` 之类目录被误豁免，连带关闭缓存目录跳过
 * 与小图过滤（既有 scan-diagnose 用例即覆盖该场景）。同理，用户自建的同名空目录
 * （C:\backup\GamePlayPhotos）也不得命中。
 *
 * 目录不存在 / 读取失败 / 入参非法均返回 false，不抛异常。
 */
export async function isOfficialAlbumDir(dir: string): Promise<boolean> {
  if (!dir || typeof dir !== 'string') return false
  if (path.basename(dir).toLowerCase() !== 'gameplayphotos') return false
  let dirNames: string[]
  try {
    dirNames = toDirNames(await fsp.readdir(dir, { withFileTypes: true }))
  } catch {
    return false
  }
  return dirNames.some((n) => UID_DIR_REGEX.test(n) || ALBUM_FINGERPRINT_DIRS.has(n.toLowerCase()))
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
    const gpp = direct ? root : await resolveGamePlayPhotosDir(root)
    if (!gpp) {
      sendScanLogEntry({
        stage: 'permission-check',
        level: 'warn',
        kind: 'path-missing',
        message: `游戏根下未找到 GamePlayPhotos 目录，跳过: ${root}`
      })
      logger('warn', `[Scanner] 游戏根下未找到 GamePlayPhotos 目录，跳过: ${root}`)
      continue
    }
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
        // 全链路诊断：权限不足节点（E003：目标路径 + 错误码 + 错误栈）
        sendScanLogEntry({
          stage: 'permission-check',
          level: 'error',
          kind: 'permission',
          code: 'E003',
          message: `访问 GamePlayPhotos 被拒绝（权限不足）：${gpp}`,
          detail: {
            path: gpp,
            errorCode: (err as { code?: string } | null)?.code ?? 'UNKNOWN',
            stack: err instanceof Error ? (err.stack ?? err.message) : String(err)
          }
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
