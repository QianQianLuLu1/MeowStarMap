import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
// 复用设置页的展示原语（与迁出前 SyncServicePage 同款跨目录引用，见其原注释）。
import { SectionShell, SettingsToggle, SettingsCard, SettingsRow } from '../../settings/shared'
import { useGlobalToast } from '../../../components/common/ToastProvider'
import { ConfirmDialog } from '../../../components/common/ConfirmDialog'
import { EmptyState } from '../../../components/common/EmptyState'
import { PairingQrDialog } from '../../../components/sync/PairingQrDialog'
import { usePairingQr } from '../../../components/sync/usePairingQr'
import { useErrorToast } from '../../../hooks/useErrorToast'
import { IconCopyText } from '../../../icons'
import { useUIStore } from '../../../stores/uiStore'
import type {
  NikkiSyncPairedDeviceInfo,
  NikkiSyncServerStatusInfo
} from '../../../../shared/types/electron-api'
import { CONSOLE_HEADING_KEYS, type ConsoleView } from './console-views'
import { useSyncOverview } from './useSyncOverview'
import { SelfCheckCard } from './SelfCheckCard'
import { exportDiagnostics, openUpstreamLink } from './export-diagnostics'
import { UPSTREAM_ANDROID_APK_URL, UPSTREAM_QUARK_URL, UPSTREAM_BAIDU_URL } from './upstream-links'

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
 * K1：本仓编排点自报的启动阶段 → i18n key 映射。
 * 主进程只会记真实发生的阶段（scanner / runtime-ready / lan-listen / cached-metadata）；
 * 上游六阶段里的 dictionary-enrichment / background-services 在本仓编排下不会发生，
 * 永不出现。未知阶段键原样回退展示英文短码（不谎报、不吞）。
 */
const STARTUP_STAGE_I18N_KEYS: Record<string, string> = {
  scanner: 'syncService.startupStages.stage.scanner',
  'runtime-ready': 'syncService.startupStages.stage.runtimeReady',
  'lan-listen': 'syncService.startupStages.stage.lanListen',
  'cached-metadata': 'syncService.startupStages.stage.cachedMetadata'
}

/**
 * K7：`scanDiagnostics.lastScan` 七计数 → 「观察 31 · 收录 25 …」紧凑串。
 * 纯展示聚合：缺段跳过、全缺返回 null（行不渲染），绝不给缺省计数编 0。
 */
