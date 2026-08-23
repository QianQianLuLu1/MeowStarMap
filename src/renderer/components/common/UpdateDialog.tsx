import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * 自动更新弹窗（复用 electron-updater + 主进程 app:update 推送）。
 *
 * 视觉风格完全复用 TaskProgressOverlay 的 glass-card / progress-bar 规范，保持全局 UI 一致。
 * 纯展示 + 触发 IPC：状态机由主进程驱动，本组件只负责呈现「发现新版本 → 下载进度 → 安装重启」。
 *
 * 阶段细化：
 *   - checking                → 轻量 toast（自动消失）
 *   - downloading             → 右下角非阻塞进度卡片
 *   - available / downloaded  → 居中模态（需用户决策：下载 / 安装）
 *   - error / not-available   → 居中模态（关闭 / 确定跳转官网）
 */

// 与 about-sections.tsx 保持一致的项目官网
const GITHUB_URL = 'https://github.com/QianQianLuLu1/NikkiGallery'

type UpdateStage =
  'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'

interface UpdatePayload {
  stage: UpdateStage
  version?: string
  percent?: number
  releaseNotes?: string
  releaseName?: string
  errorMessage?: string
  readyToInstall?: boolean
}

// error / not-available：带「关闭 / 确定」的模态；available / downloaded：下载安装决策模态
const isModalStage = (s: UpdateStage): boolean =>
  s === 'available' || s === 'downloaded' || s === 'error' || s === 'not-available'

