import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '../stores/uiStore'
import { OUTFIT_PRESETS } from '../stores/mediaStore'
import { useGlobalToast } from './settings/sections'
import { toFileUrl } from '../utils/file'
import { formatDate } from '../utils/date'
import { IconOutfit, IconRefresh, IconImage, IconLock, IconVideo } from '../icons'
import type { OutfitStat } from '../../shared/scene-category'

/**
 * 套装封面源判定（N3，fix-thumbnail-persist-and-ondemand）：
 * 封面缩略图优先；无缩略图且封面行是视频 → null（渲染视频占位图标，绝不把视频文件
 * 当 <img> src——<img> 无法解码视频必裂图，还会把整个视频当图片下载）；图片无缩略图
 * → 回退原文件（现状保留）。coverFileType 缺失（旧数据）按图片处理。
 */
export function resolveOutfitCoverSrc(
  stat: Pick<OutfitStat, 'coverFilePath' | 'coverThumbnail' | 'coverFileType'>
): string | null {
  if (stat.coverThumbnail) return toFileUrl(stat.coverThumbnail)
  if (stat.coverFileType === 'video') return null
  return stat.coverFilePath ? toFileUrl(stat.coverFilePath) : null
}

// 统计卡片：单个指标展示
const StatCard: React.FC<{
  label: string
  value: string | number
  hint?: string
  accent?: string
}> = ({ label, value, hint, accent }) => (
  <div className="glass-card p-4 flex flex-col gap-1" style={{ borderRadius: 16, minWidth: 0 }}>
    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
      {label}
    </span>
    <span className="text-2xl font-semibold" style={{ color: accent || 'var(--text-primary)' }}>
      {value}
    </span>
    {hint && (
      <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {hint}
      </span>
    )}
  </div>
)

// P1-I：formatDate 已统一到 utils/date.ts，直接 import 引入

// 已收集套装卡片
const OutfitCard: React.FC<{ stat: OutfitStat; onClick: () => void }> = ({ stat, onClick }) => {
  const { t } = useTranslation()
  const cover = resolveOutfitCoverSrc(stat)
  return (
    <button
      className="glass-card text-left flex flex-col overflow-hidden group"
      style={{ borderRadius: 16, border: '1px solid var(--divider)', cursor: 'pointer' }}
      onClick={onClick}
      title={t('outfit.viewOutfitPhotos', { outfit: stat.outfit })}
    >
      <div
        className="relative overflow-hidden"
        style={{ aspectRatio: '4 / 3', background: 'var(--bg-tertiary)' }}
      >
        {cover ? (
          <img
            src={cover}
            alt={stat.outfit}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {stat.coverFileType === 'video' ? <IconVideo size={32} /> : <IconImage size={32} />}
          </div>
        )}
        <div
          className="absolute top-2 right-2 px-2 py-0.5 text-xs font-medium"
          style={{
            borderRadius: 8,
            background: 'var(--overlay-bg)',
            color: 'var(--text-on-overlay)',
            backdropFilter: 'blur(8px)'
          }}
        >
          {t('outfit.count', { count: stat.count })}
        </div>
      </div>
      <div className="p-3 flex flex-col gap-1">
        <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {stat.outfit}
        </span>
        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('outfit.latestShot')} {stat.latestCreatedAt ? formatDate(stat.latestCreatedAt) : '—'}
        </span>
      </div>
    </button>
  )
}

// 未收集套装卡片（预设中存在但数据库无记录）
const UncollectedCard: React.FC<{ nameKey: string }> = ({ nameKey }) => {
  const { t } = useTranslation()
  const displayName = t(nameKey)
  return (
    <div
      className="flex flex-col items-center justify-center p-6 gap-2"
      style={{
        borderRadius: 16,
        background: 'var(--bg-tertiary)',
        border: '1px dashed var(--divider)',
        aspectRatio: '1 / 1',
        opacity: 0.6
      }}
      title={t('outfit.uncollectedHint', { outfit: displayName })}
    >
      <IconLock size={20} style={{ color: 'var(--text-tertiary)' }} />
      <span className="text-xs text-center" style={{ color: 'var(--text-tertiary)' }}>
        {displayName}
      </span>
      <span className="text-xs" style={{ color: 'var(--text-tertiary)', opacity: 0.7 }}>
        {t('outfit.locked')}
      </span>
    </div>
  )
}

