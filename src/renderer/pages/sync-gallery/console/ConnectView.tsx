import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
// 复用设置页的展示原语（与迁出前 SyncServicePage 同款跨目录引用，见其原注释）。
import { SettingsToggle } from '../../settings/shared'
import { ConsoleCard, ConsoleBadge, ConsoleHint, ConsoleRow, ConsoleSection } from './console-ui'
import { ConsoleIcon } from './ConsoleIcons'
import { WECHAT_MINI_ENTRY_IMAGE } from './brand-assets'
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
import { SYNC_CONSOLE_HOST_VIEW, type ConsoleView } from './console-views'
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
  /** N3：把轮询到的服务快照回传给 Layout 的页头状态 chip（不新增全局定时器）。 */
  onServerStatusChange?: (status: NikkiSyncServerStatusInfo | null) => void
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
export const ConnectView: React.FC<ConnectViewProps> = ({ onNavigate, onServerStatusChange }) => {
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
  const visible = currentView === SYNC_CONSOLE_HOST_VIEW

  // T3：资产总览（仅可见时轮询；桥面缺席恒 null）
  const overview = useSyncOverview(visible)
  const running = Boolean(status?.running)
  // firstRun 内联二维码：上游首跑判据（配对数为 0）且服务在跑才有内容可生成
  const firstRunActive = visible && running && overview?.firstRun === true
  const firstRunQr = usePairingQr(firstRunActive)

  // 微信入口码的「看过即收起」由通道卡内的 details 自己持久化（上游 momo.wechat-entry.seen.v1）

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
      onServerStatusChange?.(nextStatus)
      // 外部输入一律不可信：畸形设备项/启动阶段项直接丢，不让脏数据在渲染期抛错（整页变错误页）
      setDevices(
        (nextDevices ?? []).filter(
          (device) => typeof device?.deviceId === 'string' && device.deviceId.length > 0
        )
      )
      setStartupStages(
        (nextRuntime?.startupStages ?? []).filter(
          (item): item is { stage: string; at: string } =>
            typeof item?.stage === 'string' && typeof item?.at === 'string'
        )
      )
      setScanDiagnostics(
        (nextRuntime as { scanDiagnostics?: Record<string, unknown> } | null)?.scanDiagnostics ??
          null
      )
    } catch {
      // 状态查询失败静默：轮询下一轮重试（未组装时 getServerStatus 返回 available:false 不抛）
    }
  }, [onServerStatusChange])

  useEffect(() => {
    // keep-alive 下本页切走不卸载，不门控就会后台常驻 2s 定时器（用例 (r)）
    if (currentView !== SYNC_CONSOLE_HOST_VIEW) return
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
    <div className="sc-connect">
      {/* T3：资产总览（上游 library-overview 大数字卡；数值只取观测，不虚构 0） */}
      <ConsoleCard className="sc-library-overview" testId="sync-console-stats">
        <span className="sc-library-icon">
          <ConsoleIcon name="album" />
        </span>
        <div className="sc-library-main">
          <p className="sc-library-label">{t('syncConsole.connect.stats.label')}</p>
          {overview?.available ? (
            <>
              <div className="sc-library-number">
                <b>{overview.assets ?? 0}</b>
                <span>{t('syncConsole.connect.stats.assetsUnit')}</span>
              </div>
              <p className="sc-library-caption">{t('syncConsole.connect.stats.caption')}</p>
            </>
          ) : (
            <p className="sc-library-caption">{t('syncConsole.connect.stats.unavailable')}</p>
          )}
        </div>
        <div className="sc-device-summary">
          <ConsoleIcon name="phone" />
          <span>
            <b>{pairedCount}</b>
            {t('syncConsole.connect.stats.devicesUnit')}
          </span>
        </div>
      </ConsoleCard>

      <div className="sc-section-heading">
        <h2>{t('syncConsole.connect.section.title')}</h2>
        <ConsoleHint>{t('syncConsole.connect.section.networkHint')}</ConsoleHint>
      </div>

      <div className="sc-connection-grid">
        {/* T3：Android 通道卡（上游 androidCard 移植；首配二维码与宿主操作同卡） */}
        <ConsoleCard className="sc-connection-card" testId="sync-console-android-card">
          <div className="sc-channel-top">
            <span className="sc-channel-icon">
              <ConsoleIcon name="android" />
            </span>
            <ConsoleBadge>{t('syncConsole.shell.brandLatin')}</ConsoleBadge>
          </div>
          <h2>{t('syncConsole.connect.android.title')}</h2>
          <p className="sc-channel-description">{t('syncConsole.connect.android.description')}</p>
          {firstRunActive && (
            <div className="sc-first-pairing" data-testid="sync-first-run-qr">
              <p className="sc-channel-note">{t('syncConsole.connect.firstRun.hint')}</p>
              {firstRunQr.svg !== null ? (
                <div
                  className="sync-qr-surface [&>svg]:w-full [&>svg]:h-full"
                  dangerouslySetInnerHTML={{ __html: firstRunQr.svg }}
                />
              ) : (
                <div className="sync-qr-surface animate-pulse" />
              )}
              {firstRunQr.offer && (
                <p className="sc-channel-note">
                  {t('syncService.pairing.expiresIn')}：
                  {Math.floor((firstRunQr.expiresInSeconds ?? 0) / 60)}:
                  {String((firstRunQr.expiresInSeconds ?? 0) % 60).padStart(2, '0')}
                </p>
              )}
            </div>
          )}
          {pairedCount > 0 && (
            <div className="sc-paired-note">
              <ConsoleIcon name="check" />
              <div>
                <strong>{t('syncConsole.connect.android.paired')}</strong>
                <span>{t('syncConsole.connect.android.pairedHint')}</span>
              </div>
            </div>
          )}
          <ol className="sc-connection-steps">
            <li>
              <span className="sc-step-number">1</span>
              {t('syncConsole.connect.android.stepInstall')}
            </li>
            <li>
              <span className="sc-step-number">2</span>
              {t('syncConsole.connect.android.stepPair')}
            </li>
            <li>
              <span className="sc-step-number">3</span>
              {t('syncConsole.connect.android.stepBrowse')}
            </li>
          </ol>
          <button
            type="button"
            className="btn-primary sc-channel-action"
            disabled={!running}
            onClick={() => setQrOpen(true)}
          >
            {t('syncConsole.connect.android.newQr')}
          </button>
          <p className="sc-channel-note">
            {running
              ? t('syncConsole.connect.android.newQrNote')
              : t('syncService.pairing.hintDisabled')}
          </p>
          <div className="sc-button-row">
            <button
              type="button"
              className="btn-secondary text-sm"
              onClick={() => void openUpstreamLink(UPSTREAM_ANDROID_APK_URL, showError)}
            >
              {t('syncConsole.connect.android.download')}
            </button>
            <button
              type="button"
              className="btn-secondary text-sm"
              onClick={() => void exportDiagnostics(t, showMessage, showError)}
            >
              {t('syncConsole.connect.android.export')}
            </button>
          </div>
          <p className="sc-channel-note">{t('syncConsole.connect.android.exportNote')}</p>
        </ConsoleCard>

        {/* N7：微信小程序通道卡（上游 wechatPanelHtml：入口码 + 步骤 + 连接码 + 底部入口） */}
        <SyncPcCompanionSection />
      </div>

      {/* T3：首次使用引导（上游 firstUse 移植；details 不做完成态持久化） */}
      <details className="sc-details sc-card">
        <summary>
          {t('syncConsole.connect.guide.title')}
          <span>{t('syncConsole.connect.guide.summary')}</span>
        </summary>
        <ol className="sc-connection-steps">
          {(
            [
              ['step1Title', 'step1Body'],
              ['step2Title', 'step2Body'],
              ['step3Title', 'step3Body']
            ] as const
          ).map(([titleKey, bodyKey]) => (
            <li key={titleKey}>
              <div>
                <strong className="sc-setting-title">
                  {t(`syncConsole.connect.guide.${titleKey}`)}
                </strong>
                <p className="sc-setting-help">{t(`syncConsole.connect.guide.${bodyKey}`)}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="sc-button-row">
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
            className="btn-secondary text-xs"
            onClick={() => onNavigate('settings')}
          >
            {t('syncConsole.connect.guide.openNetwork')}
          </button>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => onNavigate('settings')}
          >
            {t('syncConsole.connect.guide.openScan')}
          </button>
        </div>
      </details>

      {/* T3：连接自查（掉线自动展开） */}
      <SelfCheckCard status={status} onNavigate={onNavigate} />

      <p className="sc-privacy-note">
        <ConsoleIcon name="shield" size={14} />
        {t('syncConsole.connect.privacyNote')}
      </p>

      {/* 宿主增强：上游控制页不暴露的服务开关/配对/设备管理，控制台保留为独立卡片 */}
      <div className="sc-service-stack">
        <ConsoleSection
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
          <div className="sc-service-rows">
            <ConsoleRow label={t('syncService.status.label')}>
              <span className="flex items-center gap-2 text-sm">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: running ? 'var(--accent)' : 'var(--text-tertiary)' }}
                />
                {!status?.available
                  ? t('syncService.status.unavailable')
                  : running
                    ? t('syncService.status.running')
                    : t('syncService.status.stopped')}
              </span>
            </ConsoleRow>
            {/* 灵感同步 v1：键缺席只说明当前构建没有这一面，不能说成用户关掉了 */}
            {status?.inspirationV1 && (
              <ConsoleRow label={t('syncService.status.inspiration')}>
                <span className="text-xs">{t('syncService.status.inspirationOn')}</span>
              </ConsoleRow>
            )}
            {startupStages.length > 0 && (
              <ConsoleRow label={t('syncService.startupStages.label')}>
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
              </ConsoleRow>
            )}
            {running && status && (
              <>
                <ConsoleRow label={t('syncService.status.address')}>
                  <button
                    type="button"
                    className="btn-secondary font-mono text-xs"
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
                </ConsoleRow>
                <ConsoleRow label={t('syncService.status.serverId')}>
                  <span className="font-mono text-xs">{status.serverId ?? '—'}</span>
                </ConsoleRow>
                <ConsoleRow label={t('syncService.status.tlsFingerprint')}>
                  <button
                    type="button"
                    className="btn-secondary font-mono text-xs"
                    title={status.tlsFingerprintSha256 ?? ''}
                    onClick={() => void copyFingerprint()}
                  >
                    {(status.tlsFingerprintSha256 ?? '').slice(0, 16)}…
                    <IconCopyText />
                  </button>
                </ConsoleRow>
              </>
            )}
          </div>

          {/* K4：连接诊断折叠卡（只聚合既有观测，不做主动探测） */}
          {status?.diagnostics && (
            <details className="sc-details">
              <summary>{t('syncService.diagnostics.title')}</summary>
              <div className="sc-service-rows">
                <ConsoleRow label={t('syncService.diagnostics.bindAddress')}>
                  <span className="font-mono text-xs">{status.diagnostics.host}</span>
                </ConsoleRow>
                <ConsoleRow label={t('syncService.diagnostics.port')}>
                  <span className="font-mono text-xs">{status.diagnostics.port}</span>
                </ConsoleRow>
                <ConsoleRow label={t('syncService.diagnostics.secure')}>
                  <span className="text-xs">
                    {status.diagnostics.secure
                      ? t('syncService.diagnostics.secureOn')
                      : t('syncService.diagnostics.secureOff')}
                  </span>
                </ConsoleRow>
                {status.diagnostics.tlsFingerprintTail8 && (
                  <ConsoleRow label={t('syncService.diagnostics.tlsTail')}>
                    <span className="font-mono text-xs">
                      {status.diagnostics.tlsFingerprintTail8}
                    </span>
                  </ConsoleRow>
                )}
                {status.diagnostics.pairedDeviceCount !== undefined && (
                  <ConsoleRow label={t('syncService.diagnostics.devices')}>
                    <span className="text-xs">{status.diagnostics.pairedDeviceCount}</span>
                  </ConsoleRow>
                )}
                {status.diagnostics.connectionHosts &&
                  status.diagnostics.connectionHosts.length > 0 && (
                    <ConsoleRow label={t('syncService.diagnostics.altHosts')}>
                      <span className="font-mono text-xs">
                        {status.diagnostics.connectionHosts.join(' · ')}
                      </span>
                    </ConsoleRow>
                  )}
                {lastScanText && (
                  <ConsoleRow label={t('syncService.diagnostics.lastScan')}>
                    <span className="font-mono text-xs">{lastScanText}</span>
                  </ConsoleRow>
                )}
                {status.diagnostics.lastError && (
                  <ConsoleRow label={t('syncService.diagnostics.lastError')}>
                    <span className="font-mono text-xs" style={{ color: 'var(--danger)' }}>
                      {status.diagnostics.lastError}
                    </span>
                  </ConsoleRow>
                )}
              </div>
            </details>
          )}
        </ConsoleSection>

        <ConsoleSection title={t('syncService.pairing.title')}>
          <div className="sc-button-row">
            <p className="sc-setting-help">
              {running
                ? t('syncService.pairing.hintRunning')
                : t('syncService.pairing.hintDisabled')}
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
        </ConsoleSection>

        <ConsoleSection title={t('syncService.devices.title')}>
          {devices.length === 0 ? (
            <EmptyState
              title={t('syncService.devices.empty')}
              subtitle={t('syncService.devices.emptyHint')}
            />
          ) : (
            <div className="sc-service-rows">
              {devices.map((device) => (
                <ConsoleRow key={device.deviceId} label={device.deviceName}>
                  <div className="flex flex-wrap items-center justify-end gap-3">
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
                </ConsoleRow>
              ))}
            </div>
          )}
        </ConsoleSection>
      </div>
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
const SyncPcCompanionSection: React.FC = () => {
  const { t } = useTranslation()
  const currentView = useUIStore((s) => s.currentView)
  const [wechatStatus, setWechatStatus] = useState<unknown>(null)
  const [qrSvg, setQrSvg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  // 上游 momo.wechat-entry.seen.v1：首次展开入口码，收起一次后记住
  const [entryOpen, setEntryOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(WECHAT_ENTRY_SEEN_KEY) !== '1'
    } catch {
      return true
    }
  })

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
    if (currentView !== SYNC_CONSOLE_HOST_VIEW) return
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

  // T3：微信画廊连上即收起入口码（上游同款「看过一次即折叠」）
  useEffect(() => {
    if (stateText !== 'connected') return
    setEntryOpen(false)
    try {
      window.localStorage.setItem(WECHAT_ENTRY_SEEN_KEY, '1')
    } catch {
      // localStorage 不可用时仅本次会话收起
    }
  }, [stateText])

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
    <ConsoleCard className="sc-connection-card" testId="sync-service-pc-section">
      <div className="sc-channel-top">
        <span className="sc-channel-icon sc-channel-icon-wechat">
          <ConsoleIcon name="wechat" />
        </span>
        <ConsoleBadge>{t('syncConsole.connect.wechat.platforms')}</ConsoleBadge>
      </div>
      <h2>{t('syncConsole.connect.wechat.title')}</h2>
      <p className="sc-channel-description">{t('syncConsole.connect.wechat.description')}</p>
      {/* 上游 wechatPanelHtml：入口码 details 首次展开，看过一次后收起 */}
      <details
        className="sc-wechat-entry-code"
        open={entryOpen}
        onToggle={(event) => {
          const open = event.currentTarget.open
          setEntryOpen(open)
          try {
            if (open) window.localStorage.removeItem(WECHAT_ENTRY_SEEN_KEY)
            else window.localStorage.setItem(WECHAT_ENTRY_SEEN_KEY, '1')
          } catch {
            // localStorage 不可用时仅本次会话保留展开态
          }
        }}
      >
        <summary>{t('syncConsole.connect.wechat.entrySummary')}</summary>
        <img
          src={WECHAT_MINI_ENTRY_IMAGE}
          alt={t('syncConsole.connect.wechat.entryAlt')}
          width={220}
          height={220}
        />
        <p className="sc-channel-note">{t('syncConsole.connect.wechat.entryHint')}</p>
      </details>
      <ol className="sc-connection-steps">
        <li>
          <span className="sc-step-number">1</span>
          {t('syncConsole.connect.wechat.step1')}
        </li>
        <li>
          <span className="sc-step-number">2</span>
          {t('syncConsole.connect.wechat.step2')}
        </li>
        <li>
          <span className="sc-step-number">3</span>
          {t('syncConsole.connect.wechat.step3')}
        </li>
      </ol>
      <button
        type="button"
        data-testid="pc-wechat-start"
        className="btn-primary sc-channel-action"
        disabled={busy}
        onClick={() => void startWechat()}
      >
        {t('syncService.pc.wechatStart')}
      </button>
      <p data-testid="pc-wechat-status" className="sc-channel-note" role="status">
        {t('syncService.pc.wechatStatus', { state: stateText })}
      </p>
      {qrSvg && (
        <div className="sc-wechat-qr">
          <img
            data-testid="pc-wechat-qr"
            alt=""
            className="h-40 w-40"
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`}
          />
        </div>
      )}
      {failed && (
        <p data-testid="pc-error" className="sc-channel-note">
          {t('syncService.pc.unavailable')}
        </p>
      )}
      <div className="sc-button-row">
        <button
          type="button"
          data-testid="pc-wechat-stop"
          className="btn-secondary text-sm"
          disabled={busy}
          onClick={() => void stopWechat()}
        >
          {t('syncService.pc.wechatStop')}
        </button>
        <button
          type="button"
          data-testid="pc-open-desktop"
          className="btn-ghost text-sm"
          onClick={() => void openDesktop()}
        >
          {t('syncService.pc.openDesktop')}
        </button>
      </div>
      <p className="sc-channel-note">{t('syncConsole.connect.wechat.note')}</p>
    </ConsoleCard>
  )
}
