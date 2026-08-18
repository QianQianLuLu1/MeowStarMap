import React, { useState } from 'react'
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
  onClick,
  onContextMenu
}) => {
  // 加载错误状态：src 非空但加载失败时显示警告图标
  const [hasError, setHasError] = useState(false)
  // 损坏文件容错：损坏文件不显示缩略图（避免再次触发解码失败），直接显示占位图
  // 非损坏文件正常逻辑：有 src 且未出错时显示缩略图
  const showThumb = !isCorrupted && !!src && !hasError

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
          src={src}
          alt={alt}
          className={imgClassName}
          loading="lazy"
          onError={() => setHasError(true)}
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
