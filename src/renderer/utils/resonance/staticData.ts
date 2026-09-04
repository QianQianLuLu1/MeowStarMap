/**
 * 共鸣录静态数据装载器。
 *
 * - 卡池/套装数据为生成期快照，体积小，静态 import 打进主 bundle；
 * - 图鉴目录（catalog/）与名称包（names/<lang>.json）按需动态 import，
 *   Vite 拆分为独立 chunk（与宿主 i18n locale 懒加载同款范式）；
 * - 百分位快照与元数据单独加载；
 * - 任何文件缺失/损坏都走降级（null / 回退英文 / 空包），绝不抛出到 UI 层。
 */
import bannersJson from '../../data/resonance/banners.json'
import outfitsJson from '../../data/resonance/outfits.json'
import { BANNER_THUMBNAIL_URLS } from '../../data/resonance/thumbnails/index'
import type { CatalogIndexPartKey } from './catalogCompactFormat'
import { decodeCatalogPartPayload } from './catalogCompactFormat'
import type { PercentileData } from './percentile'
import type { Banner, ProcessDeps } from './types'

// ============ 卡池与套装（静态，始终可用） ============

export const BANNER_DATA = bannersJson as unknown as Record<string, Banner>

export const OUTFIT_ITEMS = outfitsJson as unknown as Record<string, string[]>

export function getBannerById(bannerId: number): Banner | undefined {
  return BANNER_DATA[String(bannerId)]
}

export function getOutfitItemsById(outfitId: string): string[] | undefined {
  return OUTFIT_ITEMS[outfitId]
}

/** 绑定静态数据的处理依赖（process.ts 注入用） */
export function getStaticProcessDeps(): ProcessDeps {
  return {
    getBanner: getBannerById,
    getOutfitItems: getOutfitItemsById
  }
}

// ============ 卡池缩略图（本地静态资源，缺失返回 null） ============

// 生成期随包分发的卡池缩略图索引（scripts/copy-resonance-thumbnails.ts 产物）：
// 卡池 id → 打包内本地资源 URL，非外链、断网可用。
const BANNER_THUMBNAILS: ReadonlyMap<number, string> = new Map(
  Object.entries(BANNER_THUMBNAIL_URLS).map(([id, url]) => [Number(id), url])
)

/** 卡池缩略图 URL（打包内本地资源）；无对应资源返回 null，调用方降级为色块占位 */
export function getBannerThumbnailUrl(bannerId: number): string | null {
  return BANNER_THUMBNAILS.get(bannerId) ?? null
}

// ============ 图鉴目录（懒加载，损坏降级为 null） ============

export interface CatalogData {
  items: ReturnType<typeof decodeCatalogPartPayload>
  outfits: unknown
  makeups: unknown
  momo: unknown
  eurekas: unknown
  props: unknown
  outfitItems: Record<string, number[]>
  makeupItems: Record<string, number[]>
  makeupOutfits: Record<string, number[]>
  momoOutfits: Record<string, number[]>
  palettes: unknown
}

const CATALOG_PART_FILES: Record<string, () => Promise<{ default: unknown }>> = {
  items: () => import('../../data/resonance/catalog/items.json'),
  outfits: () => import('../../data/resonance/catalog/outfits.json'),
  makeups: () => import('../../data/resonance/catalog/makeups.json'),
  momo: () => import('../../data/resonance/catalog/momo.json'),
  eurekas: () => import('../../data/resonance/catalog/eurekas.json'),
  props: () => import('../../data/resonance/catalog/props.json'),
  outfitItems: () => import('../../data/resonance/catalog/outfitItems.json'),
  makeupItems: () => import('../../data/resonance/catalog/makeupItems.json'),
  makeupOutfits: () => import('../../data/resonance/catalog/makeupOutfits.json'),
  momoOutfits: () => import('../../data/resonance/catalog/momoOutfits.json'),
  palettes: () => import('../../data/resonance/catalog/palettes.json')
}

const RELATION_PARTS = new Set(['outfitItems', 'makeupItems', 'makeupOutfits', 'momoOutfits'])

let catalogPromise: Promise<CatalogData | null> | null = null

/** 懒加载并解码全部图鉴分片；任何分片缺失/损坏 → null（调用方降级展示） */
export function loadCatalog(): Promise<CatalogData | null> {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      try {
        const result: Partial<CatalogData> = {}
        for (const [part, loader] of Object.entries(CATALOG_PART_FILES)) {
          const mod = await loader()
          const decoded = decodeCatalogPartPayload(part as CatalogIndexPartKey, mod.default)
          if (decoded == null) return null
          if (RELATION_PARTS.has(part)) {
            const rel = decoded as Record<string, number[]>
            if (typeof rel !== 'object' || Array.isArray(rel)) return null
            result[part as keyof CatalogData] = rel as never
          } else if (Array.isArray(decoded)) {
            if (decoded.length === 0) return null
            result[part as keyof CatalogData] = decoded as never
          } else {
            result[part as keyof CatalogData] = decoded as never
          }
        }
        const required: Array<keyof CatalogData> = [
          'items',
          'outfits',
          'makeups',
          'momo',
          'eurekas',
          'props',
          'outfitItems',
          'makeupItems',
          'makeupOutfits',
          'momoOutfits',
          'palettes'
        ]
        for (const key of required) {
          if (result[key] === undefined) return null
        }
        return result as CatalogData
      } catch {
        return null
      }
    })()
  }
  return catalogPromise
}

