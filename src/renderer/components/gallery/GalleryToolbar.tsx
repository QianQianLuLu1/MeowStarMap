import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore, type ViewMode, type FilterType, type SortBy } from '../../stores/uiStore'
import { ScanButton } from '../scanner/ScanButton'
import {
  IconGrid,
  IconList,
  IconTimeline,
  IconMasonry,
  IconSearch,
  IconChevronUp,
  IconStar,
  IconWarning,
  IconEvent,
  IconSlideshow,
  IconImport,
  IconDelete
} from '../../icons'
import { ShareMenuButton } from '../common/ShareMenuButton'
import type { ShareChannelId } from '../common/ShareGuideDialog'

const filterTypes = [
  { id: 'all', labelKey: 'gallery.toolbar.filterType.all' },
  { id: 'image', labelKey: 'gallery.toolbar.filterType.image' },
  { id: 'video', labelKey: 'gallery.toolbar.filterType.video' }
] as const

const sortOptions = [
  { id: 'date', labelKey: 'gallery.toolbar.sortBy.date' },
  { id: 'name', labelKey: 'gallery.toolbar.sortBy.name' },
  { id: 'size', labelKey: 'gallery.toolbar.sortBy.size' },
  { id: 'resolution', labelKey: 'gallery.toolbar.sortBy.resolution' },
  { id: 'rating', labelKey: 'gallery.toolbar.sortBy.rating' }
] as const

const viewModes: { id: ViewMode; labelKey: string; icon: React.ReactNode }[] = [
  { id: 'grid', labelKey: 'gallery.toolbar.viewMode.grid', icon: <IconGrid size={16} /> },
  { id: 'list', labelKey: 'gallery.toolbar.viewMode.list', icon: <IconList size={16} /> },
  {
    id: 'timeline',
    labelKey: 'gallery.toolbar.viewMode.timeline',
    icon: <IconTimeline size={16} />
  },
  { id: 'masonry', labelKey: 'gallery.toolbar.viewMode.masonry', icon: <IconMasonry size={16} /> },
  {
    id: 'event-timeline',
    labelKey: 'gallery.toolbar.viewMode.eventTimeline',
    icon: <IconEvent size={16} />
  }
]

const ratingOptions = [
  { value: null, labelKey: 'gallery.toolbar.rating.all' },
  { value: 1, labelKey: 'gallery.toolbar.rating.star1Plus' },
  { value: 2, labelKey: 'gallery.toolbar.rating.star2Plus' },
  { value: 3, labelKey: 'gallery.toolbar.rating.star3Plus' },
  { value: 4, labelKey: 'gallery.toolbar.rating.star4Plus' },
  { value: 5, labelKey: 'gallery.toolbar.rating.star5' }
] as const

interface GalleryToolbarProps {
  searchInput: string
  onSearchChange: (value: string) => void
  // T09：剪贴板分享入口（仅在已选择文件时由父组件传入）
  onShareClipboard?: (channelId: ShareChannelId) => void
  // T11：幻灯片播放入口，传入当前筛选文件总数与起始索引；不传则隐藏按钮
  onSlideshow?: () => void
  // T14：文件导入向导入口
  onImport?: () => void
  // 损坏文件容错：批量清理入口，仅在 showCorruptedOnly=true 时由父组件传入
  // 父组件负责显示确认对话框并调用 mediaAction.cleanupCorrupted()
  onCleanupCorrupted?: () => void
}

