import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SectionShell, SettingsToggle, SettingsCard, SettingsRow, useGlobalToast } from './shared'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { EmptyState } from '../../components/common/EmptyState'
import { PairingQrDialog } from '../../components/sync/PairingQrDialog'
import { useErrorToast } from '../../hooks/useErrorToast'
import { IconCopyText } from '../../icons'
import type { SyncDeviceInfo, SyncServerStatusInfo } from '../../../shared/types/electron-api'

// 状态轮询间隔（上游 pc-companion DesktopPageScript 同款 2s）
const STATUS_POLL_MS = 2000

/**
 * 同步服务设置分区（sync-integration 阶段5）。
 *
 * - 开关 = sync.serverEnabled 设置（RENDERER_PREF_KEYS 白名单）+ 立即启停；
 *   启停失败时持久化设置与本地状态一并回滚，避免下次启动反复自启失败
 * - 状态卡 2s 轮询 getStatus（运行地址/连接数/已配对数/TLS 指纹），操作后立即刷新
 * - 设备列表（仅活跃设备）+ 撤销确认（软删，撤销后设备需重新配对）
 */
export const SyncServiceSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const { showError } = useErrorToast()
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<SyncServerStatusInfo | null>(null)
  const [devices, setDevices] = useState<SyncDeviceInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [qrOpen, setQrOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<SyncDeviceInfo | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const api = window.electronAPI
    if (!api) return
    try {
      const [nextStatus, nextDevices] = await Promise.all([
        api.sync.getStatus(),
        api.sync.listDevices()
      ])
      setStatus(nextStatus)
      setDevices(nextDevices)
    } catch {
      // 状态查询失败静默：轮询下一轮重试（未组装时 getStatus 返回 available:false 不抛）
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const value = await window.electronAPI?.settings.get('sync.serverEnabled', false)
        if (alive) setEnabled(Boolean(value))
      } catch {
        // 设置读取失败保持默认关闭态
      }
    })()
    void refresh()
    const timer = setInterval(() => void refresh(), STATUS_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [refresh])

  const handleToggle = async (value: boolean): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    setBusy(true)
    setEnabled(value)
    try {
      await api.settings.set('sync.serverEnabled', value)
      try {
        if (value) await api.sync.startServer()
        else await api.sync.stopServer()
        showMessage(value ? t('toast.syncEnabled') : t('toast.syncDisabled'))
      } catch (err) {
        // 回滚：持久化设置与本地状态一并还原（下次启动不再反复自启失败）
        try {
          await api.settings.set('sync.serverEnabled', !value)
        } catch {
          // 回滚失败仅保留本地态
        }
        setEnabled(!value)
        showError(err)
      }
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const handleRevokeConfirm = async (): Promise<void> => {
    const api = window.electronAPI
    if (!revokeTarget || !api) return
    const deviceId = revokeTarget.deviceId
    try {
      const refreshed = await api.sync.revokeDevice(deviceId)
      setDevices(refreshed)
      showMessage(t('settings.sync.devices.revoked'), 'success')
    } catch (err) {
      showError(err)
    } finally {
      setRevokeTarget(null)
      void refresh()
    }
  }

  const copyFingerprint = async (): Promise<void> => {
    const fingerprint = status?.tlsFingerprintSha256
    if (!fingerprint) return
    try {
      await navigator.clipboard.writeText(fingerprint)
      showMessage(t('settings.sync.status.copied'))
    } catch (err) {
      showError(err)
    }
  }

  const running = Boolean(status?.running)

  return (
    <div className="space-y-4">
      <SectionShell
        title={t('settings.sync.service.title')}
        description={t('settings.sync.service.description')}
      >
        <SettingsToggle
          label={t('settings.sync.enable')}
          description={t('settings.sync.enableDesc')}
          checked={enabled}
          disabled={busy}
          onChange={(value) => void handleToggle(value)}
        />
        <SettingsCard>
          <div className="space-y-2">
            <SettingsRow label={t('settings.sync.status.label')}>
              <span className="flex items-center gap-2 text-sm">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{
                    background: running
                      ? 'var(--accent, #22c55e)'
                      : status?.available === false
                        ? 'var(--text-tertiary)'
                        : 'var(--text-tertiary)'
                  }}
                />
                {!status?.available
                  ? t('settings.sync.status.unavailable')
                  : running
                    ? t('settings.sync.status.running')
                    : t('settings.sync.status.stopped')}
              </span>
            </SettingsRow>
            {running && status && (
              <>
                <SettingsRow label={t('settings.sync.status.address')}>
                  <button
                    type="button"
                    className="icon-btn font-mono text-sm"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(`${status.lanHost}:${status.port}`)
                        .then(() => showMessage(t('settings.sync.status.copied')))
                        .catch((err) => showError(err))
                    }}
                  >
                    {status.lanHost}:{status.port}
                    <IconCopyText />
                  </button>
                </SettingsRow>
                <SettingsRow label={t('settings.sync.status.connections')}>
                  <span className="text-sm">{status.connections}</span>
                </SettingsRow>
                <SettingsRow label={t('settings.sync.status.serverId')}>
                  <span className="font-mono text-sm">{status.serverId ?? '—'}</span>
                </SettingsRow>
                <SettingsRow label={t('settings.sync.status.tlsFingerprint')}>
                  <button
                    type="button"
                    className="icon-btn font-mono text-xs"
                    title={status.tlsFingerprintSha256 ?? ''}
                    onClick={() => void copyFingerprint()}
                  >
                    {(status.tlsFingerprintSha256 ?? '').slice(0, 16)}…
                    <IconCopyText />
                  </button>
                </SettingsRow>
              </>
            )}
          </div>
        </SettingsCard>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {running
              ? t('settings.sync.pairing.hintRunning')
              : t('settings.sync.pairing.hintDisabled')}
          </p>
          <button
            type="button"
            className="btn-primary text-sm"
            disabled={!running}
            onClick={() => setQrOpen(true)}
          >
            {t('settings.sync.pairing.open')}
          </button>
        </div>
      </SectionShell>

      <SectionShell title={t('settings.sync.devices.title')}>
        {devices.length === 0 ? (
          <EmptyState
            title={t('settings.sync.devices.empty')}
            subtitle={t('settings.sync.devices.emptyHint')}
          />
        ) : (
          <div className="space-y-2">
            {devices.map((device) => (
              <SettingsCard key={device.deviceId}>
                <SettingsRow label={device.deviceName}>
                  <div className="flex items-center gap-3">
                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {device.platform === 'ios' ? 'iOS' : 'Android'}
                      {device.appVersion ? ` · v${device.appVersion}` : ''}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {t('settings.sync.devices.lastSeen')}：
                      {device.lastSeenAt
                        ? new Date(device.lastSeenAt).toLocaleString()
                        : t('settings.sync.devices.never')}
                    </span>
                    <button
                      type="button"
                      className="btn-danger text-xs"
                      onClick={() => setRevokeTarget(device)}
                    >
                      {t('settings.sync.devices.revoke')}
                    </button>
                  </div>
                </SettingsRow>
              </SettingsCard>
            ))}
          </div>
        )}
      </SectionShell>

      <PairingQrDialog open={qrOpen} onClose={() => setQrOpen(false)} />
      <ConfirmDialog
        open={revokeTarget !== null}
        title={t('settings.sync.devices.revokeConfirmTitle')}
        message={t('settings.sync.devices.revokeConfirmMessage', {
          name: revokeTarget?.deviceName ?? ''
        })}
        confirmText={t('settings.sync.devices.revokeConfirm')}
        confirmVariant="danger"
        onConfirm={() => void handleRevokeConfirm()}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  )
}
