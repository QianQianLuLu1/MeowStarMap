import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
// 复用设置页的展示原语（与迁出前 SyncServicePage 同款跨目录引用，见其原注释）。
import { SettingsToggle } from '../../settings/shared'
import { useGlobalToast } from '../../../components/common/ToastProvider'
import { EmptyState } from '../../../components/common/EmptyState'
import { Tooltip } from '../../../components/common/Tooltip'
import { useErrorToast } from '../../../hooks/useErrorToast'
import { useMediaStore } from '../../../stores/mediaStore'
import { useUIStore } from '../../../stores/uiStore'
import { SYNC_CONSOLE_HOST_VIEW } from './console-views'
import { toFileUrl } from '../../../utils/file'
import { SETTING_KEY_LAUNCH_AT_LOGIN } from '../../../../shared/settings-keys'
import type {
  NikkiSyncExtraDirectoriesInfo,
  NikkiSyncExtraDirectoryProposalInfo,
  NikkiSyncGameRootApplyResult,
  NikkiSyncMetadataConsentInfo,
  NikkiSyncServerStatusInfo,
  NikkiSyncSyncAccountsInfo
} from '../../../../shared/types/electron-api'
import { NetworkPermissionCard } from './NetworkPermissionCard'
import { HotspotCard } from './HotspotCard'
import { ConsoleRow, ConsoleSection } from './console-ui'
import { openUpstreamLink } from './export-diagnostics'

// 阶段 3：服务开关隐含 Runtime 开关（切数据源时也要落 Runtime，见 handleGallerySourceToggle）
const SETTING_RUNTIME_ENABLED = 'nikkisync.runtimeEnabled'
// 阶段 4：图库数据源开关（'local' | 'nikkisync'），消费点 mediaStore 的源分流
const SETTING_GALLERY_SOURCE = 'gallery.dataSource'
// 阶段 6：上游远端元数据解析开关。渲染层只能写这个布尔键本身
// （在 src/shared/settings-keys.ts 白名单里），出站请求的实际端点由主进程侧常量决定。
const SETTING_METADATA_RESOLVER = 'nikkisync.metadataResolverEnabled'
// 软件启动时是否自动启用 LAN 同步服务（默认关，消费点 nikkisync-runtime-setup.ts）
const SETTING_SYNC_AUTOSTART = 'nikkisync.autoStartSyncServer'

/**
 * K9：账号分组文案。上游 `label` 是中文（`UID x` / 未识别 / 旋转吧大喵），已在 handler
 * 剔除；渲染层按 `uid` 三态 + i18n 生成，`src/**` 不出现硬编码中文。
 */
function accountLabel(uid: string, t: (key: string, options?: Record<string, unknown>) => string) {
  if (uid === '') return t('syncService.syncAccounts.unknownUid')
  if (uid === 'source:spinning_momo') return t('syncService.syncAccounts.spinningMomo')
  return t('syncService.syncAccounts.uidLabel', { uid })
}

/**
 * T1/T4/T7：同步设置视图。
 *
 * 自 SyncServicePage 原样迁入：图库数据源 / 元数据解析 + 披露 + K2 同意块 /
 * 自动启用 / 照片目录（gameRoot）/ K6 额外照片目录 / K9 账号同步作用域 /
 * Windows 外壳能力 6 开关（SyncShellSection）。行为契约由 console/SettingsView.test.tsx
 * 逐条钉住（原判据不重写）。
 *
 * T4 新增（上游 settings 页移植）：
 * - 两条纯静态说明行（相册更新→自动收录新照片 / 关闭窗口后→在托盘继续运行），不落设置键；
 * - 开机自启开关绑定宿主 `launchAtLogin`（settings:get/set，白名单键）；
 * - 法律条款三链 = desktopOpen().url + '/legal/privacy|terms|services'，
 *   PC 服务缺席 ⇒ 禁用 + Tooltip 说明。
 *
 * T7 新增：本地网络权限卡 / 临时热点卡（opt-in 门控 + typeof 存在性守卫）。
 */
