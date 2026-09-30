import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso } from 'react-virtuoso'
import { resolveThumbnailSrc } from '../../utils/thumbnail-src'
import { formatDate } from '../../utils/date'
import { MissingBadge } from '../common/MissingBadge'
import { CorruptedBadge } from '../common/CorruptedBadge'
import { MediaThumbPlaceholder } from './MediaThumbPlaceholder'
import { MediaCheckbox } from './MediaCheckbox'
import { useFailedImages } from '../../hooks/useFailedImages'
import { getResponsiveColumns, DEFAULT_COLUMNS_BREAKPOINTS } from '../../utils/responsive'
import type { MediaFile } from '../../stores/mediaStore'

interface TimelineViewProps {
  files: MediaFile[]
  onOpen: (file: MediaFile) => void
  onContextMenu: (event: React.MouseEvent, file: MediaFile) => void
  /** 可选；选中项 id 列表（多选模式下用于勾选框与描边） */
  selectedIds?: string[]
  /**
   * 可选；多选模式下的卡片点击回调（裸点语义：切换选中而非打开全屏）。
   * 未提供时卡片点击仍走 onOpen。
   */
  onSelect?: (id: string, index: number, event: React.MouseEvent | React.KeyboardEvent) => void
  /** 可选；true 时卡片渲染可见勾选框（默认 false，保证既有调用点行为不变） */
  multiSelectMode?: boolean
  /** 可选；勾选框点击回调（点击不冒泡到卡片） */
  onToggleSelection?: (id: string) => void
}

const GROUP_HEADER_HEIGHT = 48
const GAP_Y = 16
const ITEM_HEIGHT = 180

// 性能重构 v3 改造项一：TimelineView 迁移至 react-virtuoso
// 策略：用 Virtuoso + 扁平化的"渲染单元"列表实现按日期分组 + 行级虚拟化
// 每个渲染单元要么是 group header，要么是包含 N 个文件的一行网格
// 保留：分组粘性标题、响应式列数、键盘 Enter/Space 打开、丢失文件角标
type RenderUnit =
  { kind: 'header'; date: string; count: number } | { kind: 'row'; files: MediaFile[] }

