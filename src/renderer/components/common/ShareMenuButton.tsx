import React, { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { IconShare, IconWeChat, IconQQ, IconVivo } from '../../icons'
import type { ShareChannelId } from './ShareGuideDialog'

interface ShareMenuButtonProps {
  // 选择渠道后回调（由调用方执行复制 + 弹引导窗）
  onSelect: (channelId: ShareChannelId) => void
  // 按钮文字；未传时使用 i18n 默认"分享"
  label?: string
  // 按钮大小：'sm' 用于批量操作栏，'md' 用于顶部工具栏
  size?: 'sm' | 'md'
  // 禁用
  disabled?: boolean
  // 附加 title 提示
  title?: string
  // 菜单展开方向：'bottom' 默认向下（顶部工具栏）；'top' 向上（底部栏，避免被祖先 overflow 裁剪 / 溢出视口）
  menuPosition?: 'bottom' | 'top'
}

// 视口边距，用于菜单定位钳制，与 ContextMenu 保持一致
const MARGIN = 8

export const ShareMenuButton: React.FC<ShareMenuButtonProps> = ({
  onSelect,
  label,
  size = 'sm',
  disabled = false,
  title,
  menuPosition = 'bottom'
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // 菜单定位坐标；open 切换后由 useLayoutEffect 同步计算，缺省时用 -9999 + hidden 占位避免闪烁
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null)
  // 触发按钮（保留在原 DOM 树中以维持点击可用与可见性）
  const triggerRef = useRef<HTMLDivElement>(null)
  // 门户菜单（渲染到 document.body，脱离祖先 overflow 裁剪）
  const menuRef = useRef<HTMLDivElement>(null)

  // F5：渠道列表文案走 i18n，label 支持调用方覆盖
  const channels: { id: ShareChannelId; label: string; icon: React.ReactNode }[] = [
    { id: 'wechat', label: t('share.menu.toWechat'), icon: <IconWeChat size={14} /> },
    { id: 'qq', label: t('share.menu.toQQ'), icon: <IconQQ size={14} /> },
    { id: 'vivo', label: t('share.menu.toVivo'), icon: <IconVivo size={14} /> }
  ]
  const effectiveLabel = label ?? t('share.menu.label')

  // 定位：脱离组件 DOM 后需固定到视口坐标；top 时优先向上、空间不足回退向下；right 对齐触发按钮并做右边界钳制
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null)
      return
    }
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger) return
    const tr = trigger.getBoundingClientRect()
    const mr = menu?.getBoundingClientRect()
    const mh = mr?.height ?? 0
    const mw = mr?.width ?? 0

    let top: number
    if (menuPosition === 'top') {
      // 向上：菜单底部对齐触发按钮顶部；上方不足 8px 则回退向下
      top = tr.top - mh - 6 >= MARGIN ? tr.top - mh - 6 : tr.bottom + 6
    } else {
      top = tr.bottom + 6
    }

    // 右对齐触发按钮右缘，再钳制到视口内
    let left = tr.right - mw
    if (left < MARGIN) left = MARGIN
    if (left + mw > window.innerWidth - MARGIN) {
      left = Math.max(MARGIN, window.innerWidth - mw - MARGIN)
    }
    setCoords({ left, top })
  }, [open, menuPosition])

  useEffect(() => {
    if (!open) return
    // 门户菜单在 body 中，触发按钮与菜单分属不同子树，两者皆需排除外部点击判定
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      const insideTrigger = triggerRef.current?.contains(target) ?? false
      const insideMenu = menuRef.current?.contains(target) ?? false
      if (!insideTrigger && !insideMenu) setOpen(false)
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  const sizeClass = size === 'sm' ? 'text-sm px-3' : 'text-sm px-4 py-2'

  // flex-shrink-0：与批量栏兄弟按钮（.icon-btn.batch-act-btn）的 flex-shrink:0 对齐，
  // 防止容器溢出时该包装层被优先压缩而挤压图标与文字
  return (
    <div ref={triggerRef} className="relative flex-shrink-0">
      <button
        type="button"
        className={`icon-btn batch-act-btn ${sizeClass} gap-1 whitespace-nowrap`}
        disabled={disabled}
        title={title ?? effectiveLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <IconShare size={size === 'sm' ? 14 : 16} />
        <span className="batch-act-label">{effectiveLabel}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-[90] glass-panel py-1 min-w-[180px]"
            style={{
              left: coords?.left ?? -9999,
              top: coords?.top ?? -9999,
              visibility: coords ? 'visible' : 'hidden',
              animation: 'scaleIn 150ms ease-out'
            }}
          >
            {channels.map((ch) => (
              <button
                key={ch.id}
                role="menuitem"
                className="w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors text-left"
                style={{ color: 'var(--text-primary)' }}
                onClick={() => {
                  setOpen(false)
                  onSelect(ch.id)
                }}
              >
                <span className="flex-shrink-0">{ch.icon}</span>
                <span>{ch.label}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}
