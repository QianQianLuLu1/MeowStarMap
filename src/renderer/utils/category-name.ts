/**
 * 系统分类名格式化
 *
 * 系统分类在 DB 中存稳定 key（people/location/scene/…），由本函数经
 * categories.system.* 命名空间翻译展示；用户自建或被用户改名的分类
 * （DB 中不是已知 key）原样显示。
 */
import i18n from '../i18n'

const SYSTEM_CATEGORY_KEYS = new Set([
  'people',
  'location',
  'scene',
  'screenshot',
  'recording',
  'recent',
  'favorite'
])

export function formatCategoryName(cat: { name: string; is_system?: number | boolean }): string {
  if (cat.is_system && SYSTEM_CATEGORY_KEYS.has(cat.name)) {
    return i18n.t(`categories.system.${cat.name}`)
  }
  return cat.name
}
