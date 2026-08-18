/**
 * T08：WiFi 局域网分享对话框
 * 展示分享地址、文件数量、服务状态、停止按钮
 * 不引入二维码库（避免新增依赖），改为大字号地址 + 复制按钮 + 引导文案
 */
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
// U4：改用全局 Toast，避免对话框内本地 Toast 容器与全局 Toast 重叠
import { useGlobalToast } from '../../pages/settings/shared'
import { IconClose, IconRefresh } from '../../icons'
import { BaseDialog } from './BaseDialog'

interface WifiShareDialogProps {
  open: boolean
  filePaths: string[]
  onClose: () => void
}

interface SessionInfo {
  active: boolean
  url?: string
  port?: number
  // P0-C / F-S3：6 位 PIN 码，展示给用户用于客户端认证
  pin?: string
  fileCount?: number
  startedAt?: number
  timeoutMs?: number
}

export const WifiShareDialog: React.FC<WifiShareDialogProps> = ({ open, filePaths, onClose }) => {
  const showMessage = useGlobalToast()
  const { t } = useTranslation()
  const [starting, setStarting] = useState(false)
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [remainingSeconds, setRemainingSeconds] = useState<number>(0)
  // U16：ReturnType<typeof setInterval> 兼容浏览器与 Node 环境，避免在纯浏览器预览版下类型不一致
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // P1-U9：sessionRef 同步最新 session 值，避免 effect 闭包陈旧导致关闭对话框时不停止服务
  const sessionRef = useRef<SessionInfo | null>(null)
  useEffect(() => {
    sessionRef.current = session
  }, [session])

  // 启动分享服务
  const startShare = useCallback(async () => {
    if (!filePaths || filePaths.length === 0) {
      showMessage(t('share.wifi.noFiles'), 'error')
      return
    }
    if (!window.electronAPI?.share?.startWifi) {
      showMessage(t('share.wifi.unsupported'), 'error')
      return
    }
    setStarting(true)
    try {
      const res = await window.electronAPI.share.startWifi(filePaths)
      if (res.success && res.url) {
        setSession({
          active: true,
          url: res.url,
          port: res.port,
          pin: res.pin, // P0-C：捕获 PIN 码用于 UI 展示
          fileCount: res.fileCount,
          startedAt: Date.now(),
          timeoutMs: res.timeoutMs
        })
        showMessage(t('share.wifi.started', { port: res.port }), 'success')
      } else {
        showMessage(res.message || t('share.wifi.startFailed'), 'error')
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : t('share.wifi.startFailed'), 'error')
    } finally {
      setStarting(false)
    }
  }, [filePaths, showMessage, t])

  const stopShare = useCallback(async () => {
    if (!window.electronAPI?.share?.stopWifi) return
    try {
      await window.electronAPI.share.stopWifi()
      setSession(null)
      setRemainingSeconds(0)
      showMessage(t('share.wifi.stopped'), 'info')
    } catch (err) {
      showMessage(err instanceof Error ? err.message : t('share.wifi.stopFailed'), 'error')
    }
  }, [showMessage, t])

  // 打开对话框时自动启动
  useEffect(() => {
    if (open) {
      void startShare()
    } else {
      // P1-U9：通过 sessionRef 读取最新 session 状态，避免闭包陈旧导致 stopShare 被跳过
      if (sessionRef.current?.active) {
        void stopShare()
      }
      setSession(null)
      setRemainingSeconds(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 倒计时
  useEffect(() => {
    if (!session?.active || !session.timeoutMs || !session.startedAt) return
    const update = () => {
      const elapsed = Date.now() - session.startedAt!
      const remain = Math.max(0, Math.floor((session.timeoutMs! - elapsed) / 1000))
      setRemainingSeconds(remain)
      if (remain <= 0) {
        setSession(null)
        if (tickRef.current) {
          clearInterval(tickRef.current)
          tickRef.current = null
        }
        showMessage(t('share.wifi.timeoutClosed'), 'info')
      }
    }
    update()
    tickRef.current = setInterval(update, 1000)
    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current)
        tickRef.current = null
      }
    }
  }, [session, showMessage, t])

  // 组件卸载时停止服务
  // U15：在 cleanup 内捕获 sessionRef 闭包变量，仅在确实有活跃会话时调用 stopWifi
  // 避免无条件调用外部 API（无会话时 stopWifi 是无意义的 IPC 往返）
  useEffect(() => {
    return () => {
      if (sessionRef.current?.active && window.electronAPI?.share?.stopWifi) {
        void window.electronAPI.share.stopWifi()
      }
    }
  }, [])

  const copyUrl = useCallback(async () => {
    if (!session?.url) return
    try {
      await navigator.clipboard.writeText(session.url)
      showMessage(t('share.wifi.urlCopied'), 'success')
    } catch {
      showMessage(t('share.wifi.copyUrlFailed'), 'error')
    }
  }, [session, showMessage, t])

  const formatRemain = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <BaseDialog open={open} onClose={onClose} size="md" ariaLabelledby="wifi-share-title">
      <div className="flex items-center justify-between">
        <h3
          id="wifi-share-title"
          className="text-lg font-semibold"
          style={{ color: 'var(--text-primary)' }}
        >
          {t('share.wifi.title')}
        </h3>
        <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
          <IconClose size={16} />
        </button>
      </div>

      {starting && (
        <div className="flex flex-col items-center py-8">
          <div
            className="w-10 h-10 border-2 border-current border-t-transparent rounded-full animate-spin mb-3"
            style={{ color: 'var(--accent)' }}
          />
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            {t('share.wifi.starting')}
          </p>
        </div>
      )}

      {!starting && session?.active && session.url && (
        <>
          <div className="rounded-xl p-4 text-center" style={{ background: 'var(--bg-tertiary)' }}>
            <p className="text-xs mb-2" style={{ color: 'var(--text-tertiary)' }}>
              {t('share.wifi.accessUrl')}
            </p>
            <p
              className="font-mono text-lg font-semibold break-all"
              style={{ color: 'var(--accent)' }}
            >
              {session.url}
            </p>
            <button className="btn-secondary text-xs mt-3" onClick={copyUrl}>
              {t('share.wifi.copyUrl')}
            </button>
          </div>

          {/* P0-C：PIN 码展示区域 —— 手机端首次访问需输入此码认证 */}
          {session.pin && (
            <div
              className="rounded-xl p-4 flex items-center justify-between"
              style={{ background: 'var(--accent-soft)' }}
            >
              <div>
                <p className="text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>
                  {t('share.wifi.pin')}
                </p>
                <p
                  className="font-mono text-2xl font-bold tracking-[0.4em]"
                  style={{ color: 'var(--accent)' }}
                >
                  {session.pin}
                </p>
              </div>
              <button
                className="btn-secondary text-xs"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(session.pin!)
                    showMessage(t('share.wifi.pinCopied'), 'success')
                  } catch {
                    showMessage(t('share.wifi.copyPinFailed'), 'error')
                  }
                }}
              >
                {t('share.wifi.copyPin')}
              </button>
            </div>
          )}

          <div
            className="grid grid-cols-3 gap-2 text-center text-xs"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <div className="rounded-lg p-2" style={{ background: 'var(--bg-secondary)' }}>
              <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {session.fileCount ?? 0}
              </p>
              <p>{t('share.wifi.fileCount')}</p>
            </div>
            <div className="rounded-lg p-2" style={{ background: 'var(--bg-secondary)' }}>
              <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {session.port}
              </p>
              <p>{t('share.wifi.port')}</p>
            </div>
            <div className="rounded-lg p-2" style={{ background: 'var(--bg-secondary)' }}>
              <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {formatRemain(remainingSeconds)}
              </p>
              <p>{t('share.wifi.remainTime')}</p>
            </div>
          </div>

          <div
            className="text-xs p-3 rounded-lg"
            style={{ background: 'rgba(255,184,0,0.08)', color: '#9a6c00' }}
          >
            <p>{t('share.wifi.tips.sameWifi')}</p>
            <p>{t('share.wifi.tips.firewall')}</p>
            <p>{t('share.wifi.tips.pinAuth')}</p>
            <p>{t('share.wifi.tips.lanOnly')}</p>
            <p>{t('share.wifi.tips.timeout')}</p>
          </div>

          <div className="flex justify-between gap-3 pt-1">
            <button
              className="btn-secondary text-sm"
              onClick={() => void startShare()}
              disabled={starting}
              title={t('share.wifi.restartTitle')}
            >
              <IconRefresh size={14} className="mr-1" /> {t('share.wifi.restart')}
            </button>
            <button className="btn-danger text-sm" onClick={() => void stopShare()}>
              {t('share.wifi.stop')}
            </button>
          </div>
        </>
      )}

      {!starting && !session?.active && (
        <div className="text-center py-6">
          <p className="text-sm mb-4" style={{ color: 'var(--text-tertiary)' }}>
            {t('share.wifi.stopped')}
          </p>
          <button
            className="btn-primary text-sm"
            onClick={() => void startShare()}
            disabled={starting}
          >
            {t('share.wifi.restartButton')}
          </button>
        </div>
      )}
    </BaseDialog>
  )
}
