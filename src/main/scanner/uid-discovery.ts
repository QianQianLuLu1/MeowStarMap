/**
 * 独立的游戏目录 UID 发现机制（对齐上游 nikki_albums 的 FindUid.find()）
 *
 * 原理：即使照片被复制到非标准目录，只要游戏本体安装在机器上，
 * 游戏安装目录下的 GamePlayPhotos 文件夹包含所有账号的 UID 子目录。
 * 通过扫描这些子目录名匹配 ^\d+$（纯数字、任意位数）即可发现 UID。
 *
 * 可测性：抽取为独立模块，不依赖 worker-entry 的 electron 上下文，
 * 通过依赖注入 log 函数实现可测试性（与 repair-legacy-data-v3 模式一致）
 */
import fs from 'fs'
import path from 'path'
import { sendScanLogEntry } from './scan-logger'

// UID 正则：纯数字、任意位数（名称完全由数字组成即为 UID 文件夹）。
// 无限暖暖真实 UID 多为 6-12 位数字，但规范要求不硬编码具体位数：
// GamePlayPhotos 一级子目录中「完全由数字组成」的目录名即判定为 UID，
// 准确性由真实目录发现（而非位数假设）保障。
// fs.readdirSync 原生默认能读到隐藏目录，配合此纯数字判定即可发现全部 UID 文件夹。
const UID_REGEX = /^\d+$/

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
 * 子目录名匹配 ^\d+$（纯数字）的即为有效 UID。
 *
 * 同时返回目录首层全部条目名：未发现 UID 时供 E004 输出「目录下所有文件/文件夹名列表」，
 * 便于区分「目录为空 / 目录被改名 / 权限不足读不到」。
 * 读取失败时 entries 为 null（无法列出），uids 为空数组。
 */
function readUidsFromDir(gameplayPhotosDir: string): { uids: string[]; entries: string[] | null } {
  try {
    const dirents = fs.readdirSync(gameplayPhotosDir, { withFileTypes: true })
    const entries = dirents.map((d) => d.name)
    const uids = dirents
      .filter((entry) => entry.isDirectory() && UID_REGEX.test(entry.name))
      .map((entry) => entry.name)
    return { uids, entries }
  } catch {
    // 目录读取失败（权限不足/不存在等）不阻塞流程
    return { uids: [], entries: null }
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

    // 全链路诊断：[目录遍历] 节点——直接读取 GamePlayPhotos 下所有子目录（原生 readdir，无隐藏过滤）
    sendScanLogEntry({
      stage: 'dir-traverse',
      level: 'info',
      message: `开始遍历 GamePlayPhotos 目录：${gameplayPhotosDir}`
    })
    const { uids: found, entries } = readUidsFromDir(gameplayPhotosDir)
    // 全链路诊断：E004 —— 未找到 UID 文件夹，输出该目录下全部条目名以便定位
    if (found.length === 0) {
      sendScanLogEntry({
        stage: 'traverse-result',
        level: 'warn',
        kind: entries === null ? 'permission' : 'empty',
        code: 'E004',
        message: `未找到 UID 文件夹（E004）：${gameplayPhotosDir}`,
        detail: {
          path: gameplayPhotosDir,
          entries: entries ?? [],
          readable: entries !== null
        }
      })
    }
    for (const uid of found) uids.add(uid)
  }

  const result = Array.from(uids)
  // 全链路诊断：[遍历结果] 节点——列出 UID 数量与列表，便于核对与 nikki_albums 是否一致
  sendScanLogEntry({
    stage: 'traverse-result',
    level: result.length > 0 ? 'info' : 'warn',
    kind: result.length > 0 ? 'ok' : 'empty',
    message: `找到 UID 文件夹 ${result.length} 个，列表：${result.join(', ') || '(none)'}`,
    detail: result
  })
  if (result.length > 0) {
    log?.('info', `[uid-discovery] 从游戏目录发现 ${result.length} 个 UID:`, result)
  }
  return result
}
