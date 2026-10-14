import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SectionShell, SettingsToggle, SettingsCard, SettingsRow, useGlobalToast } from './shared'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { EmptyState } from '../../components/common/EmptyState'
import { PairingQrDialog } from '../../components/sync/PairingQrDialog'
import { useErrorToast } from '../../hooks/useErrorToast'
import { IconCopyText } from '../../icons'
import type {
  NikkiSyncPairedDeviceInfo,
  NikkiSyncServerStatusInfo
} from '../../../shared/types/electron-api'

// 状态轮询间隔（上游 pc-companion DesktopPageScript 同款 2s）
const STATUS_POLL_MS = 2000
/**
 * 阶段 3：本节的后端已从移植面（`sync:*` 通道 + `src/main/sync/` 自有实现）
 * 切换为**真实的 NikkiSync LocalSyncServer**（`nikkisync:*` 通道）。
 * 开关落 `nikkisync.syncServerEnabled`；同时必须落 `nikkisync.runtimeEnabled`——
 * 没有内嵌 Runtime 就没有可 `start()` 的上游服务器，否则下次启动服务节是空的。
 */
const SETTING_SYNC_ENABLED = 'nikkisync.syncServerEnabled'
const SETTING_RUNTIME_ENABLED = 'nikkisync.runtimeEnabled'

/**
 * 同步服务设置分区（sync-integration 阶段5 落地，阶段3 改接真实 NikkiSync 服务）。
 *
 * - 开关 = `nikkisync.syncServerEnabled`（+ 隐含 `nikkisync.runtimeEnabled`）+ 立即启停；
 *   启停失败时两个持久化设置与本地状态一并回滚，避免下次启动反复自启失败
 * - 状态卡 2s 轮询 getServerStatus（服务地址 / 服务 ID / TLS 指纹），操作后立即刷新
 * - 不展示“已连接客户端数”：上游 `WebSocketHub.sockets` 是私有成员且无公开计数，
 *   本仓不为此改上游，也不虚构该数字
 * - 设备列表（仅未撤销设备，读 NikkiSync 的 paired_devices）+ 撤销确认（上游 revoke 软删）
 */
export const SyncServiceSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const { showError } = useErrorToast()
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<NikkiSyncServerStatusInfo | null>(null)
  const [devices, setDevices] = useState<NikkiSyncPairedDeviceInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [qrOpen, setQrOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<NikkiSyncPairedDeviceInfo | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const api = window.electronAPI
    if (!api) return
    try {
      const [nextStatus, nextDevices] = await Promise.all([
        api.nikkisync.getServerStatus(),
        api.nikkisync.getPairedDevices().catch(() => [] as NikkiSyncPairedDeviceInfo[])
      ])
      setStatus(nextStatus)
      setDevices(nextDevices)
    } catch {
      // 状态查询失败静默：轮询下一轮重试（未组装时 getServerStatus 返回 available:false 不抛）
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const value = await window.electronAPI?.settings.get(SETTING_SYNC_ENABLED, false)
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

  /** 两个开关同进同退（服务开关隐含 Runtime 开关）。 */
  const persistEnabled = async (value: boolean): Promise<void> => {
    const api = window.electronAPI
    if (!api) return
    await api.settings.set(SETTING_SYNC_ENABLED, value)
    await api.settings.set(SETTING_RUNTIME_ENABLED, value)
  }

  const handleToggle = async (value: boolean): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    setBusy(true)
    setEnabled(value)
    try {
      await persistEnabled(value)
      try {
        if (value) await api.nikkisync.startServer()
        else await api.nikkisync.stopServer()
        showMessage(value ? t('toast.syncEnabled') : t('toast.syncDisabled'))
      } catch (err) {
        // 回滚：两个持久化设置与本地状态一并还原（下次启动不再反复自启失败）
        try {
          await persistEnabled(!value)
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
      const refreshed = await api.nikkisync.revokeDevice(deviceId)
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
                      const address = `${status.lanHost ?? status.host}:${status.port}`
                      void navigator.clipboard
                        .writeText(address)
                        .then(() => showMessage(t('settings.sync.status.copied')))
                        .catch((err) => showError(err))
                    }}
                  >
                    {status.lanHost ?? status.host}:{status.port}
                    <IconCopyText />
                  </button>
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