export const UpdateDialog: React.FC = () => {
  const { t } = useTranslation()
  const [payload, setPayload] = useState<UpdatePayload | null>(null)
  // 用户主动关闭模态后隐藏，直到下一次事件（如重启后再次检查）重置
  const [dismissed, setDismissed] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 订阅主进程推送的更新事件
  useEffect(() => {
    const api = window.electronAPI?.app
    if (!api?.onUpdate) return

    const showToast = (text: string): void => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
      setToast(text)
      toastTimer.current = setTimeout(() => setToast(null), 2500)
    }

    const unsubscribe = api.onUpdate((p: UpdatePayload) => {
      setPayload(p)
      // 新事件到达即重置关闭状态，确保下次检查能重新弹窗
      setDismissed(false)
      if (p.stage === 'checking') showToast(t('updateDialog.checking'))
      else {
        // 进入有实体 UI 的阶段（模态/进度卡片）时清掉 toast
        if (toastTimer.current) clearTimeout(toastTimer.current)
        setToast(null)
      }
    })

    return () => {
      unsubscribe()
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [t])

  const handleDownload = useCallback(async () => {
    try {
      await window.electronAPI?.app?.downloadUpdate()
    } catch (err) {
      console.error(t('updateDialog.log.downloadFailed'), err)
    }
  }, [t])

  const handleInstall = useCallback(async () => {
    try {
      await window.electronAPI?.app?.installUpdate()
    } catch (err) {
      console.error(t('updateDialog.log.installFailed'), err)
    }
  }, [t])

  // 「确定」按钮：打开项目官网（网络繁忙 / 已是最新均跳官网）
  const handleOpenOfficial = useCallback(async () => {
    try {
      await window.electronAPI?.shell?.openExternal?.(GITHUB_URL)
    } catch (err) {
      console.error(t('updateDialog.log.openOfficialFailed'), err)
    }
  }, [t])

  // 下载进度：右下角非阻塞卡片（与 TaskProgressOverlay 同源样式）
  if (payload?.stage === 'downloading') {
    const percent = Math.min(100, Math.max(0, payload.percent ?? 0))
    return (
      <div
        className="fixed glass-card p-4 w-80 z-50 right-6"
        style={{ bottom: '44px', animation: 'slideInBottom 300ms ease-out' }}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center justify-between mb-3">
          <span
            className="text-sm font-medium truncate"
            style={{ color: 'var(--text-primary)' }}
            title={
              payload.version
                ? t('updateDialog.downloadingVersion', { version: payload.version })
                : t('updateDialog.downloading')
            }
          >
            {payload.version
              ? t('updateDialog.downloadingVersion', { version: payload.version })
              : t('updateDialog.downloading')}
            …
          </span>
          <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>
            {percent.toFixed(0)}%
          </span>
        </div>
        <div className="progress-bar mb-1">
          <div
            className="progress-bar-fill"
            style={{ width: `${percent}%`, transition: 'width 300ms ease-out' }}
          />
        </div>
      </div>
    )
  }

  // 轻量 toast（checking / not-available）
  if (toast) {
    return (
      <div
        className="fixed glass-card px-4 py-2 z-50 left-1/2"
        style={{
          bottom: '44px',
          transform: 'translateX(-50%)',
          animation: 'slideInBottom 300ms ease-out'
        }}
        role="status"
        aria-live="polite"
      >
        <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
          {toast}
        </span>
      </div>
    )
  }

  // 模态阶段（available / downloaded / error），被用户关闭则隐藏
  if (!payload || !isModalStage(payload.stage) || dismissed) return null

  const versionText = payload.version ? ` v${payload.version}` : ''

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.35)' }}
      role="dialog"
      aria-modal="true"
      aria-label={t('updateDialog.ariaLabel')}
    >
      <div
        className="glass-card p-6 w-[420px] max-w-[90vw] max-h-[80vh] flex flex-col"
        style={{ animation: 'slideInBottom 300ms ease-out' }}
      >
        {payload.stage === 'available' && (
          <>
            <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              {t('updateDialog.foundNewVersion')}
              {versionText}
            </h2>
            <p className="text-xs mb-3" style={{ color: 'var(--text-tertiary)' }}>
              {t('updateDialog.availablePrompt')}
            </p>
            {payload.releaseNotes && (
              <pre
                className="text-xs mb-4 p-3 rounded overflow-auto flex-1"
                style={{
                  color: 'var(--text-secondary)',
                  background: 'var(--bg-primary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: '40vh'
                }}
              >
                {payload.releaseNotes}
              </pre>
            )}
            <div className="flex justify-end gap-2 mt-auto">
              <button
                className="px-3 py-1.5 rounded text-sm transition-colors"
                style={{ color: 'var(--text-secondary)' }}
                onClick={() => setDismissed(true)}
              >
                {t('updateDialog.later')}
              </button>
              <button
                className="px-3 py-1.5 rounded text-sm font-medium text-white"
                style={{ background: 'var(--accent)' }}
                onClick={handleDownload}
              >
                {t('updateDialog.downloadNow')}
              </button>
            </div>
          </>
        )}

        {payload.stage === 'downloaded' && (
          <>
            <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              {t('updateDialog.downloadedTitle')}
              {versionText}
            </h2>
            <p className="text-xs mb-4" style={{ color: 'var(--text-tertiary)' }}>
              {t('updateDialog.downloadedPrompt')}
            </p>
            <div className="flex justify-end gap-2 mt-auto">
              <button
                className="px-3 py-1.5 rounded text-sm transition-colors"
                style={{ color: 'var(--text-secondary)' }}
                onClick={() => setDismissed(true)}
              >
                {t('updateDialog.restartLater')}
              </button>
              <button
                className="px-3 py-1.5 rounded text-sm font-medium text-white"
                style={{ background: 'var(--accent)' }}
                onClick={handleInstall}
              >
                {t('updateDialog.installAndRestart')}
              </button>
            </div>
          </>
        )}

        {payload.stage === 'error' && (
          <>
            <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              {t('settings.about.updateTitle')}
            </h2>
            <p
              className="text-xs mb-4 p-3 rounded overflow-auto"
              style={{
                color: 'var(--text-secondary)',
                background: 'var(--bg-primary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '30vh'
              }}
            >
              {t('settings.about.updateNetworkBusy')}
            </p>
            <div className="flex justify-end gap-2 mt-auto">
              <button
                className="px-3 py-1.5 rounded text-sm transition-colors"
                style={{ color: 'var(--text-secondary)' }}
                onClick={() => setDismissed(true)}
              >
                {t('common.close')}
              </button>
              <button
                className="px-3 py-1.5 rounded text-sm font-medium text-white"
                style={{ background: 'var(--accent)' }}
                onClick={handleOpenOfficial}
              >
                {t('common.ok')}
              </button>
            </div>
          </>
        )}

        {payload.stage === 'not-available' && (
          <>
            <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              {t('settings.about.updateTitle')}
            </h2>
            <p
              className="text-xs mb-4 p-3 rounded overflow-auto"
              style={{
                color: 'var(--text-secondary)',
                background: 'var(--bg-primary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '30vh'
              }}
            >
              {t('settings.about.updateNoNewVersion')}
            </p>
            <div className="flex justify-end gap-2 mt-auto">
              <button
                className="px-3 py-1.5 rounded text-sm transition-colors"
                style={{ color: 'var(--text-secondary)' }}
                onClick={() => setDismissed(true)}
              >
                {t('common.close')}
              </button>
              <button
                className="px-3 py-1.5 rounded text-sm font-medium text-white"
                style={{ background: 'var(--accent)' }}
                onClick={handleOpenOfficial}
              >
                {t('common.ok')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