function formatLastScanCounts(scanDiagnostics: unknown, t: (key: string) => string): string | null {
  const lastScan =
    typeof scanDiagnostics === 'object' && scanDiagnostics !== null
      ? (scanDiagnostics as { lastScan?: Record<string, unknown> }).lastScan
      : undefined
  if (typeof lastScan !== 'object' || lastScan === null) return null
  const entries: Array<[string, string]> = [
    ['filesObserved', t('syncService.diagnostics.lastScanObserved')],
    ['resourcesAccepted', t('syncService.diagnostics.lastScanAccepted')],
    ['resourcesIgnored', t('syncService.diagnostics.lastScanIgnored')],
    ['assetsCreated', t('syncService.diagnostics.lastScanCreated')],
    ['assetsUpdated', t('syncService.diagnostics.lastScanUpdated')],
    ['assetsDeleted', t('syncService.diagnostics.lastScanDeleted')],
    ['errorCount', t('syncService.diagnostics.lastScanErrors')]
  ]
  const parts = entries
    .filter(([key]) => typeof lastScan[key] === 'number')
    .map(([key, label]) => `${label} ${String(lastScan[key])}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** T3：微信入口折叠的持久化键（上游 pc-companion 同款字面量，逐字保留）。 */
const WECHAT_ENTRY_SEEN_KEY = 'momo.wechat-entry.seen.v1'

interface ConnectViewProps {
  onNavigate: (view: ConsoleView) => void
}

/**
 * T1/T3：手机连接视图（控制台默认视图）。
 *
 * 自 SyncServicePage 原样迁入：service 状态卡（总开关 + 2s 轮询 + K1 启动阶段 +
 * K4/K7 诊断折叠）、配对新设备（PairingQrDialog）、已配对设备（撤销确认流）、
 * N7 微信画廊卡。行为契约由 console/ConnectView.test.tsx 逐条钉住（原判据不重写）。
 *
 * T3 新增（上游 DesktopPage.ts:46-82 connect 页移植）：
 * - 资产总览统计卡（useSyncOverview，仅本视图可见时 2s 轮询）
 * - firstRun（配对数为 0）内联首次配对二维码（usePairingQr，与对话框共享 5 分钟过期判据）
 * - Android App 卡（新二维码 / APK 直链 / 连接失败导出诊断包）
 * - 首次使用引导（<details>，不做完成态持久化）
 * - SelfCheckCard（掉线自动展开）
 * - 微信卡折叠持久化（'momo.wechat-entry.seen.v1'）
 *
 * keep-alive 纪律：本页挂在 App.tsx 的 keep-alive 循环里，切走只 display:none 不卸载，
 * 所有轮询必须按 currentView 门控；控制台子视图切走时本组件整体卸载，定时器随 cleanup 清零。
 */
export const ConnectView: React.FC<ConnectViewProps> = ({ onNavigate }) => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const { showError } = useErrorToast()
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<NikkiSyncServerStatusInfo | null>(null)
  // K1：本会话真实发生的启动阶段（runtime-status 响应体可选段；缺省 = 尚无已完成阶段）
  const [startupStages, setStartupStages] = useState<Array<{ stage: string; at: string }>>([])
  // K7：最近一次扫描的诊断聚合计数（runtime-status 响应体可选段；未扫描/老链接缺省）
  const [scanDiagnostics, setScanDiagnostics] = useState<Record<string, unknown> | null>(null)
  const [devices, setDevices] = useState<NikkiSyncPairedDeviceInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [qrOpen, setQrOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<NikkiSyncPairedDeviceInfo | null>(null)
  const currentView = useUIStore((s) => s.currentView)
  const visible = currentView === 'sync-service'

  // T3：资产总览（仅可见时轮询；桥面缺席恒 null）
  const overview = useSyncOverview(visible)
  const running = Boolean(status?.running)
  // firstRun 内联二维码：上游首跑判据（配对数为 0）且服务在跑才有内容可生成
  const firstRunActive = visible && running && overview?.firstRun === true
  const firstRunQr = usePairingQr(firstRunActive)

  // T3：微信卡折叠态（看过一次即收起；持久化键逐字对齐上游）
  const [wechatOpen, setWechatOpen] = useState(() => {
    try {
      return window.localStorage.getItem(WECHAT_ENTRY_SEEN_KEY) !== '1'
    } catch {
      return true
    }
  })
  const persistWechatFold = useCallback((open: boolean): void => {
    try {
      if (open) window.localStorage.removeItem(WECHAT_ENTRY_SEEN_KEY)
      else window.localStorage.setItem(WECHAT_ENTRY_SEEN_KEY, '1')
    } catch {
      // 隐私模式等存储不可用场景：折叠态仅本次会话生效
    }
  }, [])

  // 微信画廊连上即收起入口卡（稳定身份，避免轮询渲染反复触发 effect）
  const handleWechatConnected = useCallback((): void => {
    setWechatOpen(false)
    persistWechatFold(false)
  }, [persistWechatFold])

  // R3 审查修复：在途刷新守卫——切走/卸载后慢响应不得再 setState（轮询与手动刷新共用）
  const pollAliveRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    const api = window.electronAPI
    if (!api) return
    try {
      const [nextStatus, nextDevices, nextRuntime] = await Promise.all([
        api.nikkisync.getServerStatus(),
        api.nikkisync.getPairedDevices().catch(() => [] as NikkiSyncPairedDeviceInfo[]),
        // K1：启动阶段随 runtime-status 一并拉取；失败降级为「无阶段」，不打断状态轮询
        api.nikkisync
          .getRuntimeStatus()
          .catch(() => null as { startupStages?: Array<{ stage: string; at: string }> } | null)
      ])
      if (!pollAliveRef.current) return
      setStatus(nextStatus)
      setDevices(nextDevices)
      setStartupStages(nextRuntime?.startupStages ?? [])
      setScanDiagnostics(
        (nextRuntime as { scanDiagnostics?: Record<string, unknown> } | null)?.scanDiagnostics ??
          null
      )
    } catch {
      // 状态查询失败静默：轮询下一轮重试（未组装时 getServerStatus 返回 available:false 不抛）
    }
  }, [])

  useEffect(() => {
    // keep-alive 下本页切走不卸载，不门控就会后台常驻 2s 定时器（用例 (r)）
    if (currentView !== 'sync-service') return
    let alive = true
    pollAliveRef.current = true
    void (async () => {
      try {
        const value = await window.electronAPI?.settings.get(SETTING_SYNC_ENABLED, false)
        // 严格 === true：主进程对 app_settings 历史非布尔值收敛成关闭
        // （nikkisync-runtime-setup.ts 的 settingsFrom），渲染层用 Boolean() 会显示「已启用」
        // 而服务其实没起。判据必须与消费点一致。
        if (alive) setEnabled(value === true)
      } catch {
        // 设置读取失败保持默认关闭态
      }
    })()
    void refresh()
    const timer = setInterval(() => void refresh(), STATUS_POLL_MS)
    return () => {
      alive = false
      pollAliveRef.current = false
      clearInterval(timer)
    }
  }, [currentView, refresh])

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
      // 写在同一个 try 里：持久化本身失败也要走下面那条回滚分支。它曾落在只有 finally
      // 没有 catch 的外层 try，rejection 直冒到 `void handleToggle(value)`（悬空 promise），
      // 而 enabled 已翻转 ⇒ UI 显示开启、配置从未落地。
      await persistEnabled(value)
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
      showMessage(t('syncService.devices.revoked'), 'success')
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
      showMessage(t('syncService.status.copied'))
    } catch (err) {
      showError(err)
    }
  }

  // K7：诊断卡「上次扫描」行文本（段缺失/未扫描时为 null ⇒ 行不渲染）
  const lastScanText = formatLastScanCounts(scanDiagnostics, t)
  const pairedCount = overview?.pairedDevices ?? devices.length

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
          {t(CONSOLE_HEADING_KEYS.connect.title)}
        </h3>
      </div>

      {/* T3：资产总览统计卡（上游 connect 页首卡；数值来自 library-overview 观测，不虚构） */}
      <SettingsCard>
        <div className="space-y-1" data-testid="sync-console-stats">
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {t('syncConsole.connect.stats.label')}
          </p>
          {overview?.available ? (
            <>
              <p className="text-sm font-medium">
                {overview.assets ?? 0} {t('syncConsole.connect.stats.assetsUnit')} · {pairedCount}{' '}
                {t('syncConsole.connect.stats.devicesUnit')}
              </p>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('syncConsole.connect.stats.caption')}
              </p>
            </>
          ) : (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncConsole.connect.stats.unavailable')}
            </p>
          )}
        </div>
      </SettingsCard>

      {/* T3：firstRun 内联首次配对二维码（配对数为 0 且服务在跑；与对话框共享生成/过期判据） */}
      {firstRunActive && (
        <SettingsCard>
          <div className="flex flex-col items-center gap-2" data-testid="sync-first-run-qr">
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncConsole.connect.firstRun.hint')}
            </p>
            {firstRunQr.svg !== null ? (
              // qrcode 库输出的是受控 SVG（无外部内容）；白底承载面见 globals.css .sync-qr-surface
              <div
                className="sync-qr-surface w-48 h-48 [&>svg]:w-full [&>svg]:h-full"
                dangerouslySetInnerHTML={{ __html: firstRunQr.svg }}
              />
            ) : (
              <div
                className="w-48 h-48 rounded-lg animate-pulse"
                style={{ background: 'var(--bg-tertiary)' }}
              />
            )}
            {firstRunQr.offer && (
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('syncService.pairing.expiresIn')}：
                {Math.floor((firstRunQr.expiresInSeconds ?? 0) / 60)}:
                {String((firstRunQr.expiresInSeconds ?? 0) % 60).padStart(2, '0')}
              </p>
            )}
          </div>
        </SettingsCard>
      )}

      {/* ①状态总览与总开关（自 SyncServicePage 原样迁入） */}
      <SectionShell
        title={t('syncService.service.title')}
        description={t('syncService.service.description')}
      >
        <SettingsToggle
          label={t('syncService.enable')}
          description={t('syncService.enableDesc')}
          checked={enabled}
          disabled={busy}
          onChange={(value) => void handleToggle(value)}
        />
        <SettingsCard>
          <div className="space-y-2">
            <SettingsRow label={t('syncService.status.label')}>
              <span className="flex items-center gap-2 text-sm">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{
                    background: running ? 'var(--accent)' : 'var(--text-tertiary)'
                  }}
                />
                {!status?.available
                  ? t('syncService.status.unavailable')
                  : running
                    ? t('syncService.status.running')
                    : t('syncService.status.stopped')}
              </span>
            </SettingsRow>
            {/* 灵感同步 v1（上游 589b932）：值取自主进程对装载面的观测，非渲染层常量。
                键缺席只说明当前构建没有这一面，不能据此写「未启用」——那是把环境差异说成用户选择。 */}
            {status?.inspirationV1 && (
              <SettingsRow label={t('syncService.status.inspiration')}>
                <span className="text-xs">{t('syncService.status.inspirationOn')}</span>
              </SettingsRow>
            )}
            {/* 灵感库面板在控制台 Inspiration 视图复用（sync-inspiration 独立二级页保留深链） */}
            {startupStages.length > 0 && (
              <SettingsRow label={t('syncService.startupStages.label')}>
                {/* K1：阶段名→i18n 映射；未知阶段不谎报，原样展示英文短码 */}
                <span className="flex flex-wrap items-center gap-1 text-xs">
                  {startupStages.map((item, index) => (
                    <React.Fragment key={`${item.stage}-${item.at}`}>
                      {index > 0 && <span style={{ color: 'var(--text-tertiary)' }}>→</span>}
                      <span
                        className="rounded px-1.5 py-0.5"
                        style={{ background: 'var(--bg-secondary)' }}
                      >
                        {STARTUP_STAGE_I18N_KEYS[item.stage]
                          ? t(STARTUP_STAGE_I18N_KEYS[item.stage])
                          : item.stage}
                      </span>
                    </React.Fragment>
                  ))}
                </span>
              </SettingsRow>
            )}
            {running && status && (
              <>
                <SettingsRow label={t('syncService.status.address')}>
                  <button
                    type="button"
                    className="icon-btn font-mono text-sm"
                    onClick={() => {
                      const address = `${status.lanHost ?? status.host}:${status.port}`
                      void navigator.clipboard
                        .writeText(address)
                        .then(() => showMessage(t('syncService.status.copied')))
                        .catch((err) => showError(err))
                    }}
                  >
                    {status.lanHost ?? status.host}:{status.port}
                    <IconCopyText />
                  </button>
                </SettingsRow>
                <SettingsRow label={t('syncService.status.serverId')}>
                  <span className="font-mono text-sm">{status.serverId ?? '—'}</span>
                </SettingsRow>
                <SettingsRow label={t('syncService.status.tlsFingerprint')}>
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

        {/* K4：连接诊断折叠卡（观测面：纯聚合既有状态，不做主动探测；未装配时无此段） */}
        {status?.diagnostics && (
          <details className="group">
            <summary
              className="cursor-pointer select-none text-sm"
              style={{ color: 'var(--text-secondary)' }}
            >
              {t('syncService.diagnostics.title')}
            </summary>
            <SettingsCard>
              <div className="space-y-2">
                <SettingsRow label={t('syncService.diagnostics.bindAddress')}>
                  <span className="font-mono text-xs">{status.diagnostics.host}</span>
                </SettingsRow>
                <SettingsRow label={t('syncService.diagnostics.port')}>
                  <span className="font-mono text-xs">{status.diagnostics.port}</span>
                </SettingsRow>
                <SettingsRow label={t('syncService.diagnostics.secure')}>
                  <span className="text-xs">
                    {status.diagnostics.secure
                      ? t('syncService.diagnostics.secureOn')
                      : t('syncService.diagnostics.secureOff')}
                  </span>
                </SettingsRow>
                {status.diagnostics.tlsFingerprintTail8 && (
                  <SettingsRow label={t('syncService.diagnostics.tlsTail')}>
                    <span className="font-mono text-xs">
                      {status.diagnostics.tlsFingerprintTail8}
                    </span>
                  </SettingsRow>
                )}
                {status.diagnostics.pairedDeviceCount !== undefined && (
                  <SettingsRow label={t('syncService.diagnostics.devices')}>
                    <span className="text-xs">{status.diagnostics.pairedDeviceCount}</span>
                  </SettingsRow>
                )}
                {status.diagnostics.connectionHosts &&
                  status.diagnostics.connectionHosts.length > 0 && (
                    <SettingsRow label={t('syncService.diagnostics.altHosts')}>
                      <span className="font-mono text-xs">
                        {status.diagnostics.connectionHosts.join(' · ')}
                      </span>
                    </SettingsRow>
                  )}
                {/* K7：上次扫描计数（runtime-status 响应体；仅计数无路径/UID/错误原文） */}
                {lastScanText && (
                  <SettingsRow label={t('syncService.diagnostics.lastScan')}>
                    <span className="font-mono text-xs">{lastScanText}</span>
                  </SettingsRow>
                )}
                {status.diagnostics.lastError && (
                  <SettingsRow label={t('syncService.diagnostics.lastError')}>
                    <span className="font-mono text-xs" style={{ color: 'var(--danger)' }}>
                      {status.diagnostics.lastError}
                    </span>
                  </SettingsRow>
                )}
              </div>
            </SettingsCard>
          </details>
        )}
      </SectionShell>

      {/* ②配对：服务没跑起来时二维码无内容可生成，按钮按 running 禁用 */}
      <SectionShell title={t('syncService.pairing.title')}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {running ? t('syncService.pairing.hintRunning') : t('syncService.pairing.hintDisabled')}
          </p>
          <button
            type="button"
            className="btn-primary text-sm"
            disabled={!running}
            onClick={() => setQrOpen(true)}
          >
            {t('syncService.pairing.open')}
          </button>
        </div>
      </SectionShell>

      {/* ③设备管理 */}
      <SectionShell title={t('syncService.devices.title')}>
        {devices.length === 0 ? (
          <EmptyState
            title={t('syncService.devices.empty')}
            subtitle={t('syncService.devices.emptyHint')}
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
                      {t('syncService.devices.lastSeen')}：
                      {device.lastSeenAt
                        ? new Date(device.lastSeenAt).toLocaleString()
                        : t('syncService.devices.never')}
                    </span>
                    <button
                      type="button"
                      className="btn-danger text-xs"
                      onClick={() => setRevokeTarget(device)}
                    >
                      {t('syncService.devices.revoke')}
                    </button>
                  </div>
                </SettingsRow>
              </SettingsCard>
            ))}
          </div>
        )}
      </SectionShell>

      {/* T3：Android App 卡（上游 connect 页 androidCard 移植） */}
      <SectionShell
        title={t('syncConsole.connect.android.title')}
        description={t('syncConsole.connect.android.description')}
      >
        <div className="space-y-2">
          {pairedCount > 0 ? (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncConsole.connect.android.paired')} ·{' '}
              {t('syncConsole.connect.android.pairedHint')}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncConsole.connect.android.newQrNote')}
            </p>
            <button
              type="button"
              className="btn-primary text-sm"
              disabled={!running}
              onClick={() => setQrOpen(true)}
            >
              {t('syncConsole.connect.android.newQr')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary text-sm"
              onClick={() => void openUpstreamLink(UPSTREAM_ANDROID_APK_URL, showError)}
            >
              {t('syncConsole.connect.android.download')}
            </button>
            <button
              type="button"
              className="btn-ghost text-sm"
              onClick={() => void exportDiagnostics(t, showMessage, showError)}
            >
              {t('syncConsole.connect.android.export')}
            </button>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {t('syncConsole.connect.android.exportNote')}
          </p>
        </div>
      </SectionShell>

      {/* N7：PC 端分区（微信画廊）——T3 起包进可折叠卡，折叠态持久化（上游同款键） */}
      <details
        className="group"
        open={wechatOpen}
        onToggle={(event) => {
          const open = event.currentTarget.open
          setWechatOpen(open)
          persistWechatFold(open)
        }}
      >
        <summary
          className="cursor-pointer select-none text-sm"
          style={{ color: 'var(--text-secondary)' }}
        >
          {t('syncService.pc.title')}
        </summary>
        <SyncPcCompanionSection onConnected={handleWechatConnected} />
      </details>

      {/* T3：首次使用引导（上游 firstUse 移植；<details> 不做完成态持久化） */}
      <details className="group">
        <summary
          className="cursor-pointer select-none text-sm"
          style={{ color: 'var(--text-secondary)' }}
        >
          {t('syncConsole.connect.guide.title')} · {t('syncConsole.connect.guide.summary')}
        </summary>
        <SettingsCard>
          <div className="space-y-3">
            <ol className="space-y-2">
              {(
                [
                  ['step1Title', 'step1Body'],
                  ['step2Title', 'step2Body'],
                  ['step3Title', 'step3Body']
                ] as const
              ).map(([titleKey, bodyKey]) => (
                <li key={titleKey} className="text-xs">
                  <strong className="block text-sm font-medium">
                    {t(`syncConsole.connect.guide.${titleKey}`)}
                  </strong>
                  <span style={{ color: 'var(--text-tertiary)' }}>
                    {t(`syncConsole.connect.guide.${bodyKey}`)}
                  </span>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => void openUpstreamLink(UPSTREAM_QUARK_URL, showError)}
              >
                {t('syncConsole.connect.guide.quark')}
              </button>
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => void openUpstreamLink(UPSTREAM_BAIDU_URL, showError)}
              >
                {t('syncConsole.connect.guide.baidu')}
              </button>
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => onNavigate('settings')}
              >
                {t('syncConsole.connect.guide.openNetwork')}
              </button>
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => onNavigate('settings')}
              >
                {t('syncConsole.connect.guide.openScan')}
              </button>
            </div>
          </div>
        </SettingsCard>
      </details>

      {/* T3：连接自查（掉线自动展开） */}
      <SelfCheckCard status={status} onNavigate={onNavigate} />

      {/* T3：隐私口径（上游 connect 页脚注逐字） */}
      <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
        {t('syncConsole.connect.privacyNote')}
      </p>

      <PairingQrDialog open={qrOpen} onClose={() => setQrOpen(false)} />
      <ConfirmDialog
        open={revokeTarget !== null}
        title={t('syncService.devices.revokeConfirmTitle')}
        message={t('syncService.devices.revokeConfirmMessage', {
          name: revokeTarget?.deviceName ?? ''
        })}
        confirmText={t('syncService.devices.revokeConfirm')}
        confirmVariant="danger"
        onConfirm={() => void handleRevokeConfirm()}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  )
}

/**
 * N7：PC 端分区。打开控制页走既有 `electronAPI.shell.openExternal` 桥；微信画廊
 * 启停/状态经 `nikkisync:wechat-*` 四条通道。桥面方法缺席（老 preload / 服务未装配）
 * 一律静默降级为不可用提示，绝不把 IPC rejection 冒成未捕获错误或全局 toast。
 * 二维码 SVG 由本仓主进程 `qrcode` 生成，经 data URL 渲染（不引入 innerHTML）。
 */
const SyncPcCompanionSection: React.FC<{ onConnected?: () => void }> = ({ onConnected }) => {
  const { t } = useTranslation()
  const currentView = useUIStore((s) => s.currentView)
  const [wechatStatus, setWechatStatus] = useState<unknown>(null)
  const [qrSvg, setQrSvg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  // R3 审查修复：在途刷新守卫（与页头状态卡同口径）
  const sectionAliveRef = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    const client = window.electronAPI?.nikkisync
    if (typeof client?.wechatStatus !== 'function') return
    try {
      const res = await client.wechatStatus()
      if (!sectionAliveRef.current) return
      setWechatStatus(res?.status ?? null)
      setFailed(false)
    } catch {
      if (sectionAliveRef.current) setFailed(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // F12：父页 keep-alive 不卸载本分区，仅挂载取一次会让画廊状态整会话陈旧
  // （画廊可能被本机控制页在外部启停）。与页头服务状态卡同口径轮询，
  // 并按 currentView 门控——离开本页不后台常驻定时器。
  useEffect(() => {
    if (currentView !== 'sync-service') return
    sectionAliveRef.current = true
    const timer = setInterval(() => void refresh(), STATUS_POLL_MS)
    return () => {
      sectionAliveRef.current = false
      clearInterval(timer)
    }
  }, [currentView, refresh])

  const stateText =
    typeof wechatStatus === 'object' && wechatStatus !== null && 'state' in wechatStatus
      ? String((wechatStatus as Record<string, unknown>).state ?? '')
      : ''

  // T3：微信画廊连上即收起入口卡（上游同款「看过一次即折叠」语义的完成态分支）
  useEffect(() => {
    if (stateText === 'connected') onConnected?.()
  }, [stateText, onConnected])

  const openDesktop = async (): Promise<void> => {
    const client = window.electronAPI?.nikkisync
    const shell = window.electronAPI?.shell
    if (typeof client?.desktopOpen !== 'function' || typeof shell?.openExternal !== 'function') {
      return
    }
    setFailed(false)
    try {
      const { url } = await client.desktopOpen()
      if (url) await shell.openExternal(url)
    } catch {
      setFailed(true)
    }
  }

  const startWechat = async (): Promise<void> => {
    const client = window.electronAPI?.nikkisync
    if (typeof client?.wechatStart !== 'function') return
    setBusy(true)
    setFailed(false)
    try {
      const res = await client.wechatStart()
      setQrSvg(typeof res?.qrSvg === 'string' ? res.qrSvg : null)
      setWechatStatus(res?.status ?? null)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const stopWechat = async (): Promise<void> => {
    const client = window.electronAPI?.nikkisync
    if (typeof client?.wechatStop !== 'function') return
    setBusy(true)
    setFailed(false)
    try {
      const res = await client.wechatStop()
      setQrSvg(null)
      setWechatStatus(res?.status ?? null)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="sync-service-pc-section">
      <SectionShell title={t('syncService.pc.title')} description={t('syncService.pc.description')}>
        <SettingsCard>
          <div className="space-y-2">
            <button
              type="button"
              data-testid="pc-open-desktop"
              className="btn-secondary text-sm"
              onClick={() => void openDesktop()}
            >
              {t('syncService.pc.openDesktop')}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="pc-wechat-start"
                className="btn-primary text-sm"
                disabled={busy}
                onClick={() => void startWechat()}
              >
                {t('syncService.pc.wechatStart')}
              </button>
              <button
                type="button"
                data-testid="pc-wechat-stop"
                className="btn-ghost text-sm"
                disabled={busy}
                onClick={() => void stopWechat()}
              >
                {t('syncService.pc.wechatStop')}
              </button>
            </div>
            <p
              data-testid="pc-wechat-status"
              className="text-xs"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('syncService.pc.wechatStatus', { state: stateText })}
            </p>
            {qrSvg && (
              <img
                data-testid="pc-wechat-qr"
                alt=""
                className="h-40 w-40"
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`}
              />
            )}
            {failed && (
              <p
                data-testid="pc-error"
                className="text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t('syncService.pc.unavailable')}
              </p>
            )}
          </div>
        </SettingsCard>
      </SectionShell>
    </div>
  )
}
