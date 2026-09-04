/**
 * 共鸣录静态图鉴「压缩元组」目录格式的解码器。
 *
 * 逻辑复用自开源项目 gongeo.us-nikki-tracker（dastrokes，MIT License）
 * 的 app/utils/catalogCompactFormat.ts（纯函数，无框架依赖），仅做类型内联与
 * 注释调整。源格式：{ v: 1, t?: string[], s?: string[], r: rows } 或裸 rows。
 */

export type CatalogIndexPartKey =
  | 'items'
  | 'outfits'
  | 'makeups'
  | 'momo'
  | 'eurekas'
  | 'props'
  | 'outfitItems'
  | 'makeupItems'
  | 'makeupOutfits'
  | 'momoOutfits'

export type EurekaPosition = 'head' | 'hands' | 'feet'
export type EurekaStyle = 'elegant' | 'fresh' | 'sweet' | 'sexy' | 'cool'

export interface EurekaColor {
  id: number
  order: number
  colorType: number
}

export interface EurekaCatalogEntry {
  id: number
  suitId: number
  position: EurekaPosition
  quality: 3 | 4 | 5
  styles: Record<EurekaStyle, number>
  mainStyle: EurekaStyle
  tagIds: number[]
  provinceId: number
  colors: EurekaColor[]
}

export type PropSource = 'event' | 'home' | 'resonance' | 'starlit' | 'store'

export interface PropCatalogEntry {
  id: number
  quality: number
  variantRootId?: number
  sources?: PropSource[]
  version?: string
  bannerIds?: number[]
}

export interface CatalogItemEntry {
  id: number
  quality: number
  type: string
  style: string | null
  labels: string[]
  obtain_type?: number
  catalogGroupIds?: number[]
  catalogGroupRootId?: number
}

export interface CatalogOutfitEntry {
  id: number
  quality: number
  style: string | null
  labels: string[]
  obtain_type?: number
  catalogGroupIds?: number[]
  catalogGroupRootId?: number
}

export interface CatalogMakeupEntry {
  id: number
  quality: number
  type: string
  style: string | null
  obtain_type?: number
  catalogGroupIds?: number[]
  catalogGroupRootId?: number
}

export interface CatalogMomoEntry {
  id: number
  quality: number
  obtain_type?: number
  version?: string
  catalogGroupIds?: number[]
  catalogGroupRootId?: number
}

export type CatalogRelationMap = Record<string, number[]>

type CompactCatalogPayload = {
  v?: number
  t?: string[]
  s?: string[]
  r?: unknown[][]
}

const CATALOG_ITEM_TYPES = [
  'hair',
  'outerwear',
  'shoes',
  'hairAccessories',
  'headwear',
  'earrings',
  'neckwear',
  'chokers',
  'dresses',
  'chestAccessories',
  'handhelds',
  'socks',
  'gloves',
  'faceDecorations',
  'backpieces',
  'tops',
  'bracelets',
  'armDecorations',
  'pendants',
  'bottoms',
  'bodyPaint',
  'rings'
] as const
const CATALOG_MAKEUP_TYPES = [
  'fullMakeup',
  'baseMakeup',
  'eyebrows',
  'eyelashes',
  'contactLenses',
  'lips'
] as const
const CATALOG_STYLES = ['sweet', 'sexy', 'fresh', 'cool', 'elegant'] as const
const EUREKA_POSITIONS = ['head', 'hands', 'feet'] as const
const EUREKA_STYLE_VALUE_KEYS = ['elegant', 'fresh', 'sweet', 'sexy', 'cool'] as const

const isCompactCatalogPayload = (value: unknown): value is CompactCatalogPayload =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (value as CompactCatalogPayload).v === 1 &&
  Array.isArray((value as CompactCatalogPayload).r)

const isCompactRowPayload = (value: unknown): value is unknown[][] =>
  Array.isArray(value) && (value.length === 0 || Array.isArray(value[0]))

const unpackCompactIds = (ids: unknown): number[] => {
  if (Array.isArray(ids)) {
    return ids.filter((id): id is number => typeof id === 'number')
  }

  return typeof ids === 'number' ? [ids] : []
}

const expandCompactStyle = (styles: readonly string[] | undefined, index: unknown) => {
  if (index === null || index === undefined) return null
  if (typeof index !== 'number') return null

  const style = styles?.[index]
  return style ? `style.${style}` : null
}

const expandCompactLabels = (labels: unknown) =>
  Array.isArray(labels)
    ? labels.map((label) => (typeof label === 'number' ? `label.${label}.name` : String(label)))
    : []

