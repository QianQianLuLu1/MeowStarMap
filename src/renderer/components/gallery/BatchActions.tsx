import React, { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAutoAnimate } from '@formkit/auto-animate/react'
import {
  IconDelete,
  IconExport,
  IconMove,
  IconWatermark,
  IconClose,
  IconSelectAll,
  IconInvertSelection,
  IconCategory,
  IconShare,
  IconRename
} from '../../icons'
import { ShareMenuButton } from '../common/ShareMenuButton'
import type { ShareChannelId } from '../common/ShareGuideDialog'

export interface BatchActionsProps {
  count: number
  total: number
  onExport: () => void
  onMove: () => void
  onWatermark: () => void
  onDelete: () => void
  onClear: () => void
  onSelectAll: () => void
  onInvertSelection: () => void
  onCategorize?: () => void
  // T08：WiFi 局域网分享
  onShareWifi?: () => void
  // T09：剪贴板分享（微信 / QQ / vivo）
  onShareClipboard?: (channelId: ShareChannelId) => void
  // T12：批量重命名
  onBatchRename?: () => void
  // P1-02：导出到默认文件夹（仅在配置了默认路径时显示）
  onExportToDefault?: () => void
  // P1-04：跨档案转移——可选档案列表与回调
  profiles?: Array<{ uid: string; nickname: string }>
  onTransferToProfile?: (targetUid: string) => void
}

