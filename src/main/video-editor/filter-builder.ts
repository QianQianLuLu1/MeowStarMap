/**
 * 视频调色滤镜构建器
 *
 * 把图片编辑器 FilterParams 的基础调色子集映射为 ffmpeg -vf 滤镜串。
 * 纯函数、无 electron 依赖，便于单测。
 *
 * 映射规则详见 docs/VIDEO_EDIT_PLAN.md §4.1。
 *
 * 仅处理本期实现的 4 项核心调色 + temperature/tint（共 5 项）。
 * vibrance / highlights / shadows / clarity 等扩展项预留扩展位，本期不实现，
 * 由调用方按需追加（在返回串后拼接逗号 + 自定义段）。
 */
import type { FilterParams } from '../../shared/types/editor'

/**
 * 把 FilterParams 基础调色子集转为 ffmpeg -vf 字符串。
 *
 * 全 0 时返回空串，调用方可据此跳过 -vf 参数。
 *
 * @param params 图片编辑器完整 FilterParams（仅取 brightness/contrast/saturation/temperature/tint）
 * @returns ffmpeg 滤镜串（如 `eq=brightness=0.1:contrast=0.85,colorbalance=rs=0.2:mb=-0.2`），空串表示无调色
 */
export function buildColorFilter(params: FilterParams): string {
  const filters: string[] = []

  // 基础调色（eq 滤镜）：brightness / contrast / saturation
  const eqParts: string[] = []
  if (params.brightness !== 0) {
    // eq.brightness 范围 -1.0~1.0，图片参数 -100~100 → /200 得 ±0.5
    eqParts.push(`brightness=${(params.brightness / 200).toFixed(4)}`)
  }
  if (params.contrast !== 0) {
    // eq.contrast 范围 -1000~1000，1.0 为原值，图片参数 -100~100 → 1 + /100 得 0~2
    eqParts.push(`contrast=${(1 + params.contrast / 100).toFixed(4)}`)
  }
  if (params.saturation !== 0) {
    // eq.saturation 范围 -1000~1000，1.0 为原值，图片参数 -100~100 → 1 + /100 得 0~2
    eqParts.push(`saturation=${(1 + params.saturation / 100).toFixed(4)}`)
  }
  if (eqParts.length > 0) {
    filters.push(`eq=${eqParts.join(':')}`)
  }

  // 色温色调（colorbalance 滤镜）：temperature / tint
  if (params.temperature !== 0 || params.tint !== 0) {
    const cb: string[] = []
    if (params.temperature !== 0) {
      // 暖：加红减蓝；冷：减红加蓝。rs=红阴影，mb=蓝中调
      cb.push(`rs=${(params.temperature / 200).toFixed(4)}`)
      cb.push(`mb=${(-params.temperature / 200).toFixed(4)}`)
    }
    if (params.tint !== 0) {
      // gs=绿中调；正值为品红方向（与图片 applyTint 一致：正值减绿→品红）
      cb.push(`gs=${(-params.tint / 300).toFixed(4)}`)
    }
    filters.push(`colorbalance=${cb.join(':')}`)
  }

  return filters.join(',')
}
