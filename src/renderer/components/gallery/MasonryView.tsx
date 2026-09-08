import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
// 复用成熟开源方案 masonic 的布局内核（usePositioner / useResizeObserver / useMasonry），
// 仅自行提供「容器内滚动」的 scrollTop/height 数据源，避免自实现绝对定位与虚拟化。
import { useMasonry, usePositioner, useResizeObserver } from 'masonic'
import { toFileUrl } from '../../utils/file'
import { MissingBadge } from '../common/MissingBadge'
import { CorruptedBadge } from '../common/CorruptedBadge'
import { MediaThumbPlaceholder } from './MediaThumbPlaceholder'
import { MediaCheckbox } from './MediaCheckbox'
import { useFailedImages } from '../../hooks/useFailedImages'
import { useContainerSize } from '../../hooks/useContainerSize'
import type { MediaFile } from '../../stores/mediaStore'

interface MasonryViewProps {
  files: MediaFile[]
  /** 可选；缺失时默认空数组，不影响渲染 */
  selectedIds?: string[]
  /** 可选；缺失时点击 no-op */
  onSelect?: (id: string, index: number, event: React.MouseEvent) => void
  /** 可选；缺失时右键 no-op */
  onContextMenu?: (event: React.MouseEvent, file: MediaFile) => void
  /** 可选；true 时卡片渲染可见勾选框（默认 false，保证既有调用点行为不变） */
  multiSelectMode?: boolean
  /** 可选；勾选框点击回调（与卡片点击解耦，勾选框点击不会冒泡到卡片） */
  onToggleSelection?: (id: string) => void
}

const GAP = 16
const MIN_COL_WIDTH = 220

// 复用原断点逻辑，保证与 Grid 视图一致的响应式列数
function getColumns(width: number): number {
  if (width <= 0) return 1
  return Math.max(1, Math.floor((width + GAP) / (MIN_COL_WIDTH + GAP)))
}

interface MasonryContextValue {
  selectedSet: Set<string>
  onSelect: (id: string, index: number, event: React.MouseEvent) => void
  onContextMenu: (event: React.MouseEvent, file: MediaFile) => void
  failedImages: Set<string>
  markFailed: (id: string) => void
  multiSelectMode: boolean
  onToggleSelection: (id: string) => void
}

const MasonryContext = React.createContext<MasonryContextValue | null>(null)

function MasonryCard({ index, data }: { index: number; width: number; data: MediaFile }) {
  const ctx = React.useContext(MasonryContext)
  if (!ctx) return null
  const { selectedSet, onSelect, onContextMenu, failedImages, markFailed, multiSelectMode } = ctx
  const onToggleSelection = ctx.onToggleSelection

  const file = data
  const thumbUrl = toFileUrl(file.thumbnail || file.file_path)
  const isSelected = selectedSet.has(file.id)
  const isMissing = file.is_missing === true
  const isCorrupted = file.is_corrupted === true
  const hasError = failedImages.has(file.id)
  const showThumb = !isCorrupted && !!thumbUrl && !hasError

  const aspect = file.width && file.height ? file.height / file.width : 1
  const clampedAspect = Math.max(0.3, Math.min(3, aspect))

  return (
    <div
      data-media-id={file.id}
      className={`media-card relative ${isSelected ? 'ring-2 ring-offset-2' : ''}`}
      style={{
        width: '100%',
        background: 'var(--bg-tertiary)',
        opacity: isMissing ? 0.45 : 1,
        cursor: 'pointer',
        ...(isSelected ? ({ '--tw-ring-color': 'var(--accent)' } as React.CSSProperties) : {})
      }}
      onClick={(e) => onSelect(file.id, index, e)}
      onContextMenu={(e) => onContextMenu(e, file)}
    >
      {multiSelectMode && (
        <MediaCheckbox
          checked={isSelected}
          onChange={() => onToggleSelection(file.id)}
          label={file.file_name}
          className="absolute top-2 left-2 z-10"
        />
      )}
      <div
        className="relative w-full overflow-hidden rounded-xl"
        style={{ background: 'var(--bg-tertiary)', aspectRatio: `1 / ${clampedAspect}` }}
      >
        {isMissing && <MissingBadge />}
        {isCorrupted && <CorruptedBadge reason={file.corrupted_reason} />}
        {showThumb ? (
          <img
            data-testid="thumb"
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
      <div
        className="absolute bottom-0 left-0 right-0 p-2 text-xs truncate"
        style={{ color: 'var(--text-secondary)', background: 'var(--overlay-gradient-bottom)' }}
      >
        {file.file_name}
      </div>
    </div>
  )
}

export const MasonryView: React.FC<MasonryViewProps> = ({
  files,
  selectedIds,
  onSelect,
  onContextMenu,
  multiSelectMode = false,
  onToggleSelection
}) => {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  // 复用项目已有 hook 获取容器可见宽高（clientWidth/Height，已排除滚动条）
  const { width, height } = useContainerSize(scrollRef)
  const [scrollTop, setScrollTop] = useState(0)
  const [isScrolling, setIsScrolling] = useState(false)
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // —— 参数校验（不提前 return，保证所有 Hook 调用顺序稳定）——
  const safeFiles = useMemo<MediaFile[]>(() => {
    if (!Array.isArray(files)) {
      console.warn('[MasonryView] files must be an array; rendered empty container')
      return []
    }
    return files.filter((f) => f && typeof f.id === 'string')
  }, [files])

  const safeOnSelect = typeof onSelect === 'function' ? onSelect : () => {}
  const safeOnContextMenu = typeof onContextMenu === 'function' ? onContextMenu : () => {}
  const safeOnToggleSelection =
    typeof onToggleSelection === 'function' ? onToggleSelection : () => {}

  const { failedImages, markFailed } = useFailedImages(safeFiles)
  const selectedSet = useMemo(() => new Set(selectedIds || []), [selectedIds])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setScrollTop(el.scrollTop)
    setIsScrolling(true)
    if (scrollTimer.current) clearTimeout(scrollTimer.current)
    // 滚动停止后关闭 isScrolling，恢复 pointer-events
    scrollTimer.current = setTimeout(() => setIsScrolling(false), 120)
  }, [])

  useEffect(() => {
    return () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
    }
  }, [])

  const columnCount = getColumns(width)
  // 仅当 files 或容器宽度变化时重建 positioner（清空缓存），避免索引错位（masonic dev 守卫）
  const positioner = usePositioner(
    {
      width: width || 1,
      columnCount,
      columnGutter: GAP,
      rowGutter: GAP
    },
    [safeFiles, width]
  )
  const resizeObserver = useResizeObserver(positioner)

  const masonry = useMasonry({
    positioner,
    resizeObserver,
    items: safeFiles,
    height: height || 0,
    scrollTop,
    isScrolling,
    itemKey: (data) => data.id,
    overscanBy: 3,
    render: MasonryCard
  })

  return (
    <MasonryContext.Provider
      value={{
        selectedSet,
        onSelect: safeOnSelect,
        onContextMenu: safeOnContextMenu,
        failedImages,
        markFailed,
        multiSelectMode,
        onToggleSelection: safeOnToggleSelection
      }}
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-auto"
        role="feed"
        aria-label={t('gallery.masonry.ariaLabel')}
      >
        {masonry}
      </div>
    </MasonryContext.Provider>
  )
}