// ============ 名称包（按语言懒加载，缺译回退英文，再失败回退空包） ============

export interface NamePack {
  banner: Record<string, string>
  outfit: Record<string, string>
  item: Record<string, string>
  makeup: Record<string, string>
  momo: Record<string, string>
  prop: Record<string, string>
  eureka: Record<string, string>
  /** true 表示该语言包为生成期回退英文（ru/th/vi）或运行时回退 */
  isFallback: boolean
}

function createEmptyNamePack(isFallback = false): NamePack {
  return {
    banner: {},
    outfit: {},
    item: {},
    makeup: {},
    momo: {},
    prop: {},
    eureka: {},
    isFallback
  }
}

function toNamePack(raw: unknown, isFallback: boolean): NamePack {
  if (!raw || typeof raw !== 'object') return createEmptyNamePack(isFallback)
  const obj = raw as Record<string, unknown>
  const pick = (key: string): Record<string, string> => {
    const section = obj[key]
    if (!section || typeof section !== 'object' || Array.isArray(section)) return {}
    const out: Record<string, string> = {}
    for (const [id, name] of Object.entries(section as Record<string, unknown>)) {
      if (typeof name === 'string' && name.length > 0) out[id] = name
    }
    return out
  }
  return {
    banner: pick('banner'),
    outfit: pick('outfit'),
    item: pick('item'),
    makeup: pick('makeup'),
    momo: pick('momo'),
    prop: pick('prop'),
    eureka: pick('eureka'),
    isFallback
  }
}

// 与宿主 i18n 语言清单一致；生成脚本保证 12 份全部存在
const NAME_PACK_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  'zh-CN': () => import('../../data/resonance/names/zh-CN.json'),
  'zh-TW': () => import('../../data/resonance/names/zh-TW.json'),
  en: () => import('../../data/resonance/names/en.json'),
  ja: () => import('../../data/resonance/names/ja.json'),
  ko: () => import('../../data/resonance/names/ko.json'),
  fr: () => import('../../data/resonance/names/fr.json'),
  de: () => import('../../data/resonance/names/de.json'),
  es: () => import('../../data/resonance/names/es.json'),
  pt: () => import('../../data/resonance/names/pt.json'),
  ru: () => import('../../data/resonance/names/ru.json'),
  th: () => import('../../data/resonance/names/th.json'),
  vi: () => import('../../data/resonance/names/vi.json')
}

const namePackCache = new Map<string, Promise<NamePack>>()

/** 按语言加载名称包：损坏/缺失 → 回退英文；英文也失败 → 空包（UI 显示 id） */
export function loadNames(lang: string): Promise<NamePack> {
  const cached = namePackCache.get(lang)
  if (cached) return cached

  const promise = (async () => {
    const loader = NAME_PACK_LOADERS[lang]
    if (loader) {
      try {
        const mod = await loader()
        return toNamePack(mod.default, lang === 'ru' || lang === 'th' || lang === 'vi')
      } catch {
        // 落入下方英文回退
      }
    }
    if (lang !== 'en') {
      try {
        const enMod = await NAME_PACK_LOADERS.en()
        return toNamePack(enMod.default, true)
      } catch {
        // 落入空包
      }
    }
    return createEmptyNamePack(true)
  })()

  namePackCache.set(lang, promise)
  return promise
}

// ============ 百分位快照与元数据（缺失/损坏降级 null） ============

let percentilePromise: Promise<PercentileData | null> | null = null

export function loadPercentile(): Promise<PercentileData | null> {
  if (!percentilePromise) {
    percentilePromise = import('../../data/resonance/percentile.json')
      .then((mod) => {
        const data = mod.default as unknown as PercentileData
        if (
          !data ||
          typeof data !== 'object' ||
          !data.metrics ||
          !Array.isArray(data.metrics.avg_5star_pulls)
        ) {
          return null
        }
        return data
      })
      .catch(() => null)
  }
  return percentilePromise
}

export interface SnapshotMeta {
  source: string
  sourceUrl: string
  sourceLicense: string
  generatedAt: string
  gameVersion: string | null
  catalogGeneratedAt: string | null
  percentileGeneratedAt: string | null
  latestBannerId: number
  snapshotNote: string
}

let metaPromise: Promise<SnapshotMeta | null> | null = null

export function loadSnapshotMeta(): Promise<SnapshotMeta | null> {
  if (!metaPromise) {
    metaPromise = import('../../data/resonance/snapshot-meta.json')
      .then((mod) => {
        const meta = mod.default as unknown as SnapshotMeta
        if (!meta || typeof meta !== 'object' || typeof meta.source !== 'string') return null
        return meta
      })
      .catch(() => null)
  }
  return metaPromise
}