export const TimelineView: React.FC<TimelineViewProps> = ({
  files,
  onOpen,
  onContextMenu,
  selectedIds,
  onSelect,
  multiSelectMode = false,
  onToggleSelection
}) => {
  const { t } = useTranslation()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const { failedImages, markFailed } = useFailedImages(files)
  // 扁平化渲染单元丢失了原始下标，用 id → 下标映射把正确的 index 交回给 onSelect
  // （GalleryPage 的 Shift 区间选择与 openFullscreen 都依赖 files 内的真实下标）
  const indexById = useMemo(() => new Map(files.map((f, i) => [f.id, i])), [files])
  const selectedSet = useMemo(() => new Set(selectedIds || []), [selectedIds])

  // 响应式列数：监听 wrapper 尺寸
  useEffect(() => {
    const update = () => {
      const w = wrapperRef.current?.clientWidth || window.innerWidth
      setWidth(w)
    }
    update()
    const observer = new ResizeObserver(update)
    if (wrapperRef.current) observer.observe(wrapperRef.current)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  const cols = useMemo(() => getResponsiveColumns(width, DEFAULT_COLUMNS_BREAKPOINTS), [width])

  // 按日期分组
  const grouped = useMemo(() => {
    const map = new Map<string, MediaFile[]>()
    files.forEach((file) => {
      const date = formatDate(file.created_at)
      if (!map.has(date)) map.set(date, [])
      map.get(date)!.push(file)
    })
    return Array.from(map.entries()).map(([date, groupFiles]) => ({
      date,
      files: groupFiles
    }))
  }, [files])

  // 扁平化为渲染单元列表：header + 每行 N 个文件
  const units = useMemo<RenderUnit[]>(() => {
    if (cols <= 0) return []
    const result: RenderUnit[] = []
    for (const group of grouped) {
      result.push({ kind: 'header', date: group.date, count: group.files.length })
      for (let i = 0; i < group.files.length; i += cols) {
        result.push({ kind: 'row', files: group.files.slice(i, i + cols) })
      }
    }
    return result
  }, [grouped, cols])

  const handleKeyDown = useCallback(
    (file: MediaFile, e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onOpen(file)
      }
    },
    [onOpen]
  )

  return (
    <div
      ref={wrapperRef}
      className="flex-1 min-h-0 overflow-hidden"
      role="feed"
      aria-label={t('gallery.timeline.ariaLabel')}
    >
      <Virtuoso
        data={units}
        computeItemKey={(index) => {
          const unit = units[index]
          // N8：行 key 以行内首个文件 id 命名（空行兜底 index）。此前用 `row-${index}`，
          // 插入/删除文件后所有行下标整体移位 → 行子树整屏重挂载、行内缩略图重新请求
          return unit.kind === 'header'
            ? `header-${unit.date}`
            : `row-${unit.files[0]?.id ?? index}`
        }}
        defaultItemHeight={ITEM_HEIGHT + GAP_Y}
        overscan={400}
        increaseViewportBy={{ top: 200, bottom: 200 }}
        itemContent={(_, unit) => {
          if (unit.kind === 'header') {
            return (
              <div
                className="flex items-center gap-4"
                style={{ height: GROUP_HEADER_HEIGHT, marginBottom: GAP_Y }}
              >
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {unit.date}
                </h3>
                <div className="flex-1 h-px" style={{ background: 'var(--divider)' }} />
                <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  {t('gallery.timeline.itemCount', { count: unit.count })}
                </span>
              </div>
            )
          }
          // 行网格
          return (
            <div
              className="grid gap-4"
              style={{
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                marginBottom: GAP_Y
              }}
            >
              {unit.files.map((file) => {
                const thumbUrl = resolveThumbnailSrc(file)
                const hasError = failedImages.has(file.id)
                const isMissing = file.is_missing === true
                // 损坏文件容错：损坏文件不显示缩略图，仅显示占位图 + 损坏角标
                const isCorrupted = file.is_corrupted === true
                const showThumb = !isCorrupted && !!thumbUrl && !hasError
                const isSelected = selectedSet.has(file.id)
                const fileIndex = indexById.get(file.id) ?? -1
                return (
                  <div
                    key={file.id}
                    className={`media-card aspect-square ${
                      multiSelectMode ? 'relative ' : ''
                    }${isSelected ? 'ring-2 ring-offset-2' : ''}`}
                    style={{
                      background: 'var(--bg-tertiary)',
                      height: ITEM_HEIGHT,
                      opacity: isMissing ? 0.45 : 1,
                      ...(isSelected
                        ? ({ '--tw-ring-color': 'var(--accent)' } as React.CSSProperties)
                        : {})
                    }}
                    onClick={(e) =>
                      multiSelectMode && onSelect ? onSelect(file.id, fileIndex, e) : onOpen(file)
                    }
                    onContextMenu={(e) => onContextMenu(e, file)}
                    role="article"
                    tabIndex={0}
                    onKeyDown={(e) => handleKeyDown(file, e)}
                    aria-selected={isSelected}
                  >
                    {multiSelectMode && (
                      <MediaCheckbox
                        checked={isSelected}
                        onChange={() => onToggleSelection?.(file.id)}
                        label={file.file_name}
                        className="absolute top-2 left-2 z-10"
                      />
                    )}
                    <div
                      className="w-full h-full flex items-center justify-center relative overflow-hidden rounded-xl"
                      style={{ background: 'var(--bg-tertiary)' }}
                    >
                      {isMissing && <MissingBadge />}
                      {isCorrupted && <CorruptedBadge reason={file.corrupted_reason} />}
                      {showThumb ? (
                        <img
                          src={thumbUrl}
                          alt={file.file_name}
                          className="absolute inset-0 w-full h-full object-cover"
                          loading="lazy"
                          draggable={false}
                          onError={() => markFailed(file.id)}
                        />
                      ) : null}
                      <MediaThumbPlaceholder
                        fileType={file.file_type}
                        hasError={hasError || isCorrupted}
                        visible={!showThumb}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )
        }}
      />
    </div>
  )
}
