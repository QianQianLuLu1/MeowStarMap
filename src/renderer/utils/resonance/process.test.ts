import { describe, expect, it } from 'vitest'
import {
  addMissingItems,
  buildEvoLevelMap,
  computeGlobalStats,
  getOutfitIdFromItemId,
  processBannerPullData,
  processPearpalData,
  type ProcessDeps
} from './process'
import type { Banner, PullRecord } from './types'

/**
 * 合成卡池环境。算法约定：物品 id 末 4 位 + 前缀 1 推导套装 id，因此
 * 5★ 套 = 10001（物品 1020000001）、4★ 套 = 10002（物品 2020000002）、
 * type-3 池 4★ 套 = 10003（物品 2020000003）。
 * pulls 数组按最新在前（newest-first）构造。
 */
function makeDeps(): ProcessDeps & { banners: Record<string, Banner> } {
  const banners: Record<string, Banner> = {
    '1': {
      bannerId: 1,
      bannerType: 2,
      outfit4StarId: ['10002'],
      outfit5StarId: ['10001'],
      runs: []
    },
    '2': {
      bannerId: 2,
      bannerType: 3,
      outfit4StarId: ['10003'],
      outfit5StarId: [],
      runs: []
    },
    '3': {
      bannerId: 3,
      bannerType: 2,
      outfit4StarId: ['10002'],
      outfit5StarId: ['10001'],
      runs: []
    }
  }
  const outfits: Record<string, string[]> = {
    '10001': ['1020000001'],
    '10002': ['2020000002'],
    '10003': ['2020000003']
  }
  return {
    banners,
    getBanner: (id) => banners[String(id)],
    getOutfitItems: (id) => outfits[id]
  }
}

describe('getOutfitIdFromItemId', () => {
  it('取末 4 位加前缀 1', () => {
    expect(getOutfitIdFromItemId('1020000001')).toBe('10001')
  })
})

describe('processBannerPullData pity 边界', () => {
  const deps = makeDeps()

  it('零抽：各池统计为 0、垫抽为 0', () => {
    const processed = processBannerPullData({ 1: [] }, undefined, deps)
    const banner = processed['1']
    expect(banner.stats.totalPulls).toBe(0)
    expect(banner.stats.pity5Star).toBe(0)
    expect(banner.stats.pity4Star).toBe(0)
  })

  it('5★ 命中：pullsToObtain 等于当次 5★ 垫抽数并清零（时序 4★→4★→5★）', () => {
    // 时序（旧→新）：ts1=4★, ts2=4★, ts3=5★；数组按最新在前
    const pulls: PullRecord[] = [
      ['2025-01-03 10:00:00', '1020000001'],
      ['2025-01-02 10:00:00', '2020000002'],
      ['2025-01-01 10:00:00', '2020000002']
    ]
    const processed = processBannerPullData({ 1: pulls }, [], deps)
    const banner = processed['1']
    expect(banner.stats.totalPulls).toBe(3)
    const fiveStar = banner.pulls.find((p) => p.quality === 5)
    expect(fiveStar?.pullsToObtain).toBe(3) // 开局三抽出 5★
    expect(banner.stats.avg5StarPulls).toBe(3)
    expect(banner.stats.pity5Star).toBe(0) // 命中后清零
    expect(banner.stats.pity4Star).toBe(1) // 末抽未出 4★，垫抽 1
  })

  it('连续 4★ 每次都按独立垫抽数记录（1、2）', () => {
    // 时序：ts1=4★(pto=1) → ts2=非套装(垫) → ts3=4★(pto=2)
    const pulls: PullRecord[] = [
      ['2025-01-03 10:00:00', '2020000002'],
      ['2025-01-02 10:00:00', '9999900009'],
      ['2025-01-01 10:00:00', '2020000002']
    ]
    const processed = processBannerPullData({ 1: pulls }, [], deps)
    const banner = processed['1']
    const fourStars = banner.pulls.filter((p) => p.quality === 4)
    expect(fourStars.map((p) => p.pullsToObtain).sort((a, b) => a - b)).toEqual([1, 2])
    expect(banner.stats.avg4StarPulls).toBe(1.5)
    expect(banner.stats.pity4Star).toBe(0)
    expect(banner.stats.pity5Star).toBe(3)
  })

  it('跨卡池独立计数：池 1 的 5★ 垫抽不影响池 3', () => {
    // 池 1：时序 5×4★，5★ 垫抽累计 5；池 3：单抽出 5★
    const pulls1: PullRecord[] = [
      ['2025-01-05 10:00:00', '2020000002'],
      ['2025-01-04 10:00:00', '2020000002'],
      ['2025-01-03 10:00:00', '2020000002'],
      ['2025-01-02 10:00:00', '2020000002'],
      ['2025-01-01 10:00:00', '2020000002']
    ]
    const processed = processBannerPullData(
      { 1: pulls1, 3: [['2025-01-01 10:00:00', '1020000001']] },
      [],
      deps
    )
    expect(processed['1']!.stats.pity5Star).toBe(5)
    expect(processed['1']!.stats.pity4Star).toBe(0) // 连续 4★ 命中后清零
    expect(processed['3']!.stats.pity5Star).toBe(0) // 池 3 首抽即出 5★
    expect(processed['3']!.stats.totalPulls).toBe(1)
  })

  it('type-3 池 4★ 计入 4StarOnly 系列', () => {
    // 时序：4★ → 非套装 → 4★，avg4StarOnly = (1+2)/2
    const pulls: PullRecord[] = [
      ['2025-01-03 10:00:00', '2020000003'],
      ['2025-01-02 10:00:00', '9999900009'],
      ['2025-01-01 10:00:00', '2020000003']
    ]
    const processed = processBannerPullData({ 2: pulls }, [], deps)
    const stats = processed['2']!.stats
    expect(stats.total4StarOnlyItems).toBe(2)
    expect(stats.total4StarItems).toBe(0)
    expect(stats.avg4StarOnlyPulls).toBe(1.5)
    expect(stats.avg4StarPulls).toBe(0)
    expect(stats.totalPulls).toBe(3)
  })

  it('edits 手动补录：pullIndex 负数、不参与 pity、参与完成度', () => {
    const processed = processBannerPullData(
      { 1: [['2025-01-01 10:00:00', '2020000002']] },
      { 1: [['2025-01-02 10:00:00', '1020000001']] },
      deps
    )
    const banner = processed['1']
    const editPull = banner.pulls.find((p) => p.itemId === '1020000001')
    expect(editPull?.pullIndex).toBeLessThan(0)
    expect(editPull?.quality).toBe(5)
    const outfit = banner.outfits.find((o) => o.id === '10001')
    expect(outfit?.obtainedItems).toBe(1)
    expect(outfit?.completion).toBe(1)
  })

  it('未知物品（不属于卡池套装）计入总抽数但不计入物品数', () => {
    const processed = processBannerPullData(
      { 1: [['2025-01-01 10:00:00', '9999900009']] },
      undefined,
      deps
    )
    const banner = processed['1']
    expect(banner.stats.totalPulls).toBe(1)
    expect(banner.stats.totalItems).toBe(0)
  })
})

