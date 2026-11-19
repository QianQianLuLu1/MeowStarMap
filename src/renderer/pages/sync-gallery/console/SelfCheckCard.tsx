import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsCard, SettingsRow } from '../../settings/shared'
import type { NikkiSyncServerStatusInfo } from '../../../../shared/types/electron-api'
import type { ConsoleView } from './console-views'

interface SelfCheckCardProps {
  /** 来自 Connect 视图 2s 轮询的 getServerStatus 快照（null = 尚未拉到） */
  status: NikkiSyncServerStatusInfo | null
  onNavigate: (view: ConsoleView) => void
}

/**
 * T3：连接自查折叠卡（上游 DesktopPage.ts:70-82 selfCheck 的移植）。
 *
 * - 纯聚合既有观测（getServerStatus().diagnostics），不做主动探测；
 * - 服务由运行转掉线（running true→false）时自动展开，把排障入口递到用户眼前；
 *   初始即离线不自动展开（未启用是常态，不是事故）；
 * - 两条自查线：连接错误（服务态 + 诊断摘要 + 三步排障）与照片参数读取不到
 *   （扫描收录 + 在线解析默认关 + 本地解码内置），跳转按钮都落在同步设置视图。
 */
export const SelfCheckCard: React.FC<SelfCheckCardProps> = ({ status, onNavigate }) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const prevRunning = useRef<boolean | null>(null)
  const running = Boolean(status?.running)

  useEffect(() => {
    // 掉线沿（true→false）自动展开；首次观测（null→false）不算掉线
    if (prevRunning.current === true && !running) setOpen(true)
    prevRunning.current = running
  }, [running])

  const diagnostics = status?.diagnostics

  return (
    <details
      className="group"
      data-testid="sync-self-check"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className="cursor-pointer select-none text-sm"
        style={{ color: 'var(--text-secondary)' }}
      >
        {t('syncConsole.connect.selfCheck.title')}
      </summary>
      <SettingsCard>
        <div className="space-y-3">
          <div className="space-y-2">
            <p className="text-xs font-medium">
              {t('syncConsole.connect.selfCheck.connectionTitle')}
            </p>
            {/* 标签用自查专属键：避免与状态卡「运行状态」行重名（同页 getByText 判据不冲突） */}
            <SettingsRow label={t('syncConsole.connect.selfCheck.serviceLabel')}>
              <span className="text-xs">
                {!status?.available
                  ? t('syncConsole.connect.selfCheck.serviceUnavailable')
                  : running
                    ? t('syncConsole.connect.selfCheck.serviceOnline')
                    : t('syncConsole.connect.selfCheck.serviceOffline')}
              </span>
            </SettingsRow>
            {/* 诊断摘要只在掉线时展开：在线时 K4 诊断卡已在场，不重复渲染同值文本 */}
            {diagnostics && !running && (
              <>
                <SettingsRow label={t('syncService.diagnostics.bindAddress')}>
                  <span className="font-mono text-xs">
                    {diagnostics.host}:{diagnostics.port}
                  </span>
                </SettingsRow>
                {diagnostics.tlsFingerprintTail8 && (
                  <SettingsRow label={t('syncService.diagnostics.tlsTail')}>
                    <span className="font-mono text-xs">{diagnostics.tlsFingerprintTail8}</span>
                  </SettingsRow>
                )}
                {diagnostics.lastError && (
                  <SettingsRow label={t('syncService.diagnostics.lastError')}>
                    <span className="font-mono text-xs" style={{ color: 'var(--danger)' }}>
                      {diagnostics.lastError}
                    </span>
                  </SettingsRow>
                )}
              </>
            )}
            <ol
              className="list-decimal pl-4 text-xs space-y-1"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <li>{t('syncConsole.connect.selfCheck.connectionStep1')}</li>
              <li>{t('syncConsole.connect.selfCheck.connectionStep2')}</li>
              <li>{t('syncConsole.connect.selfCheck.connectionStep3')}</li>
            </ol>
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => onNavigate('settings')}
            >
              {t('syncConsole.connect.selfCheck.openNetwork')}
            </button>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium">
              {t('syncConsole.connect.selfCheck.metadataTitle')}
            </p>
            <ol
              className="list-decimal pl-4 text-xs space-y-1"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <li>{t('syncConsole.connect.selfCheck.metadataStep1')}</li>
              <li>{t('syncConsole.connect.selfCheck.metadataStep2')}</li>
              <li>{t('syncConsole.connect.selfCheck.metadataStep3')}</li>
            </ol>
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => onNavigate('settings')}
            >
              {t('syncConsole.connect.selfCheck.openScan')}
            </button>
          </div>
        </div>
      </SettingsCard>
    </details>
  )
}
