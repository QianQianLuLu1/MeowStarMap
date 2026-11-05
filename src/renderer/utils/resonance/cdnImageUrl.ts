/**
 * 共鸣录衣橱六类实体的 CDN 图片地址构造（纯逻辑，零网络请求）。
 *
 * 主机与路径分段集中在本文件，视图侧不得散落硬编码；图片由调用方以 img 热链按需加载，
 * 加载失败的占位回退由调用方处理。
 */

export type CdnImageCategory = 'outfit' | 'item' | 'makeup' | 'momo' | 'prop' | 'eureka'

/** 唯一批准的 CDN 主机（含 https 协议），业务代码不得引入其他主机 */
const CDN_HOST = 'https://cdn.gongeo.us'

const PATH_SEGMENTS: Readonly<Record<CdnImageCategory, string>> = {
  outfit: '/images/outfits',
  item: '/images/items/icons',
  makeup: '/images/items/makeups',
  momo: '/images/momo/icons',
  prop: '/images/props',
  eureka: '/images/eurekas'
}

const ID_LENGTHS: Readonly<Record<CdnImageCategory, number>> = {
  outfit: 5,
  item: 10,
  makeup: 8,
  momo: 10,
  prop: 10,
  eureka: 4
}

function isCdnImageCategory(value: unknown): value is CdnImageCategory {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PATH_SEGMENTS, value)
}

/**
 * 按分类与标识构造 CDN 图片地址。
 * 分类须为六类之一，标识须为「位数与分类匹配」的安全正整数；
 * 任一不满足返回 null（由调用方回退占位），不抛异常、不产生地址。
 */
export function cdnImageUrl(category: unknown, id: unknown): string | null {
  if (!isCdnImageCategory(category)) return null
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null
  if (String(id).length !== ID_LENGTHS[category]) return null
  return `${CDN_HOST}${PATH_SEGMENTS[category]}/${id}.png`
}
