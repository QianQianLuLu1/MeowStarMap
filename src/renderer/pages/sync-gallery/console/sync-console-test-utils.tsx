// @vitest-environment jsdom
/**
 * T1：同步控制台按视图测试套件的共享装配（自 SyncServicePage.test.tsx 的
 * installElectronApi 原样迁入并扩展 PC 对齐轮新通道）。
 *
 * 纪律：
 * - 旧判据依赖的 stub 形态逐字保留（makeStatus/makeDevice/makeSyncAccounts/
 *   makeOrganizerItem/makeOrganizerView 与全部 opts 开关）；
 * - 新通道（getLibraryOverview/restartServer/networkAuth/networkConflict/
 *   hotspotControl/openHotspotSettings）给齐 honest 缺省，用例内可覆写；
 * - getShellStatus 的 enabled 短键从 settings store 派生（与主进程 readShellFlags
 *   同口径），保证「拨开关 ⇒ 卡片门控随之变化」的链路可驱动；
 * - 每视图套件直接渲染视图组件（不经 Layout），调用计数类判据不受邻视图干扰；
 *   Layout 行为由 SyncConsoleLayout.test.tsx 单独钉住。
 */
/* eslint-disable no-restricted-syntax -- 纯测试装配夹具（仅被 *.test.tsx 引用，不随应用打包）：
   中文常量是钉住 zh-CN 开关文案的断言值；原生 Error 仅作 IPC 失败信号（ASCII 文案），
   与 eslint.config.js tests 块对 *.test.* 的豁免同等待遇 */
import React from 'react'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { render } from '@testing-library/react'
import { GlobalToastContext } from '../../../components/common/ToastProvider'
import { useUIStore } from '../../../stores/uiStore'

export const mockShowMessage = vi.fn()

export const SETTING_SYNC_ENABLED = 'nikkisync.syncServerEnabled'
export const SETTING_RUNTIME_ENABLED = 'nikkisync.runtimeEnabled'
export const SETTING_METADATA_RESOLVER = 'nikkisync.metadataResolverEnabled'
export const METADATA_TOGGLE_NAME = '解析穿搭与拍摄参数'
export const SETTING_SYNC_AUTOSTART = 'nikkisync.autoStartSyncServer'
export const AUTOSTART_TOGGLE_NAME = '软件启动时自动启用同步服务'
/** 与视图内的 STATUS_POLL_MS 同值：门控用例靠它推进定时器 */
export const STATUS_POLL_MS = 2000

export function makeStatus(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    running: true,
    host: '0.0.0.0',
    port: 28080,
    secure: true,
    serverId: 'server_0123456789abcdef',
    mdnsEnabled: true,
    tlsFingerprintSha256: 'aa'.repeat(32),
    lanHost: '192.168.1.10',
    pairedDeviceCount: 1,
    // K4：诊断段（观测面；主进程在 syncStatus 里聚合）
    diagnostics: {
      running: true,
      host: '0.0.0.0',
      port: 28080,
      secure: true,
      mdnsEnabled: true,
      pairedDeviceCount: 1,
      tlsFingerprintTail8: 'abcd1234',
      updatedAt: '2026-10-25T08:00:00.000Z'
    },
    ...overrides
  }
}

export function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: 'dev-1',
    deviceName: 'iPhone 15',
    platform: 'ios',
    appVersion: '1.0.0',
    pairedAt: '2026-10-14T00:00:00.000Z',
    lastSeenAt: '2026-10-14T01:00:00.000Z',
    ...overrides
  }
}

