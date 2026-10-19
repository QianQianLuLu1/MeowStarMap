// @core-change: 阶段4 新增 assetEdits 命名空间，暴露资产编辑叠加层的读取与写入
// 资产编辑叠加层命名空间：对应主进程 handlers/asset-edits-handler.ts 的 asset-edits:* 通道。
// 本 App 专有数据（非 NikkiSync 协议 DTO），因此返回体是塑形后的驼峰形态。
import { call } from '../ipc'
import type { AssetEditsInfo, AssetEditsPatchInfo } from '../../../shared/types/electron-api'

/** electronAPI.assetEdits：按 NikkiSync asset_id 归键的用户编辑 */
export const assetEditsAPI = {
  /** 批量读叠加层（一页资产一次往返）；未迁移的旧库如实回退为空列表 */
  list: (assetIds: string[]) => call<{ edits: AssetEditsInfo[] }>('asset-edits:list', assetIds),
  /** 写入一条编辑并回读塑形后的结果 */
  set: (assetId: string, patch: AssetEditsPatchInfo) =>
    call<{ edit: AssetEditsInfo | null }>('asset-edits:set', { assetId, patch })
}
