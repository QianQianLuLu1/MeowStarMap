import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '../common/EmptyState'
import { IconStar } from '../../icons'
import { useResonanceStore } from '../../stores/resonanceStore'
import {
  BANNER_DATA,
  getStaticProcessDeps,
  loadNames,
  loadPercentile,
  loadSnapshotMeta,
  type NamePack,
  type SnapshotMeta
} from '../../utils/resonance/staticData'
import { computeGlobalStats, processBannerPullData } from '../../utils/resonance/process'
import {
  computeBannerLuckRanking,
  computeBannerLuckRankingType3,
  computeDistribution,
  computeLuckTier,
  computeOverview,
  computeOverallLuckPercentile,
  computePullActivity
} from '../../utils/resonance/personalStats'
import type { PercentileData } from '../../utils/resonance/percentile'

/**
 * 个人统计子页：总览卡 / 欧非百分位（静态快照，缺失时隐藏区块）/
 * SVG 出货分布直方图 / 累计曲线 / 按卡池明细。全部本地数据计算，零联网。
 */

/** 出货分布直方图（纯 SVG，无图表库） */
const HistogramChart: React.FC<{
  buckets: Array<{ pullsToObtain: number; count: number }>
  color: string
  label: string
}> = ({ buckets, color, label }) => {
  const maxCount = Math.max(...buckets.map((bucket) => bucket.count), 1)
  const width = Math.max(buckets.length * 18, 60)
  return (
    <figure className="space-y-1" aria-label={label}>
      <svg
        viewBox={`0 0 ${width} 60`}
        className="w-full h-16"
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        {buckets.map((bucket, index) => {
          const barHeight = Math.max((bucket.count / maxCount) * 52, 2)
          return (
            <rect
              key={bucket.pullsToObtain}
              x={index * 18 + 3}
              y={58 - barHeight}
              width={12}
              height={barHeight}
              rx={2}
              fill={color}
            >
              <title>{`${bucket.pullsToObtain}: ${bucket.count}`}</title>
            </rect>
          )
        })}
      </svg>
      <figcaption
        className="flex justify-between text-xs"
        style={{ color: 'var(--text-tertiary)' }}
      >
        <span>{buckets[0]?.pullsToObtain ?? '—'}</span>
        <span>{buckets[buckets.length - 1]?.pullsToObtain ?? '—'}</span>
      </figcaption>
    </figure>
  )
}

