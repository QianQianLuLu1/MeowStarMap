import React, { useState, useRef, useEffect } from 'react'
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
}

export const ShareMenuButton: React.FC<ShareMenuButtonProps> = ({
  onSelect,
  label,
  size = 'sm',
  disabled = false,
  title
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // F5：渠道列表文案走 i18n，label 支持调用方覆盖
  const channels: { id: ShareChannelId; label: string; icon: React.ReactNode }[] = [
    { id: 'wechat', label: t('share.menu.toWechat'), icon: <IconWeChat size={14} /> },
    { id: 'qq', label: t('share.menu.toQQ'), icon: <IconQQ size={14} /> },
    { id: 'vivo', label: t('share.menu.toVivo'), icon: <IconVivo size={14} /> }
  ]
  const effectiveLabel = label ?? t('share.menu.label')

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
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

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={`icon-btn ${sizeClass} w-auto gap-1`}
        disabled={disabled}
        title={title ?? effectiveLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <IconShare size={size === 'sm' ? 14 : 16} />
        {effectiveLabel}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 mt-1 glass-panel py-1 min-w-[180px] z-50"
          style={{ animation: 'scaleIn 150ms ease-out' }}
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
        </div>
      )}
    </div>
  )
}
