/**
 * 物理文件身份（设备号 + inode）读取与去重。
 *
 * 背景：游戏/启动器用 Windows 硬链接把同一物理文件暴露在多个目录下
 * （如 `GamePlayPhotos\<UID>\NikkiPhotos_HighQuality\x.jpeg` 与 `X6Game\ScreenShot\x.jpeg`），
 * 扫描器按路径各写一条 `media_files` 记录。重复/相似检测假定「一行 = 一个文件」，
 * 于是同一文件的两个硬链接路径被判成两份重复（同 size、同 sha256）或两份相似（同 pHash）。
 *
 * 本模块提供唯一的收敛点：**按 dev + ino 去重**，同一物理文件只保留 id 最小的一行。
 *
 * 兜底：stat 失败（文件缺失/无权限/路径非法）返回 null，该行保留（fail-open），
 * 与 src/main/utils/AGENTS.md 的既有错误策略一致——宁可少去重，不可误删候选。
 * 文件系统不提供文件索引号时（FAT32/exFAT 卷、部分网络重定向盘，同卷所有 ino 恒为退化值 0）
 * 同样判为「身份不可辨」按 fail-open 处理：否则整卷会被并成一行，
 * markDuplicatesInWorker 随即命中 rows.length < 2 分支清空全部 is_duplicate 标记。
 */
import { statSync } from 'fs'

/** 物理文件身份：设备号 + inode。二者都相同才是同一个物理文件（硬链接） */
export interface PhysicalFileKey {
  dev: number
  ino: number
}

/** stat 实现签名，供测试注入桩，避免 mock fs */
export type StatPhysicalFile = (filePath: string) => PhysicalFileKey | null

/**
 * 读取文件的物理身份。
 * @param filePath 绝对路径；非字符串或空串直接返回 null，不调用 statSync
 * @returns dev + ino；stat 抛错时返回 null
 */
export function statPhysicalFile(filePath: string): PhysicalFileKey | null {
  if (typeof filePath !== 'string' || filePath === '') return null
  try {
    const s = statSync(filePath)
    return { dev: s.dev, ino: s.ino }
  } catch {
    return null
  }
}

/**
 * 物理身份可用性判定：stat 失败，或文件系统不提供文件索引号（`ino === 0`，
 * FAT32/exFAT 卷与部分重定向网络盘的形态），都视为「不可辨」，与 stat 失败同等处理。
 */
function isUsableKey(key: PhysicalFileKey | null): key is PhysicalFileKey {
  return key !== null && key.ino !== 0
}

/**
 * 同一物理文件（硬链接的多个路径）只保留 id 最小的一行，其余剔除。
 * 身份不可辨（stat 失败 / `ino === 0`）的行一律保留，不参与去重也不被去重。
 *
 * @param rows 候选行（需含 id 与 file_path）
 * @param stat stat 实现，默认 statPhysicalFile
 * @returns 去重后的行，保持原相对顺序
 */
export function dedupeByPhysicalFile<T extends { id: number; file_path: string }>(
  rows: T[],
  stat: StatPhysicalFile = statPhysicalFile
): T[] {
  if (!Array.isArray(rows) || rows.length < 2) return rows

  const keys = rows.map((r) => stat(r.file_path))
  // 每个物理文件 → 胜出行下标（id 最小者）
  const winner = new Map<string, number>()
  keys.forEach((k, i) => {
    if (!isUsableKey(k)) return
    const key = `${k.dev}:${k.ino}`
    const prev = winner.get(key)
    if (prev === undefined || rows[i].id < rows[prev].id) winner.set(key, i)
  })

  const keep = new Set<number>()
  keys.forEach((k, i) => {
    if (!isUsableKey(k)) keep.add(i)
  })
  for (const i of winner.values()) keep.add(i)

  return rows.filter((_, i) => keep.has(i))
}
