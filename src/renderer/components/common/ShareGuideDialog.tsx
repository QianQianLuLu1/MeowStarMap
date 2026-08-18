import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconWeChat, IconQQ, IconVivo } from '../../icons'
import { BaseDialog } from './BaseDialog'

export type ShareChannelId = 'wechat' | 'qq' | 'vivo'

interface ShareGuideDialogProps {
  open: boolean
  channelId: ShareChannelId | null
  // installed=true 表示已安装；running=true 表示正在运行
  installed: boolean
  running?: boolean
  // 复制结果，用于失败时显示错误
  copyResult?: { success: boolean; message: string; count: number; skipped: number } | null
  onClose: () => void
}

// F4：渠道图标映射（无文案，走 i18n）；与主进程 SHARE_CHANNELS 保持同步，仅前端展示用
const CHANNEL_ICONS: Record<ShareChannelId, React.ReactNode> = {
  wechat: <IconWeChat size={28} />,
  qq: <IconQQ size={28} />,
  vivo: <IconVivo size={28} />
}

export const ShareGuideDialog: React.FC<ShareGuideDialogProps> = ({
  open,
  channelId,
  installed,
  running,
  copyResult,
  onClose
}) => {
  const { t } = useTranslation()
  // P1-U13：焦点陷阱 + ESC 关闭由 BaseDialog 统一处理
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const [launching, setLaunching] = useState(false)
  const [launchMessage, setLaunchMessage] = useState<string | null>(null)

  // F4：渠道显示配置走 i18n，文案诚实化（明确告知"复制到剪贴板 + 手动粘贴"机制）
  const channel = channelId
    ? {
        name: t(`share.guide.channels.${channelId}`),
        icon: CHANNEL_ICONS[channelId],
        guide: t(`share.guide.guides.${channelId}.running`),
        notRunning: t(`share.guide.guides.${channelId}.notRunning`),
        fallback: t(`share.guide.guides.${channelId}.notInstalled`)
      }
    : null

  // 自动关闭策略：
  // - 已安装且运行中：3 秒后自动关闭（用户只需看到引导）
  // - 已安装未运行：不自动关闭（等用户点击"打开"按钮）
  // - 未安装：5 秒后自动关闭
  // - 复制失败：不自动关闭
  useEffect(() => {
    if (!open || !channelId) return
    if (copyResult && !copyResult.success) return
    const isRunning = installed && running
    const delay = isRunning ? 3000 : !installed ? 5000 : 0
    if (delay === 0) return
    const timer = setTimeout(() => onClose(), delay)
    return () => clearTimeout(timer)
  }, [open, channelId, installed, running, copyResult, onClose])

  // 重置启动状态
  useEffect(() => {
    if (!open) {
      setLaunching(false)
      setLaunchMessage(null)
    }
  }, [open])

  // 复制失败：显示错误信息
  if (copyResult && !copyResult.success) {
    return (
      <BaseDialog
        open={open && !!channelId}
        onClose={onClose}
        size="md"
        initialFocusRef={closeBtnRef}
      >
        <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          {t('share.guide.failed')}
        </h3>
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          {copyResult.message}
        </p>
        <div className="flex justify-end pt-2">
          <button ref={closeBtnRef} className="btn-primary" onClick={onClose}>
            {t('share.guide.known')}
          </button>
        </div>
      </BaseDialog>
    )
  }

  // 三态文案选择
  const isRunning = installed && !!running
  const text = channel
    ? isRunning
      ? channel.guide
      : installed
        ? channel.notRunning
        : channel.fallback
    : ''

  // 启动目标应用
  const handleLaunch = async () => {
    if (!channelId) return
    setLaunching(true)
    setLaunchMessage(null)
    try {
      const res = await window.electronAPI?.share?.launchApp(channelId)
      if (res?.success) {
        setLaunchMessage(t('share.guide.launchSuccess'))
      } else {
        setLaunchMessage(res?.message || t('share.guide.launchFailed'))
      }
    } catch (err) {
      setLaunchMessage(
        `${t('share.guide.launchFailed')}: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      setLaunching(false)
    }
  }

  return (
    <BaseDialog
      open={open && !!channelId && !!channel}
      onClose={onClose}
      size="md"
      initialFocusRef={closeBtnRef}
    >
      {/* channel 可能在退出动画期间为 null（channelId 已被父组件清空），需安全访问 */}
      <div className="flex items-center gap-3">
        <span style={{ color: 'var(--text-primary)' }}>{channel?.icon}</span>
        <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          {t('share.guide.shareTo', { name: channel?.name ?? '' })}
        </h3>
      </div>
      <p className="text-sm whitespace-pre-line" style={{ color: 'var(--text-secondary)' }}>
        {text}
      </p>
      {copyResult && copyResult.skipped > 0 && (
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('share.guide.skipped', { count: copyResult.skipped })}
        </p>
      )}
      {launchMessage && (
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {launchMessage}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-2">
        {/* 已安装但未运行：显示"打开 XX"按钮 */}
        {installed && !isRunning && (
          <button className="btn-secondary" onClick={handleLaunch} disabled={launching}>
            {launching
              ? t('share.guide.launching')
              : t('share.guide.open', { name: channel?.name ?? '' })}
          </button>
        )}
        <button ref={closeBtnRef} className="btn-primary" onClick={onClose}>
          {t('share.guide.known')}
        </button>
      </div>
    </BaseDialog>
  )
}
