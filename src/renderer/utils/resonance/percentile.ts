/**
 * 百分位计算（逻辑复用自 gongeo.us-nikki-tracker 的 app/utils/percentile.ts，
 * MIT, dastrokes）。
 *
 * 与源实现的差异：百分位快照数据由调用方注入（随包静态快照），不再模块级
 * import JSON，便于降级与测试。快照为静态分发、不会自动更新。
 */

export type PercentilePoint = [number, number] // [百分位, 阈值]

export interface PercentileData {
  generated_at: string
  metrics: {
    avg_5star_pulls: PercentilePoint[]
    avg_5star_pulls_banner: PercentilePoint[]
    avg_4star_pulls_type2: PercentilePoint[]
    avg_4star_pulls_type2_banner: PercentilePoint[]
    avg_4star_pulls_type3: PercentilePoint[]
    avg_4star_pulls_type3_banner: PercentilePoint[]
    total_pulls_per_user: PercentilePoint[]
  }
}

/** 线性插值求 value 处于分布的哪个百分位（data 按 percentile 升序） */
export const calculatePercentile = (value: number, data: PercentilePoint[]): number => {
  for (let i = 0; i < data.length; i++) {
    const dataPoint = data[i]
    if (!dataPoint) continue
    const [percentile, threshold] = dataPoint

    if (value <= threshold) {
      if (i === 0) return 0

      const prevDataPoint = data[i - 1]
      if (!prevDataPoint) continue
      const [prevPercentile, prevThreshold] = prevDataPoint
      if (threshold <= prevThreshold) {
        return (prevPercentile + percentile) / 2
      }
      const ratio = (value - prevThreshold) / (threshold - prevThreshold)
      return prevPercentile + ratio * (percentile - prevPercentile)
    }
  }

  return 100
}

export const getThresholdAtPercentile = (percentile: number, data: PercentilePoint[]): number => {
  const clampedPercentile = Math.min(100, Math.max(0, percentile))
  const firstDataPoint = data[0]
  if (!firstDataPoint) return 0

  if (clampedPercentile <= firstDataPoint[0]) return firstDataPoint[1]

  for (let i = 1; i < data.length; i++) {
    const dataPoint = data[i]
    const prevDataPoint = data[i - 1]
    if (!dataPoint || !prevDataPoint) continue

    const [currentPercentile, currentThreshold] = dataPoint
    const [previousPercentile, previousThreshold] = prevDataPoint

    if (clampedPercentile <= currentPercentile) {
      const range = currentPercentile - previousPercentile
      if (range <= 0) return currentThreshold

      const ratio = (clampedPercentile - previousPercentile) / range
      return previousThreshold + ratio * (currentThreshold - previousThreshold)
    }
  }

  return data[data.length - 1]?.[1] ?? firstDataPoint[1]
}

/** 平均出货越低越欧，取反得到「欧度」百分位 */
export const getLuckPercentile = (avg: number, data: PercentilePoint[]): number =>
  100 - calculatePercentile(avg, data)

// ---- 便捷封装（data 可为 null：快照缺失/损坏时降级为 null，由 UI 隐藏区块） ----

export const getAvg5StarPercentile = (avg: number, data: PercentileData | null): number | null =>
  data ? getLuckPercentile(avg, data.metrics.avg_5star_pulls) : null

export const getBannerAvg5StarPercentile = (
  avg: number,
  data: PercentileData | null
): number | null => (data ? getLuckPercentile(avg, data.metrics.avg_5star_pulls_banner) : null)

export const getAvg4StarType2Percentile = (
  avg: number,
  data: PercentileData | null
): number | null => (data ? getLuckPercentile(avg, data.metrics.avg_4star_pulls_type2) : null)

export const getAvg4StarType3Percentile = (
  avg: number,
  data: PercentileData | null
): number | null => (data ? getLuckPercentile(avg, data.metrics.avg_4star_pulls_type3) : null)

export const getBannerAvg4StarType3Percentile = (
  avg: number,
  data: PercentileData | null
): number | null =>
  data ? getLuckPercentile(avg, data.metrics.avg_4star_pulls_type3_banner) : null

export const getTotalPullsPercentile = (
  total: number,
  data: PercentileData | null
): number | null => (data ? calculatePercentile(total, data.metrics.total_pulls_per_user) : null)
