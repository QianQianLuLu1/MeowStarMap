/**
 * 物品/套装变体 id 编码规则（逻辑复用自 gongeo.us-nikki-tracker 的
 * shared/utils/variants.ts，MIT, dastrokes）。
 *
 * 套装：5 位基础 id；7 位变体 id 末 2 位为后缀 01=觉醒 02=进化1 03=进化2 04=进化3。
 * 部件：10 位 id，前 4 位前缀编码变体类型。
 * 注意：5 位基础套装 id "10001" 虽以 "01" 结尾也不得判为觉醒，仅 7 位 id 携带后缀。
 */

export type VariantType = 'base' | 'glowup' | 'evo1' | 'evo2' | 'evo3'

const OUTFIT_SUFFIX_MAP: Record<string, VariantType> = {
  '01': 'glowup',
  '02': 'evo1',
  '03': 'evo2',
  '04': 'evo3'
}

const OUTFIT_VARIANT_TO_ITEM_PREFIX: Record<VariantType, string> = {
  base: '1020',
  glowup: '1022',
  evo1: '1023',
  evo2: '1024',
  evo3: '1025'
}

export function isOutfitVariantId(outfitId: string): boolean {
  return outfitId.length === 7 && outfitId.slice(-2) in OUTFIT_SUFFIX_MAP
}

export function getBaseOutfitId(outfitId: string): string {
  return isOutfitVariantId(outfitId) ? outfitId.slice(0, 5) : outfitId
}

export function getOutfitVariantType(outfitId: string): VariantType {
  if (!isOutfitVariantId(outfitId)) return 'base'
  return OUTFIT_SUFFIX_MAP[outfitId.slice(-2)] ?? 'base'
}

export function getItemPrefixForOutfitId(outfitId: string): string {
  return OUTFIT_VARIANT_TO_ITEM_PREFIX[getOutfitVariantType(outfitId)]
}

const ITEM_PREFIX_MAP: Record<string, VariantType> = {
  '1022': 'glowup',
  '1023': 'evo1',
  '1024': 'evo2',
  '1025': 'evo3',
  '1026': 'glowup',
  '1027': 'glowup',
  '1028': 'glowup'
}

function getItemPrefix(itemId: string): string | null {
  return itemId.length === 10 ? itemId.substring(0, 4) : null
}

export function isItemVariantId(itemId: string | number, familyRootId?: string | number): boolean {
  if (String(itemId) === String(familyRootId)) return false
  const prefix = getItemPrefix(String(itemId))
  return prefix !== null && prefix in ITEM_PREFIX_MAP
}

export function getItemVariantType(
  itemId: string | number,
  familyRootId?: string | number
): VariantType {
  if (String(itemId) === String(familyRootId)) return 'base'
  const prefix = getItemPrefix(String(itemId))
  if (!prefix) return 'base'
  return ITEM_PREFIX_MAP[prefix] ?? 'base'
}

export function getItemBody(itemId: string | number): string {
  const s = String(itemId)
  return s.length === 10 ? s.substring(4) : s
}
