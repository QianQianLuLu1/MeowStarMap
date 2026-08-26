import React, { forwardRef, useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  VirtuosoGrid,
  type VirtuosoGridHandle,
  type ListRange,
  type GridListProps
} from 'react-virtuoso'
import { toFileUrl } from '../../stores/mediaStore'
import { formatFileSize } from '../../utils/format'
import { IconEdit, IconFavorite, IconDelete } from '../../icons'
import { MissingBadge } from '../common/MissingBadge'
import { CorruptedBadge } from '../common/CorruptedBadge'
import { MediaThumbPlaceholder } from './MediaThumbPlaceholder'
import { useFailedImages } from '../../hooks/useFailedImages'
import { getResponsiveColumns, DEFAULT_COLUMNS_BREAKPOINTS } from '../../utils/responsive'
import type { MediaFile } from '../../stores/mediaStore'

// 高分屏检测：DPR ≥ 2 时启用高清缩略图档位（512px）
// 模块加载时一次性检测，避免每次渲染都读取 devicePixelRatio
// 普通屏（DPR < 2）下完全不影响现有 low/standard 双档位逻辑
const HIGH_DPI_MODE = typeof window !== 'undefined' && window.devicePixelRatio >= 2

// 前置守卫：后端会把游戏原生缩略图路径直接填入 thumbnail（形如
// .../GamePlayPhotos/{uid}/NikkiPhotos_LowQuality|HighQuality/xxx.jpg），
// 这类路径不适用缓存命名规则（_low/_high）改写，否则会推导出不存在的路径导致 404。
// 路径分隔符可能是反斜杠或正斜杠，且目录名大小写不保证，统一小写归一化后匹配。
const isNativeGameThumbnail = (thumbnail: string): boolean => {
  const lower = thumbnail.toLowerCase()
  return lower.includes('nikkiphotos_lowquality') || lower.includes('nikkiphotos_highquality')
}

// P1-03：从标准缩略图路径推导低质量路径（缓存命名规则：${hash}.jpg → ${hash}_low.jpg）
// 原生游戏缩略图路径返回 null，组件直接使用原 thumbnail 路径显示
export const toLowQualityUrl = (thumbnail: string | undefined): string | null => {
  if (!thumbnail) return null
  if (isNativeGameThumbnail(thumbnail)) return null
  if (thumbnail.endsWith('.jpg')) {
    return thumbnail.slice(0, -4) + '_low.jpg'
  }
  return null
}

// 高清档位路径推导：${hash}.jpg → ${hash}_high.jpg
export const toHighQualityUrl = (thumbnail: string | undefined): string | null => {
  if (!thumbnail) return null
  if (isNativeGameThumbnail(thumbnail)) return null
  if (
    thumbnail.endsWith('.jpg') &&
    !thumbnail.endsWith('_low.jpg') &&
    !thumbnail.endsWith('_high.jpg')
  ) {
    return thumbnail.slice(0, -4) + '_high.jpg'
  }
  return null
}

interface VirtualImageGridProps {
  items: MediaFile[]
  selectedIds: string[]
  onSelect: (id: string, index: number, event: React.MouseEvent | React.KeyboardEvent) => void
  onHover: (id: string | null) => void
  onContextMenu: (event: React.MouseEvent, file: MediaFile) => void
  onEdit?: (file: MediaFile) => void
  onFavorite?: (file: MediaFile) => void
  onDelete?: (file: MediaFile) => void
  // 无限滚动：传入即启用触底加载与状态页脚，不传则完全保持原有行为
  onEndReached?: () => void
  loadingMore?: boolean
  hasMore?: boolean
}

