// @core-change: decrypt 命名空间新增 clearClothCache 方法（阶段 3）
// 解密命名空间：对应主进程 handlers/decrypt-handler.ts 注册的 decrypt:* 通道
import { call } from '../ipc'
import type {
  ClearClothCacheResponse,
  DecodeClothDiyResponse,
  DecodeFileResponse,
  DecodeHomeBuildResponse,
  EncodeCameraParamsResponse,
  LookupClothDataResponse
} from '../../../shared/types/electron-api'

/** electronAPI.decrypt：游戏参数解密 */
export const decryptAPI = {
  decodeFile: (filePath: string, albumType: string, uid?: string) =>
    call<DecodeFileResponse>('decrypt:decodeFile', filePath, albumType, uid),
  // Group 2: 相机参数加密
  encodeCameraParams: (jsonText: string) =>
    call<EncodeCameraParamsResponse>('decrypt:encodeCameraParams', jsonText),
  // Group 3: 染色分享码解码
  decodeClothDiy: (codeStr: string) =>
    call<DecodeClothDiyResponse>('decrypt:decodeClothDiy', codeStr),
  // Group 4: 家园建造分享码解码
  decodeHomeBuild: (codeStr: string) =>
    call<DecodeHomeBuildResponse>('decrypt:decodeHomeBuild', codeStr),
  // Group 5: 服饰数据批量查询（数据源失败静默降级为空对象，永不 reject——校验失败才抛 IpcError）
  lookupCloth: (ids: number[]) => call<LookupClothDataResponse>('decrypt:lookupCloth', ids),
  // Group 6: 清空搭配码网络结果缓存（阶段 3；目录缺失返回 {0,0}，单文件失败跳过）
  clearClothCache: () => call<ClearClothCacheResponse>('decrypt:clearClothCache')
}
