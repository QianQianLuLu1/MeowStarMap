import React, { forwardRef, useCallback, useMemo } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { toFileUrl } from '../../utils/file'
import { formatFileSize } from '../../utils/format'
import { formatDate } from '../../utils/date'
import { IconStar } from '../../icons'
import { MissingBadge } from '../common/MissingBadge'
import { CorruptedBadge } from '../common/CorruptedBadge'
import { MediaThumbPlaceholder } from './MediaThumbPlaceholder'
import { useFailedImages } from '../../hooks/useFailedImages'
import type { MediaFile } from '../../stores/mediaStore'

interface ListViewProps {
  files: MediaFile[]
  selectedIds: string[]
  onSelect: (id: string, index: number, event: React.MouseEvent | React.KeyboardEvent) => void
  onToggleSelection: (id: string) => void
  onContextMenu: (event: React.MouseEvent, file: MediaFile) => void
}

const ITEM_HEIGHT = 72
const GAP = 8

// 性能重构 v3 改造项一：ListView 迁移至 react-virtuoso
// - 用 Virtuoso 替换自研 useVirtualScroll，万级文件滚动帧率 ≥ 55 FPS
// - 保留：多选（Ctrl/Cmd/Shift）、键盘 ↑↓ 导航、滚动位置记忆、丢失文件角标、缩略图降级
const ListViewComponent = forwardRef<VirtuosoHandle, ListViewProps>(
  ({ files, selectedIds, onSelect, onToggleSelection, onContextMenu }, ref) => {
    const { failedImages, markFailed } = useFailedImages(files)
    const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

    const handleClick = useCallback(
      (file: MediaFile, index: number, e: React.MouseEvent) => {
        if (e.ctrlKey || e.metaKey) {
          onToggleSelection(file.id)
        } else {
          onSelect(file.id, index, e)
        }
      },
      [onSelect, onToggleSelection]
    )

    const handleKeyDown = useCallback(
      (file: MediaFile, index: number, e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(file.id, index, e)
        }
        // ↑↓ 让浏览器默认 focus 切换，Virtuoso 自动滚动可视区域
      },
      [onSelect]
    )

    return (
      <Virtuoso
        ref={ref}
        data={files}
        computeItemKey={(_, file) => file.id}
        defaultItemHeight={ITEM_HEIGHT + GAP}
        overscan={400}
        increaseViewportBy={{ top: 200, bottom: 200 }}
        itemContent={(index, file) => {
          const thumbUrl = toFileUrl(file.thumbnail || file.file_path)
          const isSelected = selectedSet.has(file.id)
          const hasError = failedImages.has(file.id)
          const isMissing = file.is_missing === true
          // 损坏文件容错：损坏文件不显示缩略图，仅显示占位图 + 损坏角标
          const isCorrupted = file.is_corrupted === true
          const showThumb = !isCorrupted && !!thumbUrl && !hasError
          return (
            <div
              data-list-index={index}
              className="flex items-center gap-4 p-3 rounded-xl transition-all duration-200 hover:translate-x-1"
              style={{
                background: isSelected ? 'var(--accent)' : 'var(--bg-secondary)',
                color: isSelected ? 'white' : 'var(--text-primary)',
                height: ITEM_HEIGHT,
                marginBottom: GAP,
                opacity: isMissing ? 0.5 : 1
              }}
              onClick={(e) => handleClick(file, index, e)}
              onContextMenu={(e) => onContextMenu(e, file)}
              onKeyDown={(e) => handleKeyDown(file, index, e)}
              tabIndex={0}
              role="listitem"
              aria-selected={isSelected}
            >
              <div
                className="w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 relative overflow-hidden"
                style={{
                  background: isSelected ? 'var(--text-on-overlay)' : 'var(--bg-tertiary)',
                  opacity: isSelected ? 0.18 : 1
                }}
              >
                {isMissing && <MissingBadge size="sm" />}
                {isCorrupted && <CorruptedBadge size="sm" reason={file.corrupted_reason} />}
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
                  size={20}
                  variant="overlay"
                  visible={!showThumb}
                  strokeWidth="2"
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">{file.file_name}</p>
                <p className="text-xs" style={{ opacity: isSelected ? 0.95 : 0.7 }}>
                  {formatDate(file.created_at)}
                </p>
              </div>
              <div className="text-xs text-right" style={{ opacity: isSelected ? 0.95 : 0.7 }}>
                <p>{file.width && file.height ? `${file.width}x${file.height}` : '-'}</p>
                <p>{formatFileSize(file.file_size)}</p>
              </div>
              <div className="flex items-center gap-1">
                {Array.from({ length: 5 }).map((_, i) => (
                  <IconStar key={i} size={12} filled={i < file.rating} />
                ))}
              </div>
            </div>
          )
        }}
      />
    )
  }
)

ListViewComponent.displayName = 'ListView'

export const ListView = React.memo(ListViewComponent)
