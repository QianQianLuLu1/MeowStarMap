import { describe, expect, it } from 'vitest'
import {
  createEmptyWardrobeData,
  createWardrobeSummary,
  getBannerOutfitVariantLevels,
  getPearpalCompletedOutfitItemIds,
  getWardrobeSetProgress,
  inferWardrobeIdsFromTracker,
  normalizeWardrobeData,
  normalizeWardrobeItemIds,
  type WardrobeSummaryCatalogIndex,
  type WardrobeTrackerCatalogIndex
} from './wardrobe'
import {
  getBaseOutfitId,
  getItemVariantType,
  getOutfitVariantType,
  isOutfitVariantId
} from './variants'
import { processBannerPullData, type ProcessDeps } from './process'
import type { Banner } from './types'

describe('variants 变体 id 编码', () => {
  it('5 位基础 id 不判为变体', () => {
    expect(isOutfitVariantId('10001')).toBe(false)
    expect(getOutfitVariantType('10001')).toBe('base')
  })
  it('7 位变体 id 识别后缀', () => {
    expect(getOutfitVariantType('1000101')).toBe('glowup')
    expect(getOutfitVariantType('1000104')).toBe('evo3')
    expect(getBaseOutfitId('1000103')).toBe('10001')
  })
  it('部件前缀识别变体类型', () => {
    expect(getItemVariantType('1020100001')).toBe('base')
    expect(getItemVariantType('1023100001')).toBe('evo1')
    expect(getItemVariantType('1022100001', 1020100001)).toBe('glowup')
  })
})

describe('normalizeWardrobeData', () => {
  it('去重、排序、剔除非法项', () => {
    const data = normalizeWardrobeData({
      ownedItemIds: [3, 1, 2, 1, -5, '4', 0],
      ownedMakeupIds: ['x'],
      updatedAt: '2025-01-01'
    })
    expect(data.ownedItemIds).toEqual([1, 2, 3, 4])
    expect(data.ownedMakeupIds).toEqual([])
    expect(data.version).toBe(1)
  })
  it('空集与非法输入回退空数据', () => {
    expect(normalizeWardrobeData(null)).toEqual(createEmptyWardrobeData())
    expect(normalizeWardrobeData([])).toEqual(createEmptyWardrobeData())
  })
  it('normalizeWardrobeItemIds：全满/部分/零件', () => {
    expect(normalizeWardrobeItemIds([])).toEqual([])
  })
})

describe('getWardrobeSetProgress', () => {
  const owned = new Set([1, 2])
  it('全满', () => {
    expect(getWardrobeSetProgress([1, 2], owned)).toEqual({
      status: 'owned',
      owned: 2,
      total: 2
    })
  })
  it('部分', () => {
    expect(getWardrobeSetProgress([1, 2, 3], owned)).toEqual({
      status: 'partial',
      owned: 2,
      total: 3
    })
  })
  it('零件（未拥有）', () => {
    expect(getWardrobeSetProgress([3, 4], owned)).toEqual({
      status: 'missing',
      owned: 0,
      total: 2
    })
  })
})

describe('getBannerOutfitVariantLevels 进化等级', () => {
  it('5★：拿满即 base+glowup，抽数与完成度解锁 evo', () => {
    expect(
      getBannerOutfitVariantLevels({
        quality: 5,
        totalPulls: 0,
        outfitCompletion: 1,
        manualEvoLevel: 0
      })
    ).toEqual(['base', 'glowup'])
    expect(
      getBannerOutfitVariantLevels({
        quality: 5,
        totalPulls: 180,
        outfitCompletion: 1,
        manualEvoLevel: 0
      })
    ).toEqual(['base', 'glowup', 'evo1'])
    expect(
      getBannerOutfitVariantLevels({
        quality: 5,
        totalPulls: 230,
        outfitCompletion: 2,
        manualEvoLevel: 0
      })
    ).toEqual(['base', 'glowup', 'evo1', 'evo2', 'evo3'])
  })
  it('4★：完成度 ≥2 解锁 evo1', () => {
    expect(
      getBannerOutfitVariantLevels({
        quality: 4,
        totalPulls: 999,
        outfitCompletion: 2,
        manualEvoLevel: 0
      })
    ).toEqual(['base', 'glowup', 'evo1'])
    expect(
      getBannerOutfitVariantLevels({
        quality: 4,
        totalPulls: 999,
        outfitCompletion: 1,
        manualEvoLevel: 0
      })
    ).toEqual(['base', 'glowup'])
  })
  it('手动 evo 覆盖', () => {
    expect(
      getBannerOutfitVariantLevels({
        quality: 5,
        totalPulls: 0,
        outfitCompletion: 1,
        manualEvoLevel: 4
      })
    ).toEqual(['base', 'glowup', 'evo1', 'evo2', 'evo3'])
  })
})

