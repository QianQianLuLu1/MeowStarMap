/**
 * 扫描目录配置读写（游戏目录候选排除集 / 自定义目录）。
 *
 * 五要素：
 * - 依赖声明：仅 window.electronAPI.settings（既有 IPC 通道 settings:get / settings:set），
 *   不新增通道、不新增依赖；无 electronAPI（预览版/单测）时安全降级。
 * - 启动说明：纯异步读写，无副作用、无模块级状态。
 * - 错误处理：读取非数组/读取失败 → 返回空数组，不抛异常（调用方据此显示全部候选）。
 * - 参数校验：逐项过滤非字符串与空白项，避免脏配置透传到主进程 zod schema 校验失败。
 * - 基础测试：见 src/renderer/pages/settings/ScanGameRootsSection.test.tsx。
 */

/** 用户自定义游戏目录（三级兜底持久化，支持多条） */
export const CUSTOM_SCAN_PATHS_KEY = 'customScanPaths'
/** 用户在「游戏目录」分区取消勾选的目录，扫描时作为 excludedPaths 传入 */
export const EXCLUDED_SCAN_PATHS_KEY = 'excludedScanPaths'
/** 默认勾选（修改时间最新项）是否已落库；用于区分「未初始化」与「用户主动全选」 */
export const GAME_ROOTS_INITIALIZED_KEY = 'gameRootsSelectionInitialized'

/** 配置条目数量上限，与 scanner-handler.ts 的 schema max(64) 一致 */
export const MAX_PATH_ITEMS = 64

/** 归一化：仅保留非空字符串项并截断到上限（大小写保持原样，比较由调用方处理） */
export function normalizePathList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .slice(0, MAX_PATH_ITEMS)
}

async function readSetting(key: string, fallback: unknown = []): Promise<string[]> {
  try {
    const raw = await window.electronAPI?.settings?.get(key, fallback)
    return normalizePathList(raw)
  } catch {
    // 设置读取失败不阻塞 UI：按空配置处理，用户可重新勾选
    return []
  }
}

async function writeSetting(key: string, paths: string[]): Promise<void> {
  const next = normalizePathList(paths)
  try {
    await window.electronAPI?.settings?.set(key, next)
  } catch {
    // 写入失败仅影响下次启动的默认勾选，不打断当前交互
  }
}

/** 读取用户自定义游戏目录（无配置返回空数组） */
export function loadCustomScanPaths(): Promise<string[]> {
  return readSetting(CUSTOM_SCAN_PATHS_KEY)
}

/** 保存用户自定义游戏目录 */
export function saveCustomScanPaths(paths: string[]): Promise<void> {
  return writeSetting(CUSTOM_SCAN_PATHS_KEY, paths)
}

/** 读取被用户排除的游戏目录（无配置返回空数组 = 不排除任何目录） */
export function loadExcludedScanPaths(): Promise<string[]> {
  return readSetting(EXCLUDED_SCAN_PATHS_KEY)
}

/** 保存被用户排除的游戏目录 */
export function saveExcludedScanPaths(paths: string[]): Promise<void> {
  return writeSetting(EXCLUDED_SCAN_PATHS_KEY, paths)
}

/** 读取「默认勾选是否已初始化」标记 */
export async function isGameRootsInitialized(): Promise<boolean> {
  try {
    return (await window.electronAPI?.settings?.get(GAME_ROOTS_INITIALIZED_KEY, false)) === true
  } catch {
    return false
  }
}

/** 标记「默认勾选已初始化」 */
export async function markGameRootsInitialized(): Promise<void> {
  try {
    await window.electronAPI?.settings?.set(GAME_ROOTS_INITIALIZED_KEY, true)
  } catch {
    // 标记失败仅影响下次进入设置页时是否重算默认勾选，不影响扫描
  }
}

/**
 * 需求三.3：多目录共存时的默认勾选集合——优先在「含 GamePlayPhotos」的候选中取
 * 修改时间（mtimeMs）最新者；无任何候选含相册目录时退化为全体最新者；
 * 全部不可 stat（mtimeMs 均为 0，如权限受限）时全部勾选，避免静默漏扫。
 */
export function pickDefaultSelectedPaths(
  candidates: Array<{ path: string; mtimeMs: number; hasGamePlayPhotos: boolean }>
): Set<string> {
  if (!Array.isArray(candidates) || candidates.length === 0) return new Set<string>()
  const withAlbum = candidates.filter((c) => c.hasGamePlayPhotos)
  const pool = withAlbum.length > 0 ? withAlbum : candidates
  const max = Math.max(...pool.map((c) => c.mtimeMs))
  // 全部 mtime 为 0（读取失败/不可 stat）时无法区分新旧，全部勾选
  const selected = max === 0 ? pool : pool.filter((c) => c.mtimeMs === max)
  return new Set(selected.map((c) => c.path))
}