/** 按卡池累计曲线（纯 SVG polyline） */
const CumulativeChart: React.FC<{
  points: Array<{ bannerId: number; cumulative: number }>
  label: string
}> = ({ points, label }) => {
  if (points.length === 0) return null
  const maxCumulative = points[points.length - 1]!.cumulative
  const stepX = 100 / Math.max(points.length - 1, 1)
  const path = points
    .map((point, index) => {
      const x = index * stepX
      const y = 40 - (point.cumulative / maxCumulative) * 36
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  return (
    <figure className="space-y-1" aria-label={label}>
      <svg
        viewBox="0 0 100 40"
        className="w-full h-20"
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        <path
          d={path}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption
        className="flex justify-between text-xs"
        style={{ color: 'var(--text-tertiary)' }}
      >
        <span>#{points[0]!.bannerId}</span>
        <span>#{points[points.length - 1]!.bannerId}</span>
      </figcaption>
    </figure>
  )
}

function StatCard({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--bg-tertiary)' }}>
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </p>
      <p className="text-lg font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>
        {value}
      </p>
    </div>
  )
}

const formatAvg = (value: number): string => (value > 0 ? value.toFixed(1) : '—')
const formatPercentile = (value: number | null): string =>
  value === null ? '—' : `${Math.round(value)}%`

export const StatsView: React.FC = () => {
  const { t, i18n } = useTranslation()
  const pulls = useResonanceStore((s) => s.pulls)
  const edits = useResonanceStore((s) => s.edits)

  const [names, setNames] = useState<NamePack | null>(null)
  const [percentile, setPercentile] = useState<PercentileData | null>(null)
  const [meta, setMeta] = useState<SnapshotMeta | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadPercentile().then((data) => {
      if (!cancelled) setPercentile(data)
    })
    void loadSnapshotMeta().then((data) => {
      if (!cancelled) setMeta(data)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void loadNames(i18n.language).then((pack) => {
      if (!cancelled) setNames(pack)
    })
    return () => {
      cancelled = true
    }
  }, [i18n])

  const processedPulls = useMemo(() => {
    const byPulls: Record<string, Array<[string, string]>> = {}
    const byEdits: Record<string, Array<[string, string]>> = {}
    for (const row of pulls) (byPulls[row.banner_id] ??= []).push([row.obtained_at, row.item_id])
    for (const row of edits) (byEdits[row.banner_id] ??= []).push([row.obtained_at, row.item_id])
    if (Object.keys(byPulls).length === 0 && Object.keys(byEdits).length === 0) return {}
    return processBannerPullData(byPulls, byEdits, getStaticProcessDeps())
  }, [pulls, edits])

  const hasData = Object.keys(processedPulls).length > 0
  const globalStats = useMemo(() => computeGlobalStats(processedPulls), [processedPulls])
  const overview = useMemo(
    () => computeOverview({ processedPulls, banners: BANNER_DATA }),
    [processedPulls]
  )
  const overallPercentile = useMemo(
    () => computeOverallLuckPercentile({ processedPulls, percentileData: percentile }),
    [processedPulls, percentile]
  )
  const luckTier = computeLuckTier(overallPercentile)
  const dist5 = useMemo(() => computeDistribution(processedPulls, 5), [processedPulls])
  const dist4 = useMemo(() => computeDistribution(processedPulls, 4), [processedPulls])
  const ranking5 = useMemo(
    () => computeBannerLuckRanking({ processedPulls, percentileData: percentile }),
    [processedPulls, percentile]
  )
  const ranking3 = useMemo(
    () => computeBannerLuckRankingType3({ processedPulls, percentileData: percentile }),
    [processedPulls, percentile]
  )
  const activity = useMemo(() => computePullActivity(processedPulls), [processedPulls])

  const bannerName = (bannerId: number): string => names?.banner[String(bannerId)] ?? `#${bannerId}`

  if (!hasData) {
    return (
      <EmptyState
        icon={<IconStar size={48} />}
        title={t('resonance.stats.emptyTitle')}
        subtitle={t('resonance.stats.emptyHint')}
      />
    )
  }

  const renderRankingTable = (
    entries: Array<{ bannerId: number; totalPulls: number; percentile: number | null }>,
    avgKey: 'avg5StarPulls' | 'avg4StarPulls'
  ): React.ReactElement => (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs" style={{ color: 'var(--text-tertiary)' }}>
          <th className="py-1 font-normal">{t('resonance.stats.colBanner')}</th>
          <th className="py-1 font-normal">{t('resonance.stats.colPulls')}</th>
          <th className="py-1 font-normal">{t('resonance.stats.colAvg')}</th>
          <th className="py-1 font-normal">{t('resonance.stats.colPercentile')}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const stats = processedPulls[String(entry.bannerId)]?.stats
          const avg = stats ? stats[avgKey] : 0
          return (
            <tr key={entry.bannerId} className="border-t" style={{ borderColor: 'var(--divider)' }}>
              <td
                className="py-1.5 pr-2 truncate max-w-40"
                style={{ color: 'var(--text-primary)' }}
              >
                {bannerName(entry.bannerId)}
              </td>
              <td className="py-1.5 pr-2 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                {entry.totalPulls}
              </td>
              <td className="py-1.5 pr-2 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                {formatAvg(avg)}
              </td>
              <td className="py-1.5 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                {formatPercentile(entry.percentile)}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )

  return (
    <div className="h-full flex flex-col gap-4 min-h-0 overflow-y-auto pr-1">
      {/* 总览卡 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatCard label={t('resonance.stats.totalPulls')} value={String(globalStats.totalPulls)} />
        <StatCard
          label={t('resonance.stats.total5Star')}
          value={String(globalStats.total5StarItems)}
        />
        <StatCard
          label={t('resonance.stats.total4Star')}
          value={String(globalStats.total4StarItems)}
        />
        <StatCard
          label={t('resonance.stats.avg5StarPulls')}
          value={formatAvg(globalStats.avg5StarPulls)}
        />
        <StatCard
          label={t('resonance.stats.banners5Star')}
          value={`${overview.bannersPulled5Star}`}
        />
        <StatCard
          label={t('resonance.stats.banners4Star')}
          value={`${overview.bannersPulled4Star}`}
        />
        <StatCard
          label={t('resonance.stats.outfits5Star')}
          value={`${overview.outfitsObtained5Star}`}
        />
        <StatCard
          label={t('resonance.stats.outfits4Star')}
          value={`${overview.outfitsObtained4Star}`}
        />
      </section>

      {/* 欧非分析（百分位快照缺失时整块隐藏） */}
      {percentile !== null && (
        <section className="rounded-xl p-4 space-y-2" style={{ background: 'var(--bg-tertiary)' }}>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('resonance.stats.luckTitle')}
          </h3>
          <div className="flex items-center gap-3 flex-wrap">
            <span
              className="text-2xl font-semibold tabular-nums"
              style={{ color: 'var(--text-primary)' }}
            >
              {formatPercentile(overallPercentile)}
            </span>
            {luckTier !== null && (
              <span
                className="px-2 py-0.5 rounded text-xs"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              >
                {t('resonance.stats.luckTier', { tier: luckTier })}
              </span>
            )}
          </div>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {t('resonance.stats.luckSnapshotNote', {
              date: meta?.percentileGeneratedAt ?? '—'
            })}
          </p>
        </section>
      )}

      {/* 出货分布 */}
      {(dist5.length > 0 || dist4.length > 0) && (
        <section className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-tertiary)' }}>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('resonance.stats.distributionTitle')}
          </h3>
          {dist5.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('resonance.stats.dist5Star')}
              </p>
              <HistogramChart
                buckets={dist5}
                color="var(--warning)"
                label={t('resonance.stats.dist5Star')}
              />
            </div>
          )}
          {dist4.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('resonance.stats.dist4Star')}
              </p>
              <HistogramChart
                buckets={dist4}
                color="var(--accent)"
                label={t('resonance.stats.dist4Star')}
              />
            </div>
          )}
        </section>
      )}

      {/* 累计曲线 */}
      {activity.length > 1 && (
        <section className="rounded-xl p-4 space-y-2" style={{ background: 'var(--bg-tertiary)' }}>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('resonance.stats.activityTitle')}
          </h3>
          <CumulativeChart
            points={activity.map((point) => ({
              bannerId: point.bannerId,
              cumulative: point.cumulative
            }))}
            label={t('resonance.stats.activityTitle')}
          />
        </section>
      )}

      {/* 按卡池明细 */}
      <section className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-tertiary)' }}>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {t('resonance.stats.rankingTitle')}
        </h3>
        {ranking5.length > 0 && (
          <div>
            <p className="text-xs pb-1" style={{ color: 'var(--text-secondary)' }}>
              {t('resonance.stats.ranking5Star')}
            </p>
            {renderRankingTable(ranking5, 'avg5StarPulls')}
          </div>
        )}
        {ranking3.length > 0 && (
          <div>
            <p className="text-xs pb-1" style={{ color: 'var(--text-secondary)' }}>
              {t('resonance.stats.ranking4Star')}
            </p>
            {renderRankingTable(ranking3, 'avg4StarPulls')}
          </div>
        )}
        {ranking5.length === 0 && ranking3.length === 0 && (
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {t('resonance.stats.rankingEmpty')}
          </p>
        )}
      </section>

      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {t('resonance.import.snapshotNote')}
      </p>
    </div>
  )
}
