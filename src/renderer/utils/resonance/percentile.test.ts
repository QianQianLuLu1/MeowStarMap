import { describe, expect, it } from 'vitest'
import {
  calculatePercentile,
  getAvg5StarPercentile,
  getLuckPercentile,
  getThresholdAtPercentile,
  getTotalPullsPercentile,
  type PercentileData
} from './percentile'

const data: [number, number][] = [
  [0, 10],
  [50, 20],
  [100, 30]
]

const snapshot: PercentileData = {
  generated_at: '2026-08-01T00:00:00.000Z',
  metrics: {
    avg_5star_pulls: data,
    avg_5star_pulls_banner: data,
    avg_4star_pulls_type2: data,
    avg_4star_pulls_type2_banner: data,
    avg_4star_pulls_type3: data,
    avg_4star_pulls_type3_banner: data,
    total_pulls_per_user: data
  }
}

describe('calculatePercentile', () => {
  it('低于最小阈值 → 0', () => {
    expect(calculatePercentile(5, data)).toBe(0)
  })
  it('区间内线性插值', () => {
    expect(calculatePercentile(15, data)).toBe(25)
  })
  it('恰好在分位点', () => {
    expect(calculatePercentile(20, data)).toBe(50)
  })
  it('高于最大阈值 → 100', () => {
    expect(calculatePercentile(40, data)).toBe(100)
  })
})

describe('getThresholdAtPercentile', () => {
  it('反查与插值', () => {
    expect(getThresholdAtPercentile(0, data)).toBe(10)
    expect(getThresholdAtPercentile(25, data)).toBe(15)
    expect(getThresholdAtPercentile(100, data)).toBe(30)
  })
})

describe('getLuckPercentile（均值越低越欧 → 反转）', () => {
  it('均值 15 → 100 - 25 = 75', () => {
    expect(getLuckPercentile(15, data)).toBe(75)
  })
})

describe('便捷封装与降级', () => {
  it('快照为 null 时返回 null（UI 隐藏区块）', () => {
    expect(getAvg5StarPercentile(15, null)).toBeNull()
    expect(getTotalPullsPercentile(100, null)).toBeNull()
  })
  it('快照存在时返回数值', () => {
    expect(getAvg5StarPercentile(15, snapshot)).toBe(75)
    // total_pulls_per_user 不反转
    expect(getTotalPullsPercentile(15, snapshot)).toBe(25)
  })
})
