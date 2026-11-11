import React, { useState } from 'react'
import type { NetworkImageTemplateKind } from '../../../shared/types/electron-api'
import { useReferenceImage } from '../../hooks/useReferenceImage'

interface ReferenceImageProps {
  kind: NetworkImageTemplateKind
  /** 资源取值（正安全整数；非法时 hook 静默降级占位） */
  id: number
  /** 显示尺寸（px），默认 24 */
  size?: number
  className?: string
  alt?: string
}

/**
 * 参考数据 CDN 图片的行内缩略图（阶段 5）：挂载时按需解析、lazy 解码，
 * 无 src / 加载失败回退同尺寸占位，不影响其余行与其余功能。
 */
export const ReferenceImage: React.FC<ReferenceImageProps> = ({
  kind,
  id,
  size = 24,
  className,
  alt = ''
}) => {
  const { src } = useReferenceImage(kind, id)
  const [failed, setFailed] = useState(false)

  // kind/id 变化时重置失败态：新资源重新尝试，旧资源的失败不牵连新图
  const [prevKey, setPrevKey] = useState(`${kind}:${id}`)
  const key = `${kind}:${id}`
  if (prevKey !== key) {
    setPrevKey(key)
    setFailed(false)
  }

  if (!src || failed) {
    return (
      <span
        data-testid="reference-image-placeholder"
        aria-hidden="true"
        className={`inline-block flex-shrink-0 rounded bg-tertiary ${className ?? ''}`}
        style={{ width: size, height: size }}
      />
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={`inline-block flex-shrink-0 rounded object-cover ${className ?? ''}`}
      onError={() => setFailed(true)}
    />
  )
}