export const GalleryToolbar: React.FC<GalleryToolbarProps> = ({
  searchInput,
  onSearchChange,
  onShareClipboard,
  onSlideshow,
  onImport,
  onCleanupCorrupted
}) => {
  const {
    viewMode,
    sortBy,
    sortOrder,
    filterType,
    filterRating,
    filterDateRange,
    showMissingOnly,
    // 损坏文件容错：仅看损坏文件开关（与 showMissingOnly 互斥）
    showCorruptedOnly,
    setViewMode,
    setSortBy,
    toggleSortOrder,
    setFilterType,
    setFilterRating,
    setFilterDateRange,
    setShowMissingOnly,
    setShowCorruptedOnly
  } = useUIStore(
    useShallow((s) => ({
      viewMode: s.viewMode,
      sortBy: s.sortBy,
      sortOrder: s.sortOrder,
      filterType: s.filterType,
      filterRating: s.filterRating,
      filterDateRange: s.filterDateRange,
      showMissingOnly: s.showMissingOnly,
      showCorruptedOnly: s.showCorruptedOnly,
      setViewMode: s.setViewMode,
      setSortBy: s.setSortBy,
      toggleSortOrder: s.toggleSortOrder,
      setFilterType: s.setFilterType,
      setFilterRating: s.setFilterRating,
      setFilterDateRange: s.setFilterDateRange,
      setShowMissingOnly: s.setShowMissingOnly,
      setShowCorruptedOnly: s.setShowCorruptedOnly
    }))
  )
  const { t } = useTranslation()

  // 评分筛选下拉
  const [ratingOpen, setRatingOpen] = useState(false)
  const ratingRef = useRef<HTMLDivElement>(null)
  // 日期筛选弹窗
  const [dateOpen, setDateOpen] = useState(false)
  const dateRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ratingRef.current && !ratingRef.current.contains(e.target as Node)) setRatingOpen(false)
      if (dateRef.current && !dateRef.current.contains(e.target as Node)) setDateOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const formatDate = useCallback((d: Date | null) => (d ? d.toISOString().slice(0, 10) : ''), [])
  const dateLabel =
    filterDateRange[0] || filterDateRange[1]
      ? `${formatDate(filterDateRange[0])} ~ ${formatDate(filterDateRange[1])}`
      : t('gallery.toolbar.dateLabel')

  return (
    <div className="gallery-toolbar flex items-center justify-between flex-wrap gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        {filterTypes.map((type) => (
          <button
            key={type.id}
            className={`category-tag ${filterType === type.id ? 'active' : ''}`}
            onClick={() => setFilterType(type.id as FilterType)}
          >
            {t(type.labelKey)}
          </button>
        ))}
        <div className="w-px h-6 mx-2" style={{ background: 'var(--divider)' }} />

        {/* 评分筛选 */}
        <div ref={ratingRef} className="relative">
          <button
            className={`category-tag ${filterRating !== null ? 'active' : ''}`}
            onClick={() => setRatingOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={ratingOpen}
          >
            <IconStar size={12} filled={filterRating !== null} />
            {filterRating !== null
              ? t('gallery.toolbar.rating.starNPlus', { n: filterRating })
              : t('gallery.toolbar.rating.label')}
          </button>
          {ratingOpen && (
            <div
              role="listbox"
              className="absolute top-full left-0 mt-1 glass-panel py-1 min-w-[100px] z-50"
              style={{ animation: 'scaleIn 150ms ease-out' }}
            >
              {ratingOptions.map((opt) => (
                <button
                  key={String(opt.value)}
                  role="option"
                  aria-selected={filterRating === opt.value}
                  className="w-full px-3 py-1.5 text-sm text-left transition-colors hover:bg-[var(--hover-bg)]"
                  style={{
                    color: filterRating === opt.value ? 'var(--accent)' : 'var(--text-primary)'
                  }}
                  onClick={() => {
                    setFilterRating(opt.value)
                    setRatingOpen(false)
                  }}
                >
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 日期范围筛选 */}
        <div ref={dateRef} className="relative">
          <button
            className={`category-tag ${filterDateRange[0] || filterDateRange[1] ? 'active' : ''}`}
            onClick={() => setDateOpen((v) => !v)}
            aria-haspopup="dialog"
            aria-expanded={dateOpen}
          >
            {dateLabel}
          </button>
          {dateOpen && (
            <div
              className="absolute top-full left-0 mt-1 glass-panel p-3 z-50 space-y-2"
              style={{ animation: 'scaleIn 150ms ease-out', minWidth: '220px' }}
            >
              <div className="flex flex-col gap-1">
                <label className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {t('gallery.toolbar.dateRange.startLabel')}
                </label>
                <input
                  type="date"
                  value={formatDate(filterDateRange[0])}
                  onChange={(e) => {
                    const d = e.target.value ? new Date(e.target.value) : null
                    setFilterDateRange([d, filterDateRange[1]])
                  }}
                  className="input-field text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {t('gallery.toolbar.dateRange.endLabel')}
                </label>
                <input
                  type="date"
                  value={formatDate(filterDateRange[1])}
                  onChange={(e) => {
                    const d = e.target.value ? new Date(e.target.value) : null
                    setFilterDateRange([filterDateRange[0], d])
                  }}
                  className="input-field text-sm"
                />
              </div>
              <button
                className="btn-secondary w-full text-xs"
                onClick={() => {
                  setFilterDateRange([null, null])
                  setDateOpen(false)
                }}
              >
                {t('gallery.toolbar.dateRange.clear')}
              </button>
            </div>
          )}
        </div>

        {/* T02：仅看丢失文件开关 */}
        <button
          className={`category-tag ${showMissingOnly ? 'active' : ''}`}
          onClick={() => setShowMissingOnly(!showMissingOnly)}
          style={
            showMissingOnly ? { background: 'var(--danger-bg)', color: 'var(--danger-hover)' } : {}
          }
          title={t('gallery.toolbar.missingOnlyTitle')}
          aria-pressed={showMissingOnly}
        >
          <IconWarning size={12} />
          {t('gallery.toolbar.missingOnly')}
        </button>

        {/* 损坏文件容错：仅看损坏文件开关（与"仅看丢失"互斥） */}
        <button
          className={`category-tag ${showCorruptedOnly ? 'active' : ''}`}
          onClick={() => setShowCorruptedOnly(!showCorruptedOnly)}
          style={
            showCorruptedOnly
              ? { background: 'var(--warning-bg, #fef3c7)', color: 'var(--warning-hover, #b45309)' }
              : {}
          }
          title={t('gallery.toolbar.corruptedOnlyTitle')}
          aria-pressed={showCorruptedOnly}
        >
          <IconWarning size={12} />
          {t('gallery.toolbar.corruptedOnly')}
        </button>

        {/* 损坏文件容错：批量清理入口，仅在"仅看损坏"开启时显示
            由父组件 GalleryPage 传入 onCleanupCorrupted，负责显示确认对话框并调用 IPC */}
        {showCorruptedOnly && onCleanupCorrupted && (
          <button
            className="category-tag"
            onClick={onCleanupCorrupted}
            title={t('gallery.toolbar.cleanupCorruptedTitle')}
          >
            <IconDelete size={12} />
            {t('gallery.toolbar.cleanupCorrupted')}
          </button>
        )}

        <div className="w-px h-6 mx-2" style={{ background: 'var(--divider)' }} />
        {sortOptions.map((sort) => (
          <button
            key={sort.id}
            className={`category-tag ${sortBy === sort.id ? 'active' : ''}`}
            onClick={() => {
              if (sortBy === sort.id) {
                toggleSortOrder()
              } else {
                setSortBy(sort.id as SortBy)
              }
            }}
          >
            {t(sort.labelKey)}
            {sortBy === sort.id && (
              <IconChevronUp
                size={12}
                strokeWidth="2.5"
                style={{
                  transform: sortOrder === 'desc' ? 'rotate(180deg)' : 'none',
                  transition: 'transform 200ms'
                }}
              />
            )}
          </button>
        ))}
        <div className="w-px h-6 mx-2" style={{ background: 'var(--divider)' }} />
        <div className="relative">
          <IconSearch
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--text-tertiary)' }}
          />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t('gallery.toolbar.searchPlaceholder')}
            className="search-input pl-9 pr-3 py-1.5 text-sm w-48 sm:w-64 lg:w-80"
            style={{ color: 'var(--text-primary)' }}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        {onImport && (
          <button
            className="icon-btn"
            onClick={onImport}
            title={t('gallery.toolbar.importTitle')}
            aria-label={t('gallery.toolbar.importTitle')}
          >
            <IconImport size={18} />
          </button>
        )}
        {onShareClipboard && (
          <ShareMenuButton
            onSelect={onShareClipboard}
            label={t('share.menu.label')}
            title={t('gallery.toolbar.shareTitle')}
          />
        )}
        {onSlideshow && (
          <button
            className="icon-btn"
            onClick={onSlideshow}
            title={t('gallery.slideshow.title')}
            aria-label={t('gallery.slideshow.title')}
          >
            <IconSlideshow size={18} />
          </button>
        )}
        <div
          className="flex items-center gap-1 p-1 rounded-lg"
          style={{ background: 'var(--bg-tertiary)' }}
        >
          {viewModes.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={`icon-btn ${viewMode === mode.id ? 'active' : ''}`}
              onClick={() => setViewMode(mode.id)}
              title={t(mode.labelKey)}
              aria-label={t(mode.labelKey)}
              aria-pressed={viewMode === mode.id}
            >
              {mode.icon}
            </button>
          ))}
        </div>
        <div className="w-px h-6" style={{ background: 'var(--divider)' }} />
        <ScanButton />
      </div>
    </div>
  )
}
