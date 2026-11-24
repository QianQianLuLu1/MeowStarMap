import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConsoleSection } from './console-ui'
import { useErrorToast } from '../../../hooks/useErrorToast'
import type {
  NikkiSyncNetworkAuthResultInfo,
  NikkiSyncNetworkConflictResultInfo
} from '../../../../shared/types/electron-api'

interface NetworkPermissionCardProps {
  /** opt-in：nikkisync.shellNetworkRepairEnabled（getShellStatus().enabled.networkRepair） */
  enabled: boolean
  /** 「去开启」跳转（滚到同视图的外壳开关分区） */
  onEnableJump: () => void
}

/**
 * T7：本地网络权限卡（上游 settings 页 networkPermission 移植）。
 *
 * 五按钮 → 两通道 action 映射（契约见 shared/types/electron-api.ts PC 对齐轮段）：
 * - 允许手机连接 → networkAuth({action:'authorize'})；撤销 → {action:'revoke'}；
 *   挂载读一次 {action:'status'}（仅 opt-in 开时）。
 * - 重新检查 → networkConflict({action:'inspect'})；一键检查并修复 → {action:'repair'}；
 *   撤销上次修复 → {action:'restore'}（无 journal ⇒ canRestore:false ⇒ 按钮禁用）。
 *
 * 诚实纪律：
 * - opt-in 关 ⇒ 整卡「未启用」+ 去开启入口，零通道调用（主进程同样 fail-closed）；
 * - 桥面方法缺席（主进程未落地/老 preload）⇒ 按钮禁用 + 不可用说明，不伪造结果；
 * - 状态枚举走 i18n 封闭键集，未知码原样回退（不谎报）；冲突清单只展示 name/action/profile。
 */
export const NetworkPermissionCard: React.FC<NetworkPermissionCardProps> = ({
  enabled,
  onEnableJump
}) => {
  const { t } = useTranslation()
  const { showError } = useErrorToast()
  const [authStatus, setAuthStatus] = useState<string | null>(null)
  const [conflict, setConflict] = useState<NikkiSyncNetworkConflictResultInfo | null>(null)
  const [busy, setBusy] = useState(false)

  const client = window.electronAPI?.nikkisync
  const authAvailable = typeof client?.networkAuth === 'function'
  const conflictAvailable = typeof client?.networkConflict === 'function'

  const statusText = (status: string): string =>
    t(`syncConsole.settings.network.status.${status}`, { defaultValue: status })

  // 挂载读一次授权状态（仅 opt-in 开且桥面在位；失败静默，不弹错误）
  useEffect(() => {
    if (!enabled || !authAvailable) return
    let alive = true
    void client
      ?.networkAuth({ action: 'status' })
      .then((result: NikkiSyncNetworkAuthResultInfo) => {
        if (alive) setAuthStatus(result.status)
      })
      .catch(() => {
        if (alive) setAuthStatus(null)
      })
    return () => {
      alive = false
    }
  }, [enabled, authAvailable, client])

  const runAuth = useCallback(
    async (action: 'authorize' | 'revoke'): Promise<void> => {
      if (busy || !authAvailable) return
      setBusy(true)
      try {
        const result = await client?.networkAuth({ action })
        if (result) setAuthStatus(result.status)
      } catch (error) {
        showError(error)
      } finally {
        setBusy(false)
      }
    },
    [busy, authAvailable, client, showError]
  )

  const runConflict = useCallback(
    async (action: 'inspect' | 'repair' | 'restore'): Promise<void> => {
      if (busy || !conflictAvailable) return
      setBusy(true)
      try {
        const result = await client?.networkConflict({ action })
        if (result) setConflict(result)
      } catch (error) {
        showError(error)
      } finally {
        setBusy(false)
      }
    },
    [busy, conflictAvailable, client, showError]
  )

  return (
    <div data-testid="sync-network-card">
      <ConsoleSection
        titleAs="h2"
        title={t('syncConsole.settings.network.title')}
        description={t('syncConsole.settings.network.description')}
      >
        {!enabled ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncConsole.settings.network.disabled')}
            </p>
            <button type="button" className="btn-secondary text-xs" onClick={onEnableJump}>
              {t('syncConsole.settings.network.enableJump')}
            </button>
          </div>
        ) : (
          <div className="sc-stack">
            {!authAvailable || !conflictAvailable ? (
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('syncConsole.settings.network.unavailable')}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-primary text-sm"
                disabled={busy || !authAvailable}
                onClick={() => void runAuth('authorize')}
              >
                {t('syncConsole.settings.network.authorize')}
              </button>
              <button
                type="button"
                className="btn-ghost text-sm"
                disabled={busy || !authAvailable}
                onClick={() => void runAuth('revoke')}
              >
                {t('syncConsole.settings.network.revoke')}
              </button>
            </div>
            {authStatus && (
              <p className="text-xs" data-testid="sync-network-auth-status">
                {statusText(authStatus)}
              </p>
            )}
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncConsole.settings.network.note')}
            </p>
            <div className="sc-stack pt-1">
              <p className="text-xs font-medium">
                {t('syncConsole.settings.network.conflictTitle')}
              </p>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('syncConsole.settings.network.conflictDesc')}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={busy || !conflictAvailable}
                  onClick={() => void runConflict('inspect')}
                >
                  {t('syncConsole.settings.network.inspect')}
                </button>
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={busy || !conflictAvailable}
                  onClick={() => void runConflict('repair')}
                >
                  {t('syncConsole.settings.network.repair')}
                </button>
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  disabled={busy || !conflictAvailable || conflict?.canRestore !== true}
                  onClick={() => void runConflict('restore')}
                >
                  {t('syncConsole.settings.network.restore')}
                </button>
              </div>
              {conflict && (
                <div className="sc-stack" data-testid="sync-network-conflict-result">
                  <p className="text-xs">{statusText(conflict.status)}</p>
                  {conflict.conflicts && conflict.conflicts.length > 0 ? (
                    <>
                      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {t('syncConsole.settings.network.conflictsFound', {
                          count: conflict.conflicts.length
                        })}
                      </p>
                      <ul className="flex flex-col gap-1">
                        {conflict.conflicts.map((rule) => (
                          <li
                            key={`${rule.name}-${rule.profile}`}
                            className="font-mono text-xs"
                            style={{ color: 'var(--text-tertiary)' }}
                          >
                            {rule.name} · {rule.action} · {rule.profile}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {t('syncConsole.settings.network.noConflicts')}
                    </p>
                  )}
                </div>
              )}
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('syncConsole.settings.network.conflictNote')}
              </p>
            </div>
          </div>
        )}
      </ConsoleSection>
    </div>
  )
}