export const OutfitGalleryPage: React.FC = () => {
  const { t } = useTranslation()
  const navigateTo = useUIStore((s) => s.navigateTo)
  const setFilterOutfit = useUIStore((s) => s.setFilterOutfit)
  const showMessage = useGlobalToast()
  const [stats, setStats] = useState<OutfitStat[]>([])
  const [loading, setLoading] = useState(false)

  const loadStats = useCallback(async () => {
    if (!window.electronAPI?.mediaAction?.getOutfitStats) {
      showMessage(t('outfit.unsupported'), 'error')
      return
    }
    setLoading(true)
    try {
      const res = await window.electronAPI.mediaAction.getOutfitStats()
      if (res.success) {
        setStats(res.stats)
      } else {
        showMessage(res.message || t('outfit.loadStatsFailed'), 'error')
      }
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t('outfit.loadFailed'), 'error')
    } finally {
      setLoading(false)
    }
  }, [showMessage, t])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  // 已收集套装名集合
  const collectedNames = useMemo(() => new Set(stats.map((s) => s.outfit)), [stats])

  // 未收集预设套装（预设中存在但数据库无记录）
  const uncollectedPresets = useMemo(
    () => OUTFIT_PRESETS.filter((p) => !collectedNames.has(p.id)),
    [collectedNames]
  )

  // 用户自定义套装（不在预设库中，但数据库有记录）
  const customOutfits = useMemo(
    () => stats.filter((s) => !OUTFIT_PRESETS.some((p) => p.id === s.outfit)),
    [stats]
  )

  // 统计指标
  const totalCollected = stats.length
  const totalPresets = OUTFIT_PRESETS.length
  const progressPercent = totalPresets > 0 ? Math.round((totalCollected / totalPresets) * 100) : 0
  const topOutfit = stats[0] // stats 已按 count DESC 排序
  const collectedCount = stats.filter((s) => OUTFIT_PRESETS.some((p) => p.id === s.outfit)).length

  // 点击套装卡片：设置筛选并跳转图库
  const handleCardClick = useCallback(
    (outfit: string) => {
      setFilterOutfit(outfit)
      navigateTo('gallery')
      showMessage(t('outfit.filtered', { outfit }), 'info')
    },
    [setFilterOutfit, navigateTo, showMessage, t]
  )

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 顶部标题栏 */}
      <div
        className="flex items-center justify-between px-6 py-4"
        style={{ borderBottom: '1px solid var(--divider)' }}
      >
        <div className="flex items-center gap-3">
          <IconOutfit size={22} />
          <div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {t('outfit.title')}
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {loading
                ? t('outfit.loading')
                : t('outfit.summary', {
                    collected: totalCollected,
                    presets: totalPresets,
                    progress: progressPercent
                  })}
            </p>
          </div>
        </div>
        <button
          className="btn-secondary text-sm"
          onClick={() => void loadStats()}
          disabled={loading}
          title={t('outfit.refreshStats')}
        >
          <IconRefresh size={14} className="mr-1" /> {t('outfit.refresh')}
        </button>
      </div>

      {/* 滚动内容区 */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        {/* 统计卡片 */}
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
        >
          <StatCard
            label={t('outfit.collectedLabel')}
            value={totalCollected}
            hint={t('outfit.collectedHint')}
          />
          <StatCard
            label={t('outfit.presetTotalLabel')}
            value={totalPresets}
            hint={t('outfit.presetTotalHint')}
          />
          <StatCard
            label={t('outfit.progressLabel')}
            value={`${progressPercent}%`}
            hint={t('outfit.progressValue', { collected: totalCollected, total: totalPresets })}
            accent="var(--accent)"
          />
          <StatCard
            label={t('outfit.topOutfitLabel')}
            value={topOutfit ? topOutfit.outfit : '—'}
            hint={
              topOutfit ? t('outfit.photosCount', { count: topOutfit.count }) : t('outfit.noData')
            }
            accent="var(--success)"
          />
        </div>

        {/* 已收集套装（预设库内） */}
        <section>
          <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
            {t('outfit.collectedSection', { count: collectedCount })}
          </h3>
          {stats.length === 0 && !loading ? (
            <div
              className="glass-card flex flex-col items-center justify-center py-12 gap-2"
              style={{ borderRadius: 16 }}
            >
              <IconOutfit size={36} style={{ color: 'var(--text-tertiary)' }} />
              <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                {t('outfit.emptyHint')}
              </p>
            </div>
          ) : (
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}
            >
              {stats
                .filter((s) => OUTFIT_PRESETS.some((p) => p.id === s.outfit))
                .map((stat) => (
                  <OutfitCard
                    key={stat.outfit}
                    stat={stat}
                    onClick={() => handleCardClick(stat.outfit)}
                  />
                ))}
            </div>
          )}
        </section>

        {/* 用户自定义套装 */}
        {customOutfits.length > 0 && (
          <section>
            <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
              {t('outfit.customSection', { count: customOutfits.length })}
            </h3>
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}
            >
              {customOutfits.map((stat) => (
                <OutfitCard
                  key={stat.outfit}
                  stat={stat}
                  onClick={() => handleCardClick(stat.outfit)}
                />
              ))}
            </div>
          </section>
        )}

        {/* 未收集预设套装 */}
        {uncollectedPresets.length > 0 && (
          <section>
            <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
              {t('outfit.uncollectedSection', { count: uncollectedPresets.length })}
            </h3>
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}
            >
              {uncollectedPresets.map((p) => (
                <UncollectedCard key={p.id} nameKey={p.nameKey} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
