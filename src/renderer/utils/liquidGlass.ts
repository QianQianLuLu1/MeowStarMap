/**
 * 液态玻璃导航栏的纯函数工具（滚动进度换算 + 亮度档位判定）。
 *
 * 技法来源（开源复用，避免重复造轮子）：
 * - 滚动联动高光：scroll 位置 → CSS 变量的标准换算（clamp 到 [0,1]）。
 * - 亮度档位：BT.601 加权亮度 + 0.5 阈值二档（Apple Liquid Glass 的明/暗玻璃近似）。
 */

export type GlassTone = 'light' | 'dim'

/**
 * 把滚动容器状态换算为 [0,1] 进度。
 * 异常入参（非有限数值）与无可滚动区间（scrollHeight <= clientHeight，含 keep-alive
 * 隐藏页 display:none 的 0/0 情形）一律返回 0，不抛错。
 */
export function progressFromScroll(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number
): number {
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(scrollHeight) ||
    !Number.isFinite(clientHeight)
  ) {
    return 0
  }
  const range = scrollHeight - clientHeight
  if (range <= 0) return 0
  const progress = scrollTop / range
  if (!Number.isFinite(progress)) return 0
  return Math.min(1, Math.max(0, progress))
}

/**
 * 解析 getComputedStyle 产物的 rgb()/rgba() 串（兼容逗号与空格两种序列化），
 * 返回 BT.601 加权亮度 [0,1]；全透明（alpha=0，如 'transparent' 的计算值）
 * 与无法解析的串返回 null，调用侧应保持上一档位。
 */
export function parseRgbLuminance(color: string): number | null {
  if (typeof color !== 'string') return null
  const match = color.match(/^rgba?\(([^)]*)\)$/)
  if (!match) return null
  const parts = match[1].split(/[\s,/]+/).filter(Boolean)
  if (parts.length !== 3 && parts.length !== 4) return null
  const channels = parts.slice(0, 3).map(Number)
  if (channels.some((c) => !Number.isFinite(c) || c < 0 || c > 255)) return null
  if (parts.length === 4) {
    const alpha = Number(parts[3])
    if (!Number.isFinite(alpha) || alpha <= 0) return null
  }
  const [r, g, b] = channels
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

/** 亮度 → 玻璃明暗档位；0.5 与非有限值保守归 'light'（维持现有浅色观感）。 */
export function luminanceToTone(luminance: number): GlassTone {
  if (!Number.isFinite(luminance)) return 'light'
  return luminance >= 0.5 ? 'light' : 'dim'
}
