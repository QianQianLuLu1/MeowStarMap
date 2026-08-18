/**
 * P1-U5：编辑器 RGB 通道颜色集中管理
 * Canvas 2D 不支持 CSS 变量，需硬编码值；集中管理避免 Histogram 与 ToneCurve 数值漂移
 */
export const CHANNEL_COLORS = {
  r: { stroke: 'rgba(239, 68, 68, 0.7)', solid: '#ef4444' },
  g: { stroke: 'rgba(34, 197, 94, 0.7)', solid: '#22c55e' },
  b: { stroke: 'rgba(59, 130, 246, 0.7)', solid: '#3b82f6' },
  rgb: { stroke: 'rgba(156, 163, 175, 0.5)', solid: '#888888' }
} as const