const getCompactDictionaryValue = (dictionary: readonly string[] | undefined, index: unknown) =>
  typeof index === 'number' ? dictionary?.[index] : undefined

const normalizeCompactFamilyRoot = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined

const hasCompactValue = (value: unknown) => value !== undefined && value !== null

const decodeCompactItemRows = (
  rows: unknown[][],
  types: readonly string[] = CATALOG_ITEM_TYPES,
  styles: readonly string[] = CATALOG_STYLES
): CatalogItemEntry[] =>
  rows.flatMap(([ids, quality, typeIndex, styleIndex, labels, obtain, familyRootId]) => {
    const itemIds = unpackCompactIds(ids)
    const catalogGroupRootId = normalizeCompactFamilyRoot(familyRootId)

    return itemIds.map((id) => ({
      id,
      quality: Number(quality),
      type: getCompactDictionaryValue(types, typeIndex) ?? '',
      style: expandCompactStyle(styles, styleIndex),
      labels: expandCompactLabels(labels),
      ...(hasCompactValue(obtain) ? { obtain_type: Number(obtain) } : {}),
      ...(itemIds.length > 1 ? { catalogGroupIds: itemIds } : {}),
      ...(catalogGroupRootId === undefined ? {} : { catalogGroupRootId })
    }))
  })

const decodeCompactOutfitRows = (
  rows: unknown[][],
  styles: readonly string[] = CATALOG_STYLES
): CatalogOutfitEntry[] =>
  rows.flatMap(([ids, quality, styleIndex, labels, obtain, familyRootId]) => {
    const outfitIds = unpackCompactIds(ids)
    const catalogGroupRootId = normalizeCompactFamilyRoot(familyRootId)

    return outfitIds.map((id) => ({
      id,
      quality: Number(quality),
      style: expandCompactStyle(styles, styleIndex),
      labels: expandCompactLabels(labels),
      ...(hasCompactValue(obtain) ? { obtain_type: Number(obtain) } : {}),
      ...(outfitIds.length > 1 ? { catalogGroupIds: outfitIds } : {}),
      ...(catalogGroupRootId === undefined ? {} : { catalogGroupRootId })
    }))
  })

const decodeCompactMakeupRows = (
  rows: unknown[][],
  types: readonly string[] = CATALOG_MAKEUP_TYPES,
  styles: readonly string[] = CATALOG_STYLES
): CatalogMakeupEntry[] =>
  rows.flatMap(([ids, quality, typeIndex, styleIndex, obtain, familyRootId]) => {
    const makeupIds = unpackCompactIds(ids)
    const catalogGroupRootId = normalizeCompactFamilyRoot(familyRootId)

    return makeupIds.map((id) => ({
      id,
      quality: Number(quality),
      type: getCompactDictionaryValue(types, typeIndex) ?? '',
      style: expandCompactStyle(styles, styleIndex),
      ...(hasCompactValue(obtain) ? { obtain_type: Number(obtain) } : {}),
      ...(makeupIds.length > 1 ? { catalogGroupIds: makeupIds } : {}),
      ...(catalogGroupRootId === undefined ? {} : { catalogGroupRootId })
    }))
  })

const decodeCompactMomoRows = (rows: unknown[][]): CatalogMomoEntry[] =>
  rows.flatMap(([ids, quality, obtain, version, familyRootId]) => {
    const momoIds = unpackCompactIds(ids)
    const catalogGroupRootId = normalizeCompactFamilyRoot(familyRootId)

    return momoIds.map((id) => ({
      id,
      quality: Number(quality),
      ...(hasCompactValue(obtain) ? { obtain_type: Number(obtain) } : {}),
      ...(hasCompactValue(version) ? { version: String(version) } : {}),
      ...(momoIds.length > 1 ? { catalogGroupIds: momoIds } : {}),
      ...(catalogGroupRootId === undefined ? {} : { catalogGroupRootId })
    }))
  })

