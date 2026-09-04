import {
  defaultFilterParams,
  type FilterParams,
  type FilterPreset,
  type HSLColorKey
} from './imageProcessor'

export function mergeFilterParams(
  params: FilterParams,
  filter: FilterPreset | null,
  intensity: number
): FilterParams {
  if (!filter) return params

  const merged: FilterParams = JSON.parse(JSON.stringify(params))
  const presetParams = filter.params
  const ratio = Math.max(0, Math.min(100, intensity)) / 100

  for (const [key, value] of Object.entries(presetParams)) {
    if (key === 'hsl' && typeof value === 'object' && value) {
      for (const [colorKey, adj] of Object.entries(
        value as Partial<
          Record<HSLColorKey, { hue?: number; saturation?: number; lightness?: number }>
        >
      )) {
        const ck = colorKey as HSLColorKey
        if (!merged.hsl[ck]) continue
        merged.hsl[ck].hue += (adj?.hue || 0) * ratio
        merged.hsl[ck].saturation += (adj?.saturation || 0) * ratio
        merged.hsl[ck].lightness += (adj?.lightness || 0) * ratio
      }
    } else if (key === 'curves' && typeof value === 'object' && value) {
      // 滤镜不覆盖曲线，避免复杂合并
    } else if (typeof value === 'number' && key in defaultFilterParams && key !== 'hsl') {
      const k = key as keyof FilterParams
      const base = defaultFilterParams[k] as number
      ;(merged[k] as number) = base + (value - base) * ratio
    }
  }

  return merged
}