export interface NikkiSyncServerApiStub {
  getServerStatus: Mock
  getRuntimeStatus: Mock
  startServer: Mock
  stopServer: Mock
  getPairingCode: Mock
  getPairedDevices: Mock
  revokeDevice: Mock
  startScan: Mock
  getMetadataConsent: Mock
  setMetadataConsent: Mock
  getExtraDirectories: Mock
  inspectExtraDirectory: Mock
  addExtraDirectory: Mock
  removeExtraDirectory: Mock
  rescanExtraDirectories: Mock
  selectDirectory: Mock
  getOrganizerQueue: Mock
  decideOrganizerItem: Mock
  approveOrganizerItems: Mock
  // K9：账号同步作用域与目录来源
  getSyncAccounts: Mock
  previewSyncAccount: Mock
  setSyncAccountSelection: Mock
  setExtraDirectorySource: Mock
  // 照片目录自定义（gameRoot 持久化 + K6 手输预检）
  getGameRoot: Mock
  setGameRoot: Mock
  resetGameRoot: Mock
  admitDirectory: Mock
  // N4：灵感库
  listInspirations: Mock
  saveInspiration: Mock
  putInspirationImage: Mock
  getInspirationImage: Mock
  // N7：PC 端控制页 / 微信画廊
  desktopOpen: Mock
  wechatStart: Mock
  wechatStop: Mock
  wechatStatus: Mock
  // Windows 外壳能力（F3/F7）
  toggleHotspot: Mock
  checkIconUpdate: Mock
  // T2/T5/T6/T11：PC 对齐轮新通道（主进程并行落地；渲染层 typeof 守卫）
  getLibraryOverview: Mock
  restartServer: Mock
  networkAuth: Mock
  networkConflict: Mock
  hotspotControl: Mock
  openHotspotSettings: Mock
  getShellStatus: Mock
}

/** K9：与 handler 剔除 label 后的账号快照同形（uid 三态 + 样例 assetId）。 */
export function makeSyncAccounts(
  overrides: { all?: boolean; accounts?: Array<Record<string, unknown>> } = {}
) {
  return {
    all: overrides.all ?? true,
    accounts: overrides.accounts ?? [
      { uid: '', count: 3, selected: true, samples: [] },
      { uid: '10001', count: 12, selected: true, samples: ['asset_a', 'asset_b'] },
      { uid: 'source:spinning_momo', count: 2, selected: true, samples: ['asset_m'] }
    ]
  }
}

/** 与上游 DeletionQueue.list() 行同形（message 已在 manager 层剔除）。 */
export function makeOrganizerItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'del-1aaaaaaaaaaaaaaa',
    assetId: 'asset_1',
    state: 'pending',
    online: true,
    files: [
      { name: 'a.jpg', size: 123, folder: 'photos' },
      { name: 'b.jpg', size: 456, folder: 'raw' }
    ],
    count: 2,
    ...overrides
  }
}

export function makeOrganizerView(items = [makeOrganizerItem()]) {
  return {
    items,
    activity: {
      catalogPasses: 1,
      catalogImages: 3,
      prepared: 1,
      recycled: 0,
      queued: 0,
      active: 0
    }
  }
}

export let settingsGet: Mock
export let settingsSet: Mock
export let serverApi: NikkiSyncServerApiStub
export let store: Record<string, unknown>
// 重启弹窗与重启动作（照片目录保存/恢复默认的 needRestart 流）
export let dialogShowMessageBox: Mock
export let appRelaunch: Mock
// T11：底栏/关于页的新桥面
export let logExportZip: Mock
export let appGetVersion: Mock
export let appCheckUpdate: Mock
export let shellOpenExternal: Mock

export interface InstallOpts {
  persisted?: Record<string, unknown>
  status?: Record<string, unknown>
  runtimeStatus?: Record<string, unknown>
  consent?: Record<string, unknown> | null
  devices?: ReturnType<typeof makeDevice>[]
  startServerReject?: Error
  pairedDevicesReject?: Error
  startScanReject?: Error
  extraReject?: boolean
  organizerQueue?: Record<string, unknown>
  organizerQueueReject?: boolean
  accounts?: ReturnType<typeof makeSyncAccounts>
  accountsReject?: boolean
  previewReject?: string[]
  extraDirectories?: Array<Record<string, unknown>>
  // 照片目录自定义：gameRoot 持久化值（''/缺省 = 默认自动发现）
  gameRoot?: string
  gameRootReject?: boolean
  setGameRootReject?: Error
  setGameRootWritableFalse?: boolean
  /** 生效通道未成功（applied:false / needRestart:true）——如 Runtime 未装配、未建链、重扫故障。 */
  gameRootApplyDeferred?: boolean
  /** 生效失败且原因是「该目录解析不出游戏安装根」（applied:false + applyError）。 */
  gameRootApplyNotInstallRoot?: boolean
  admitReject?: Error
  // ---- PC 对齐轮新增 ----
  /** T2：资产总览（缺省 available:true；overviewReject 模拟通道失败） */
  overview?: Record<string, unknown>
  overviewReject?: boolean
  /** T5：networkAuth 缺省响应覆写 */
  networkAuthResult?: Record<string, unknown>
  /** T5：networkConflict 缺省响应覆写 */
  networkConflictResult?: Record<string, unknown>
  /** T6：hotspotControl 缺省响应覆写 */
  hotspotControlResult?: Record<string, unknown>
  /** T7：getShellStatus 整体覆写（缺省从 store 派生短键） */
  shellStatus?: Record<string, unknown>
  /** 老桥面模拟：移除指定 nikkisync 方法（typeof 守卫用例） */
  omitMethods?: string[]
}

