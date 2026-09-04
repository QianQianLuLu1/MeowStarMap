// 解密命名空间：对应主进程 handlers/decrypt-handler.ts 注册的 decrypt:* 通道
import { call } from '../ipc'
import type {
  DecodeClothDiyResponse,
  DecodeFileResponse,
  DecodeHomeBuildResponse,
  EncodeCameraParamsResponse
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
    call<DecodeHomeBuildResponse>('decrypt:decodeHomeBuild', codeStr)
}