describe('addMissingItems', () => {
  it('为未获得部件追加占位（count=0、obtainedAt=""）', () => {
    const deps = makeDeps()
    const processed = processBannerPullData(
      { 1: [['2025-01-01 10:00:00', '1020000001']] },
      [],
      deps
    )
    addMissingItems(processed['1']!, deps)
    const missing = processed['1']!.pulls.find((p) => p.itemId === '2020000002')
    expect(missing).toBeDefined()
    expect(missing?.count).toBe(0)
    expect(missing?.obtainedAt).toBe('')
  })
})

describe('computeGlobalStats', () => {
  const deps = makeDeps()
  it('type-2/3 分别聚合，物品数计入全局', () => {
    const processed = processBannerPullData(
      {
        1: [['2025-01-01 10:00:00', '1020000001']],
        2: [['2025-01-01 10:00:00', '2020000003']]
      },
      [],
      deps
    )
    const global = computeGlobalStats(processed)
    expect(global.totalPulls).toBe(2)
    expect(global.total5StarItems).toBe(1) // 池1(type2) 出了 5★
    expect(global.total4StarOnlyItems).toBe(1)
    expect(global.avg4StarOnlyPulls).toBe(1)
    expect(global.avg5StarPulls).toBe(1)
  })
})

describe('processPearpalData', () => {
  const deps = makeDeps()
  it('pullsToObtain 取 times_from_last_X + 1，totalPulls 取 max(pool_cnt)+1', () => {
    const processed = processPearpalData(
      {
        1: [
          {
            card_pool_id: '1',
            pool_cnt: 9,
            result: '1020000001',
            times_from_last_five_stars: 7,
            times_from_last_four_stars: 2,
            rarity: '5'
          }
        ]
      },
      deps,
      new Date('2025-06-01T12:00:00Z')
    )
    const banner = processed['1']!
    expect(banner.stats.totalPulls).toBe(10)
    const five = banner.pulls.find((p) => p.itemId === '1020000001')
    expect(five?.pullsToObtain).toBe(8)
    expect(banner.stats.pity5Star).toBe(0) // Pearpal 无法追踪垫抽
  })
  it('未知卡池直接跳过', () => {
    const processed = processPearpalData(
      {
        99: [
          {
            card_pool_id: '99',
            pool_cnt: 1,
            result: '1020000001',
            times_from_last_five_stars: 1,
            times_from_last_four_stars: 1,
            rarity: '5'
          }
        ]
      },
      deps,
      new Date()
    )
    expect(processed['99']).toBeUndefined()
  })
})

describe('buildEvoLevelMap', () => {
  it('按 bannerId→outfitId 构建覆盖表', () => {
    const map = buildEvoLevelMap({ 1: [['10001', 3]] })
    expect(map.get(1)?.get('10001')).toBe(3)
  })
})
