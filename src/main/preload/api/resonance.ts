// @core-change: 共鸣录同步上游 65bb3d8f，向渲染层暴露卡池心愿单读写方法 setWishlist
// 共鸣录命名空间：对应主进程 handlers/resonance-handler.ts 注册的 resonance:* 通道
import { call } from '../ipc'
import type {
  ResonanceCommitImportBatch,
  ResonanceCommitImportResult,
  ResonanceBannerWishlistData,
  ResonanceGetDataResult,
  ResonanceExportPayload,
  ResonanceExportResult,
  ResonanceReadImportFileResult,
  ResonanceWardrobeUpdateResult
} from '../../../shared/types/resonance'

/** electronAPI.resonance：共鸣录（离线本地功能：记录 / 衣橱 / 导入导出） */
export const resonanceAPI = {
  /** 全量读取四类记录 + 衣橱 */
  getData: () => call<ResonanceGetDataResult>('resonance:getData'),
  /** 手动补录（写入 edits 表） */
  addManualRecord: (bannerId: string, itemId: string, obtainedAt: string) =>
    call<{ added: boolean }>('resonance:addManualRecord', bannerId, itemId, obtainedAt),
  /** 修改补录时间 */
  updateManualRecord: (id: number, obtainedAt: string) =>
    call<{ updated: boolean }>('resonance:updateManualRecord', id, obtainedAt),
  /** 删除记录（kind 区分抽卡记录 / 补录） */
  deleteRecord: (kind: 'pull' | 'edit', id: number) =>
    call<{ deleted: boolean }>('resonance:deleteRecord', { kind, id }),
  /** 主进程读入导入文件（PathGuard + 大小上限；解析在渲染层纯函数） */
  readImportFile: (filePath: string) =>
    call<ResonanceReadImportFileResult>('resonance:readImportFile', filePath),
  /** 提交一个导入批次（单事务；INSERT OR IGNORE 幂等，可分批续传） */
  commitImport: (batch: ResonanceCommitImportBatch) =>
    call<ResonanceCommitImportResult>('resonance:commitImport', batch),
  /** 导出 JSON（载荷由渲染层组装；主进程守卫 envelope + 白名单路径写盘） */
  export: (filePath: string, payload: ResonanceExportPayload) =>
    call<ResonanceExportResult>('resonance:export', { filePath }, payload),
  /** 衣橱增量更新（单批上限 5000） */
  updateWardrobe: (
    adds: Array<{ category: 'item' | 'makeup' | 'momo' | 'prop' | 'eureka_color'; itemId: number }>,
    removes: Array<{
      category: 'item' | 'makeup' | 'momo' | 'prop' | 'eureka_color'
      itemId: number
    }>
  ) => call<ResonanceWardrobeUpdateResult>('resonance:updateWardrobe', { adds, removes }),
  /** 卡池心愿单全量覆盖（空 entries 即清空；回传落库后的最新数据） */
  setWishlist: (wishlist: ResonanceBannerWishlistData) =>
    call<{ wishlist: ResonanceBannerWishlistData }>('resonance:setWishlist', wishlist),
  /** 危险操作：清空全部共鸣数据（渲染层负责二次确认） */
  clearAll: () => call<{ cleared: boolean }>('resonance:clearAll')
}
