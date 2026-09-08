import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso } from 'react-virtuoso'
import { toFileUrl } from '../../utils/file'
import { IconEvent } from '../../icons'
import { MissingBadge } from '../common/MissingBadge'
import { CorruptedBadge } from '../common/CorruptedBadge'
import { MediaThumbPlaceholder } from './MediaThumbPlaceholder'
import { MediaCheckbox } from './MediaCheckbox'
import { useFailedImages } from '../../hooks/useFailedImages'
import { getResponsiveColumns, DEFAULT_COLUMNS_BREAKPOINTS } from '../../utils/responsive'
import type { MediaFile } from '../../stores/mediaStore'
import { getTimelineNodes, findVersionByDate, type TimelineNode } from '../../utils/game-events'

interface EventTimelineViewProps {
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

const NODE_HEADER_HEIGHT = 80
const GAP_Y = 16
const ITEM_HEIGHT = 180

// 性能重构 v3 改造项一：EventTimelineView 迁移至 react-virtuoso
// 策略同 TimelineView：用 Virtuoso + 扁平化的"渲染单元"列表实现按版本/活动节点分组 + 行级虚拟化
type RenderUnit =
  { kind: 'header'; node: TimelineNode; count: number } | { kind: 'row'; files: MediaFile[] }

// 将文件按所属版本/活动节点分组
function groupFilesByNode(files: MediaFile[]): Array<{ node: TimelineNode; files: MediaFile[] }> {
  const nodes = getTimelineNodes()
  if (nodes.length === 0) return []

  const fileVersionMap = new Map<string, MediaFile[]>()
  for (const file of files) {
    const version = findVersionByDate(file.created_at)
    const key = version ? `version-${version.version}` : 'unknown'
    if (!fileVersionMap.has(key)) fileVersionMap.set(key, [])
    fileVersionMap.get(key)!.push(file)
  }

  const result: Array<{ node: TimelineNode; files: MediaFile[] }> = []
  const sortedNodes = [...nodes].sort(
    (a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
  )
  for (const node of sortedNodes) {
    const nodeFiles = fileVersionMap.get(node.key) || []
    if (nodeFiles.length > 0) {
      result.push({ node, files: nodeFiles })
    }
  }

  const unknownFiles = fileVersionMap.get('unknown') || []
  if (unknownFiles.length > 0) {
    result.push({
      node: {
        type: 'event',
        key: 'unknown',
        // i18n keys，渲染时通过 t() 翻译
        name: 'gallery.eventTimeline.unknownPeriodName',
        startDate: '',
        description: 'gallery.eventTimeline.unknownPeriodDesc'
      },
      files: unknownFiles
    })
  }

  return result
}

export const EventTimelineView: React.FC<EventTimelineViewProps> = ({
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
  const indexById = useMemo(() => new Map(files.map((f, i) => [f.id, i])), [files])
  const selectedSet = useMemo(() => new Set(selectedIds || []), [selectedIds])

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

  const grouped = useMemo(() => groupFilesByNode(files), [files])

  // 扁平化为渲染单元列表
  const units = useMemo<RenderUnit[]>(() => {
    if (cols <= 0) return []
    const result: RenderUnit[] = []
    for (const group of grouped) {
      result.push({ kind: 'header', node: group.node, count: group.files.length })
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

  if (grouped.length === 0) {
    return (
      <div
        className="flex-1 flex items-center justify-center"
        style={{ color: 'var(--text-tertiary)' }}
      >
        <div className="flex flex-col items-center gap-2">
          <IconEvent size={36} strokeWidth="1.5" />
          <p className="text-sm">{t('gallery.eventTimeline.emptyHint')}</p>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={wrapperRef}
      className="flex-1 min-h-0 overflow-hidden"
      role="feed"
      aria-label={t('gallery.eventTimeline.ariaLabel')}
    >
      <Virtuoso
        data={units}
        computeItemKey={(index) => {
          const unit = units[index]
          return unit.kind === 'header' ? `header-${unit.node.key}` : `row-${index}`
        }}
        defaultItemHeight={ITEM_HEIGHT + GAP_Y}
        overscan={400}
        increaseViewportBy={{ top: 200, bottom: 200 }}
        itemContent={(_, unit) => {
          if (unit.kind === 'header') {
            return (
              <div
                className="flex items-center gap-3"
                style={{ height: NODE_HEADER_HEIGHT, marginBottom: GAP_Y }}
              >
                <div
                  className="flex items-center justify-center"
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 12,
                    background:
                      unit.node.type === 'version' ? 'var(--accent)' : 'var(--warning-bg)',
                    color:
                      unit.node.type === 'version'
                        ? 'var(--text-on-accent)'
                        : 'var(--warning-text)',
                    flexShrink: 0
                  }}
                >
                  {unit.node.type === 'version' ? (
                    <span className="text-xs font-bold">v{unit.node.version}</span>
                  ) : (
                    <IconEvent size={22} />
                  )}
                </div>
                <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3
                      className="text-base font-semibold truncate"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {unit.node.key === 'unknown' ? t(unit.node.name) : unit.node.name}
                    </h3>
                    {unit.node.type === 'version' && (
                      <span
                        className="text-xs px-2 py-0.5 rounded"
                        style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                      >
                        {t('gallery.eventTimeline.versionBadge')}
                      </span>
                    )}
                  </div>
                  <div
                    className="flex items-center gap-2 text-xs"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    <span>{unit.node.startDate || '—'}</span>
                    {unit.node.description && (
                      <>
                        <span>·</span>
                        <span className="truncate">
                          {unit.node.key === 'unknown'
                            ? t(unit.node.description)
                            : unit.node.description}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex-1 h-px" style={{ background: 'var(--divider)' }} />
                <span
                  className="text-sm whitespace-nowrap"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {t('gallery.eventTimeline.itemCount', { count: unit.count })}
                </span>
              </div>
            )
          }
          return (
            <div
              className="grid gap-4"
              style={{
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                marginBottom: GAP_Y
              }}
            >
              {unit.files.map((file) => {
                const thumbUrl = toFileUrl(file.thumbnail || file.file_path)
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
