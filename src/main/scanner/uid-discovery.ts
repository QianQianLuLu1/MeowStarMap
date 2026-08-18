/**
 * 独立的游戏目录 UID 发现机制（对齐上游 nikki_albums 的 FindUid.find()）
 *
 * 原理：即使照片被复制到非标准目录，只要游戏本体安装在机器上，
 * 游戏安装目录下的 GamePlayPhotos 文件夹包含所有账号的 UID 子目录。
 * 通过扫描这些子目录名匹配 ^\d{6,12}$ 即可发现 UID。
 *
 * 可测性：抽取为独立模块，不依赖 worker-entry 的 electron 上下文，
 * 通过依赖注入 log 函数实现可测试性（与 repair-legacy-data-v3 模式一致）
 */
import fs from 'fs'
import path from 'path'

// UID 正则：6-12 位数字，与 path-classifier 的 UID_REGEX 保持一致
const UID_REGEX = /^\d{6,12}$/

// 向上查找 GamePlayPhotos 目录的最大层级
// 媒体目录层级示例：GamePlayPhotos/{uid}/NikkiPhotos_HighQuality（2 层）
// 预留 3 层余量，覆盖 Collage 等更深子目录
const MAX_PARENT_SEARCH = 5

type LogLevel = 'info' | 'warn' | 'error'

/**
 * 从单个目录向上查找 GamePlayPhotos 目录。
 * 媒体目录可能是 .../GamePlayPhotos/{uid}/NikkiPhotos_HighQuality
 * 也可能是 .../GamePlayPhotos/{uid}/Collage
 *
 * @returns GamePlayPhotos 目录路径，未找到返回 null
 */
export function findGamePlayPhotosDir(dir: string): string | null {
  let current = dir
  for (let i = 0; i < MAX_PARENT_SEARCH; i++) {
    if (path.basename(current) === 'GamePlayPhotos') {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) break // 到达根目录
    current = parent
  }
  return null
}

/**
 * 扫描 GamePlayPhotos 目录下的所有 UID 子目录。
 * 子目录名匹配 ^\d{6,12}$ 的即为有效 UID。
 */
function readUidsFromDir(gameplayPhotosDir: string): string[] {
  try {
    const entries = fs.readdirSync(gameplayPhotosDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && UID_REGEX.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    // 目录读取失败（权限不足/不存在等）不阻塞流程
    return []
  }
}

/**
 * 扫描游戏目录下的 GamePlayPhotos 文件夹，发现所有 UID。
 * 对齐上游 nikki_albums 的 FindUid.find() 逻辑。
 *
 * @param gameDirs 已知的游戏媒体目录列表（findMediaDirectories 的返回值）
 * @param log 日志函数（可选，默认无操作）
 * @returns 发现的 UID 字符串数组（去重）
 */
export function discoverUidsFromGameDirs(
  gameDirs: string[],
  log?: (level: LogLevel, message: string, ...args: unknown[]) => void
): string[] {
  const uids = new Set<string>()

  for (const dir of gameDirs) {
    const gameplayPhotosDir = findGamePlayPhotosDir(dir)
    if (!gameplayPhotosDir) continue

    const found = readUidsFromDir(gameplayPhotosDir)
    for (const uid of found) uids.add(uid)
  }

  const result = Array.from(uids)
  if (result.length > 0) {
    log?.('info', `[uid-discovery] 从游戏目录发现 ${result.length} 个 UID:`, result)
  }
  return result
}
