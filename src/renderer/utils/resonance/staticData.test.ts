import { describe, expect, it } from 'vitest'
import {
  BANNER_DATA,
  OUTFIT_ITEMS,
  getBannerById,
  getBannerThumbnailUrl,
  getOutfitItemsById,
  getStaticProcessDeps,
  loadCatalog,
  loadNames,
  loadPercentile,
  loadSnapshotMeta
} from './staticData'

describe('卡池/套装静态数据（静态 import，始终可用）', () => {
  it('卡池快照完整（73 个卡池）', () => {
    expect(Object.keys(BANNER_DATA).length).toBeGreaterThanOrEqual(73)
    expect(BANNER_DATA['1']?.bannerType).toBe(1)
    expect(BANNER_DATA['73']).toBeDefined()
  })
  it('套装映射可查', () => {
    const banner1 = BANNER_DATA['1']!
    const outfitId = banner1.outfit5StarId[0]!
    expect(OUTFIT_ITEMS[outfitId]?.length).toBeGreaterThan(0)
  })
  it('ProcessDeps 绑定可用', () => {
    const deps = getStaticProcessDeps()
    expect(deps.getBanner(1)?.bannerId).toBe(1)
    expect(deps.getOutfitItems('10001')?.length).toBeGreaterThan(0)
  })
  it('getBannerById / getOutfitItemsById 边界', () => {
    expect(getBannerById(99999)).toBeUndefined()
    expect(getOutfitItemsById('99999')).toBeUndefined()
  })
})

describe('图鉴目录懒加载 + 解码', () => {
  it('11 片全部解码成功且非空', async () => {
    const catalog = await loadCatalog()
    expect(catalog).not.toBeNull()
    const items = catalog!.items as Array<{ id: number }>
    expect(items.length).toBeGreaterThan(0)
    const relations = catalog!.outfitItems as Record<string, number[]>
    expect(Object.keys(relations).length).toBeGreaterThan(0)
    expect(catalog!.outfits).not.toBeNull()
  }, 30_000)
})

describe('名称包懒加载 + 语言回退', () => {
  it('zh-CN 名称包有效', async () => {
    const pack = await loadNames('zh-CN')
    expect(Object.keys(pack.item).length).toBeGreaterThan(1000)
    expect(pack.isFallback).toBe(false)
  }, 30_000)
  it('ru/th/vi 为生成期回退英文包', async () => {
    const pack = await loadNames('ru')
    expect(pack.isFallback).toBe(true)
    expect(Object.keys(pack.item).length).toBeGreaterThan(1000)
  }, 30_000)
  it('未知语言回退英文包（不崩溃）', async () => {
    const pack = await loadNames('xx-XX')
    expect(pack.isFallback).toBe(true)
    expect(Object.keys(pack.item).length).toBeGreaterThan(1000)
  }, 30_000)
})

describe('卡池缩略图（本地静态资源）', () => {
  it('已有卡池返回相对资源 URL（非外链），未知卡池返回 null', () => {
    // 缩略图与 banners.json 同源生成：索引覆盖全部卡池
    for (const id of Object.keys(BANNER_DATA)) {
      const url = getBannerThumbnailUrl(Number(id))
      expect(url).not.toBeNull()
      expect(typeof url).toBe('string')
      expect(url!.length).toBeGreaterThan(0)
      // 离线硬约束：不允许任何 http(s) 外链资源
      expect(url!.startsWith('http://')).toBe(false)
      expect(url!.startsWith('https://')).toBe(false)
    }
    expect(getBannerThumbnailUrl(999999)).toBeNull()
  })
})

describe('百分位快照与元数据', () => {
  it('百分位快照结构有效', async () => {
    const data = await loadPercentile()
    expect(data).not.toBeNull()
    expect(data!.metrics.avg_5star_pulls.length).toBeGreaterThan(0)
    expect(data!.generated_at).toBeTruthy()
  })
  it('元数据包含来源与许可', async () => {
    const meta = await loadSnapshotMeta()
    expect(meta).not.toBeNull()
    expect(meta!.source).toBe('gongeo.us-nikki-tracker')
    expect(meta!.sourceLicense).toBe('MIT')
  })
})