export const BatchActions: React.FC<BatchActionsProps> = ({
  count,
  total,
  onExport,
  onMove,
  onWatermark,
  onDelete,
  onClear,
  onSelectAll,
  onInvertSelection,
  onCategorize,
  onShareWifi,
  onShareClipboard,
  onBatchRename,
  onExportToDefault,
  profiles,
  onTransferToProfile
}) => {
  const { t } = useTranslation()
  // P2-1：条件按钮出现/消失时 FLIP 平滑重排
  const [actionsRef] = useAutoAnimate({ duration: 200, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' })

  return (
    <div
      ref={actionsRef}
      className="fixed left-1/2 -translate-x-1/2 glass-card px-4 py-2 flex items-center gap-2 z-40 flex-nowrap overflow-x-auto batch-actions-root max-w-[calc(100vw-32px)]"
      style={{ bottom: '44px', animation: 'slideInBottom 200ms ease-out' }}
      role="toolbar"
      aria-label={t('batch.actions.ariaLabel')}
    >
      <span
        className="text-sm font-medium px-2 whitespace-nowrap flex-shrink-0"
        style={{ color: 'var(--text-primary)' }}
      >
        {t('batch.actions.selectedCount', { count, total })}
      </span>
      <div className="w-px h-5 mx-1 flex-shrink-0" style={{ background: 'var(--divider)' }} />
      <button
        className="icon-btn batch-act-btn text-sm px-3 gap-1 whitespace-nowrap"
        onClick={onSelectAll}
        aria-label={t('batch.actions.selectAll')}
      >
        <IconSelectAll size={14} />
        <span className="batch-act-label">{t('batch.actions.selectAll')}</span>
      </button>
      <button
        className="icon-btn batch-act-btn text-sm px-3 gap-1 whitespace-nowrap"
        onClick={onInvertSelection}
        aria-label={t('batch.actions.invertSelection')}
      >
        <IconInvertSelection size={14} />
        <span className="batch-act-label">{t('batch.actions.invertSelection')}</span>
      </button>
      <div className="w-px h-5 mx-1 flex-shrink-0" style={{ background: 'var(--divider)' }} />
      <button
        className="icon-btn batch-act-btn text-sm px-3 gap-1 whitespace-nowrap"
        onClick={onDelete}
        aria-label={t('batch.actions.delete')}
      >
        <IconDelete size={14} />
        <span className="batch-act-label">{t('batch.actions.delete')}</span>
      </button>
      <button
        className="icon-btn batch-act-btn text-sm px-3 gap-1 whitespace-nowrap"
        onClick={onExport}
        aria-label={t('batch.actions.export')}
        title={t('batch.actions.exportSelectDir')}
      >
        <IconExport size={14} />
        <span className="batch-act-label">{t('batch.actions.export')}</span>
      </button>
      {onExportToDefault && (
        <button
          className="icon-btn batch-act-btn text-sm px-3 gap-1 whitespace-nowrap"
          onClick={onExportToDefault}
          aria-label={t('batch.actions.exportToDefault')}
          title={t('batch.actions.exportToDefaultHint')}
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          <IconExport size={14} />
          <span className="batch-act-label">{t('batch.actions.exportToDefault')}</span>
        </button>
      )}
      <button
        className="icon-btn batch-act-btn text-sm px-3 gap-1 whitespace-nowrap"
        onClick={onMove}
        aria-label={t('batch.actions.move')}
      >
        <IconMove size={14} />
        <span className="batch-act-label">{t('batch.actions.move')}</span>
      </button>
      <button
        className="icon-btn batch-act-btn text-sm px-3 gap-1 whitespace-nowrap"
        onClick={onWatermark}
        aria-label={t('batch.actions.watermark')}
      >
        <IconWatermark size={14} />
        <span className="batch-act-label">{t('batch.actions.watermark')}</span>
      </button>
      {onBatchRename && (
        <button
          className="icon-btn batch-act-btn text-sm px-3 gap-1 whitespace-nowrap"
          onClick={onBatchRename}
          aria-label={t('batch.actions.renameAria')}
          title={t('batch.actions.renameHint')}
        >
          <IconRename size={14} />
          <span className="batch-act-label">{t('batch.actions.rename')}</span>
        </button>
      )}
      {onCategorize && (
        <button
          className="icon-btn batch-act-btn text-sm px-3 gap-1 whitespace-nowrap"
          onClick={onCategorize}
          aria-label={t('batch.actions.categorize')}
        >
          <IconCategory size={14} />
          <span className="batch-act-label">{t('batch.actions.categorize')}</span>
        </button>
      )}
      {/* P1-04：转移到档案——下拉式选择目标档案 */}
      {onTransferToProfile && profiles && profiles.length > 0 && (
        <ProfileTransferMenu profiles={profiles} onSelect={onTransferToProfile} />
      )}
      {onShareClipboard && (
        <ShareMenuButton
          onSelect={onShareClipboard}
          label={t('batch.actions.share')}
          title={t('batch.actions.shareClipboardTitle')}
          menuPosition="top"
        />
      )}
      {onShareWifi && (
        <button
          className="icon-btn batch-act-btn text-sm px-3 gap-1 whitespace-nowrap"
          onClick={onShareWifi}
          aria-label={t('batch.actions.wifiShare')}
          title={t('batch.actions.wifiShareHint')}
        >
          <IconShare size={14} />
          <span className="batch-act-label">{t('batch.actions.wifiShare')}</span>
        </button>
      )}
      <div className="w-px h-5 mx-1 flex-shrink-0" style={{ background: 'var(--divider)' }} />
      <button
        className="icon-btn flex-shrink-0"
        onClick={onClear}
        aria-label={t('batch.actions.clearSelection')}
      >
        <IconClose size={14} />
      </button>
    </div>
  )
}

// P1-04：转移到档案下拉菜单——批量更新选中文件的 account_uid
// 内联实现以避免引入新文件；交互参考 ShareMenuButton（点击外部关闭 + Esc 关闭）
const ProfileTransferMenu: React.FC<{
  profiles: Array<{ uid: string; nickname: string }>
  onSelect: (targetUid: string) => void
}> = ({ profiles, onSelect }) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

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

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="icon-btn batch-act-btn text-sm px-3 gap-1 whitespace-nowrap"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('batch.actions.transferToProfileHint')}
        onClick={() => setOpen((v) => !v)}
      >
        <IconCategory size={14} />
        <span className="batch-act-label">{t('batch.actions.transferToProfile')}</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 mt-1 glass-panel py-1 min-w-[180px] z-50 max-h-[280px] overflow-y-auto"
          style={{ animation: 'scaleIn 150ms ease-out' }}
        >
          {profiles.map((p) => (
            <button
              key={p.uid}
              role="menuitem"
              className="w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors text-left"
              style={{ color: 'var(--text-primary)' }}
              onClick={() => {
                setOpen(false)
                onSelect(p.uid)
              }}
            >
              <IconCategory size={14} />
              <span className="truncate">{p.nickname}</span>
              <span className="ml-auto text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {p.uid}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
