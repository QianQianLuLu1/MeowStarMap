// 媒体列表命名空间：对应主进程 handlers/media-handler.ts 注册的 media:list 等通道
import { call, subscribe } from '../ipc'
import type {
  GroupCountsResult,
  MediaListResult,
  MediaSearchBuildDocsResult,
  MediaSearchExportIndexResult,
  MediaSearchImportIndexResult,
  MediaSearchResult
} from '../../../shared/types/electron-api'
import type { MarkDuplicatesResult, PhashResult, ScanResult } from '../../../shared/types/duplicate'

/** electronAPI.media：媒体列表查询 / 重复检测 / 相似检测 / 全文搜索 / 更新通知 */
export const mediaAPI = {
  list: (options?: {
    page?: number
    pageSize?: number
    includeDeleted?: boolean
    deletedOnly?: boolean
    sortBy?: string
    sortOrder?: string
    accountUid?: string
    albumType?: string
    hideDuplicates?: boolean
    // 损坏文件容错：corruptedOnly=true 仅返回 is_corrupted=1 的记录（"仅看损坏"筛选器）
    corruptedOnly?: boolean
    // 损坏文件容错：hideCorrupted=true 过滤掉 is_corrupted=1 的记录（图库默认视图）
    hideCorrupted?: boolean
    // 媒体来源过滤：'launcher' 用于启动器缓存视图，undefined 时后端默认排除 launcher
    mediaSource?: 'game' | 'launcher' | 'cloud' | 'all'
    // 图库板块目录限制：true 时仅返回 ...\GamePlayPhotos\{uid}\NikkiPhotos_HighQuality 下的图片
    galleryHighQualityOnly?: boolean
  }) => call<MediaListResult>('media:list', options),
  // F-S10：重复文件检测——返回完整 sha256 hash 重复的分组
  findDuplicates: () => call<ScanResult>('media:findDuplicates'),
  // T05：基于 pHash 的相似图检测——返回汉明距离≤threshold 的图片分组
  findSimilar: (options?: { threshold?: number }) => call<ScanResult>('media:findSimilar', options),
  // T05：手动触发 phash 补算（用于已入库但 phash 为 NULL 的图片）
  generatePhash: () => call<PhashResult>('media:generatePhash'),
  // P0-03：智能媒体分组——按维度统计分组数量
  getGroupCounts: (
    dimension: string,
    accountUid?: string,
    mediaSource?: 'game' | 'launcher' | 'cloud' | 'all'
  ) => call<GroupCountsResult>('media:getGroupCounts', dimension, accountUid, mediaSource),
  // P1-01：手动触发重复标记（基于 pHash 极严格阈值 + 评分推荐保留）
  markDuplicates: () => call<MarkDuplicatesResult>('media:markDuplicates'),
  // P1-01：查询已标记的重复分组（is_duplicate=1 按 original_id 聚合）
  listDuplicateGroups: () => call<unknown[]>('duplicate:listGroups'),
  // 性能重构 v3：全文搜索文件名（FTS5 优先，LIKE fallback）
  search: (keyword: string, limit?: number) =>
    call<MediaSearchResult>('media:search', keyword, limit),
  // 全文搜索：批量拉取索引文档（启动重建 / 增量拉取）
  searchBuildDocs: (options?: { since?: string; limit?: number; offset?: number }) =>
    call<MediaSearchBuildDocsResult>('search:buildDocs', options),
  // 全文搜索：导出索引片段到 userData（持久化）
  searchExportIndex: (segments: Array<{ key: string; data: string }>, schemaHash?: string) =>
    call<MediaSearchExportIndexResult>('search:exportIndex', { segments, schemaHash }),
  // 全文搜索：从 userData 导入索引片段
  searchImportIndex: () => call<MediaSearchImportIndexResult>('search:importIndex'),
  onUpdated: (callback: () => void) => subscribe('media:updated', callback)
}