// P1-U11：抽取 MediaCardActions 消除 hover/touch 两套按钮组重复
// variant='hover' 用于桌面 hover 态（var(--overlay-bg-medium)），variant='touch' 用于触屏常驻态（var(--overlay-bg)）
const MediaCardActions: React.FC<{
  file: MediaFile
  onEdit?: (file: MediaFile) => void
  onFavorite?: (file: MediaFile) => void
  onDelete?: (file: MediaFile) => void
  variant: 'hover' | 'touch'
}> = ({ file, onEdit, onFavorite, onDelete, variant }) => {
  const { t } = useTranslation()
  const bgClass = variant === 'hover' ? 'bg-[var(--overlay-bg-medium)]' : 'bg-[var(--overlay-bg)]'
  return (
    <div className="absolute top-2 right-2 flex gap-1">
      {onEdit && file.file_type === 'image' && (
        <button
          className={`w-7 h-7 rounded-md flex items-center justify-center ${bgClass} text-[var(--text-on-overlay)] hover:bg-[var(--overlay-bg-hover)] transition-colors`}
          onClick={(e) => {
            e.stopPropagation()
            onEdit(file)
          }}
          title={t('gallery.virtualGrid.editTitle')}
          aria-label={t('gallery.virtualGrid.editAria')}
        >
          <IconEdit size={14} />
        </button>
      )}
      {onFavorite && (
        <button
          className={`w-7 h-7 rounded-md flex items-center justify-center ${bgClass} text-[var(--text-on-overlay)] hover:bg-[var(--overlay-bg-hover)] transition-colors`}
          onClick={(e) => {
            e.stopPropagation()
            onFavorite(file)
          }}
          title={
            file.is_favorite
              ? t('gallery.virtualGrid.unfavoriteTitle')
              : t('gallery.virtualGrid.favoriteTitle')
          }
          aria-label={
            file.is_favorite
              ? t('gallery.virtualGrid.unfavoriteAria')
              : t('gallery.virtualGrid.favoriteAria')
          }
        >
          <IconFavorite size={14} filled={file.is_favorite} />
        </button>
      )}
      {onDelete && (
        <button
          className={`w-7 h-7 rounded-md flex items-center justify-center ${bgClass} text-[var(--text-on-overlay)] hover:bg-[var(--danger)] transition-colors`}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(file)
          }}
          title={t('gallery.virtualGrid.deleteTitle')}
          aria-label={t('gallery.virtualGrid.deleteAria')}
        >
          <IconDelete size={14} />
        </button>
      )}
    </div>
  )
}

