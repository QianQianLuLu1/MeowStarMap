import { describe, expect, it } from 'vitest'
import {
  computeBannerLuckRanking,
  computeBannerLuckRankingType3,
  computeDistribution,
  computeLuckTier,
  computeOverallLuckPercentile,
  computeOverview,
  computePullActivity
} from './personalStats'
import { processBannerPullData, type ProcessDeps } from './process'
import type { PercentileData } from './percentile'
import type { Banner } from './types'

function makeDeps(): ProcessDeps {
  const banners: Record<string, Banner> = {
    '5': {
      bannerId: 5,
      bannerType: 2,
      outfit4StarId: ['10002'],
      outfit5StarId: ['10001'],
      runs: []
    },
    '6': {
      bannerId: 6,
      bannerType: 3,
      outfit4StarId: ['10003'],
      outfit5StarId: [],
      runs: []
    },
    '10': {
      bannerId: 10,
      bannerType: 1,
      outfit4StarId: ['10004'],
      outfit5StarId: ['10005'],
      runs: []
    }
  }
  const outfits: Record<string, string[]> = {
    '10001': ['1020000001'],
    '10002': ['2020000002'],
    '10003': ['2020000003'],
    '10004': ['2020000004'],
    '10005': ['1020000005']
  }
  return {
    getBanner: (id) => banners[String(id)],
    getOutfitItems: (id) => outfits[id]
  }
}

const percentileData: PercentileData = {
  generated_at: '2026-08-01T00:00:00.000Z',
  metrics: {
    avg_5star_pulls: [
      [0, 5],
      [50, 10],
      [100, 20]
    ],
    avg_5star_pulls_banner: [
      [0, 5],
      [50, 10],
      [100, 20]
    ],
    avg_4star_pulls_type2: [
      [0, 5],
      [50, 10],
      [100, 20]
    ],
    avg_4star_pulls_type2_banner: [
      [0, 5],
      [50, 10],
      [100, 20]
    ],
    avg_4star_pulls_type3: [
      [0, 5],
      [50, 10],
      [100, 20]
    ],
    avg_4star_pulls_type3_banner: [
      [0, 5],
      [50, 10],
      [100, 20]
    ],
    total_pulls_per_user: [
      [0, 5],
      [50, 10],
      [100, 20]
    ]
  }
}

describe('personalStats 组合口径', () => {
  const deps = makeDeps()
  const processed = processBannerPullData(
    {
      5: [
        ['2025-01-03 10:00:00', '1020000001'],
        ['2025-01-02 10:00:00', '2020000002']
      ],
      6: [['2025-01-01 10:00:00', '2020000003']]
    },
    [],
    deps
  )

  it('overview：限定池聚合且常驻池排除', () => {
    const banners: Record<string, Banner> = {
      '5': deps.getBanner(5)!,
      '6': deps.getBanner(6)!,
      '10': deps.getBanner(10)!
    }
    const overview = computeOverview({ processedPulls: processed, banners })
    expect(overview.pulls5StarBanners).toBe(2)
    expect(overview.pulls4StarBanners).toBe(1)
    expect(overview.bannersPulled5Star).toBe(1)
    expect(overview.bannersPulled4Star).toBe(1)
    expect(overview.outfitsObtained5Star).toBe(1)
    expect(overview.outfitsObtained4Star).toBe(2) // 池5 的 10002 + 池6(type3) 的 10003
  })

  it('欧非百分位：5★ 均值 1（很欧）→ 高百分位；快照缺失 → null', () => {
    const p = computeOverallLuckPercentile({ processedPulls: processed, percentileData })
    expect(p).not.toBeNull()
    expect(p!).toBeGreaterThan(50)
    expect(
      computeOverallLuckPercentile({ processedPulls: processed, percentileData: null })
    ).toBeNull()
  })

  it('档位：百分位映射 1..6', () => {
    expect(computeLuckTier(0)).toBe(1)
    expect(computeLuckTier(49)).toBe(3)
    expect(computeLuckTier(50)).toBe(4)
    expect(computeLuckTier(99)).toBe(6)
    expect(computeLuckTier(null)).toBeNull()
  })

  it('按卡池欧非排名：type-2 池参与、含百分位', () => {
    const ranking = computeBannerLuckRanking({ processedPulls: processed, percentileData })
    expect(ranking).toHaveLength(1)
    expect(ranking[0]!.bannerId).toBe(5)
    expect(ranking[0]!.percentile).not.toBeNull()
  })

  it('type-3 排名', () => {
    const ranking = computeBannerLuckRankingType3({ processedPulls: processed, percentileData })
    expect(ranking).toHaveLength(1)
    expect(ranking[0]!.bannerId).toBe(6)
  })

  it('分布直方图：只统计 pullIndex>0 且 pullsToObtain>0 的命中记录', () => {
    const dist = computeDistribution(processed, 5)
    expect(dist).toEqual([{ pullsToObtain: 2, count: 1 }])
    // 两笔 4★ 的 pullsToObtain 均为 1 → 合并一桶
    const dist4 = computeDistribution(processed, 4)
    expect(dist4).toEqual([{ pullsToObtain: 1, count: 2 }])
  })

  it('活动曲线：按卡池 id 升序累计', () => {
    const activity = computePullActivity(processed)
    expect(activity.map((p) => p.bannerId)).toEqual([5, 6])
    expect(activity[activity.length - 1]!.cumulative).toBe(3)
  })
})
