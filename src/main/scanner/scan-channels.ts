/**
 * 扫描通道编排（需求二：官方相册专属通道 + ScreenShot/Video 次级通道）。
 *
 * 背景：上一轮为对齐 nikki_albums 把 `startScan` 收敛为「只扫 GamePlayPhotos」，
 * 导致 `X6Game\ScreenShot` / `X6Game\Video` 不再自动入库。按用户确认，恢复其为
 * **独立的次级通道**，与官方相册通道并行扫描，且保留原有过滤与缩略图生成语义。
 *
 * 两条通道的差异（务必保持）：
 * - 官方相册通道（officialAlbum）：GamePlayPhotos 子树，强制遍历豁免、UID 闸门、
 *   复用游戏原生 LQ 缩略图、不触发生成任务；
 * - 次级通道（secondary）：X6Game\ScreenShot / X6Game\Saved\ScreenShot / X6Game\Video，
 *   沿用原有缓存目录跳过与小图过滤，缩略图照常生成，分类为 local_screenshot / game。
 *
 * 五要素：
 * - 依赖声明：仅 fs/promises + path + 既有 gameplayphotos-root（官方相册根解析）。
 * - 启动说明：纯编排，无副作用；由 worker-entry.startScan 调用。
 * - 错误处理：不抛异常——单个根解析失败记入 missing（E002）并带上实际子目录列表，
 *   供上层无静默失败地报告；目录读取失败返回空列表。
 * - 参数校验：gameRoots 非数组 → 空通道集；逐项跳过空/非字符串项。
 * - 基础测试：见 __tests__/scan-channels.test.ts。
 */
import fsp from 'fs/promises'
import path from 'path'
import { resolveGamePlayPhotosScanRoots, isOfficialAlbumDir } from './gameplayphotos-root'
import { sendScanLogEntry } from './scan-logger'
import { getLastProbeTrail } from './game-directory-discovery'

/** 次级通道：游戏内截图与录像目录（相对游戏根目录） */
const SECONDARY_RELATIVE_PATHS = [
  path.join('X6Game', 'ScreenShot'),
  path.join('X6Game', 'Saved', 'ScreenShot'),
  path.join('X6Game', 'Video')
]

/** 未找到官方相册目录的根（E002 详情） */
export interface MissingAlbumRoot {
  root: string
  code: 'E002'
  /** 该根目录下的实际条目名列表，供诊断定位「拼错层级 / 未安装 / 目录被改名」 */
  children: string[]
}

export interface ScanChannelSet {
  /** 官方相册通道：已确认存在的 GamePlayPhotos 目录 */
  officialAlbum: string[]
  /** 次级通道：已确认存在的 ScreenShot / Video 目录 */
  secondary: string[]
  /** 官方相册解析失败的根（携带 E002 与子目录列表） */
  missing: MissingAlbumRoot[]
}

/**
 * 通道日志回调。
 *
 * level 取值刻意与 gameplayphotos-root 的 Logger 一致（info/warn/error/debug），
 * 便于原样透传；worker-entry 的 workerLog 只接受 info/warn/error，
 * 由调用方做一次 debug→info 归一后传入（见 worker-entry.runScanChannels）。
 */
export type ChannelLogLevel = 'warn' | 'info' | 'error' | 'debug'
export type ChannelLogger = (level: ChannelLogLevel, message: string) => void

/** 读取目录首层条目名；读取失败返回空数组（不抛异常、不中断编排） */
async function listChildren(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir)
    return Array.isArray(entries) ? entries.map((e) => String(e)) : []
  } catch {
    return []
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 将游戏根目录集合编排为两条扫描通道。
 *
 * @param gameRoots 游戏安装根目录（可含用户手动指定的 GamePlayPhotos 目录）
 * @param logger 可选日志回调（worker-entry 传 workerLog）
 * @param onPermissionDenied 官方相册目录访问被拒（EACCES/EPERM）时回调，供上层提示提权
 */
export async function resolveScanChannels(
  gameRoots: string[],
  logger?: ChannelLogger,
  onPermissionDenied?: (root: string) => void
): Promise<ScanChannelSet> {
  const empty: ScanChannelSet = { officialAlbum: [], secondary: [], missing: [] }
  if (!Array.isArray(gameRoots)) return empty

  const noopLogger: ChannelLogger = () => undefined
  const officialAlbum = await resolveGamePlayPhotosScanRoots(
    gameRoots,
    logger ?? noopLogger,
    onPermissionDenied
  )
  const secondary: string[] = []
  const missing: MissingAlbumRoot[] = []
  const seenSecondary = new Set<string>()

  for (const root of gameRoots) {
    if (!root || typeof root !== 'string') continue

    // 该根是否已被解析出官方相册目录：
    // - 相等：用户手动直选的目录本身就是 GamePlayPhotos；
    // - 前缀：解析结果为 root\X6Game\...\GamePlayPhotos。
    const rootLower = root.toLowerCase()
    const resolved = officialAlbum.some(
      (p) => p.toLowerCase() === rootLower || p.toLowerCase().startsWith(rootLower + path.sep)
    )

    // 官方相册解析失败：记 E002 + 实际子目录列表（用于区分「拼错层级 / 未安装 / 目录被改名」）
    if (!resolved) {
      const children = await listChildren(root)
      missing.push({ root, code: 'E002', children })
      sendScanLogEntry({
        stage: 'channel-resolve',
        level: 'warn',
        kind: 'path-missing',
        code: 'E002',
        message: `游戏根下未解析出 GamePlayPhotos 目录（E002）：${root}`,
        detail: { root, children }
      })
    }

    for (const rel of SECONDARY_RELATIVE_PATHS) {
      const candidate = path.join(root, rel)
      const key = candidate.toLowerCase()
      if (seenSecondary.has(key)) continue
      if (await exists(candidate)) {
        seenSecondary.add(key)
        secondary.push(candidate)
      }
    }
  }

  // E001：未找到任何可扫描目录——detail 输出已探测的游戏根目录与定位阶段探测轨迹
  if (officialAlbum.length === 0 && secondary.length === 0) {
    sendScanLogEntry({
      stage: 'path-locate',
      level: 'error',
      kind: gameRoots.length === 0 ? 'empty' : 'path-missing',
      code: 'E001',
      message:
        gameRoots.length === 0
          ? `未找到任何游戏安装目录（E001）`
          : `找到游戏根目录，但未能解析出任何可扫描子目录（E001）`,
      detail: { gameRoots, probeTrail: getLastProbeTrail() }
    })
  }

  return { officialAlbum, secondary, missing }
}

/**
 * 判定目录是否应按「官方相册通道」处理（供上层决定豁免与缩略图策略）。
 * 复用 gameplayphotos-root 的指纹判定，避免两处口径分叉。
 */
export async function isOfficialAlbumChannel(dir: string): Promise<boolean> {
  return isOfficialAlbumDir(dir)
}
