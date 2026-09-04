// 缩略图命名空间：对应主进程 thumbnail 模块注册的 thumbnail:* 通道
import { call } from '../ipc'

/** electronAPI.thumbnail：图片缩略图生成 */
export const thumbnailAPI = {
  // P1-03：quality='low' 返回 64px 低质量缩略图，'standard' 或 undefined 返回标准 320px
  // 高清档位：quality='high' 返回 512px 高清缩略图（高分屏 DPR ≥ 2 时使用）
  generate: (filePath: string, quality?: 'low' | 'standard' | 'high') =>
    call<string | null>('thumbnail:generate', filePath, quality)
}