describe('inferWardrobeIdsFromTracker 从共鸣记录推断', () => {
  const deps = makeDeps()

  function makeDeps(): ProcessDeps {
    const banners: Record<string, Banner> = {
      '5': {
        bannerId: 5,
        bannerType: 2,
        outfit4StarId: ['10002'],
        outfit5StarId: ['10001'],
        runs: []
      }
    }
    const outfits: Record<string, string[]> = {
      '10001': ['1020000001', '1020100001'],
      '10002': ['2020000002'],
      // 觉醒/进化套装（7 位 id）的部件
      '1000101': ['1022100001'],
      '1000102': ['1023100001']
    }
    return {
      getBanner: (id) => banners[String(id)],
      getOutfitItems: (id) => outfits[id]
    }
  }

  const catalogIndex: WardrobeTrackerCatalogIndex = {
    itemById: new Map([
      [1020000001, true],
      [1020100001, true],
      [2020000002, true],
      [1022100001, true],
      [1023100001, true]
    ]),
    outfitItemsById: new Map([
      [10001, [1020000001, 1020100001]],
      [1000101, [1022100001]],
      [1000102, [1023100001]],
      [10002, [2020000002]]
    ]),
    makeupById: new Map([
      [10001001, true],
      [10001002, true]
    ]),
    makeupItemsById: new Map([[10001001, [10001002]]]),
    momoById: new Map([[1160100001, true]]),
    fullMakeupIdsByOutfitId: new Map([[10001, [10001001]]]),
    momoIdsByOutfitId: new Map([[10001, [1160100001]]])
  }

  it('获得部件入衣橱；拿满 5★ 且抽数达标时推断觉醒/进化/妆容/momo', () => {
    const processed = processBannerPullData(
      {
        5: [
          ['2025-01-02 10:00:00', '2020000002'],
          ['2025-01-01 10:00:00', '1020000001'],
          ['2025-01-01 09:00:00', '1020100001']
        ]
      },
      [],
      deps
    )
    // 拿满（completion=1）且 totalPulls=2 → base+glowup
    const result = inferWardrobeIdsFromTracker({
      processedBanners: processed,
      catalogIndex,
      bannerData: { '5': deps.getBanner(5)! }
    })
    expect(result.itemIds).toEqual(expect.arrayContaining([1020000001, 1020100001, 2020000002]))
    expect(result.found.items).toBeGreaterThanOrEqual(3)
  })

  it('抽数 ≥180/≥100/≥140 分别解锁进化1/妆容/momo', () => {
    const processed = processBannerPullData(
      // 拿满 5★ 套（completion=1）且 totalPulls=180
      { 5: buildPulls(180, '2020000002', ['1020000001', '1020100001']) },
      [],
      deps
    )
    const result = inferWardrobeIdsFromTracker({
      processedBanners: processed,
      catalogIndex,
      bannerData: { '5': deps.getBanner(5)! }
    })
    expect(result.itemIds).toContain(1023100001) // evo1 部件（totalPulls≥180）
    expect(result.makeupIds).toContain(10001001) // ≥100 推断妆容
    expect(result.makeupIds).toContain(10001002)
    expect(result.momoIds).toContain(1160100001) // ≥140 推断 momo
  })
})

function buildPulls(
  count: number,
  fourStarItem: string,
  fiveStarItems: string[]
): [string, string][] {
  const pulls: [string, string][] = []
  for (let i = 0; i < count - fiveStarItems.length; i++) {
    pulls.push([padTime(i), fourStarItem])
  }
  // 最新在前：5★ 放数组头部
  for (const item of fiveStarItems) {
    pulls.unshift([padTime(count), item])
  }
  return pulls
}
function padTime(i: number): string {
  const day = String(28 - (i % 28)).padStart(2, '0')
  const hour = String(i % 24).padStart(2, '0')
  const minute = String(i % 60).padStart(2, '0')
  return `2025-01-${day} ${hour}:${minute}:00`
}

