/**
 * 视频抽帧纯色帧判定（plan: fix-video-thumbnail-white-frame）
 *
 * 背景：ffmpeg 固定抽 0s 首帧时，片头存在白闪 / 淡入 / 装饰帧的视频会产出
 * 「完全平坦」的纯白 JPEG（实测 320×180 仅 600~900 字节，正常帧 10~40 KB），
 * 该帧能被正常解码，因此既不报错也不触发既有 0s→1s 错误重试，会作为缩略图
 * 永久命中缓存，表现为「缓存 / 重复文件板块视频缩略图概率显示为纯白色」。
 *
 * 本模块提供纯色判定能力，供主进程 ThumbnailGenerator 与 media worker 共用：
 *   1. isBlankImageFile        —— 抽帧后立即判定，用于决定是否继续向后取帧
 *   2. isBlankCachedThumbnail —— 缓存命中场景判定，先用体积闸门过滤，避免每次访问都解码
 *
 * 设计约束：
 * - 不 import t / logger：主进程用 logger + `../i18n`，worker 用 workerLog + `../i18n/worker-safe`，
 *   引入任一都会造成另一侧的依赖污染，故本模块保持零 i18n、零日志依赖，由调用方负责记录。
 * - 失败开放（fail-open）：任何异常一律返回 false，绝不让判定逻辑阻断正常抽帧。
 */

import fsp from 'fs/promises'
import sharp from 'sharp'

/**
 * 纯色判定阈值：各通道标准差的最大值不超过该值即视为纯色（纯白 / 纯黑 / 纯灰）。
 * 实测：纯色帧 stdev ≈ 0；真实画面 stdev 通常 40~70（即使过曝的雪景也在 20 以上）。
 */
export const BLANK_STDEV_THRESHOLD = 6

/**
 * 缓存命中自检的体积闸门（字节）。
 * 正常 320×180 画面帧 10~40 KB，纯色帧实测 600~900 B；
 * 超过该值直接跳过解码，避免每次访问缩略图都付一次 sharp 解码（约 1~3 ms）。
 */
export const BLANK_CACHE_SIZE_HINT_BYTES = 4096

/**
 * 判定图片是否为近乎纯色的帧（纯白 / 纯黑 / 纯灰）。
 *
 * 复用仓库既有 sharp stats 写法（见 src/main/utils/scene-brightness.ts）：
 * 先缩到 128×128 再取 stats，避免对大图做全量统计。
 *
 * @param filePath 图片文件路径
 * @returns true = 近乎纯色；读取失败 / 非图片 / 解码异常一律 false（失败开放）
 */
export async function isBlankImageFile(filePath: string): Promise<boolean> {
  // 参数校验：空值直接失败开放，不抛错
  if (!filePath || typeof filePath !== 'string') return false

  try {
    const stats = await sharp(filePath).resize(128, 128, { fit: 'inside' }).stats()
    const channels = stats?.channels
    if (!Array.isArray(channels) || channels.length === 0) return false

    // 任一通道存在足够细节 → 非纯色
    for (const channel of channels) {
      const stdev = Number(channel?.stdev)
      if (Number.isFinite(stdev) && stdev > BLANK_STDEV_THRESHOLD) {
        return false
      }
    }
    return true
  } catch {
    // 文件不存在 / 非图片字节 / 解码失败：失败开放，按「有内容」处理
    return false
  }
}

/**
 * 缓存命中场景的纯色自检。
 *
 * 先用体积闸门短路：绝大多数正常缩略图体积远大于闸门值，
 * 只有疑似纯色的小文件才真正解码判定，热路径成本趋近于 0。
 *
 * @param filePath 缩略图文件路径
 * @returns true = 疑似纯色（需要自愈重建）；stat 失败或超出闸门一律 false
 */
export async function isBlankCachedThumbnail(filePath: string): Promise<boolean> {
  if (!filePath || typeof filePath !== 'string') return false

  try {
    const stat = await fsp.stat(filePath)
    if (!stat.isFile()) return false
    if (stat.size > BLANK_CACHE_SIZE_HINT_BYTES) return false
  } catch {
    // 无法 stat（文件不存在 / 无权限）：不判定为纯色
    return false
  }

  return isBlankImageFile(filePath)
}