export function installElectronApi(opts: InstallOpts = {}) {
  store = { ...opts.persisted }
  settingsGet = vi.fn((key: string, fallback: unknown) =>
    Promise.resolve(store[key] !== undefined ? store[key] : fallback)
  )
  settingsSet = vi.fn((key: string, value: unknown) => {
    store[key] = value
    return Promise.resolve()
  })
  serverApi = {
    getServerStatus: vi.fn(async () => makeStatus(opts.status)),
    // K1：启动阶段来自 runtime-status 响应体（无新通道）；缺省不给 startupStages
    getRuntimeStatus: vi.fn(async () => ({
      state: 'idle',
      dbPath: 'C:/userData/nikkisync/nikkisync.db',
      linkReady: true,
      ...(opts.runtimeStatus ?? {})
    })),
    startServer: vi.fn(
      opts.startServerReject
        ? async () => {
            throw opts.startServerReject
          }
        : async () => makeStatus()
    ),
    stopServer: vi.fn(async () => makeStatus({ running: false })),
    getPairingCode: vi.fn(async () => ({
      content: 'NS1|server_x|192.168.1.10|28080|tok|1893456000|' + 'ab'.repeat(32),
      expiresAt: '2026-10-14T12:05:00.000Z',
      serverId: 'server_x',
      host: '192.168.1.10',
      port: 28080,
      tlsFingerprintSha256: 'aa'.repeat(32)
    })),
    getPairedDevices: vi.fn(
      opts.pairedDevicesReject
        ? async () => {
            throw opts.pairedDevicesReject
          }
        : async () => opts.devices ?? []
    ),
    revokeDevice: vi.fn(async () => (opts.devices ?? []).slice(1)),
    // 阶段 4：切到 NikkiSync 数据源会触发一次不阻塞的扫描
    startScan: vi.fn(
      opts.startScanReject
        ? async () => {
            throw opts.startScanReject
          }
        : async () => ({ scanId: 'scan_test' })
    ),
    // K2：在线解析同意（consent:null 模拟「解析关闭/未装配」⇒ 页面隐藏同意块）
    getMetadataConsent: vi.fn(async () => {
      if (opts.consent === null) {
        throw new Error('metadata consent is unavailable')
      }
      return {
        enabled: false,
        policyVersion: '2026-10-13.1',
        recipients: [
          {
            name: 'Nuan5 metadata service',
            endpoint: 'https://nuan5.pro/api/decode-photo2',
            fields: ['photo UID', 'NUAN5 JPEG-prefix parameter MD5 digest']
          }
        ],
        ...(opts.consent ?? {})
      }
    }),
    setMetadataConsent: vi.fn(async (input: { enabled: boolean; policyVersion: string }) => ({
      enabled: input.enabled,
      policyVersion: input.policyVersion,
      recipients: []
    })),
    // K6：额外照片目录（默认一个已配置目录；extraReject 模拟「会话未挂面」⇒ 隐藏整节）
    getExtraDirectories: vi.fn(async () =>
      opts.extraReject
        ? Promise.reject(new Error('extra directories panel is unavailable'))
        : {
            directories: opts.extraDirectories ?? [
              { id: 'dir_1', path: 'D:\\ExtraPhotos', mode: 'native' as const }
            ],
            automaticRoots: ['C:\\game\\photos'],
            busy: false
          }
    ),
    inspectExtraDirectory: vi.fn(async () => ({
      id: 'prop_1',
      roots: [],
      images: 12,
      videos: 2,
      limited: false
    })),
    addExtraDirectory: vi.fn(async () => ({ directories: [], automaticRoots: [], busy: false })),
    removeExtraDirectory: vi.fn(async () => ({ directories: [], automaticRoots: [], busy: false })),
    rescanExtraDirectories: vi.fn(async () => ({
      directories: [],
      automaticRoots: [],
      busy: false
    })),
    selectDirectory: vi.fn(async () => 'D:\\NewPhotos'),
    // K8：整理队列（默认空队列；organizerQueueReject 模拟「开关开但会话未装配」）
    getOrganizerQueue: vi.fn(() =>
      opts.organizerQueueReject
        ? Promise.reject(new Error('organizer deletion queue is unavailable'))
        : Promise.resolve(
            opts.organizerQueue ?? {
              items: [],
              activity: { catalogPasses: 0, queued: 0, active: 0 }
            }
          )
    ),
    decideOrganizerItem: vi.fn(async () => []),
    approveOrganizerItems: vi.fn(async () => ({ items: [], approved: 0, skipped: 0 })),
    // K9：账号作用域（accountsReject 模拟「会话无 accounts」⇒ 整节隐藏）
    getSyncAccounts: vi.fn(() =>
      opts.accountsReject
        ? Promise.reject(new Error('sync account scope is unavailable'))
        : Promise.resolve(opts.accounts ?? makeSyncAccounts())
    ),
    previewSyncAccount: vi.fn(async ({ assetId }: { assetId: string }) => {
      if (opts.previewReject?.includes(assetId)) throw new Error('NikkiSync asset not found')
      return {
        resourceId: `res_${assetId}`,
        mimeType: 'image/jpeg',
        sourcePath: `D:\\Photos\\${assetId}.jpg`
      }
    }),
    // 与上游一致：null = 全部；数组 = 逐项选中
    setSyncAccountSelection: vi.fn(async ({ uids }: { uids: string[] | null }) => {
      const base = opts.accounts ?? makeSyncAccounts()
      return {
        all: uids === null,
        accounts: base.accounts.map((account) => ({
          ...account,
          selected: uids === null || uids.includes(String(account.uid))
        }))
      }
    }),
    setExtraDirectorySource: vi.fn(
      async ({ id, source }: { id: string; source: 'spinning_momo' | 'other' }) => ({
        directories: (opts.extraDirectories ?? []).map((dir) =>
          dir.id === id ? { ...dir, source } : dir
        ),
        automaticRoots: [],
        busy: false
      })
    ),
    // ---- 照片目录自定义（gameRoot 持久化在 nikkisync.gameRoot；'' = 默认自动发现）----
    getGameRoot: vi.fn(async () => {
      if (opts.gameRootReject) throw new Error('game root settings unavailable')
      return { gameRoot: opts.gameRoot ?? '' }
    }),
    setGameRoot: vi.fn(
      opts.setGameRootReject
        ? async () => {
            throw opts.setGameRootReject
          }
        : async ({ path }: { path: string }) => ({
            gameRoot: path,
            writable: !opts.setGameRootWritableFalse,
            ...(opts.gameRootApplyNotInstallRoot
              ? { applied: false, needRestart: true, applyError: 'installation-not-found' }
              : opts.gameRootApplyDeferred
                ? { applied: false, needRestart: true }
                : { applied: true, needRestart: false })
          })
    ),
    resetGameRoot: vi.fn(async () =>
      opts.gameRootApplyNotInstallRoot
        ? { applied: false, needRestart: true, applyError: 'installation-not-found' }
        : opts.gameRootApplyDeferred
          ? { applied: false, needRestart: true }
          : { applied: true, needRestart: false }
    ),
    // K6 手输预检：主进程校验并登记 pathGuard；admitReject 模拟校验拒绝
    admitDirectory: vi.fn(
      opts.admitReject
        ? async () => {
            throw opts.admitReject
          }
        : async ({ path }: { path: string }) => ({ path })
    ),
    // N4：灵感库（面板在老桥面缺席时静默隐藏；这里给齐以便后续用例直接驱动）
    listInspirations: vi.fn(async () => ({ items: [], nextCursor: null })),
    saveInspiration: vi.fn(async () => ({ revision: 1, entry: {} })),
    putInspirationImage: vi.fn(async () => ({ ok: true })),
    getInspirationImage: vi.fn(async () => null),
    // N7：PC 端控制页 / 微信画廊
    desktopOpen: vi.fn(async () => ({ url: 'http://127.0.0.1:39123/' })),
    wechatStart: vi.fn(async () => ({
      status: { state: 'waiting' },
      qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    })),
    wechatStop: vi.fn(async () => ({ status: { state: 'closed' } })),
    wechatStatus: vi.fn(async () => ({ status: { state: 'idle' } })),
    // Windows 外壳能力（F3/F7）：默认 toggled / unavailable，用例内可覆写
    toggleHotspot: vi.fn(async () => ({
      status: 'toggled',
      state: { startedHere: true, active: true }
    })),
    checkIconUpdate: vi.fn(async () => ({ status: 'unavailable' })),
    // ---- T2/T5/T6/T11：PC 对齐轮新通道（形状与 shared/types 契约一致）----
    getLibraryOverview: vi.fn(() =>
      opts.overviewReject
        ? Promise.reject(new Error('library overview is unavailable'))
        : Promise.resolve(
            opts.overview ?? { available: true, assets: 128, pairedDevices: 1, firstRun: false }
          )
    ),
    restartServer: vi.fn(async () => makeStatus()),
    networkAuth: vi.fn(async () => ({
      status: 'absent',
      ruleGroup: 'NikkiSync',
      ...(opts.networkAuthResult ?? {})
    })),
    networkConflict: vi.fn(async () => ({
      status: 'ok',
      conflicts: [],
      canRestore: false,
      ...(opts.networkConflictResult ?? {})
    })),
    hotspotControl: vi.fn(async () => ({
      status: 'unchanged',
      state: { active: false, startedHere: false },
      ...(opts.hotspotControlResult ?? {})
    })),
    openHotspotSettings: vi.fn(async () => ({ opened: true })),
    // enabled 短键从 store 派生（与主进程 readShellFlags 同口径）；可整体覆写
    getShellStatus: vi.fn(async () => ({
      enabled: {
        iconUpdate: Boolean(store['nikkisync.shellIconUpdateEnabled']),
        programUpdate: Boolean(store['nikkisync.shellProgramUpdateEnabled']),
        tray: Boolean(store['nikkisync.shellTrayEnabled']),
        support: Boolean(store['nikkisync.shellSupportEnabled']),
        networkRepair: Boolean(store['nikkisync.shellNetworkRepairEnabled']),
        hotspot: Boolean(store['nikkisync.shellHotspotEnabled'])
      },
      ...(opts.shellStatus ?? {})
    }))
  }
  // 老桥面模拟：按需摘除方法（typeof 存在性守卫用例）
  for (const name of opts.omitMethods ?? []) {
    delete (serverApi as unknown as Record<string, unknown>)[name]
  }
  dialogShowMessageBox = vi.fn(async () => 0)
  appRelaunch = vi.fn(async () => undefined)
  logExportZip = vi.fn(async () => ({
    success: true,
    filePath: 'C:/diagnostics/nikkisync.zip',
    message: '诊断包已导出'
  }))
  appGetVersion = vi.fn(async () => '2.5.7-beta')
  appCheckUpdate = vi.fn(async () => ({ checking: true }))
  shellOpenExternal = vi.fn(async () => ({ success: true }))
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    settings: { get: settingsGet, set: settingsSet },
    nikkisync: serverApi,
    shell: { openExternal: shellOpenExternal },
    dialog: { selectDirectory: serverApi.selectDirectory, showMessageBox: dialogShowMessageBox },
    app: { relaunch: appRelaunch, getVersion: appGetVersion, checkUpdate: appCheckUpdate },
    log: { exportZip: logExportZip }
  }
  // 折叠态/子视图持久化隔离：每个用例从干净的 localStorage 起步
  window.localStorage.clear()
}

/** 视图直渲染（GlobalToastContext 注入 mock，错误/成功 toast 可直接断言）。 */
export function renderView(node: React.ReactElement) {
  return render(
    <GlobalToastContext.Provider value={mockShowMessage}>{node}</GlobalToastContext.Provider>
  )
}

/** 各视图套件共用的 beforeEach 语义：装桥 + 清 toast + 前台态。 */
export function setupConsoleTest(opts: InstallOpts = {}) {
  installElectronApi(opts)
  mockShowMessage.mockClear()
  // 轮询按 currentView 门控（用例 (r)），不进本页就一条状态都不拉
  useUIStore.setState({ currentView: 'sync-gallery' })
}
