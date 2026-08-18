import React, { useEffect, useRef, useState, useCallback } from 'react'

/**
 * 自动更新弹窗（复用 electron-updater + 主进程 app:update 推送）。
 *
 * 视觉风格完全复用 TaskProgressOverlay 的 glass-card / progress-bar 规范，保持全局 UI 一致。
 * 纯展示 + 触发 IPC：状态机由主进程驱动，本组件只负责呈现「发现新版本 → 下载进度 → 安装重启」。
 *
 * 阶段细化：
 *   - checking / not-available → 轻量 toast（自动消失）
 *   - downloading            → 右下角非阻塞进度卡片
 *   - available / downloaded / error → 居中模态（需用户决策）
 */

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

const isModalStage = (s: UpdateStage): boolean =>
  s === 'available' || s === 'downloaded' || s === 'error'

export const UpdateDialog: React.FC = () => {
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
      // 新事件到达即重置关闭状态，确保重试 / 下次检查能重新弹窗
      setDismissed(false)
      if (p.stage === 'checking') showToast('正在检查更新…')
      else if (p.stage === 'not-available') showToast('已是最新版本')
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
  }, [])

  const handleDownload = useCallback(async () => {
    try {
      await window.electronAPI?.app?.downloadUpdate()
    } catch (err) {
      console.error('[UpdateDialog] 下载更新失败:', err)
    }
  }, [])

  const handleInstall = useCallback(async () => {
    try {
      await window.electronAPI?.app?.installUpdate()
    } catch (err) {
      console.error('[UpdateDialog] 安装更新失败:', err)
    }
  }, [])

  const handleRetry = useCallback(async () => {
    try {
      await window.electronAPI?.app?.checkUpdate()
    } catch (err) {
      console.error('[UpdateDialog] 重试检查失败:', err)
    }
  }, [])

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
            title={payload.version ? `正在下载更新 v${payload.version}` : '正在下载更新'}
          >
            {payload.version ? `正在下载更新 v${payload.version}` : '正在下载更新'}…
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
      aria-label="应用更新"
    >
      <div
        className="glass-card p-6 w-[420px] max-w-[90vw] max-h-[80vh] flex flex-col"
        style={{ animation: 'slideInBottom 300ms ease-out' }}
      >
        {payload.stage === 'available' && (
          <>
            <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              发现新版本{versionText}
            </h2>
            <p className="text-xs mb-3" style={{ color: 'var(--text-tertiary)' }}>
              有可用更新，是否下载并安装？
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
                稍后
              </button>
              <button
                className="px-3 py-1.5 rounded text-sm font-medium text-white"
                style={{ background: 'var(--accent)' }}
                onClick={handleDownload}
              >
                下载更新
              </button>
            </div>
          </>
        )}

        {payload.stage === 'downloaded' && (
          <>
            <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              更新已下载完成{versionText}
            </h2>
            <p className="text-xs mb-4" style={{ color: 'var(--text-tertiary)' }}>
              新版本已准备就绪，重启应用后生效。
            </p>
            <div className="flex justify-end gap-2 mt-auto">
              <button
                className="px-3 py-1.5 rounded text-sm transition-colors"
                style={{ color: 'var(--text-secondary)' }}
                onClick={() => setDismissed(true)}
              >
                稍后重启
              </button>
              <button
                className="px-3 py-1.5 rounded text-sm font-medium text-white"
                style={{ background: 'var(--accent)' }}
                onClick={handleInstall}
              >
                安装并重启
              </button>
            </div>
          </>
        )}

        {payload.stage === 'error' && (
          <>
            <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              更新出错
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
              {payload.errorMessage ?? '未知错误'}
            </p>
            <div className="flex justify-end gap-2 mt-auto">
              <button
                className="px-3 py-1.5 rounded text-sm transition-colors"
                style={{ color: 'var(--text-secondary)' }}
                onClick={() => setDismissed(true)}
              >
                关闭
              </button>
              <button
                className="px-3 py-1.5 rounded text-sm font-medium text-white"
                style={{ background: 'var(--accent)' }}
                onClick={handleRetry}
              >
                重试
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
