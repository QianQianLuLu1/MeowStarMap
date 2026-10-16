import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SectionShell, SettingsToggle, SettingsCard, SettingsRow, useGlobalToast } from './shared'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { EmptyState } from '../../components/common/EmptyState'
import { PairingQrDialog } from '../../components/sync/PairingQrDialog'
import { useErrorToast } from '../../hooks/useErrorToast'
// 阶段 4：切源要同时写 store 的分流开关，否则 UI 与列表取数各说各话
import { useMediaStore } from '../../stores/mediaStore'
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
// 阶段 4：图库数据源开关（'local' | 'nikkisync'），消费点 mediaStore 的源分流
const SETTING_GALLERY_SOURCE = 'gallery.dataSource'
// 阶段 6：上游远端元数据解析开关。渲染层只能写这个布尔键本身
// （在 src/shared/settings-keys.ts 白名单里），出站请求的实际端点由主进程侧常量决定。
const SETTING_METADATA_RESOLVER = 'nikkisync.metadataResolverEnabled'

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
  const [gallerySource, setGallerySource] = useState<'local' | 'nikkisync'>('local')
  // 阶段 6：上游远端元数据解析开关（默认关——为真即产生对第三方的出站请求）
  const [metadataEnabled, setMetadataEnabled] = useState(false)
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

  /** 阶段 4：图库数据源（'local' 默认 / 'nikkisync'）。 */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const value = await window.electronAPI?.settings.get(SETTING_GALLERY_SOURCE, 'local')
        if (alive && value === 'nikkisync') setGallerySource('nikkisync')
      } catch {
        // 读不到就保持默认本地库：切源是显式选择，绝不默认生效
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /** 阶段 6：元数据解析开关的读回。读不到一律保持关闭（该开关有出站后果，不默认生效）。 */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const value = await window.electronAPI?.settings.get(SETTING_METADATA_RESOLVER, false)
        if (alive) setMetadataEnabled(value === true)
      } catch {
        // 静默：保持关闭态
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const handleGallerySourceToggle = async (value: boolean): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    const next = value ? 'nikkisync' : 'local'
    const previous = gallerySource
    setBusy(true)
    setGallerySource(next)
    // store 先行：列表分流读的就是这个状态
    useMediaStore.getState().setSource(next)
    try {
      await api.settings.set(SETTING_GALLERY_SOURCE, next)
      if (next === 'nikkisync') {
        // 没有 Runtime 会话就没有可查的 assets 表 ⇒ 切源隐含启用运行时
        await api.settings.set(SETTING_RUNTIME_ENABLED, true)
        // 立即触发一次扫描：首次切过去时 NikkiSync 库往往还是空的。
        // 扫描是异步长任务，这里刻意不 await —— 完成后主进程推 library-changed，
        // 图库页据此自动刷新，设置页不必阻塞在扫描上
        void api.nikkisync.startScan({}).catch((error: unknown) => {
          showError(error)
        })
      }
      showMessage(t('settings.sync.gallerySourceApplied', { source: next }), 'success')
    } catch (error) {
      // 持久化失败即回滚三处状态，避免「UI 显示已切、下次启动又回本地」的不一致
      setGallerySource(previous)
      useMediaStore.getState().setSource(previous)
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 阶段 6：元数据解析开关。
   *
   * 只写自己那一个设置项：**不**启停同步服务、**不**改数据源、**不**触发扫描——
   * 那三件事各有自己的开关与后果，混在一个处理器里会让用户无法判定「我刚才到底开了什么」。
   * 生效时机是下一次建会话（重启，或换根 / 改端口触发的重建），因此这里刻意不做
   * 「立即生效」的伪装；成功也不再弹确认条（开关状态本身就是反馈），
   * 只为真正需要用户知道的失败路径报错并回滚。
   */
  const handleMetadataToggle = async (value: boolean): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    const previous = metadataEnabled
    setBusy(true)
    setMetadataEnabled(value)
    try {
      await api.settings.set(SETTING_METADATA_RESOLVER, value)
    } catch (error) {
      setMetadataEnabled(previous)
      showError(error)
    } finally {
      setBusy(false)
    }
  }

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
        {/* 阶段 4：图库数据源。默认本地库，切到 NikkiSync 隐含要求 Runtime 已启用，
            否则运行时没跑、它的库也没扫过，切过去必然是一片空白 */}
        <SettingsToggle
          label={t('settings.sync.gallerySource')}
          description={t('settings.sync.gallerySourceDesc')}
          checked={gallerySource === 'nikkisync'}
          disabled={busy}
          onChange={(value) => void handleGallerySourceToggle(value)}
        />
        {/* 阶段 6：上游远端元数据解析。默认关闭，开启即向第三方发起请求 */}
        <SettingsToggle
          label={t('settings.sync.metadata.enable')}
          description={t('settings.sync.metadata.enableDesc')}
          checked={metadataEnabled}
          disabled={busy}
          onChange={(value) => void handleMetadataToggle(value)}
        />
        {/* 披露常驻可见，不放进 tooltip、也不等开了之后再找：
            用户必须在点下去之前就看到「发给谁、写到哪里、会不会下发给已配对设备」 */}
        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.sync.metadata.disclosure')}
        </p>
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