describe('getPearpalCompletedOutfitItemIds（共鸣笔记 suit_list → 衣柜部件）', () => {
  const index = {
    itemById: new Map<number, unknown>([
      [1020000001, { id: 1020000001 }],
      [1020100001, { id: 1020100001 }],
      [2020000002, { id: 2020000002 }]
    ]),
    outfitItemsById: new Map<number, readonly number[]>([
      [10001, [1020000001, 1020100001]],
      [10002, [2020000002, 9999999999]],
      [10003, []]
    ])
  }

  it('正常：命中套装时展开其部件，并剔除目录中不存在的部件', () => {
    expect(getPearpalCompletedOutfitItemIds([10001], index)).toEqual([1020000001, 1020100001])
    expect(getPearpalCompletedOutfitItemIds(['10002'], index)).toEqual([2020000002])
  })

  it('跨套装部件去重（同一部件只出现一次）', () => {
    const shared = {
      itemById: new Map<number, unknown>([
        [1, {}],
        [2, {}]
      ]),
      outfitItemsById: new Map<number, readonly number[]>([
        [100, [1, 2]],
        [200, [2, 1]]
      ])
    }
    const ids = getPearpalCompletedOutfitItemIds([100, 200], shared)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('异常与边界：未知 suit、非安全整数、非数字、空数组一律跳过', () => {
    expect(getPearpalCompletedOutfitItemIds([], index)).toEqual([])
    expect(getPearpalCompletedOutfitItemIds([999999], index)).toEqual([])
    expect(getPearpalCompletedOutfitItemIds([1.5, 'abc', null], index)).toEqual([])
    // 已知套装但无部件映射 → 空
    expect(getPearpalCompletedOutfitItemIds([10003], index)).toEqual([])
  })
})

describe('createWardrobeSummary 汇总', () => {
  const index: WardrobeSummaryCatalogIndex = {
    items: [
      { id: 1020000001, quality: 5, type: 'dresses' },
      { id: 1020100001, quality: 5, type: 'hair' },
      { id: 2020000002, quality: 4, type: 'shoes' },
      { id: 1022100001, quality: 5, type: 'dresses' } // 觉醒变体，base scope 下应排除
    ],
    outfits: [{ id: 10001 }, { id: 1000101 }, { id: 10002 }],
    makeups: [
      // 部件 10001002 为 7 位 id（非 10 位部件前缀），基底口径下判 base
      { id: 10001001, type: 'fullMakeup', variantType: 'base' },
      { id: 10001002, type: 'lips', variantType: 'base' }
    ],
    momo: [{ id: 1160100001 }],
    outfitItemsById: new Map([
      [10001, [1020000001, 1020100001]],
      [1000101, [1022100001]],
      [10002, [2020000002]]
    ]),
    makeupItemsById: new Map([[10001001, [10001002]]])
  }

  it('base scope：变体排除、套装进度与近完成统计正确', () => {
    const summary = createWardrobeSummary({
      index,
      ownedItemIds: [1020000001]
    })
    expect(summary.items.total).toBe(3)
    expect(summary.items.owned).toBe(1)
    expect(summary.outfits.total).toBe(2)
    expect(summary.outfits.partial).toBe(1)
    expect(summary.makeups.total).toBe(1)
    expect(summary.fullMakeups.total).toBe(1)
    expect(summary.nearCompleteOutfits[0]?.id).toBe(10001)
  })

  it('all scope：包含变体', () => {
    const summary = createWardrobeSummary({
      index,
      ownedItemIds: [],
      scope: 'all'
    })
    expect(summary.items.total).toBe(4)
    expect(summary.outfits.total).toBe(3)
  })

  it('全满套装计入 owned', () => {
    const summary = createWardrobeSummary({
      index,
      ownedItemIds: [1020000001, 1020100001, 2020000002]
    })
    expect(summary.outfits.owned).toBe(2)
    expect(summary.outfits.partial).toBe(0)
    expect(summary.items.owned).toBe(3)
  })

  it('非基底整妆不再计入汇总（上游 65bb3d8f 起按 variantType 判定）', () => {
    // 真实目录取证：2.10.1 的 95 个整妆中，旧尾缀启发式与部件口径唯一分歧样本是 10239002
    // —— 尾缀 02 使旧规则判为基底并计入，但其部件前缀 1025 为进化3，新规则判为非基底。
    const evoIndex: WardrobeSummaryCatalogIndex = {
      items: [],
      outfits: [],
      makeups: [
        { id: 10239002, type: 'fullMakeup', variantType: 'evo3' },
        // 整妆的部件需以「基底妆容」身份存在于目录中，才会计入其拥有度统计
        { id: 10001002, type: 'lips', variantType: 'base' }
      ],
      momo: [],
      outfitItemsById: new Map(),
      makeupItemsById: new Map([[10239002, [10001002]]])
    }
    const summary = createWardrobeSummary({
      index: evoIndex,
      ownedItemIds: [],
      ownedMakeupIds: [10001002]
    })
    expect(summary.fullMakeups.total).toBe(0)
    expect(summary.fullMakeups.owned).toBe(0)
  })

  it('尾缀形似变体但部件为基底的整妆仍须计入（证明不是单纯少算）', () => {
    const baseIndex: WardrobeSummaryCatalogIndex = {
      items: [],
      outfits: [],
      makeups: [
        { id: 90000003, type: 'fullMakeup', variantType: 'base' },
        { id: 10001002, type: 'lips', variantType: 'base' }
      ],
      momo: [],
      outfitItemsById: new Map(),
      makeupItemsById: new Map([[90000003, [10001002]]])
    }
    const summary = createWardrobeSummary({
      index: baseIndex,
      ownedItemIds: [],
      ownedMakeupIds: [10001002]
    })
    expect(summary.fullMakeups.total).toBe(1)
    expect(summary.fullMakeups.owned).toBe(1)
  })

  it('all scope 下整妆不做基底过滤', () => {
    const mixedIndex: WardrobeSummaryCatalogIndex = {
      items: [],
      outfits: [],
      makeups: [
        { id: 10239002, type: 'fullMakeup', variantType: 'evo3' },
        { id: 10347001, type: 'fullMakeup', variantType: 'base' }
      ],
      momo: [],
      outfitItemsById: new Map(),
      makeupItemsById: new Map()
    }
    expect(
      createWardrobeSummary({ index: mixedIndex, ownedItemIds: [], scope: 'all' }).fullMakeups.total
    ).toBe(2)
    expect(createWardrobeSummary({ index: mixedIndex, ownedItemIds: [] }).fullMakeups.total).toBe(1)
  })
})
