/**
 * T04：无限暖暖版本与活动时间表
 * 用于"活动时间轴"视图按版本/活动周期分组照片
 *
 * 数据来源：官方公告 / 维基百科 / 游戏内公告
 * 后续维护：直接在本文件追加 GAME_VERSIONS / GAME_EVENTS 即可，无需改代码
 *
 * 位置说明：本模块仅被渲染进程使用（EventTimelineView），故放在渲染层。
 * 其 i18n 依赖渲染进程实例（react-i18next 的 i18n default export）；
 * 若放回 src/main 会连带引入主进程 logger(electron-log)，把 Node 内建
 * fs/os/path/crypto 拖进渲染 bundle，导致浏览器运行时 "Failed to resolve module specifier"。
 */

import i18n from '../i18n'

/**
 * 游戏版本节点
 * - version：版本号（与游戏内显示一致）
 * - name：版本主题名（如"妄想季"）
 * - startDate：版本上线日期（YYYY-MM-DD）
 * - endDate：版本结束日期（下一版本上线前一天，留空则到下一版本开始前）
 */
export interface GameVersion {
  version: string
  name: string
  startDate: string // YYYY-MM-DD
  endDate?: string // YYYY-MM-DD（留空则自动取下一版本 startDate 前一天）
}

/**
 * 限时活动节点
 * - name：活动名
 * - startDate / endDate：活动起止日期
 * - description：活动简述（可选）
 */
export interface GameEvent {
  name: string
  startDate: string // YYYY-MM-DD
  endDate: string // YYYY-MM-DD
  description?: string
}

/**
 * 无限暖暖版本更新时间表
 * 按时间升序排列；仅收录已确认的版本日期
 * 数据来源：官方维护公告与游戏内版本号
 *
 * TODO: i18n: 版本主题名为游戏专有名词，需重构为存储 i18n key 并在 UI 层 t() 解析
 */
export const GAME_VERSIONS: GameVersion[] = [
  { version: '1.0', name: '开服首版', startDate: '2024-12-05' },
  { version: '1.1', name: '新春特别版', startDate: '2025-01-24' },
  { version: '1.3', name: '初春版', startDate: '2025-02-26' },
  { version: '1.4', name: '妄想季', startDate: '2025-03-26' },
  { version: '1.5', name: '泡泡季', startDate: '2025-04-29' },
  { version: '1.6', name: '天真季', startDate: '2025-06-13' },
  { version: '1.7', name: '蓝泪季', startDate: '2025-07-08' },
  { version: '1.8', name: '丹青季', startDate: '2025-07-30' },
  { version: '1.9', name: '音乐季', startDate: '2025-09-02' },
  { version: '2.0', name: '二周年', startDate: '2025-11-26' },
  { version: '2.2', name: '更新版', startDate: '2026-02-02' },
  { version: '2.3', name: '予我无冕之心', startDate: '2026-03-03' }
]

/**
 * 限时活动时间表
 * 仅收录公开活动中可明确查证起止日期的；后续可追加
 *
 * TODO: i18n: 活动名/描述需重构为存储 i18n key 并在 UI 层 t() 解析
 */
export const GAME_EVENTS: GameEvent[] = [
  {
    name: '暖暖生日惊喜速递',
    startDate: '2024-11-30',
    endDate: '2024-12-31',
    description: '开服预热活动'
  },
  {
    name: '新春特别活动',
    startDate: '2025-01-24',
    endDate: '2025-02-25',
    description: '1.1 版本限时活动'
  }
]

/**
 * 获取所有版本节点（按时间升序）
 */
export function getGameVersions(): GameVersion[] {
  return GAME_VERSIONS
}

/**
 * 获取所有活动节点（按开始时间升序）
 */
export function getGameEvents(): GameEvent[] {
  return GAME_EVENTS
}

/**
 * 根据日期找到所属的版本节点
 * - 若日期早于最早的版本，返回 null
 * - 否则返回 startDate <= date 的最后一个版本
 */
export function findVersionByDate(dateStr: string): GameVersion | null {
  if (!dateStr) return null
  const target = new Date(dateStr).getTime()
  if (Number.isNaN(target)) return null

  let matched: GameVersion | null = null
  for (const v of GAME_VERSIONS) {
    const start = new Date(v.startDate).getTime()
    if (start <= target) {
      matched = v
    } else {
      break
    }
  }
  return matched
}

/**
 * 获取所有版本节点 + 活动节点的合并列表（按时间升序）
 * 用于时间轴渲染
 */
export interface TimelineNode {
  type: 'version' | 'event'
  key: string // 唯一标识（version 或 event-索引）
  name: string
  startDate: string
  endDate?: string
  description?: string
  version?: string
}

export function getTimelineNodes(): TimelineNode[] {
  const nodes: TimelineNode[] = []
  for (const v of GAME_VERSIONS) {
    nodes.push({
      type: 'version',
      key: `version-${v.version}`,
      name: v.name,
      startDate: v.startDate,
      endDate: v.endDate,
      description: i18n.t('main.gameEvents.versionDescription', { version: v.version }),
      version: v.version
    })
  }
  for (let i = 0; i < GAME_EVENTS.length; i++) {
    const e = GAME_EVENTS[i]
    nodes.push({
      type: 'event',
      key: `event-${i}`,
      name: e.name,
      startDate: e.startDate,
      endDate: e.endDate,
      description: e.description
    })
  }
  return nodes.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())
}
