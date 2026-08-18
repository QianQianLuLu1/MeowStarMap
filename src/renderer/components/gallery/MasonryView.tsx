import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso } from 'react-virtuoso'
import { toFileUrl } from '../../utils/file'
import { MissingBadge } from '../common/MissingBadge'
import { CorruptedBadge } from '../common/CorruptedBadge'
import { MediaThumbPlaceholder } from './MediaThumbPlaceholder'
import { useFailedImages } from '../../hooks/useFailedImages'
import type { MediaFile } from '../../stores/mediaStore'

interface MasonryViewProps {
  files: MediaFile[]
  selectedIds: string[]
  onSelect: (id: string, index: number, event: React.MouseEvent) => void
  onContextMenu: (event: React.MouseEvent, file: MediaFile) => void
}

const GAP = 16
const MIN_COL_WIDTH = 220
// 每个虚拟"段"的高度：将瀑布流按垂直带切片，每个 band 作为一个 Virtuoso item 渲染
// band 内的 item 仍用绝对定位保留真瀑布流布局
const BAND_HEIGHT = 600

interface ItemLayout {
  index: number
  file: MediaFile
  x: number
  y: number
  width: number
  height: number
}

interface Band {
  start: number
  height: number
  items: ItemLayout[]
}

function getColumns(width: number): number {
  if (width <= 0) return 1
  return Math.max(1, Math.floor((width + GAP) / (MIN_COL_WIDTH + GAP)))
}

// 性能重构 v3 改造项一：MasonryView 迁移至 react-virtuoso
// 策略：保留原贪心最短列算法计算真瀑布流位置，按垂直 band 切片交给 Virtuoso 虚拟化
// - 每个 band 高度 BAND_HEIGHT，包含所有与该 y 区间重叠的 item
// - band 内 item 绝对定位到 band 顶部，保留瀑布流视觉效果
// - 保留：多选、右键菜单、丢失文件角标、文件名条
export const MasonryView: React.FC<MasonryViewProps> = ({
  files,
  selectedIds,
  onSelect,
  onContextMenu
}) => {
  const { t } = useTranslation()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const { failedImages, markFailed } = useFailedImages(files)

  // 监听容器尺寸
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  // 计算完整 masonry 布局：贪心算法放入当前最短列
  const layouts = useMemo<ItemLayout[]>(() => {
    const cols = getColumns(width)
    if (cols <= 0 || files.length === 0) return []

    const colWidth = (width - (cols - 1) * GAP) / cols
    const colHeights = new Array(cols).fill(0)
    const result: ItemLayout[] = []

    files.forEach((file, index) => {
      const aspect = file.width && file.height ? file.height / file.width : 1
      const clampedAspect = Math.max(0.3, Math.min(3, aspect))
      const itemHeight = colWidth * clampedAspect

      let minCol = 0
      for (let c = 1; c < cols; c++) {
        if (colHeights[c] < colHeights[minCol]) minCol = c
      }

      const x = minCol * (colWidth + GAP)
      const y = colHeights[minCol]

      result.push({ index, file, x, y, width: colWidth, height: itemHeight })
      colHeights[minCol] = y + itemHeight + GAP
    })

    return result
  }, [files, width])

  // 按垂直 band 切片：每个 band 包含所有与 [start, start+BAND_HEIGHT) 重叠的 item
  const bands = useMemo<Band[]>(() => {
    if (layouts.length === 0) return []
    const maxBottom = layouts.reduce((max, item) => Math.max(max, item.y + item.height), 0)
    const bandCount = Math.ceil(maxBottom / BAND_HEIGHT)
    const result: Band[] = []

    for (let i = 0; i < bandCount; i++) {
      const start = i * BAND_HEIGHT
      const end = start + BAND_HEIGHT
      const bandItems = layouts.filter((item) => {
        return item.y + item.height >= start && item.y < end
      })
      if (bandItems.length === 0) continue
      const bandBottom = bandItems.reduce((max, item) => Math.max(max, item.y + item.height), 0)
      result.push({
        start,
        height: Math.max(BAND_HEIGHT, bandBottom - start),
        items: bandItems
      })
    }

    return result
  }, [layouts])

  const handleClick = useCallback(
    (file: MediaFile, index: number, e: React.MouseEvent) => {
      onSelect(file.id, index, e)
    },
    [onSelect]
  )

  return (
    <div
      ref={wrapperRef}
      className="flex-1 min-h-0 overflow-hidden"
      role="feed"
      aria-label={t('gallery.masonry.ariaLabel')}
    >
      <Virtuoso
        data={bands}
        computeItemKey={(index) => `band-${bands[index]?.start ?? index}`}
        defaultItemHeight={BAND_HEIGHT}
        overscan={BAND_HEIGHT * 2}
        increaseViewportBy={{ top: BAND_HEIGHT, bottom: BAND_HEIGHT }}
        itemContent={(_, band) => (
          <div style={{ position: 'relative', height: band.height, marginBottom: 0 }}>
            {band.items.map((item) => {
              const { file, index, x, y, width: itemWidth, height: itemHeight } = item
              const thumbUrl = toFileUrl(file.thumbnail || file.file_path)
              const isSelected = selectedSet.has(file.id)
              const isMissing = file.is_missing === true
              // 损坏文件容错：损坏文件不显示缩略图，仅显示占位图 + 损坏角标
              const isCorrupted = file.is_corrupted === true
              const hasError = failedImages.has(file.id)
              const showThumb = !isCorrupted && !!thumbUrl && !hasError
              return (
                <div
                  key={file.id}
                  className={`media-card ${isSelected ? 'ring-2 ring-offset-2' : ''}`}
                  style={{
                    position: 'absolute',
                    left: x,
                    top: y - band.start,
                    width: itemWidth,
                    height: itemHeight,
                    background: 'var(--bg-tertiary)',
                    opacity: isMissing ? 0.45 : 1,
                    ...(isSelected
                      ? ({ '--tw-ring-color': 'var(--accent)' } as React.CSSProperties)
                      : {})
                  }}
                  onClick={(e) => handleClick(file, index, e)}
                  onContextMenu={(e) => onContextMenu(e, file)}
                >
                  <div
                    className="relative w-full h-full overflow-hidden rounded-xl"
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
                  <div
                    className="absolute bottom-0 left-0 right-0 p-2 text-xs truncate"
                    style={{
                      color: 'var(--text-secondary)',
                      background: 'var(--overlay-gradient-bottom)'
                    }}
                  >
                    {file.file_name}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      />
    </div>
  )
}
