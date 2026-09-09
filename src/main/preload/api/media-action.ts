// 媒体操作命名空间：对应主进程 handlers/media-handler.ts 注册的 media:* 通道
import { call } from '../ipc'
import type { OutfitStatsResult } from '../../../shared/types/electron-api'

/** electronAPI.mediaAction：媒体记录的字段更新与回收站管理 */
export const mediaActionAPI = {
  updateRating: (mediaId: number, rating: number) =>
    call<{ updated: boolean }>('media:updateRating', mediaId, rating),
  // P0-D：删除 toggleFavorite（已有 updateFavorite 满足需求）
  updateFavorite: (mediaId: number, isFavorite: boolean) =>
    call<{ updated: boolean }>('media:updateFavorite', mediaId, isFavorite),
  updateTags: (mediaId: number, tags: string[]) =>
    call<{ updated: boolean }>('media:updateTags', mediaId, tags),
  updateNotes: (mediaId: number, notes: string) =>
    call<{ updated: boolean }>('media:updateNotes', mediaId, notes),
  updateCategory: (mediaId: number, categoryId: number | null) =>
    call<{ updated: boolean }>('media:updateCategory', mediaId, categoryId),
  // F-O1：更新套装标注
  updateOutfit: (mediaId: number, outfit: string) =>
    call<{ updated: boolean }>('media:updateOutfit', mediaId, outfit),
  // F-O1：批量分析场景时段
  analyzeSceneTime: (mediaIds?: number[]) =>
    call<{ message: string; analyzed: number }>('media:analyzeSceneTime', mediaIds),
  // 物理删除数据库记录（配合文件永久删除场景，与 softDelete 语义不同，不合并）
  delete: (mediaId: number) => call<{ deleted: boolean }>('media:delete', mediaId),
  // F-S6 回收站：软删除/恢复/彻底删除/清空
  softDelete: (mediaIds: number[]) => call<{ message: string }>('media:softDelete', mediaIds),
  restore: (mediaIds: number[]) => call<{ message: string }>('media:restore', mediaIds),
  // #fix-permanent-delete-error-toast：返回类型与主进程真实 data 对齐（含 deletedCount/failedCount）
  permanentDelete: (mediaIds: number[]) =>
    call<{ message: string; deletedCount: number; failedCount: number }>(
      'media:permanentDelete',
      mediaIds
    ),
  emptyRecycleBin: () => call<{ message: string }>('media:emptyRecycleBin'),
  // T02：丢失记录清理（批量 / 单条）
  cleanupMissing: () => call<{ cleaned: number }>('media:cleanupMissing'),
  removeMissing: (mediaId: number) => call<{ removed: boolean }>('media:removeMissing', mediaId),
  // 损坏文件容错：清理所有 is_corrupted=1 的记录（批量删除数据库记录）
  // 返回 { message, cleared }：message 是用户可见的摘要，cleared 是清理的记录数
  cleanupCorrupted: () => call<{ message: string; cleared: number }>('media:cleanupCorrupted'),
  // 损坏文件容错：从库中移除单条损坏记录
  removeCorrupted: (mediaId: number) =>
    call<{ removed: boolean }>('media:removeCorrupted', mediaId),
  // T03：套装图鉴统计
  getOutfitStats: () => call<OutfitStatsResult>('media:getOutfitStats')
}
