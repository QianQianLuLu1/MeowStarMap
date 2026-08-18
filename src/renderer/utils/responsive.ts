interface Breakpoint {
  width: number
  cols: number
}

/**
 * P1-U10：Gallery 视图默认响应式列数断点
 *
 * VirtualImageGrid / TimelineView / EventTimelineView 三者原各自维护相同的断点表
 * （1280→6, 1024→5, 768→4, 480→3, 0→2），统一为单一数据源。
 */
export const DEFAULT_COLUMNS_BREAKPOINTS: readonly Breakpoint[] = [
  { width: 1280, cols: 6 },
  { width: 1024, cols: 5 },
  { width: 768, cols: 4 },
  { width: 480, cols: 3 },
  { width: 0, cols: 2 }
] as const

/**
 * 根据容器宽度计算响应式列数
 *
 * @param width 容器宽度（px）
 * @param breakpoints 断点表（降序排列），默认 DEFAULT_COLUMNS_BREAKPOINTS
 * @returns 匹配的列数
 */
export function getResponsiveColumns(
  width: number,
  breakpoints: readonly Breakpoint[] = DEFAULT_COLUMNS_BREAKPOINTS
): number {
  return breakpoints.find((b) => width >= b.width)?.cols ?? 2
}

/**
 * 计算等价于 CSS `repeat(auto-fill, minmax(minItemWidth, 1fr))` 的列数
 *
 * 虚拟列表必须把成员切成定长的行，无法交给 auto-fill 自动换行，
 * 因此这里用同样的公式还原列数，保证虚拟化前后布局一致。
 *
 * @param width 可用宽度（px，已扣除容器内边距）
 * @param minItemWidth 单项最小宽度（px）
 * @param gap 列间距（px）
 * @returns 列数，至少为 1
 */
export function getAutoFillColumns(width: number, minItemWidth: number, gap: number): number {
  if (width <= 0 || minItemWidth <= 0) return 1
  return Math.max(1, Math.floor((width + gap) / (minItemWidth + gap)))
}
