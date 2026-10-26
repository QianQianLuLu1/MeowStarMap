import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
// 复用设置页的展示原语（仓库已有 8 个非 settings 文件同样引它）：这 4 个原语的既有消费点
// 全在 pages/settings/ 内，为单一外部落点把它们搬进 components/common 会波及 10+ 文件的
// import 行，属越界重构，故此处直接跨目录引用。
import { SectionShell, SettingsToggle, SettingsCard, SettingsRow } from '../settings/shared'
import { useGlobalToast } from '../../components/common/ToastProvider'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { EmptyState } from '../../components/common/EmptyState'
import { PageHeader } from '../../components/common/PageHeader'
import { PairingQrDialog } from '../../components/sync/PairingQrDialog'
import { useErrorToast } from '../../hooks/useErrorToast'
import { IconCopyText, IconSync } from '../../icons'
import { useMediaStore } from '../../stores/mediaStore'
import { useUIStore } from '../../stores/uiStore'
import type {
  NikkiSyncExtraDirectoriesInfo,
  NikkiSyncExtraDirectoryProposalInfo,
  NikkiSyncMetadataConsentInfo,
  NikkiSyncOrganizerItemInfo,
  NikkiSyncOrganizerViewInfo,
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
// K8：整理队列（批量删除）开关。默认关属破坏性能力的双保险之一；
// 关闭时三条 organizer 通道按契约回 PRECONDITION_FAILED（错误文案指向本开关）。
const SETTING_ORGANIZER_ENABLED = 'nikkisync.organizerEnabled'

/**
 * K8：上游 DeletionQueue 11 态 → i18n key 映射。未知状态回退原样英文短码
 * （不谎报，K1 启动阶段同款口径）；state 值域由上游协议定义，本仓不发明新态。
 */
const ORGANIZER_STATE_I18N_KEYS: Record<string, string> = {
  preparing: 'syncService.organizer.state.preparing',
  pending: 'syncService.organizer.state.pending',
  confirming: 'syncService.organizer.state.confirming',
  queued: 'syncService.organizer.state.queued',
  checking: 'syncService.organizer.state.checking',
  executing: 'syncService.organizer.state.executing',
  recycled: 'syncService.organizer.state.recycled',
  failed: 'syncService.organizer.state.failed',
  changed: 'syncService.organizer.state.changed',
  cancelled: 'syncService.organizer.state.cancelled',
  rejected: 'syncService.organizer.state.rejected'
}

/** K8：可执行 PC 侧动作（批准/拒绝）的状态集；终态与 executing 不再给操作钮。 */
const ORGANIZER_ACTIONABLE_STATES = new Set([
  'preparing',
  'pending',
  'confirming',
  'queued',
  'checking'
])

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

/**
 * 同步服务二级子页（层级 2）。原设置页 `sync` 分组的 `SyncServiceSection`，
 * 随「同步服务从设置页剥离」迁入同步图库板块：入口是 `SyncGalleryToolbar` 的
 * 「同步服务」按钮，走 `navigateTo('sync-service')` 压栈，返回用侧边栏返回按钮。
 *
 * 页内按复杂度分三层：
 *  ①同步状态总览 + 总开关 / 图库数据源 / 元数据解析
 *  ②配对新设备（`PairingQrDialog` 覆盖层）
 *  ③已配对设备管理列表（撤销走 `ConfirmDialog`）
 *
 * 行为契约（逐条由同目录 `SyncServicePage.test.tsx` 锁住）：
 * - 开关 = `nikkisync.syncServerEnabled`（+ 隐含 `nikkisync.runtimeEnabled`）+ 立即启停；
 *   启停失败时两个持久化设置与本地状态一并回滚，避免下次启动反复自启失败
 * - 状态卡 2s 轮询 getServerStatus（服务地址 / 服务 ID / TLS 指纹），操作后立即刷新
 * - 不展示“已连接客户端数”：上游 `WebSocketHub.sockets` 是私有成员且无公开计数，
 *   本仓不为此改上游，也不虚构该数字
 * - 设备列表（仅未撤销设备，读 NikkiSync 的 paired_devices）+ 撤销确认（上游 revoke 软删）
 *
 * 与设置页时期的一处必要差异：本页挂在 `App.tsx` 的 keep-alive 循环里，切走只 `display:none`
 * 不卸载，所以 2s 轮询必须按 `currentView` 门控，否则用户离开后定时器仍在后台打 IPC。
 */
export const SyncServicePage: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const { showError } = useErrorToast()
  const [enabled, setEnabled] = useState(false)
  const [gallerySource, setGallerySource] = useState<'local' | 'nikkisync'>('local')
  // 阶段 6：上游远端元数据解析开关（默认关——为真即产生对第三方的出站请求）
  const [metadataEnabled, setMetadataEnabled] = useState(false)
  // K2：在线解析同意状态（仅解析开启的会话上有；拉取失败/未装配 ⇒ null，同意块隐藏）
  const [consent, setConsent] = useState<NikkiSyncMetadataConsentInfo | null>(null)
  const [status, setStatus] = useState<NikkiSyncServerStatusInfo | null>(null)
  // K1：本会话真实发生的启动阶段（runtime-status 响应体可选段；缺省 = 尚无已完成阶段）
  const [startupStages, setStartupStages] = useState<Array<{ stage: string; at: string }>>([])
  // K7：最近一次扫描的诊断聚合计数（runtime-status 响应体可选段；未扫描/老链接缺省）
  const [scanDiagnostics, setScanDiagnostics] = useState<Record<string, unknown> | null>(null)
  const [devices, setDevices] = useState<NikkiSyncPairedDeviceInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [qrOpen, setQrOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<NikkiSyncPairedDeviceInfo | null>(null)
  // K6：额外照片目录（null = 会话未挂面/未装配 ⇒ 整节隐藏，预期内不报错）
  const [extraDirs, setExtraDirs] = useState<NikkiSyncExtraDirectoriesInfo | null>(null)
  const [proposal, setProposal] = useState<NikkiSyncExtraDirectoryProposalInfo | null>(null)
  // K8：整理队列（破坏性能力，开关默认关）。null = 未拉到/不可用 ⇒ 队列区显示不可用而非报错
  const [organizerEnabled, setOrganizerEnabled] = useState(false)
  const [organizerQueue, setOrganizerQueue] = useState<NikkiSyncOrganizerViewInfo | null>(null)
  const [organizerUnavailable, setOrganizerUnavailable] = useState(false)
  /** K8：待确认的批准目标（single=单条，batch=全部可批准项）；null = 无待确认。 */
  const [approveTarget, setApproveTarget] = useState<
    { mode: 'single'; item: NikkiSyncOrganizerItemInfo } | { mode: 'batch' } | null
  >(null)
  const currentView = useUIStore((s) => s.currentView)

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
    void (async () => {
      try {
        const value = await window.electronAPI?.settings.get(SETTING_SYNC_ENABLED, false)
        // 严格 === true：主进程对 app_settings 历史非布尔值收敛成关闭
        // （nikkisync-runtime-setup.ts 的 settingsFrom），渲染层用 Boolean() 会显示「已启用」
        // 而服务其实没起。判据必须与消费点一致，同下方元数据/整理两处开关。
        if (alive) setEnabled(value === true)
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
  }, [currentView, refresh])

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

  /**
   * K2：同意状态拉取。仅在解析开启时拉——同意面只存在于「解析开启的会话」上，
   * 解析关闭时通道按契约回 PRECONDITION_FAILED，此处降级为 null（同意块隐藏），
   * 不把这个预期内的失败当成错误弹给用户。
   */
  useEffect(() => {
    if (!metadataEnabled) return
    let alive = true
    void window.electronAPI?.nikkisync
      .getMetadataConsent()
      .then((next) => {
        if (alive) setConsent(next)
      })
      .catch(() => {
        if (alive) setConsent(null)
      })
    return () => {
      alive = false
    }
  }, [metadataEnabled])

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
        // 同步图库页据此自动刷新，本页不必阻塞在扫描上
        void api.nikkisync.startScan({}).catch((error: unknown) => {
          showError(error)
        })
      }
      showMessage(t('syncService.gallerySourceApplied', { source: next }), 'success')
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

  /**
   * K2：同意开关。policyVersion 取页面当前展示的原串提交（上游逐字比对策略版本，
   * 防「看旧文案点新同意」）；提交失败回滚开关态并报错。生效即时的：同意在位时
   * 上游 guard 放行、撤回时上游 setEnabled(false) 内部即中止在途请求。
   */
  const handleConsentToggle = async (value: boolean): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api || !consent) return
    const previous = consent
    setBusy(true)
    setConsent({ ...consent, enabled: value })
    try {
      const next = await api.nikkisync.setMetadataConsent({
        enabled: value,
        policyVersion: consent.policyVersion
      })
      setConsent(next)
    } catch (error) {
      setConsent(previous)
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /**
   * K6：额外目录状态拉取。老链接/未装配会话上通道按契约回 PRECONDITION_FAILED——
   * 这是预期内状态而非故障，降级为隐藏整节（不弹错误）。
   */
  const refreshExtraDirs = useCallback(async (): Promise<void> => {
    try {
      const next = await window.electronAPI?.nikkisync.getExtraDirectories()
      setExtraDirs(next ?? null)
    } catch {
      setExtraDirs(null)
    }
  }, [])

  useEffect(() => {
    if (currentView !== 'sync-service') return
    void refreshExtraDirs()
  }, [currentView, refreshExtraDirs])

  /** K8：开关读回。读不到一律保持关闭（破坏性能力绝不默认生效）。 */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const value = await window.electronAPI?.settings.get(SETTING_ORGANIZER_ENABLED, false)
        if (alive) setOrganizerEnabled(value === true)
      } catch {
        // 静默：保持关闭态
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /**
   * K8：队列拉取。开关关闭时一次都不拉；开关开但会话未装配时通道回
   * PRECONDITION_FAILED——这是预期内状态，降级为「不可用」提示而非错误弹窗。
   */
  const refreshOrganizerQueue = useCallback(async (): Promise<void> => {
    try {
      const next = await window.electronAPI?.nikkisync.getOrganizerQueue()
      setOrganizerQueue(next ?? null)
      setOrganizerUnavailable(false)
    } catch {
      setOrganizerQueue(null)
      setOrganizerUnavailable(true)
    }
  }, [])

  useEffect(() => {
    // 仅队列区可见（开关开 + 本页在前台）时轮询；否则不留后台定时器
    if (!organizerEnabled || currentView !== 'sync-service') return
    void refreshOrganizerQueue()
    const timer = setInterval(() => void refreshOrganizerQueue(), STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [organizerEnabled, currentView, refreshOrganizerQueue])

  /** K8：开关切换。写入失败回滚开关态并报错；开启后立即拉一次队列。 */
  const handleOrganizerToggle = async (value: boolean): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    const previous = organizerEnabled
    setBusy(true)
    setOrganizerEnabled(value)
    try {
      await api.settings.set(SETTING_ORGANIZER_ENABLED, value)
      if (value) void refreshOrganizerQueue()
    } catch (error) {
      setOrganizerEnabled(previous)
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** K8：拒绝（非破坏性：不删任何文件，队列项转 rejected）。 */
  const handleReject = async (item: NikkiSyncOrganizerItemInfo): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    setBusy(true)
    try {
      await api.nikkisync.decideOrganizerItem({ id: item.id, approve: false })
      await refreshOrganizerQueue()
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** K8：确认弹窗的确认回调——单条走 decide，批量走 approveMany；完成后刷新队列。 */
  const handleConfirmApprove = async (): Promise<void> => {
    const api = window.electronAPI
    const target = approveTarget
    if (busy || !api || !target) return
    setBusy(true)
    try {
      if (target.mode === 'single') {
        await api.nikkisync.decideOrganizerItem({ id: target.item.id, approve: true })
      } else {
        const ids = (organizerQueue?.items ?? [])
          .filter((item) => ORGANIZER_ACTIONABLE_STATES.has(item.state) && item.online)
          .map((item) => item.id)
        if (ids.length > 0) await api.nikkisync.approveOrganizerItems({ ids })
      }
      setApproveTarget(null)
      await refreshOrganizerQueue()
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** K6：添加流程——系统目录选择器 → 预检（images/videos 计数）→ 用户确认后按提案 id 提交。 */
  const handleAddDirectory = async (): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    try {
      const selected = await api.dialog.selectDirectory()
      if (!selected) return
      setProposal(await api.nikkisync.inspectExtraDirectory({ path: selected }))
    } catch (error) {
      showError(error)
    }
  }

  const handleConfirmAdd = async (): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api || !proposal) return
    const id = proposal.id
    setBusy(true)
    try {
      setExtraDirs(await api.nikkisync.addExtraDirectory({ id }))
      setProposal(null)
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  const handleRemoveDirectory = async (id: string): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    try {
      setExtraDirs(await api.nikkisync.removeExtraDirectory({ id }))
    } catch (error) {
      showError(error)
    }
  }

  const handleRescanExtraDirs = async (): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    try {
      setExtraDirs(await api.nikkisync.rescanExtraDirectories())
    } catch (error) {
      showError(error)
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

  const running = Boolean(status?.running)
  // K7：诊断卡「上次扫描」行文本（段缺失/未扫描时为 null ⇒ 行不渲染）
  const lastScanText = formatLastScanCounts(scanDiagnostics, t)

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t('syncService.page.title')} icon={<IconSync size={20} />} />
      {/* 表单行不设宽度上限会被拉满整窗（标签与控件隔得太远），沿用设置页的 max-w-2xl */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-2xl space-y-4">
          {/* ①状态总览与三个各管一件事的开关 */}
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
            {/* 阶段 4：图库数据源。默认本地库，切到 NikkiSync 隐含要求 Runtime 已启用，
              否则运行时没跑、它的库也没扫过，切过去必然是一片空白 */}
            <SettingsToggle
              label={t('syncService.gallerySource')}
              description={t('syncService.gallerySourceDesc')}
              checked={gallerySource === 'nikkisync'}
              disabled={busy}
              onChange={(value) => void handleGallerySourceToggle(value)}
            />
            {/* 阶段 6：上游远端元数据解析。默认关闭，开启即向第三方发起请求 */}
            <SettingsToggle
              label={t('syncService.metadata.enable')}
              description={t('syncService.metadata.enableDesc')}
              checked={metadataEnabled}
              disabled={busy}
              onChange={(value) => void handleMetadataToggle(value)}
            />
            {/* 披露常驻可见，不放进 tooltip、也不等开了之后再找：
              用户必须在点下去之前就看到「发给谁、写到哪里、会不会下发给已配对设备」 */}
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncService.metadata.disclosure')}
            </p>
            {/* K2：在线解析同意块（仅解析开启且会话挂出同意面时显示；同意前零出站） */}
            {metadataEnabled && consent && (
              <SettingsCard>
                <div className="space-y-2">
                  <p className="text-xs font-medium">{t('syncService.consent.title')}</p>
                  <SettingsRow label={t('syncService.consent.endpoint')}>
                    <span className="font-mono text-xs break-all">
                      {consent.recipients[0]?.endpoint}
                    </span>
                  </SettingsRow>
                  <SettingsRow label={t('syncService.consent.policyVersion')}>
                    <span className="font-mono text-xs">{consent.policyVersion}</span>
                  </SettingsRow>
                  <SettingsRow label={t('syncService.consent.fields')}>
                    <ul
                      className="list-disc pl-4 text-xs"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {consent.recipients[0]?.fields.map((field) => (
                        <li key={field}>{field}</li>
                      ))}
                    </ul>
                  </SettingsRow>
                  <SettingsToggle
                    label={t('syncService.consent.enable')}
                    description={t('syncService.consent.enableDesc')}
                    checked={consent.enabled}
                    disabled={busy}
                    onChange={(value) => void handleConsentToggle(value)}
                  />
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                    {t('syncService.consent.revokeNote')}
                  </p>
                </div>
              </SettingsCard>
            )}
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

          {/* ④K6：额外照片目录（仅作用于同步库扫描器；会话未挂面时整节隐藏） */}
          {extraDirs && (
            <SectionShell
              title={t('syncService.extraDirectories.title')}
              description={t('syncService.extraDirectories.scopeNote')}
            >
              <div className="space-y-2">
                {extraDirs.directories.length === 0 ? (
                  <EmptyState
                    title={t('syncService.extraDirectories.empty')}
                    subtitle={t('syncService.extraDirectories.emptyHint')}
                  />
                ) : (
                  extraDirs.directories.map((dir) => (
                    <SettingsCard key={dir.id}>
                      <SettingsRow label={dir.path}>
                        <div className="flex items-center gap-3">
                          <span
                            className="font-mono text-xs"
                            style={{ color: 'var(--text-tertiary)' }}
                          >
                            {dir.mode}
                          </span>
                          <button
                            type="button"
                            className="btn-danger text-xs"
                            disabled={busy}
                            onClick={() => void handleRemoveDirectory(dir.id)}
                          >
                            {t('syncService.extraDirectories.remove')}
                          </button>
                        </div>
                      </SettingsRow>
                    </SettingsCard>
                  ))
                )}
                {/* 预检确认区：展示识别到的照片/视频计数，确认后才真正加入 */}
                {proposal && (
                  <SettingsCard>
                    <SettingsRow label={proposal.id}>
                      <div className="flex items-center gap-3">
                        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          {t('syncService.extraDirectories.proposalSummary', {
                            images: proposal.images,
                            videos: proposal.videos
                          })}
                        </span>
                        <button
                          type="button"
                          className="btn-primary text-xs"
                          disabled={busy}
                          onClick={() => void handleConfirmAdd()}
                        >
                          {t('syncService.extraDirectories.confirmAdd')}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() => setProposal(null)}
                        >
                          {t('syncService.extraDirectories.cancelAdd')}
                        </button>
                      </div>
                    </SettingsRow>
                  </SettingsCard>
                )}
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="btn-secondary text-sm"
                    disabled={busy}
                    onClick={() => void handleAddDirectory()}
                  >
                    {t('syncService.extraDirectories.add')}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost text-sm"
                    disabled={busy || extraDirs.busy}
                    onClick={() => void handleRescanExtraDirs()}
                  >
                    {t('syncService.extraDirectories.rescan')}
                  </button>
                </div>
              </div>
            </SectionShell>
          )}

          {/* ⑤K8：整理队列（批量删除；破坏性能力默认关，开关门由主进程三通道强制） */}
          <SectionShell title={t('syncService.organizer.title')}>
            <div className="space-y-2">
              <SettingsToggle
                label={t('syncService.organizer.toggle')}
                description={t('syncService.organizer.toggleDesc')}
                checked={organizerEnabled}
                disabled={busy}
                onChange={(value) => void handleOrganizerToggle(value)}
              />
              {organizerEnabled && (
                <>
                  {organizerUnavailable ? (
                    <EmptyState
                      title={t('syncService.organizer.unavailable')}
                      subtitle={t('syncService.organizer.unavailableHint')}
                    />
                  ) : !organizerQueue || organizerQueue.items.length === 0 ? (
                    <EmptyState
                      title={t('syncService.organizer.empty')}
                      subtitle={t('syncService.organizer.emptyHint')}
                    />
                  ) : (
                    <>
                      {organizerQueue.items.map((item) => {
                        const actionable = ORGANIZER_ACTIONABLE_STATES.has(item.state)
                        // 已知 11 态走 i18n 映射；未知状态回退原样英文短码（不谎报，K1 同款口径）
                        const stateKey = ORGANIZER_STATE_I18N_KEYS[item.state]
                        return (
                          <SettingsCard key={item.id}>
                            <SettingsRow
                              label={stateKey ? t(stateKey) : item.state}
                              description={`${t('syncService.organizer.filesCount', {
                                count: item.count
                              })} · ${
                                item.online
                                  ? t('syncService.organizer.online')
                                  : t('syncService.organizer.offline')
                              }`}
                            >
                              {actionable && (
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    className="btn-danger text-xs"
                                    disabled={busy || !item.online}
                                    onClick={() => setApproveTarget({ mode: 'single', item })}
                                  >
                                    {t('syncService.organizer.approve')}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-ghost text-xs"
                                    disabled={busy}
                                    onClick={() => void handleReject(item)}
                                  >
                                    {t('syncService.organizer.reject')}
                                  </button>
                                </div>
                              )}
                            </SettingsRow>
                          </SettingsCard>
                        )
                      })}
                      <div className="flex justify-end">
                        <button
                          type="button"
                          className="btn-danger text-sm"
                          disabled={
                            busy ||
                            !organizerQueue.items.some(
                              (item) => ORGANIZER_ACTIONABLE_STATES.has(item.state) && item.online
                            )
                          }
                          onClick={() => setApproveTarget({ mode: 'batch' })}
                        >
                          {t('syncService.organizer.approveAll')}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </SectionShell>
        </div>
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
      {/* K8：破坏性确认弹窗——列明将移入 Windows 回收站的文件总数与去向，取消可退；
          未确认绝不发起 decide/approveMany（由 approveTarget 是否为 null 把关）。 */}
      <ConfirmDialog
        open={approveTarget !== null}
        title={t('syncService.organizer.confirmTitle')}
        message={t('syncService.organizer.confirmBody', {
          count:
            approveTarget?.mode === 'single'
              ? approveTarget.item.count
              : (organizerQueue?.items ?? [])
                  .filter((item) => ORGANIZER_ACTIONABLE_STATES.has(item.state) && item.online)
                  .reduce((sum, item) => sum + item.count, 0)
        })}
        confirmText={t('syncService.organizer.confirmAction')}
        cancelText={t('syncService.organizer.cancel')}
        confirmVariant="danger"
        onConfirm={() => void handleConfirmApprove()}
        onCancel={() => setApproveTarget(null)}
      />
    </div>
  )
}