// 性能重构 v3 改造项一：VirtualImageGrid 迁移至 react-virtuoso VirtuosoGrid
// - 用 VirtuosoGrid 替换自研 useVirtualGrid，万级文件滚动帧率 ≥ 55 FPS
// - 保留：多选（Ctrl/Cmd/Shift）、键盘 ↑↓←→/Home/End/Enter/Space、缩略图分级加载（low/standard/high）
// - 保留：滚动停止后切换标准质量、高分屏后台预生成 512px 高清档、触屏常驻操作按钮、收藏徽标、视频时长徽标
const VirtualImageGridComponent = forwardRef<VirtuosoGridHandle, VirtualImageGridProps>(
  (props, ref) => {
    const {
      items: rawItems,
      selectedIds,
      onSelect,
      onHover,
      onContextMenu,
      onEdit,
      onFavorite,
      onDelete,
      onEndReached,
      loadingMore = false,
      hasMore = false
    } = props
    // 参数校验：items 必须为数组，非数组降级为空，杜绝脏数据进入 VirtuosoGrid
    // 用 useMemo 包裹，避免每次渲染重建引用导致下游 useCallback/useEffect 依赖抖动
    const items = useMemo(() => (Array.isArray(rawItems) ? rawItems : []), [rawItems])
    const { t } = useTranslation()
    const wrapperRef = useRef<HTMLDivElement>(null)
    const [columns, setColumns] = useState(4)
    const [hoveredId, setHoveredId] = useState<string | null>(null)
    const [focusedIndex, setFocusedIndex] = useState<number>(-1)
    // P1-U10：failedImages 状态管理 + items 变化时自动清空
    const { failedImages, markFailed } = useFailedImages(items)
    // U-G16：触屏设备无 hover 事件，需始终显示快捷操作按钮
    const [isTouchDevice, setIsTouchDevice] = useState(false)
    const gap = 16

    // P1-03：缩略图分级加载——首屏用低质量（64px），滚动停止 300ms 后替换为标准质量（320px）
    // highQualityIds 记录已切换到标准质量的文件 id；滚动中不切换，避免抖动
    const [highQualityIds, setHighQualityIds] = useState<Set<string>>(new Set())
    const scrollTimerRef = useRef<number | null>(null)
    // 通过 rangeChanged 跟踪当前可视区间，用于触发标准质量升级
    const visibleRangeRef = useRef<ListRange>({ startIndex: 0, endIndex: 0 })

    // P1-03 / 高清档位路径推导抽为模块级纯函数 toLowQualityUrl / toHighQualityUrl
    //（含游戏原生缩略图路径守卫），推导返回 null 时直接使用原 thumbnail 路径显示。

    // U-G16：挂载时检测触屏能力（matchMedia 优先，回退到 ontouchstart）
    useEffect(() => {
      const hoverNone = window.matchMedia?.('(hover: none)').matches
      const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0
      setIsTouchDevice(hoverNone || hasTouch)
    }, [])

    // 选中态 Set：O(1) 查找
    const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

    // 响应式列数：监听 wrapper 尺寸变化
    useEffect(() => {
      const update = () => {
        const width = wrapperRef.current?.clientWidth || window.innerWidth
        setColumns(getResponsiveColumns(width, DEFAULT_COLUMNS_BREAKPOINTS))
      }
      update()
      window.addEventListener('resize', update)
      const observer = new ResizeObserver(update)
      if (wrapperRef.current) observer.observe(wrapperRef.current)
      return () => {
        window.removeEventListener('resize', update)
        observer.disconnect()
      }
    }, [])

    // P1-03：滚动停止 300ms 后，把当前可见项切换到标准质量
    const triggerHighQualityUpgrade = useCallback(() => {
      if (scrollTimerRef.current !== null) {
        window.clearTimeout(scrollTimerRef.current)
      }
      scrollTimerRef.current = window.setTimeout(() => {
        const { startIndex, endIndex } = visibleRangeRef.current
        if (endIndex <= startIndex) return
        setHighQualityIds((prev) => {
          const next = new Set(prev)
          for (let i = startIndex; i <= endIndex; i++) {
            const file = items[i]
            if (file?.thumbnail && !next.has(file.id)) {
              next.add(file.id)
            }
          }
          return next
        })
      }, 300)
    }, [items])

    // 高分屏下后台预生成高清缩略图（512px），仅对可见区间前 20 项触发
    useEffect(() => {
      if (!HIGH_DPI_MODE) return
      const generate = window.electronAPI?.thumbnail?.generate
      if (!generate) return
      const { startIndex, endIndex } = visibleRangeRef.current
      const upper = Math.min(endIndex, startIndex + 20)
      for (let i = startIndex; i <= upper; i++) {
        const file = items[i]
        if (!file?.thumbnail) continue
        generate(file.file_path, 'high').catch(() => {})
      }
    }, [items, columns])

    // 清理滚动定时器
    useEffect(() => {
      return () => {
        if (scrollTimerRef.current !== null) {
          window.clearTimeout(scrollTimerRef.current)
        }
      }
    }, [])

    // 分页页脚：仅在启用无限滚动（传入 onEndReached）且已有内容时展示
    // 加载中优先于"没有更多"，避免翻页途中先闪一下结束文案
    const footerText =
      !onEndReached || items.length === 0
        ? null
        : loadingMore
          ? t('gallery.virtualGrid.loadingMore')
          : hasMore
            ? null
            : t('gallery.virtualGrid.noMore')

    // 自定义 List 组件：响应式 grid 布局
    // React 19 允许 ref 作为普通 prop，无需 forwardRef
    const gridComponents = useMemo(
      () => ({
        List: ({ children, className, style, ref, ...rest }: GridListProps) => (
          <div
            ref={ref}
            className={className}
            style={{
              ...style,
              display: 'grid',
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              gap: `${gap}px`
            }}
            {...rest}
          >
            {children}
          </div>
        ),
        Footer: () =>
          footerText === null ? null : (
            <div
              className="py-4 text-center text-xs"
              style={{ color: 'var(--text-secondary)' }}
              role="status"
              aria-live="polite"
            >
              {footerText}
            </div>
          )
      }),
      [columns, gap, footerText]
    )

    // 键盘导航：保留 ↑↓←→/Home/End/Enter/Space
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (items.length === 0) return
        let nextIndex: number
        switch (e.key) {
          case 'ArrowRight':
            nextIndex = Math.min(items.length - 1, focusedIndex + 1)
            break
          case 'ArrowLeft':
            nextIndex = Math.max(0, focusedIndex - 1)
            break
          case 'ArrowDown':
            nextIndex = Math.min(items.length - 1, focusedIndex + columns)
            break
          case 'ArrowUp':
            nextIndex = Math.max(0, focusedIndex - columns)
            break
          case 'Home':
            nextIndex = 0
            break
          case 'End':
            nextIndex = items.length - 1
            break
          default:
            if (e.key === 'Enter' || e.key === ' ') {
              if (focusedIndex >= 0 && focusedIndex < items.length) {
                onSelect(items[focusedIndex].id, focusedIndex, e)
              }
            }
            return
        }
        e.preventDefault()
        setFocusedIndex(nextIndex)
        const virtuoso = ref as React.MutableRefObject<VirtuosoGridHandle | null>
        virtuoso.current?.scrollToIndex(nextIndex)
      },
      [focusedIndex, items, columns, onSelect, ref]
    )

    useEffect(() => {
      if (focusedIndex >= items.length) setFocusedIndex(-1)
    }, [items.length, focusedIndex])

    return (
      <div
        ref={wrapperRef}
        className="flex-1 min-h-0 overflow-hidden"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        role="grid"
        aria-label={t('gallery.virtualGrid.ariaLabel')}
      >
        <VirtuosoGrid
          ref={ref}
          data={items}
          computeItemKey={(_, file) => file.id}
          components={gridComponents}
          overscan={150}
          increaseViewportBy={{ top: 100, bottom: 100 }}
          endReached={onEndReached}
          rangeChanged={(range) => {
            visibleRangeRef.current = range
            triggerHighQualityUpgrade()
          }}
          itemContent={(index, file) => {
            const isSelected = selectedSet.has(file.id)
            // 视频文件无缩略图时，不得使用原视频文件作为 <img> 源（加载视频进 img 必触发
            // onError 显示警告图标）。仅在确有 thumbnail 时才用文件源；图片类型才允许回退
            // 到原文件路径，保证无缩略图的视频稳定降级为视频占位图标而非裂图。
            const standardUrl = toFileUrl(
              file.file_type === 'video' ? file.thumbnail : file.thumbnail || file.file_path
            )
            const useHighQuality = highQualityIds.has(file.id)
            const lowUrl = toLowQualityUrl(file.thumbnail)
            const highUrl = HIGH_DPI_MODE ? toHighQualityUrl(file.thumbnail) : null
            const thumbUrl =
              useHighQuality || !lowUrl
                ? standardUrl
                : highUrl
                  ? toFileUrl(highUrl)
                  : toFileUrl(lowUrl)
            const isFocused = index === focusedIndex
            const hasError = failedImages.has(file.id)
            const isMissing = file.is_missing === true
            // 损坏文件容错：损坏文件不显示缩略图，仅显示占位图 + 损坏角标
            const isCorrupted = file.is_corrupted === true
            const showThumb = !isCorrupted && !!thumbUrl && !hasError
            return (
              <div
                className={`media-card aspect-square ${isSelected ? 'ring-2 ring-offset-2' : ''}`}
                style={{
                  background: 'var(--bg-tertiary)',
                  ...(isSelected
                    ? ({ '--tw-ring-color': 'var(--accent)' } as React.CSSProperties)
                    : {}),
                  outline: isFocused ? '2px solid var(--accent)' : 'none',
                  outlineOffset: '2px',
                  opacity: isMissing ? 0.45 : 1
                }}
                onClick={(e) => onSelect(file.id, index, e)}
                onMouseEnter={() => {
                  setHoveredId(file.id)
                  onHover(file.id)
                }}
                onMouseLeave={() => {
                  setHoveredId(null)
                  onHover(null)
                }}
                onContextMenu={(e) => onContextMenu(e, file)}
                onFocus={() => setFocusedIndex(index)}
                tabIndex={isFocused ? 0 : -1}
                role="gridcell"
                aria-selected={isSelected}
              >
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
                      data-media-id={file.id}
                      onError={() => {
                        if (!useHighQuality && lowUrl) {
                          setHighQualityIds((prev) => new Set(prev).add(file.id))
                        } else {
                          markFailed(file.id)
                        }
                      }}
                    />
                  ) : null}
                  <MediaThumbPlaceholder
                    fileType={file.file_type}
                    hasError={hasError || isCorrupted}
                    visible={!showThumb}
                  />

                  {hoveredId === file.id && (
                    <>
                      <div
                        className="absolute inset-0 flex flex-col justify-end p-3"
                        style={{
                          background: 'linear-gradient(transparent 50%, var(--overlay-bg-strong))'
                        }}
                      >
                        <p className="text-[var(--text-on-overlay)] text-xs font-medium ellipsis-2">
                          {file.file_name}
                        </p>
                        <p className="text-[var(--text-on-overlay-secondary)] text-xs">
                          {formatFileSize(file.file_size)}
                        </p>
                      </div>
                      <MediaCardActions
                        file={file}
                        onEdit={onEdit}
                        onFavorite={onFavorite}
                        onDelete={onDelete}
                        variant="hover"
                      />
                    </>
                  )}

                  {isTouchDevice && hoveredId !== file.id && (
                    <MediaCardActions
                      file={file}
                      onEdit={onEdit}
                      onFavorite={onFavorite}
                      onDelete={onDelete}
                      variant="touch"
                    />
                  )}

                  {isTouchDevice && hoveredId !== file.id && (
                    <div
                      className="absolute inset-x-0 bottom-0 left-0 right-8 p-2"
                      style={{ background: 'var(--overlay-gradient-bottom)' }}
                    >
                      <p className="text-[var(--text-on-overlay)] text-xs font-medium truncate">
                        {file.file_name}
                      </p>
                    </div>
                  )}

                  {file.is_favorite && hoveredId !== file.id && !isTouchDevice && (
                    <div className="absolute top-2 right-2">
                      <IconFavorite size={16} filled />
                    </div>
                  )}

                  {file.duration && (
                    <div
                      className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded text-xs font-medium text-[var(--text-on-overlay)]"
                      style={{ background: 'var(--overlay-bg-strong)' }}
                    >
                      {Math.floor(file.duration / 60)}:{String(file.duration % 60).padStart(2, '0')}
                    </div>
                  )}
                </div>
              </div>
            )
          }}
        />
      </div>
    )
  }
)

VirtualImageGridComponent.displayName = 'VirtualImageGrid'

export const VirtualImageGrid = React.memo(VirtualImageGridComponent)
