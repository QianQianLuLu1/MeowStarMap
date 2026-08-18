import { type FilterPreset } from './imageProcessor'

const categories = [
  { id: 'all', name: 'filter.category.all' },
  { id: 'natural', name: 'filter.category.natural' },
  { id: 'vintage', name: 'filter.category.vintage' },
  { id: 'artistic', name: 'filter.category.artistic' },
  { id: 'cinematic', name: 'filter.category.cinematic' },
  { id: 'custom', name: 'filter.category.custom' }
]

export function getFilterCategories() {
  return categories
}

export function getPresetsByCategory(category: string): FilterPreset[] {
  if (category === 'all') return builtinFilterPresets
  return builtinFilterPresets.filter((p) => p.category === category)
}

// U5：移除 p() 包装器后无需 FilterPresetParams 中间类型，直接使用对象字面量
// name 字段存储 i18n key，消费方需用 t() 解析；自定义预设 name 为用户输入原文
export const builtinFilterPresets: FilterPreset[] = [
  // 自然系
  {
    id: 'natural-1',
    name: 'filter.preset.natural-1',
    category: 'natural',
    params: { contrast: 5, saturation: 5 }
  },
  {
    id: 'natural-2',
    name: 'filter.preset.natural-2',
    category: 'natural',
    params: { brightness: 10, saturation: 15, vibrance: 10 }
  },
  {
    id: 'natural-3',
    name: 'filter.preset.natural-3',
    category: 'natural',
    params: { brightness: 15, contrast: -10, saturation: -5, fade: 15 }
  },
  {
    id: 'natural-4',
    name: 'filter.preset.natural-4',
    category: 'natural',
    params: {
      saturation: 10,
      shadows: 10,
      hsl: { green: { hue: 0, saturation: 10, lightness: 0 } },
      clarity: 10
    }
  },
  {
    id: 'natural-5',
    name: 'filter.preset.natural-5',
    category: 'natural',
    params: { brightness: 20, contrast: -5, highlights: -15, shadows: 15 }
  },
  // 复古系
  {
    id: 'vintage-1',
    name: 'filter.preset.vintage-1',
    category: 'vintage',
    params: { contrast: -10, saturation: -15, fade: 30, temperature: 15 }
  },
  {
    id: 'vintage-2',
    name: 'filter.preset.vintage-2',
    category: 'vintage',
    params: { contrast: -5, saturation: -10, grain: 20, fade: 25 }
  },
  {
    id: 'vintage-3',
    name: 'filter.preset.vintage-3',
    category: 'vintage',
    params: { brightness: -5, saturation: -25, temperature: 25, fade: 35 }
  },
  {
    id: 'vintage-4',
    name: 'filter.preset.vintage-4',
    category: 'vintage',
    params: { saturation: -40, fade: 40, contrast: -15 }
  },
  {
    id: 'vintage-5',
    name: 'filter.preset.vintage-5',
    category: 'vintage',
    params: { contrast: 15, saturation: 15, vignette: 40, fade: 15 }
  },
  // 艺术系
  {
    id: 'artistic-1',
    name: 'filter.preset.artistic-1',
    category: 'artistic',
    params: { saturation: -100, contrast: 10, clarity: 10 }
  },
  {
    id: 'artistic-2',
    name: 'filter.preset.artistic-2',
    category: 'artistic',
    params: { saturation: -80, contrast: 20, temperature: 10 }
  },
  {
    id: 'artistic-3',
    name: 'filter.preset.artistic-3',
    category: 'artistic',
    params: { saturation: -20, temperature: -25, tint: -10, shadows: 15 }
  },
  {
    id: 'artistic-4',
    name: 'filter.preset.artistic-4',
    category: 'artistic',
    params: {
      saturation: 30,
      hsl: {
        green: { hue: 40, saturation: 0, lightness: 0 },
        blue: { hue: 0, saturation: -20, lightness: 0 }
      }
    }
  },
  {
    id: 'artistic-5',
    name: 'filter.preset.artistic-5',
    category: 'artistic',
    params: {
      highlightHue: 40,
      highlightSaturation: 25,
      shadowHue: 220,
      shadowSaturation: 25,
      splitBalance: 10
    }
  },
  // 电影系
  {
    id: 'cinematic-1',
    name: 'filter.preset.cinematic-1',
    category: 'cinematic',
    params: { contrast: -5, saturation: -10, fade: 20, clarity: 10 }
  },
  {
    id: 'cinematic-2',
    name: 'filter.preset.cinematic-2',
    category: 'cinematic',
    params: { contrast: 25, shadows: -20, clarity: 15, vignette: 25 }
  },
  {
    id: 'cinematic-3',
    name: 'filter.preset.cinematic-3',
    category: 'cinematic',
    params: { temperature: 30, saturation: 10, highlights: -10, shadows: 10 }
  },
  {
    id: 'cinematic-4',
    name: 'filter.preset.cinematic-4',
    category: 'cinematic',
    params: { temperature: -25, tint: -10, contrast: 10, fade: 15 }
  },
  {
    id: 'cinematic-5',
    name: 'filter.preset.cinematic-5',
    category: 'cinematic',
    params: {
      highlightHue: 30,
      highlightSaturation: 30,
      shadowHue: 200,
      shadowSaturation: 30,
      splitBalance: -10,
      saturation: 5
    }
  }
]