const decodeCompactEurekaRows = (
  rows: unknown[][],
  styles: readonly string[] = CATALOG_STYLES
): EurekaCatalogEntry[] =>
  rows.map(
    ([
      id,
      suitId,
      positionIndex,
      quality,
      styleValues,
      mainStyleIndex,
      tagIds,
      provinceId,
      colors
    ]) => ({
      id: Number(id),
      suitId: Number(suitId),
      position: getCompactDictionaryValue(EUREKA_POSITIONS, positionIndex) as EurekaPosition,
      quality: Number(quality) as EurekaCatalogEntry['quality'],
      styles: Object.fromEntries(
        EUREKA_STYLE_VALUE_KEYS.map((key, index) => [
          key,
          Number(Array.isArray(styleValues) ? styleValues[index] : 0)
        ])
      ) as Record<EurekaStyle, number>,
      mainStyle: getCompactDictionaryValue(styles, mainStyleIndex) as EurekaStyle,
      tagIds: Array.isArray(tagIds)
        ? tagIds.filter((tagId): tagId is number => typeof tagId === 'number')
        : [],
      provinceId: Number(provinceId),
      colors: Array.isArray(colors)
        ? colors.flatMap((color, index) =>
            Array.isArray(color) && typeof color[0] === 'number'
              ? [
                  {
                    id: color[0],
                    order: index + 1,
                    colorType: Number(color[1])
                  }
                ]
              : []
          )
        : []
    })
  )

const decodeCompactPropRows = (rows: unknown[][]): PropCatalogEntry[] =>
  rows.map(([id, quality, variantRootId, sources, version, bannerIds]) => ({
    id: Number(id),
    quality: Number(quality),
    ...(hasCompactValue(variantRootId) ? { variantRootId: Number(variantRootId) } : {}),
    ...(Array.isArray(sources)
      ? {
          sources: sources.filter(
            (source): source is PropSource =>
              source === 'event' ||
              source === 'home' ||
              source === 'resonance' ||
              source === 'starlit' ||
              source === 'store'
          )
        }
      : {}),
    ...(hasCompactValue(version) ? { version: String(version) } : {}),
    ...(Array.isArray(bannerIds)
      ? {
          bannerIds: bannerIds.filter(
            (bannerId): bannerId is number => typeof bannerId === 'number'
          )
        }
      : {})
  }))

const decodeCompactRelationRows = (rows: unknown[][]): CatalogRelationMap =>
  Object.fromEntries(
    rows.map(([outfitId, itemIds]) => [
      String(outfitId),
      Array.isArray(itemIds)
        ? itemIds.filter((itemId): itemId is number => typeof itemId === 'number')
        : []
    ])
  )

export const decodeCatalogPartPayload = (
  part: CatalogIndexPartKey,
  payload: unknown
):
  | CatalogItemEntry[]
  | CatalogOutfitEntry[]
  | CatalogMakeupEntry[]
  | CatalogMomoEntry[]
  | EurekaCatalogEntry[]
  | PropCatalogEntry[]
  | CatalogRelationMap
  | unknown => {
  if (
    part === 'outfitItems' ||
    part === 'makeupItems' ||
    part === 'makeupOutfits' ||
    part === 'momoOutfits'
  ) {
    return isCompactCatalogPayload(payload)
      ? decodeCompactRelationRows(payload.r!)
      : isCompactRowPayload(payload)
        ? decodeCompactRelationRows(payload)
        : payload
  }

  if (Array.isArray(payload) && !isCompactRowPayload(payload)) return payload

  switch (part) {
    case 'items':
      return isCompactCatalogPayload(payload)
        ? decodeCompactItemRows(payload.r!, payload.t, payload.s)
        : isCompactRowPayload(payload)
          ? decodeCompactItemRows(payload)
          : payload
    case 'outfits':
      return isCompactCatalogPayload(payload)
        ? decodeCompactOutfitRows(payload.r!, payload.s)
        : isCompactRowPayload(payload)
          ? decodeCompactOutfitRows(payload)
          : payload
    case 'makeups':
      return isCompactCatalogPayload(payload)
        ? decodeCompactMakeupRows(payload.r!, payload.t, payload.s)
        : isCompactRowPayload(payload)
          ? decodeCompactMakeupRows(payload)
          : payload
    case 'momo':
      return isCompactCatalogPayload(payload)
        ? decodeCompactMomoRows(payload.r!)
        : isCompactRowPayload(payload)
          ? decodeCompactMomoRows(payload)
          : payload
    case 'eurekas':
      return isCompactCatalogPayload(payload)
        ? decodeCompactEurekaRows(payload.r!, payload.s)
        : isCompactRowPayload(payload)
          ? decodeCompactEurekaRows(payload)
          : payload
    case 'props':
      return isCompactCatalogPayload(payload)
        ? decodeCompactPropRows(payload.r!)
        : isCompactRowPayload(payload)
          ? decodeCompactPropRows(payload)
          : payload
    default:
      return payload
  }
}