export const SettingsView: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const { showError } = useErrorToast()
  /** 卸载后作废在途拉取：切走子视图即卸载，慢响应不得回写已卸载组件。 */
  const aliveRef = useRef(true)
  useEffect(
    () => () => {
      aliveRef.current = false
    },
    []
  )
  const [gallerySource, setGallerySource] = useState<'local' | 'nikkisync'>('local')
  // 阶段 6：上游远端元数据解析开关（默认关——为真即产生对第三方的出站请求）
  const [metadataEnabled, setMetadataEnabled] = useState(false)
  // 软件启动时是否自动启用 LAN 同步服务（默认关；只决定下次启动，不立即启停）
  const [autoStart, setAutoStart] = useState(false)
  // T4：开机自启（宿主 launchAtLogin，与服务自启是两个独立键）
  const [launchAtLogin, setLaunchAtLogin] = useState(false)
  // K2：在线解析同意状态（仅解析开启的会话上有；拉取失败/未装配 ⇒ null，同意块隐藏）
  const [consent, setConsent] = useState<NikkiSyncMetadataConsentInfo | null>(null)
  const [busy, setBusy] = useState(false)
  // K6：额外照片目录（null = 会话未挂面/未装配 ⇒ 整节隐藏，预期内不报错）
  const [extraDirs, setExtraDirs] = useState<NikkiSyncExtraDirectoriesInfo | null>(null)
  const [proposal, setProposal] = useState<NikkiSyncExtraDirectoryProposalInfo | null>(null)
  // 照片目录自定义：gameRoot 持久化值（''=默认自动发现）；input 为输入框草稿。
  // 该配置不经运行时装配（只读写设置数据库），未启用同步服务时也可先行配置。
  const [gameRoot, setGameRoot] = useState('')
  const [gameRootInput, setGameRootInput] = useState('')
  // K6 手输目录草稿：admit（主进程校验+登记 pathGuard）→ 复用既有 inspect 提案确认流
  const [typedDirInput, setTypedDirInput] = useState('')
  // K9：账号同步作用域（null = 会话无 accounts / 未装配 ⇒ 整节隐藏，预期内不报错）
  const [syncAccounts, setSyncAccounts] = useState<NikkiSyncSyncAccountsInfo | null>(null)
  const [allAccounts, setAllAccounts] = useState(true)
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([])
  const [accountSaving, setAccountSaving] = useState(false)
  // K9：样例缩略图（assetId → media:// URL；预览失败留空，不打断整卡）
  const [accountSampleUrls, setAccountSampleUrls] = useState<Record<string, string | null>>({})
  // T4：连接地址展示（挂载取一次 getServerStatus，不轮询——设置页不是状态观测面）
  const [addressStatus, setAddressStatus] = useState<NikkiSyncServerStatusInfo | null>(null)
  // T4：法律条款基址（desktopOpen().url；PC 服务缺席 ⇒ null ⇒ 三链禁用）
  const [legalBase, setLegalBase] = useState<string | null>(null)
  // T7：两个 opt-in 开关的观测（getShellStatus 优先，缺席回退 settings.get；
  // SyncShellSection 内拨动后经 onFlagsChanged 同步，无需重读）
  const [networkRepairEnabled, setNetworkRepairEnabled] = useState(false)
  const [hotspotEnabled, setHotspotEnabled] = useState(false)
  const currentView = useUIStore((s) => s.currentView)

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

  /** 自动启用开关读回：读不到一律保持关闭（开启会让 LAN 服务监听 0.0.0.0）。 */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const value = await window.electronAPI?.settings.get(SETTING_SYNC_AUTOSTART, false)
        if (alive) setAutoStart(value === true)
      } catch {
        // 静默：保持关闭态
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /** T4：开机自启读回（严格 === true，与主进程形态收敛同口径）。 */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const value = await window.electronAPI?.settings.get(SETTING_KEY_LAUNCH_AT_LOGIN, false)
        if (alive) setLaunchAtLogin(value === true)
      } catch {
        // 静默：保持关闭态
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /** T4：连接地址一次性快照（失败静默 ⇒ 显示「服务未运行」）。 */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const next = await window.electronAPI?.nikkisync.getServerStatus()
        if (alive) setAddressStatus(next ?? null)
      } catch {
        if (alive) setAddressStatus(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /** T4：法律条款基址。desktopOpen 缺席/失败 ⇒ null（三链禁用 + Tooltip 说明）。 */
  useEffect(() => {
    let alive = true
    void (async () => {
      const client = window.electronAPI?.nikkisync
      if (typeof client?.desktopOpen !== 'function') return
      try {
        const { url } = await client.desktopOpen()
        if (alive && url) setLegalBase(url.replace(/\/+$/, ''))
      } catch {
        if (alive) setLegalBase(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /** T7：opt-in 观测。getShellStatus().enabled 短键优先；老桥面回退两个设置键。 */
  useEffect(() => {
    let alive = true
    void (async () => {
      const client = window.electronAPI?.nikkisync
      if (typeof client?.getShellStatus === 'function') {
        try {
          const res = await client.getShellStatus()
          if (alive) {
            setNetworkRepairEnabled(res.enabled.networkRepair === true)
            setHotspotEnabled(res.enabled.hotspot === true)
          }
          return
        } catch {
          // 落入 settings 回退
        }
      }
      try {
        const net = await window.electronAPI?.settings.get(
          'nikkisync.shellNetworkRepairEnabled',
          false
        )
        const hot = await window.electronAPI?.settings.get('nikkisync.shellHotspotEnabled', false)
        if (alive) {
          setNetworkRepairEnabled(net === true)
          setHotspotEnabled(hot === true)
        }
      } catch {
        // 静默：保持关闭态（fail-closed）
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
    // 可选链只护住 electronAPI：老 preload 没有 nikkisync 命名空间时，
    // `window.electronAPI?.nikkisync.getMetadataConsent` 会在 effect 同步体里抛 TypeError，
    // 而同步抛出不会被下面的 .catch 接到（提交期抛出会打掉整棵子树）。故先取方法再判类型。
    const getConsent = window.electronAPI?.nikkisync?.getMetadataConsent
    if (typeof getConsent !== 'function') return
    let alive = true
    void getConsent()
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

  /** 照片目录：挂载读取持久化值（''=默认自动发现）并回填输入框草稿。只碰设置数据库，
   * 不 requireRuntime——同步服务未启用时配置也可先行落库，保存/恢复默认会当场经
   * applyGameRoot 生效，未生效才回退重启消费点。 */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await window.electronAPI?.nikkisync.getGameRoot()
        if (alive && res) {
          setGameRoot(res.gameRoot)
          setGameRootInput(res.gameRoot)
        }
      } catch {
        // 读不到保持默认（''=自动发现）：设置库只读失败极少见，不打断页面其余部分
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

  /** 只写自己那一个设置项：自动启用决定下次启动行为，不立即启停服务。 */
  const handleAutoStartToggle = async (value: boolean): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    const previous = autoStart
    setBusy(true)
    setAutoStart(value)
    try {
      await api.settings.set(SETTING_SYNC_AUTOSTART, value)
    } catch (error) {
      setAutoStart(previous)
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** T4：开机自启。只写宿主 launchAtLogin 键；失败回滚并报错（同款隔离判据）。 */
  const handleLaunchAtLoginToggle = async (value: boolean): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    const previous = launchAtLogin
    setBusy(true)
    setLaunchAtLogin(value)
    try {
      await api.settings.set(SETTING_KEY_LAUNCH_AT_LOGIN, value)
    } catch (error) {
      setLaunchAtLogin(previous)
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
      if (aliveRef.current) setExtraDirs(next ?? null)
    } catch {
      if (aliveRef.current) setExtraDirs(null)
    }
  }, [])

  useEffect(() => {
    if (currentView !== SYNC_CONSOLE_HOST_VIEW) return
    void refreshExtraDirs()
  }, [currentView, refreshExtraDirs])

  /**
   * K9：账号状态拉取。老链接/未装配会话上通道回 PRECONDITION_FAILED——预期内状态，
   * 降级为隐藏整节（不弹错误）。返回是否成功，供来源变更等调用点决定要不要提示。
   */
  const refreshAccounts = useCallback(async (): Promise<boolean> => {
    try {
      const next = await window.electronAPI?.nikkisync.getSyncAccounts()
      if (!next) return false
      if (!aliveRef.current) return false
      setSyncAccounts(next)
      setAllAccounts(next.all)
      setSelectedAccounts(next.accounts.filter((account) => account.selected).map((a) => a.uid))
      return true
    } catch {
      if (aliveRef.current) setSyncAccounts(null)
      return false
    }
  }, [])

  useEffect(() => {
    if (currentView !== SYNC_CONSOLE_HOST_VIEW) return
    void refreshAccounts()
  }, [currentView, refreshAccounts])

  /**
   * K9：样例缩略图。`preview` 给资源行的 source_path，经既有 media:// 出口读取；
   * 单张失败留空（不伪造占位、不打断整卡）。上限 60 次批量预览，防账号极多时打爆 IPC。
   */
  useEffect(() => {
    if (!syncAccounts) return
    const assetIds = syncAccounts.accounts.flatMap((account) => account.samples).slice(0, 60)
    if (assetIds.length === 0) {
      setAccountSampleUrls({})
      return
    }
    let alive = true
    void Promise.all(
      assetIds.map(async (assetId) => {
        try {
          const preview = await window.electronAPI?.nikkisync.previewSyncAccount({ assetId })
          return [assetId, toFileUrl(preview?.sourcePath)] as const
        } catch {
          return [assetId, null] as const
        }
      })
    ).then((pairs) => {
      if (alive) setAccountSampleUrls(Object.fromEntries(pairs))
    })
    return () => {
      alive = false
    }
  }, [syncAccounts])

  /**
   * K9：保存账号选择。开启「同步全部账号」时提交 `null`（上游语义 = 全部），
   * 否则提交勾选数组（可为 `[]` = 一个都不同步）。**不做乐观更新**：失败保留旧选择，
   * 避免「UI 已保存、下次启动又变回去」的裂口。
   */
  const handleSaveAccounts = async (): Promise<void> => {
    const api = window.electronAPI
    if (accountSaving || !api) return
    setAccountSaving(true)
    try {
      const next = await api.nikkisync.setSyncAccountSelection({
        uids: allAccounts ? null : selectedAccounts
      })
      setSyncAccounts(next)
      setAllAccounts(next.all)
      setSelectedAccounts(next.accounts.filter((account) => account.selected).map((a) => a.uid))
      showMessage(t('syncService.syncAccounts.saved'), 'success')
    } catch {
      showMessage(t('syncService.syncAccounts.saveFailed'), 'error')
    } finally {
      setAccountSaving(false)
    }
  }

  const toggleAccount = (uid: string, checked: boolean): void => {
    setSelectedAccounts((previous) =>
      checked ? [...new Set([...previous, uid])] : previous.filter((item) => item !== uid)
    )
  }

  /** K9：目录来源标注。成功后同时刷新目录与账号两处（来源分组随指纹变化）。 */
  const handleSetDirectorySource = async (
    id: string,
    source: 'spinning_momo' | 'other'
  ): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    setBusy(true)
    try {
      setExtraDirs(await api.nikkisync.setExtraDirectorySource({ id, source }))
      if (syncAccounts && !(await refreshAccounts())) {
        showMessage(t('syncService.syncAccounts.loadFailed'), 'error')
      }
      showMessage(t('syncService.extraDirectories.sourceUpdated'), 'success')
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** K9：添加「旋转吧大喵」目录（inspect 带 source，上游据此把它归入旋转吧大喵分组）。 */
  const handleAddSpinningDirectory = async (): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    setBusy(true)
    try {
      const selected = await api.dialog.selectDirectory()
      if (!selected) return
      setProposal(
        await api.nikkisync.inspectExtraDirectory({ path: selected, source: 'spinning_momo' })
      )
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** 照片目录：needRestart 共用的重启询问（确认 0 = 立即重启，与备份/缓存目录同款）。 */
  const promptRestart = useCallback(async (): Promise<void> => {
    const api = window.electronAPI
    if (!api?.dialog?.showMessageBox) return
    const confirmed = await api.dialog.showMessageBox({
      type: 'question',
      title: t('syncService.photoDirectories.restartTitle'),
      message: t('syncService.photoDirectories.restartMessage'),
      buttons: [
        t('syncService.photoDirectories.restartNow'),
        t('syncService.photoDirectories.restartLater')
      ]
    })
    if (confirmed === 0) await api.app?.relaunch?.()
  }, [t])

  /**
   * 照片目录生效结果的三条出口（保存 / 恢复默认共用；`successMessage` 由调用点给静态键文案，
   * 避免动态 t(key) 让 i18n 抽取与键守卫看不见消费点）：
   * - `kind === 'set'` 且 `applyError === 'installation-not-found'`：该值按「游戏安装根种子」
   *   被上游消费，目录形态不对时重启也救不了 ⇒ 给可执行提示（改选游戏安装目录，或走
   *   「额外照片目录」），**不**弹重启询问；
   * - `applied`：主进程已当场换根重建 + 全量扫描并广播 library-changed ⇒ 只报即时生效；
   * - 其余未生效支（Runtime 未装配 / 未建链 / 重扫故障）：退回旧的「重启后生效」询问——值已持久化，
   *   下次进程仍按启动消费点读到，不能因为当场没生效就说保存失败。
   *
   * `kind` 是必需的：恢复默认的入参恒是空串（交上游自动发现），「该目录不是有效的游戏安装根」
   * 对它是一句无效指向；而游戏未装且无额外目录时上游抛的正是同一条 installation not found，
   * 不按动作分流就会拿这条文案吞掉本该保留的重启询问兜底。
   */
  const announceGameRootApply = useCallback(
    async (
      result: NikkiSyncGameRootApplyResult,
      successMessage: string,
      kind: 'set' | 'reset'
    ): Promise<void> => {
      if (kind === 'set' && result.applyError === 'installation-not-found') {
        showMessage(t('syncService.photoDirectories.applyFailedInstallRoot'), 'info')
        return
      }
      if (result.applied) {
        showMessage(successMessage, 'success')
        return
      }
      showMessage(t('syncService.photoDirectories.savedDeferred'), 'success')
      await promptRestart()
    },
    [showMessage, t, promptRestart]
  )

  /** 照片目录：浏览选择。只回填输入框不直接保存——给用户检查/修改的机会。 */
  const handleBrowseGameRoot = async (): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    try {
      const selected = await api.dialog.selectDirectory()
      if (selected) setGameRootInput(selected)
    } catch (error) {
      showError(error)
    }
  }

  /** 照片目录：保存。客户端只拦「空/非绝对路径」两个零成本错误，存在性/权限交给主进程校验
   * （唯一真相源）；可写探测失败仅 info 警告不阻断（照片源目录扫描只读，只读位置合法）。 */
  const handleSaveGameRoot = async (): Promise<void> => {
    const api = window.electronAPI
    const value = gameRootInput.trim()
    if (busy || !api) return
    if (!value) {
      showMessage(t('syncService.photoDirectories.invalidEmpty'), 'info')
      return
    }
    if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(value)) {
      showMessage(t('syncService.photoDirectories.invalidAbsolute'), 'info')
      return
    }
    setBusy(true)
    try {
      const res = await api.nikkisync.setGameRoot({ path: value })
      setGameRoot(res.gameRoot)
      setGameRootInput(res.gameRoot)
      await announceGameRootApply(res, t('syncService.photoDirectories.saved'), 'set')
      // 不可写提示只在「已当场生效」时追加：生效失败（applied:false）已有 savedDeferred/
      // applyFailedInstallRoot 专属文案，再叠一条 info 是一次动作两条 toast
      if (!res.writable && res.applied)
        showMessage(t('syncService.photoDirectories.notWritable'), 'info')
    } catch (error) {
      // 失败保留输入值与当前生效目录，用户可直接改后重试
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** 照片目录：恢复默认（清空设置键并当场回到上游自动发现的游戏安装根）。 */
  const handleResetGameRoot = async (): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    setBusy(true)
    try {
      const res = await api.nikkisync.resetGameRoot()
      setGameRoot('')
      setGameRootInput('')
      await announceGameRootApply(res, t('syncService.photoDirectories.resetDone'), 'reset')
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** K6 手输预检：先 admit（主进程做敏感目录/盘根/存在性/可读校验并登记 pathGuard），
   * 再走与「添加目录」完全相同的 inspect → 提案确认流。失败则不进入 inspect。
   * busy 门必须在 try 内显式闭合（与 handleConfirmAdd 同形），否则双击会并发两条 admit+inspect 链。 */
  const handleInspectTypedDirectory = async (): Promise<void> => {
    const api = window.electronAPI
    const value = typedDirInput.trim()
    if (busy || !api || !value) return
    setBusy(true)
    try {
      await api.nikkisync.admitDirectory({ path: value })
      setProposal(await api.nikkisync.inspectExtraDirectory({ path: value }))
      setTypedDirInput('')
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
    setBusy(true)
    try {
      const selected = await api.dialog.selectDirectory()
      if (!selected) return
      setProposal(await api.nikkisync.inspectExtraDirectory({ path: selected }))
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
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
      // 新目录可能带来旋转吧大喵分组；仅在账号节可见时刷新，老链接不制造噪声
      if (syncAccounts) await refreshAccounts()
    } catch (error) {
      // 1.0.41 对齐上游控制页：提案确已过期 ⇒ 收起预览让用户重选；其余拒绝保留预览可重试
      const upstreamCode = (error as { details?: { upstreamCode?: unknown } } | null)?.details
        ?.upstreamCode
      if (upstreamCode === 'selection_expired') {
        setProposal(null)
        showMessage(t('syncService.extraDirectories.selectionExpired'), 'error')
      } else {
        showError(error)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleRemoveDirectory = async (id: string): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    setBusy(true)
    try {
      setExtraDirs(await api.nikkisync.removeExtraDirectory({ id }))
      // K9：删掉 spinning_momo 目录会让来源分组消失，账号节须同步重取（与 add / setSource 同款）
      if (syncAccounts) await refreshAccounts()
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  const handleRescanExtraDirs = async (): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    setBusy(true)
    try {
      setExtraDirs(await api.nikkisync.rescanExtraDirectories())
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** T7：「去开启」——滚到同视图的外壳开关分区（opt-in 开关就在那里）。 */
  const jumpToShellSection = (): void => {
    const target = document.querySelector('[data-testid="sync-service-shell-section"]')
    if (!target) return
    // 外壳能力已折叠进「同步与连接」卡：先展开 details 再滚动，否则跳到收起区块等于空跳
    const host = target.closest('details')
    if (host) host.open = true
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  /** T7：外壳开关观测同步（稳定身份——refreshFlags 经 deps 依赖它，抖动会造成重读风暴）。 */
  const handleShellFlagsChanged = useCallback((flags: Record<string, boolean>) => {
    setNetworkRepairEnabled(flags['nikkisync.shellNetworkRepairEnabled'] === true)
    setHotspotEnabled(flags['nikkisync.shellHotspotEnabled'] === true)
  }, [])

  const address =
    addressStatus && addressStatus.running
      ? `${addressStatus.lanHost ?? addressStatus.host}:${addressStatus.port}`
      : null

  return (
    <div className="sc-settings">
      {/* T4：同步与连接（地址快照 + 两条纯静态说明行 + 图库数据源 + 元数据解析/同意） */}
      <ConsoleSection titleAs="h2" title={t('syncConsole.settings.connection.title')}>
        {/* 行组独占一块，组内首行因此命中 `:first-child`（不再重复画一条上分割线）；
            与后续开关/披露之间的节奏由 `.sc-card-body` 的 grid gap 负责 */}
        <div className="sc-service-rows">
          <ConsoleRow label={t('syncConsole.settings.connection.address')}>
            <span className="font-mono text-xs">
              {address ?? t('syncConsole.settings.connection.addressUnknown')}
            </span>
          </ConsoleRow>
          {/* 两条纯静态说明行（上游 settings 页同款）：描述既有行为，不落设置键 */}
          <ConsoleRow label={t('syncConsole.settings.static.albumUpdate')}>
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncConsole.settings.static.albumUpdateValue')}
            </span>
          </ConsoleRow>
          <ConsoleRow label={t('syncConsole.settings.static.tray')}>
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncConsole.settings.static.trayValue')}
            </span>
          </ConsoleRow>
        </div>
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
          <div className="sc-service-rows">
            <div className="sc-service-rows">
              <p className="text-xs font-medium">{t('syncService.consent.title')}</p>
              <ConsoleRow label={t('syncService.consent.endpoint')}>
                <span className="font-mono text-xs break-all">
                  {consent.recipients[0]?.endpoint}
                </span>
              </ConsoleRow>
              <ConsoleRow label={t('syncService.consent.policyVersion')}>
                <span className="font-mono text-xs">{consent.policyVersion}</span>
              </ConsoleRow>
              <ConsoleRow label={t('syncService.consent.fields')}>
                <ul className="list-disc pl-4 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {consent.recipients[0]?.fields.map((field) => (
                    <li key={field}>{field}</li>
                  ))}
                </ul>
              </ConsoleRow>
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
          </div>
        )}

        {/* ⑤K9：账号同步作用域（1.0.27 上游 AccountSyncSettings；会话无 accounts 时整节隐藏）
          —— 上游把它嵌在「同步与连接」卡内，这里同样不单开整卡 */}
        {syncAccounts && (
          <div className="sc-service-rows" data-testid="sync-account-section">
            <div>
              <h3 className="sc-card-title">{t('syncService.syncAccounts.title')}</h3>
              <p className="sc-card-desc">{t('syncService.syncAccounts.scopeNote')}</p>
            </div>
            <div className="sc-service-rows">
              <SettingsToggle
                label={t('syncService.syncAccounts.all')}
                checked={allAccounts}
                disabled={accountSaving}
                onChange={setAllAccounts}
              />
              {syncAccounts.accounts.length === 0 ? (
                <div className="sc-empty-holder">
                  <EmptyState
                    title={t('syncService.syncAccounts.empty')}
                    subtitle={t('syncService.syncAccounts.emptyHint')}
                  />
                </div>
              ) : (
                <>
                  {syncAccounts.accounts.map((account) => {
                    const label = accountLabel(account.uid, t)
                    return (
                      <ConsoleRow
                        key={account.uid}
                        label={label}
                        description={t('syncService.syncAccounts.count', {
                          count: account.count
                        })}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className="flex items-center gap-1"
                            aria-label={t('syncService.syncAccounts.samples')}
                          >
                            {account.samples.length === 0 ? (
                              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                {t('syncService.syncAccounts.previewEmpty')}
                              </span>
                            ) : (
                              account.samples.map((assetId) => {
                                const url = accountSampleUrls[assetId]
                                return url ? (
                                  <img
                                    key={assetId}
                                    src={url}
                                    alt=""
                                    className="h-10 w-10 rounded object-cover"
                                  />
                                ) : null
                              })
                            )}
                          </span>
                          <input
                            type="checkbox"
                            aria-label={label}
                            className="w-4 h-4"
                            checked={allAccounts || selectedAccounts.includes(account.uid)}
                            disabled={allAccounts || accountSaving}
                            onChange={(event) => toggleAccount(account.uid, event.target.checked)}
                          />
                        </div>
                      </ConsoleRow>
                    )
                  })}
                  <div className="flex justify-end">
                    <button
                      type="button"
                      className="btn-primary text-sm"
                      disabled={accountSaving}
                      onClick={() => void handleSaveAccounts()}
                    >
                      {accountSaving
                        ? t('syncService.syncAccounts.saving')
                        : t('syncService.syncAccounts.save')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Windows 外壳能力：上游无对应卡，收进本卡 details（默认收起，零网络/零子进程） */}
        <details className="sc-details" data-testid="sync-shell-details">
          <summary className="sc-details-summary">{t('syncService.shell.title')}</summary>
          <p className="sc-card-desc">{t('syncService.shell.description')}</p>
          <div className="pt-2">
            <SyncShellSection onFlagsChanged={handleShellFlagsChanged} />
          </div>
        </details>
      </ConsoleSection>

      {/* T4：启动偏好（服务自启 + 开机自启，两个独立键各管一件事） */}
      <ConsoleSection titleAs="h2" title={t('syncConsole.settings.startup.title')}>
        {/* 只影响下次软件启动：开启后无需每次手动点主开关 */}
        <SettingsToggle
          label={t('syncService.autoStart')}
          description={t('syncService.autoStartDesc')}
          checked={autoStart}
          disabled={busy}
          onChange={(value) => void handleAutoStartToggle(value)}
        />
        <SettingsToggle
          label={t('syncConsole.settings.startup.launchAtLogin')}
          description={t('syncConsole.settings.startup.launchAtLoginDesc')}
          checked={launchAtLogin}
          disabled={busy}
          onChange={(value) => void handleLaunchAtLoginToggle(value)}
        />
      </ConsoleSection>

      {/* T7：本地网络权限 / 临时热点（opt-in 门控；关闭时整卡「未启用」+ 去开启） */}
      <NetworkPermissionCard enabled={networkRepairEnabled} onEnableJump={jumpToShellSection} />
      <HotspotCard enabled={hotspotEnabled} onEnableJump={jumpToShellSection} />

      {/* ③b：照片目录（gameRoot 替代默认路径；只碰设置库，不经运行时装配 ⇒ 常驻显示） */}
      <ConsoleSection
        titleAs="h2"
        title={t('syncService.photoDirectories.title')}
        description={t('syncService.photoDirectories.description')}
      >
        <div className="sc-service-rows">
          <ConsoleRow label={t('syncService.photoDirectories.currentLabel')}>
            <span
              className="font-mono text-xs truncate max-w-[24rem]"
              style={{ color: 'var(--text-tertiary)' }}
              title={gameRoot}
            >
              {gameRoot || t('syncService.photoDirectories.defaultValue')}
            </span>
          </ConsoleRow>
        </div>
        <div className="sc-stack" data-testid="sync-photo-directory-form">
          <input
            type="text"
            value={gameRootInput}
            onChange={(e) => setGameRootInput(e.target.value)}
            placeholder={t('syncService.photoDirectories.inputPlaceholder')}
            spellCheck={false}
            className="w-full px-3 py-2 text-sm rounded-lg border"
            style={{
              background: 'var(--bg-tertiary)',
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-primary)'
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-secondary text-sm"
                disabled={busy}
                onClick={() => void handleBrowseGameRoot()}
              >
                {t('syncService.photoDirectories.browse')}
              </button>
              <button
                type="button"
                className="btn-primary text-sm"
                disabled={busy}
                onClick={() => void handleSaveGameRoot()}
              >
                {t('syncService.photoDirectories.save')}
              </button>
            </div>
            <button
              type="button"
              className="btn-ghost text-sm"
              disabled={busy}
              onClick={() => void handleResetGameRoot()}
            >
              {t('syncService.photoDirectories.reset')}
            </button>
          </div>
        </div>

        {/* ④K6：额外照片目录（上游把当前目录与额外扫描目录放在同一张卡里；未挂面时整节隐藏） */}
        {extraDirs && (
          <div className="sc-stack" data-testid="sync-extra-directories">
            <div>
              <h3 className="sc-card-title">{t('syncService.extraDirectories.title')}</h3>
              <p className="sc-card-desc">{t('syncService.extraDirectories.scopeNote')}</p>
            </div>
            <div className="sc-service-rows">
              {extraDirs.directories.length === 0 ? (
                <div className="sc-empty-holder">
                  <EmptyState
                    title={t('syncService.extraDirectories.empty')}
                    subtitle={t('syncService.extraDirectories.emptyHint')}
                  />
                </div>
              ) : (
                extraDirs.directories.map((dir) => (
                  <ConsoleRow key={dir.id} label={dir.path}>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {dir.mode}
                      </span>
                      {/* K9：来源标注（仅 images 目录）——spinning_momo 的分组出现在账号节 */}
                      {dir.mode === 'images' && (
                        <>
                          {dir.source && (
                            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                              {dir.source === 'spinning_momo'
                                ? t('syncService.extraDirectories.sourceSpinning')
                                : t('syncService.extraDirectories.sourceOther')}
                            </span>
                          )}
                          <button
                            type="button"
                            className="btn-ghost text-xs"
                            disabled={busy}
                            onClick={() =>
                              void handleSetDirectorySource(
                                dir.id,
                                dir.source === 'spinning_momo' ? 'other' : 'spinning_momo'
                              )
                            }
                          >
                            {dir.source === 'spinning_momo'
                              ? t('syncService.extraDirectories.unmarkSpinning')
                              : t('syncService.extraDirectories.markSpinning')}
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="btn-danger text-xs"
                        disabled={busy}
                        onClick={() => void handleRemoveDirectory(dir.id)}
                      >
                        {t('syncService.extraDirectories.remove')}
                      </button>
                    </div>
                  </ConsoleRow>
                ))
              )}
              {/* 预检确认区：展示识别到的照片/视频计数，确认后才真正加入 */}
              {proposal && (
                <div className="sc-service-rows">
                  <ConsoleRow label={proposal.id}>
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
                  </ConsoleRow>
                </div>
              )}
              {/* 手输目录入口：先 admit（主进程校验 + 登记 pathGuard）再走既有 inspect 提案流。
                系统选择器选中的目录在 dialog-handler 登记后同样能过 inspect 门禁，两条路同权。 */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={typedDirInput}
                  onChange={(e) => setTypedDirInput(e.target.value)}
                  placeholder={t('syncService.extraDirectories.typedPlaceholder')}
                  spellCheck={false}
                  className="flex-1 px-3 py-2 text-sm rounded-lg border"
                  style={{
                    background: 'var(--bg-tertiary)',
                    borderColor: 'var(--border-subtle)',
                    color: 'var(--text-primary)'
                  }}
                />
                <button
                  type="button"
                  className="btn-secondary text-sm"
                  disabled={busy || extraDirs.busy}
                  onClick={() => void handleInspectTypedDirectory()}
                >
                  {t('syncService.extraDirectories.inspectTyped')}
                </button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-secondary text-sm"
                    disabled={busy}
                    onClick={() => void handleAddDirectory()}
                  >
                    {t('syncService.extraDirectories.add')}
                  </button>
                  {/* K9：直接添加并标为旋转吧大喵（inspect 带 source） */}
                  <button
                    type="button"
                    className="btn-ghost text-sm"
                    disabled={busy}
                    onClick={() => void handleAddSpinningDirectory()}
                  >
                    {t('syncService.extraDirectories.addSpinning')}
                  </button>
                </div>
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
          </div>
        )}
      </ConsoleSection>

      {/* T4：法律三链并入页脚（上游 settings-about 位置；PC 服务缺席 ⇒ 禁用 + Tooltip） */}
      <div className="sc-settings-about" data-testid="sync-settings-about">
        <p>
          {t('syncConsole.shell.brandName')} · {t('syncConsole.shell.brandLatin')}
        </p>
        <p>{t('syncConsole.shell.footerDisclaimer')}</p>
        <div className="sc-settings-about-links">
          {(
            [
              ['privacy', 'privacy'],
              ['terms', 'terms'],
              ['services', 'services']
            ] as const
          ).map(([labelKey, path]) => {
            const button = (
              <button
                type="button"
                className="btn-ghost text-sm"
                disabled={!legalBase}
                onClick={() => {
                  if (legalBase) void openUpstreamLink(`${legalBase}/legal/${path}`, showError)
                }}
              >
                {t(`syncConsole.settings.legal.${labelKey}`)}
              </button>
            )
            return legalBase ? (
              <React.Fragment key={path}>{button}</React.Fragment>
            ) : (
              <Tooltip key={path} content={t('syncConsole.settings.legal.unavailable')}>
                {button}
              </Tooltip>
            )
          })}
        </div>
        {!legalBase && (
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {t('syncConsole.settings.legal.unavailable')}
          </p>
        )}
      </div>
    </div>
  )
}

/** Windows 外壳能力的 6 个 opt-in 开关（与 settings-keys.ts 白名单逐字一致）。 */
const SHELL_SETTING_KEYS = [
  'nikkisync.shellIconUpdateEnabled',
  'nikkisync.shellProgramUpdateEnabled',
  'nikkisync.shellTrayEnabled',
  'nikkisync.shellSupportEnabled',
  'nikkisync.shellNetworkRepairEnabled',
  'nikkisync.shellHotspotEnabled'
] as const

/** 6 个开关的可读标签（与上面键顺序一一对应，全部走 i18n，不硬编码用户可见文案）。 */
const SHELL_TOGGLE_LABELS = [
  'syncService.shell.toggle.iconUpdate',
  'syncService.shell.toggle.programUpdate',
  'syncService.shell.toggle.tray',
  'syncService.shell.toggle.support',
  'syncService.shell.toggle.networkRepair',
  'syncService.shell.toggle.hotspot'
] as const

/**
 * Windows 外壳能力分区。6 个开关默认全关；所有动作经 nikkisync:shell-* 通道，
 * 关闭时主进程返回 {status:'disabled'} 且零网络/零子进程。
 * 事件订阅在 cleanup 中退订（keep-alive 页面不卸载，必须显式清理监听器）。
 * T7：onFlagsChanged 把开关观测同步给 SettingsView 的网络/热点卡门控。
 */
const SyncShellSection: React.FC<{
  onFlagsChanged?: (flags: Record<string, boolean>) => void
}> = ({ onFlagsChanged }) => {
  const { t } = useTranslation()
  const [flags, setFlags] = useState<Record<string, boolean>>({})
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  // F3：热点期望状态本地跟踪；只有主进程确认 toggled 才翻转，失败不翻转（诚实）。
  const [hotspotOn, setHotspotOn] = useState(false)

  // F7a：结果码/事件阶段走 i18n 封闭键集；未知码兜底原样（不崩溃、不伪造翻译）。
  const shellStatusText = (code: string): string =>
    t(`syncService.shell.status.${code}`, {
      defaultValue: t(`syncService.shell.event.${code}`, { defaultValue: code })
    })

  // R3 审查修复：flagsRef 镜像最新观测——连拨两个开关时第二次 toggle 不得拿渲染期快照
  // 展开（会丢第一次的结果）；mountedRef 守卫在途 refreshFlags 卸载/切走后不再 setState。
  const flagsRef = useRef<Record<string, boolean>>({})
  const mountedRef = useRef(true)

  const refreshFlags = useCallback(async () => {
    const api = window.electronAPI?.settings
    if (!api) return
    const next: Record<string, boolean> = {}
    for (const key of SHELL_SETTING_KEYS) {
      // 单个键读失败按 fail-closed 记 false 继续：外壳开关是「观测 + 显式拨动」，
      // 一次 IPC 抖动不该让整组观测丢失，更不该变成未处理 rejection（规范 §4）。
      try {
        next[key] = Boolean(await api.get(key, false))
      } catch {
        next[key] = false
      }
    }
    if (!mountedRef.current) return
    flagsRef.current = next
    setFlags(next)
    onFlagsChanged?.(next)
  }, [onFlagsChanged])

  useEffect(() => {
    mountedRef.current = true
    void refreshFlags()
    const client = window.electronAPI?.nikkisync
    const unsubscribe =
      typeof client?.onShellEvent === 'function'
        ? client.onShellEvent((event) => {
            setStatus(event.message ?? event.type)
          })
        : undefined
    return () => {
      mountedRef.current = false
      unsubscribe?.()
    }
  }, [refreshFlags])

  const toggle = async (key: string, value: boolean): Promise<void> => {
    const api = window.electronAPI?.settings
    if (!api) return
    // 乐观翻转 + 同步门控观测；onFlagsChanged 在 updater 外调用（避免渲染期副作用）
    const next = { ...flagsRef.current, [key]: value }
    flagsRef.current = next
    setFlags(next)
    onFlagsChanged?.(next)
    try {
      await api.set(key, value)
    } catch {
      const rolledBack = { ...flagsRef.current, [key]: !value }
      flagsRef.current = rolledBack
      setFlags(rolledBack)
      onFlagsChanged?.(rolledBack)
      setStatus('error')
    }
  }

  const run = async (
    action: 'icon' | 'program' | 'support' | 'network' | 'hotspot'
  ): Promise<void> => {
    const client = window.electronAPI?.nikkisync
    if (!client || busy) return
    setBusy(true)
    try {
      if (action === 'hotspot') {
        // F3：交替请求开/关；confirm===true 请求开启，false 请求关闭。
        const next = !hotspotOn
        const result = await client.toggleHotspot({ confirm: next })
        if (result.status === 'toggled') setHotspotOn(next)
        setStatus(result.status)
        return
      }
      const result =
        action === 'icon'
          ? await client.checkIconUpdate({})
          : action === 'program'
            ? await client.checkProgramUpdate({})
            : action === 'support'
              ? await client.submitSupportReport({})
              : await client.repairNetwork({})
      setStatus(result.status)
    } catch {
      setStatus('error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="sync-service-shell-section">
      <div className="sc-service-rows">
        <div className="sc-service-rows">
          {SHELL_SETTING_KEYS.map((key, index) => (
            <SettingsToggle
              key={key}
              label={t(SHELL_TOGGLE_LABELS[index] as string)}
              checked={flags[key] === true}
              onChange={(value) => void toggle(key, value)}
            />
          ))}
          <ConsoleRow label={t('syncService.shell.icon.title')}>
            <button
              type="button"
              className="btn-secondary text-sm"
              disabled={busy}
              onClick={() => void run('icon')}
            >
              {t('syncService.shell.icon.check')}
            </button>
          </ConsoleRow>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {t('syncService.shell.icon.current')}
          </p>
          <ConsoleRow label={t('syncService.shell.program.title')}>
            <button
              type="button"
              className="btn-secondary text-sm"
              disabled={busy}
              onClick={() => void run('program')}
            >
              {t('syncService.shell.program.check')}
            </button>
          </ConsoleRow>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {t('syncService.shell.program.notes')}
          </p>
          <ConsoleRow label={t('syncService.shell.support.title')}>
            <button
              type="button"
              className="btn-secondary text-sm"
              disabled={busy}
              onClick={() => void run('support')}
            >
              {t('syncService.shell.support.submit')}
            </button>
          </ConsoleRow>
          {status && (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {shellStatusText(status)}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-ghost text-sm"
              disabled={busy}
              onClick={() => void run('network')}
            >
              {t('syncService.shell.network.repair')}
            </button>
            <button
              type="button"
              className="btn-ghost text-sm"
              disabled={busy}
              onClick={() => void run('hotspot')}
            >
              {t('syncService.shell.network.hotspot')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
