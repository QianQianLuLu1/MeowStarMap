import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useGlobalToast } from '../../../components/common/ToastProvider'
import { useErrorToast } from '../../../hooks/useErrorToast'
import { NIKKISYNC_ALIGNED_VERSION } from '../../../../shared/nikkisync-version'
import { exportDiagnostics } from './export-diagnostics'

interface SyncStatusBarProps {
  /** 重启成功后通知控制台刷新状态（Connect 视图的轮询会自然拉齐，这里做即时补拉）。 */
  onRefresh?: () => void
}

/**
 * T11：控制台底栏——双版本口径（宿主 app.getVersion + 上游对齐常量）、
 * 重启同步服务（restartServer，typeof 守卫）、导出诊断包（log:exportZip）。
 *
 * 上游 PC 端底栏只有版本与重启；导出诊断是本仓排障链路的既有能力，一并收口到底栏。
 */
export const SyncStatusBar: React.FC<SyncStatusBarProps> = ({ onRefresh }) => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const { showError } = useErrorToast()
  const [hostVersion, setHostVersion] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    let alive = true
    const getVersion = window.electronAPI?.app?.getVersion
    if (typeof getVersion !== 'function') return
    void getVersion()
      .then((version) => {
        if (alive && typeof version === 'string') setHostVersion(version)
      })
      .catch(() => {
        // 静默：保持占位
      })
    return () => {
      alive = false
    }
  }, [])

  /** T11：重启同步服务。桥缺席诚实提示；成功 Toast + 通知刷新；失败走错误 Toast。 */
  const handleRestart = async (): Promise<void> => {
    const restartServer = window.electronAPI?.nikkisync?.restartServer
    if (typeof restartServer !== 'function') {
      showMessage(t('syncConsole.statusBar.unavailable'), 'info')
      return
    }
    setRestarting(true)
    try {
      await restartServer()
      showMessage(t('syncConsole.statusBar.restartSuccess'), 'success')
      onRefresh?.()
    } catch (error) {
      showMessage(t('syncConsole.statusBar.restartFailed'), 'error')
      showError(error)
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div
      data-testid="sync-status-bar"
      className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}
    >
      <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {t('syncConsole.statusBar.version')} {hostVersion ?? '—'}
      </span>
      <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {t('syncConsole.statusBar.aligned')} {NIKKISYNC_ALIGNED_VERSION}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        data-testid="sync-status-restart"
        className="btn-secondary text-xs"
        disabled={restarting}
        onClick={() => void handleRestart()}
      >
        {t('syncConsole.statusBar.restart')}
      </button>
      <button
        type="button"
        data-testid="sync-status-export"
        className="btn-secondary text-xs"
        onClick={() => void exportDiagnostics(t, showMessage, showError)}
      >
        {t('syncConsole.statusBar.export')}
      </button>
    </div>
  )
}
