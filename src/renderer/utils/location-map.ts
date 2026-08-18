/**
 * 坐标→地名映射表
 *
 * 数据来源：
 * - 地点分类体系：上游 nikki_albums 项目 world.rs（通过 location-data.ts 导入）
 * - 坐标范围：待社区收集，通过自动收集机制逐步积累
 *
 * 上游 location_parser.rs 中坐标→地点映射为 // todo 空壳，
 * 本模块实现了自动收集 + 手动映射 + 地点分类查询三层机制：
 * 1. getLocationName(): 坐标 → 已知地标名（通过 3D 距离匹配）
 * 2. findLocationPath(): 地名 → 完整层级路径（如 "奇迹大陆 > 筑心王国 > 花愿镇"）
 * 3. getAllLocationNames(): 获取所有已知地名列表（供 UI 搜索/选择）
 */

import { WORLD_LOCATIONS, getAllLocationNames, findLocationPath } from './location-data'

export { getAllLocationNames, findLocationPath }

interface LocationEntry {
  pos: { x: number; y: number; z: number }
  radius: number
  name: string
}

// 已知地标坐标（待社区数据收集后补充）
// 格式：{ pos: { x, y, z }, radius: 50, name: '花愿镇' }
const LOCATION_MAP: LocationEntry[] = []

// 未识别坐标自动收集（最多保留 500 条避免内存溢出）
const _unknownLocations: Array<{ x: number; y: number; z: number }> = []
const MAX_UNKNOWN = 500

/**
 * 根据坐标查找最近的地名
 * 在 radius 范围内找到最近的地标则返回名称，否则返回 null
 * 返回 null 时自动记录到未识别列表
 */
export function getLocationName(x: number, y: number, z: number): string | null {
  if (LOCATION_MAP.length === 0) {
    collectUnknown(x, y, z)
    return null
  }

  let bestMatch: LocationEntry | null = null
  let bestDist = Infinity

  for (const entry of LOCATION_MAP) {
    const dist = Math.sqrt((x - entry.pos.x) ** 2 + (y - entry.pos.y) ** 2 + (z - entry.pos.z) ** 2)
    if (dist <= entry.radius && dist < bestDist) {
      bestDist = dist
      bestMatch = entry
    }
  }

  if (!bestMatch) {
    collectUnknown(x, y, z)
  }

  return bestMatch?.name ?? null
}

/** 记录未识别坐标 */
function collectUnknown(x: number, y: number, z: number): void {
  if (_unknownLocations.length >= MAX_UNKNOWN) return
  // 去重：检查是否已存在相近坐标（距离 < 5）
  const exists = _unknownLocations.some(
    (loc) => Math.abs(loc.x - x) < 5 && Math.abs(loc.y - y) < 5 && Math.abs(loc.z - z) < 5
  )
  if (!exists) {
    _unknownLocations.push({ x, y, z })
  }
}

/** 导出未识别坐标列表（供社区收集使用） */
export function exportUnknownLocations(): string {
  return JSON.stringify(_unknownLocations, null, 2)
}

/** 获取未识别坐标数量 */
export function getUnknownLocationCount(): number {
  return _unknownLocations.length
}

/**
 * 手动添加已知地标坐标
 * 供未来通过社区数据或游戏内验证后填充
 */
export function addKnownLocation(
  x: number,
  y: number,
  z: number,
  radius: number,
  name: string
): void {
  LOCATION_MAP.push({ pos: { x, y, z }, radius, name })
}

/** 获取完整地点层级数据（供 UI 树形展示） */
export function getWorldLocations() {
  return WORLD_LOCATIONS
}
