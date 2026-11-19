import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SectionShell, SettingsCard, SettingsRow } from '../../settings/shared'
import { useErrorToast } from '../../../hooks/useErrorToast'
import type { NikkiSyncHotspotControlResultInfo } from '../../../../shared/types/electron-api'

interface HotspotCardProps {
  /** opt-in：nikkisync.shellHotspotEnabled（getShellStatus().enabled.hotspot） */
  enabled: boolean
  onEnableJump: () => void
}

/**
 * T7：临时热点卡（上游 settings 页 hotspot 移植）。
 *
 * 三按钮 → 通道 action 映射：
 * - 开启临时热点 → hotspotControl({action:'start'})；成功后展示 SSID/密码
 *   （密码默认掩码，点击显示/隐藏切换——肩屏防窥，上游同款）；
 * - 结束临时组网 → {action:'stop'}（仅本应用开启的热点可结束：state.startedHere
 *   为 false 时按钮禁用，不误关用户自开的系统热点）；
 * - 打开系统热点设置 → openHotspotSettings()（固定 ms-settings 页，无入参）。
 *
 * 诚实纪律与 NetworkPermissionCard 同款：opt-in 关 ⇒ 整卡未启用 + 去开启；
 * 桥面缺席 ⇒ 禁用 + 不可用说明；状态枚举 i18n 封闭键集、未知码原样回退。
 */
export const HotspotCard: React.FC<HotspotCardProps> = ({ enabled, onEnableJump }) => {
  const { t } = useTranslation()
  const { showError } = useErrorToast()
  const [result, setResult] = useState<NikkiSyncHotspotControlResultInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState(false)

  const client = window.electronAPI?.nikkisync
  const controlAvailable = typeof client?.hotspotControl === 'function'
  const settingsAvailable = typeof client?.openHotspotSettings === 'function'

  const statusText = (status: string): string =>
    t(`syncConsole.settings.hotspot.status.${status}`, { defaultValue: status })

  // 挂载读一次热点状态（仅 opt-in 开且桥面在位；失败静默）
  useEffect(() => {
    if (!enabled || !controlAvailable) return
    let alive = true
    void client
      ?.hotspotControl({ action: 'status' })
      .then((next: NikkiSyncHotspotControlResultInfo) => {
        if (alive) setResult(next)
      })
      .catch(() => {
        if (alive) setResult(null)
      })
    return () => {
      alive = false
    }
  }, [enabled, controlAvailable, client])

  const runControl = useCallback(
    async (action: 'start' | 'stop'): Promise<void> => {
      if (busy || !controlAvailable) return
      setBusy(true)
      try {
        const next = await client?.hotspotControl({ action })
        if (next) {
          setResult(next)
          // 密码只在 start 成功时给出；新一轮操作后回到掩码态
          setRevealed(false)
        }
      } catch (error) {
        showError(error)
      } finally {
        setBusy(false)
      }
    },
    [busy, controlAvailable, client, showError]
  )

  const openSettings = useCallback(async (): Promise<void> => {
    if (busy || !settingsAvailable) return
    setBusy(true)
    try {
      await client?.openHotspotSettings()
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }, [busy, settingsAvailable, client, showError])

  const startedHere = result?.state?.startedHere === true

  return (
    <div data-testid="sync-hotspot-card">
      <SectionShell
        title={t('syncConsole.settings.hotspot.title')}
        description={t('syncConsole.settings.hotspot.description')}
      >
        {!enabled ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncConsole.settings.hotspot.disabled')}
            </p>
            <button type="button" className="btn-secondary text-xs" onClick={onEnableJump}>
              {t('syncConsole.settings.network.enableJump')}
            </button>
          </div>
        ) : (
          <SettingsCard>
            <div className="space-y-2">
              {!controlAvailable ? (
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {t('syncConsole.settings.hotspot.unavailable')}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-primary text-sm"
                  disabled={busy || !controlAvailable}
                  onClick={() => void runControl('start')}
                >
                  {t('syncConsole.settings.hotspot.start')}
                </button>
                <button
                  type="button"
                  className="btn-ghost text-sm"
                  disabled={busy || !controlAvailable || !startedHere}
                  onClick={() => void runControl('stop')}
                >
                  {t('syncConsole.settings.hotspot.stop')}
                </button>
                <button
                  type="button"
                  className="btn-ghost text-sm"
                  disabled={busy || !settingsAvailable}
                  onClick={() => void openSettings()}
                >
                  {t('syncConsole.settings.hotspot.openSettings')}
                </button>
              </div>
              {result && (
                <p className="text-xs" data-testid="sync-hotspot-status">
                  {statusText(result.status)}
                </p>
              )}
              {/* 密码仅 start 成功时给出；默认掩码，点击显示（上游肩屏防窥同款） */}
              {result?.status === 'started' && result.ssid && (
                <div className="space-y-1" data-testid="sync-hotspot-credentials">
                  <SettingsRow label={t('syncConsole.settings.hotspot.ssid')}>
                    <span className="font-mono text-xs">{result.ssid}</span>
                  </SettingsRow>
                  {result.password && (
                    <SettingsRow label={t('syncConsole.settings.hotspot.password')}>
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-xs">
                          {revealed ? result.password : '••••••••'}
                        </span>
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() => setRevealed((prev) => !prev)}
                        >
                          {revealed
                            ? t('syncConsole.settings.hotspot.hide')
                            : t('syncConsole.settings.hotspot.reveal')}
                        </button>
                      </span>
                    </SettingsRow>
                  )}
                </div>
              )}
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('syncConsole.settings.hotspot.note')}
              </p>
            </div>
          </SettingsCard>
        )}
      </SectionShell>
    </div>
  )
}
