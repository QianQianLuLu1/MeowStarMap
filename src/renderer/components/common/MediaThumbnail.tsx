import React, { useEffect, useState } from 'react'
import { MissingBadge } from './MissingBadge'
import { CorruptedBadge } from './CorruptedBadge'
import { MediaThumbPlaceholder } from '../gallery/MediaThumbPlaceholder'

interface MediaThumbnailProps {
  /** 缩略图 URL（可为空，为空时显示占位图标） */
  src: string | null | undefined
  /** 文件名（用于 alt 文本） */
  alt: string
  /** 文件类型，决定占位图标 */
  fileType: 'image' | 'video'
  /** 是否丢失（显示丢失角标） */
  isMissing?: boolean
  /** 损坏文件容错：是否损坏（显示损坏角标，损坏时不显示缩略图只显示占位图） */
  isCorrupted?: boolean
  /** 损坏文件容错：失败原因摘要，hover 时显示 tooltip */
  corruptedReason?: string | null
  /** MissingBadge/CorruptedBadge 尺寸，默认 'md' */
  badgeSize?: 'md' | 'sm'
  /** 容器类名（追加到外层 div 之上） */
  className?: string
  /** img 元素的类名（默认 'absolute inset-0 w-full h-full object-cover'） */
  imgClassName?: string
  /**
   * 低清回退源（可选，fix-thumbnail-loading-latency 节点4）：
   * src 加载失败且提供本源时切换显示一次（如 standard 404 时回退 64px _low），
   * fallback 再失败才显示占位（防循环）。未提供/为 null 时保持既有行为（直接显示占位）。
   */
  fallbackSrc?: string | null
  /** 点击回调 */
  onClick?: () => void
  /** 右键回调 */
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void
}

/**
 * 公共媒体缩略图组件
 *
 * 设计目标：统一包装 img + MissingBadge + CorruptedBadge + MediaThumbPlaceholder + onError 错误处理，
 * 消除 8 处重复实现的 `<img className="w-full h-full object-cover" />` 模式。
 *
 * 该组件确保：
 *   1. 缩略图加载失败时显示警告图标（而非破碎图标）
 *   2. 丢失文件显示角标
 *   3. 损坏文件显示损坏角标 + 占位图（不再尝试加载缩略图，避免重复失败）
 *   4. 视频文件未加载时显示视频图标
 *   5. 无障碍：alt 文本、aria-label
 *
 * 使用方式：
 *   import { MediaThumbnail } from '@/components/common/MediaThumbnail'
 *   <MediaThumbnail
 *     src={file.thumbnail}
 *     alt={file.file_name}
 *     fileType={file.file_type}
 *     isMissing={!!file.is_missing}
 *     isCorrupted={!!file.is_corrupted}
 *     corruptedReason={file.corrupted_reason}
 *     onClick={() => onSelect(file)}
 *     onContextMenu={(e) => onContextMenu(e, file)}
 *   />
 */
export const MediaThumbnail: React.FC<MediaThumbnailProps> = ({
  src,
  alt,
  fileType,
  isMissing = false,
  isCorrupted = false,
  corruptedReason = null,
  badgeSize = 'md',
  className = '',
  imgClassName = 'absolute inset-0 w-full h-full object-cover',
  fallbackSrc = null,
  onClick,
  onContextMenu
}) => {
  // 加载错误状态：src 非空但加载失败时显示警告图标
  const [hasError, setHasError] = useState(false)
  // 是否已切换到 fallbackSrc（仅切换一次；src 变化时复位，避免复用卡片沿用旧档位）
  const [usedFallback, setUsedFallback] = useState(false)
  useEffect(() => {
    setUsedFallback(false)
  }, [src])

  // 当前生效源：src 失败且提供了 fallbackSrc 时切换（fallbackSrc 为 null 等价于未提供）
  const activeSrc = usedFallback && fallbackSrc ? fallbackSrc : src
  // 损坏文件容错：损坏文件不显示缩略图（避免再次触发解码失败），直接显示占位图
  // 非损坏文件正常逻辑：有源且未出错时显示缩略图
  const showThumb = !isCorrupted && !!activeSrc && !hasError

  return (
    <div
      className={`relative w-full h-full overflow-hidden ${className}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {/* 丢失角标 */}
      {isMissing && <MissingBadge size={badgeSize} />}

      {/* 损坏文件容错：损坏角标（橙色，区分丢失的红色） */}
      {isCorrupted && <CorruptedBadge size={badgeSize} reason={corruptedReason} />}

      {/* 缩略图（损坏文件跳过加载） */}
      {showThumb && (
        <img
          src={activeSrc ?? undefined}
          alt={alt}
          className={imgClassName}
          loading="lazy"
          onError={() => {
            // 档位回退链：首次失败且有低清可退 → 切换 fallbackSrc；回退后再失败（或无低清）→ 终止为占位
            if (!usedFallback && fallbackSrc && !hasError) {
              setUsedFallback(true)
            } else {
              setHasError(true)
            }
          }}
        />
      )}

      {/* 占位/失败图标（损坏文件、无缩略图或加载失败时显示） */}
      <MediaThumbPlaceholder
        fileType={fileType}
        hasError={hasError || isCorrupted}
        variant="overlay"
        visible={!showThumb}
      />
    </div>
  )
}
