import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useZoomable } from '../../hooks/useZoomable'
import { IconReset } from '../../icons'

/**
 * P1-U12：抽取 ZoomableContainer 共享组件，消除 DetailPage.ZoomableImage 与 EditorPage.ZoomablePreview 的重复。
 * 封装 useZoomable hook 调用 + transform 计算 + transition + reset 按钮。
 *
 * 差异通过 props 暴露：
 * - maxZoom：最大缩放倍数
 * - resetVariant：'icon'（图标按钮）| 'text'（百分比 + 复位文字）
 * - onClick：可选点击回调（自动带拖拽检测，拖拽距离 > 5px 忽略 click）
 * - children：渲染内容（图片/视频等）
 * - containerClassName / containerStyle：容器样式覆盖
 */
interface ZoomableContainerProps {
  maxZoom?: number
  resetVariant?: 'icon' | 'text'
  onClick?: () => void
  children: React.ReactNode
  containerClassName?: string
  containerStyle?: React.CSSProperties
  /** aria-label，用于无障碍 */
  ariaLabel?: string
}

export const ZoomableContainer: React.FC<ZoomableContainerProps> = ({
  maxZoom = 5,
  resetVariant = 'icon',
  onClick,
  children,
  containerClassName,
  containerStyle,
  ariaLabel
}) => {
  const { t } = useTranslation()
  const { scale, position, dragging, dragStartPos, containerRef, handlers, reset } = useZoomable({
    maxZoom
  })

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onClick) return
      // U-G1：拖拽后释放会触发 click，检查移动距离避免误触发
      if (dragStartPos.current) {
        const dx = Math.abs(e.clientX - dragStartPos.current.x)
        const dy = Math.abs(e.clientY - dragStartPos.current.y)
        dragStartPos.current = null
        if (dx > 5 || dy > 5) return
      }
      onClick()
    },
    // dragStartPos 为 useZoomable 返回的稳定 ref，列入依赖满足 exhaustive-deps
    [onClick, dragStartPos]
  )

  const cursor = scale > 1 ? (dragging ? 'grabbing' : 'grab') : onClick ? 'zoom-in' : 'default'

  return (
    <div
      ref={containerRef}
      className={containerClassName}
      style={{ ...containerStyle, cursor }}
      {...handlers}
      onClick={handleClick}
      role={onClick ? 'button' : undefined}
      aria-label={ariaLabel}
      tabIndex={onClick ? 0 : undefined}
    >
      <div
        style={{
          transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
          transition: dragging ? 'none' : 'transform 200ms ease-out',
          transformOrigin: 'center center'
        }}
        className="max-w-full max-h-full"
      >
        {children}
      </div>
      {scale > 1 && resetVariant === 'icon' && (
        <button
          className="absolute bottom-4 right-4 icon-btn"
          onClick={(e) => {
            e.stopPropagation()
            reset()
          }}
          title={t('detail.zoomable.resetZoom')}
          aria-label={t('detail.zoomable.resetZoom')}
        >
          <IconReset size={16} />
        </button>
      )}
      {scale > 1 && resetVariant === 'text' && (
        <div
          className="absolute bottom-3 right-3 flex items-center gap-2 px-3 py-1.5 rounded-lg z-20"
          style={{ background: 'var(--overlay-bg)', color: 'var(--text-on-overlay)' }}
        >
          <span className="text-xs font-mono">{Math.round(scale * 100)}%</span>
          <button
            className="text-xs px-2 py-0.5 rounded hover:bg-white/20 transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              reset()
            }}
            title={t('detail.zoomable.resetZoom')}
          >
            {t('detail.zoomable.resetButton')}
          </button>
        </div>
      )}
    </div>
  )
}
