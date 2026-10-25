// @vitest-environment jsdom
/**
 * SyncServicePage（同步服务二级子页，层级 2）单元测试。
 *
 * 阶段归属：本页由设置页 `sync` 分组剥离而来（原 `pages/settings/sync-sections.tsx` 的
 * `SyncServiceSection`）。用例 (a)–(p) 逐条搬入，锁住阶段 3/4/6 的行为契约不变：
 *  (a) 挂载读取 nikkisync.syncServerEnabled（默认 false）与状态/设备列表
 *  (b) 开关启用：写两个设置项（服务 + Runtime 隐含）+ nikkisync.startServer + toast
 *  (c) 启动失败：两个设置项一并回滚为 false + 错误 toast（开关还原）
 *  (d) 运行状态渲染（lanHost:port）与设备列表
 *  (e) 设备列表渲染 + 撤销确认流（ConfirmDialog → revokeDevice）
 *  (f) 无设备时空态
 *  (g) 设备列表通道失败不影响状态卡（getPairedDevices 单独降级为空）
 *  (h) 不再渲染“已连接客户端数”（上游无该计数，本仓不虚构）
 *  (i) 未装配态显示不可用而非报错
 *  (j)-(l) 阶段 4：图库数据源开关（写两个设置项 + store 分流 + 触发扫描 / 失败回滚 / 挂载读回）
 *  (m)-(p) 阶段 6：元数据解析开关（只写自己的键 / 挂载读回 / 披露常驻 / 失败回滚）
 *
 * 搬移带出的两条新契约（设置页里不需要、独立子页才需要）：
 *  (q) 三段层级：控制区 h3 / 配对区 h3 / 设备区 h3 同页存在，页头是 h2「同步服务」
 *  (r) 状态轮询按 currentView 门控：本页在 App.tsx 的 keep-alive 循环里切走不卸载，
 *      不门控就会后台常驻 2s 定时器一直打 getServerStatus
 *
 * 运行：npx vitest run src/renderer/pages/sync-gallery/SyncServicePage.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { GlobalToastContext } from '../../components/common/ToastProvider'
import { SyncServicePage } from './SyncServicePage'
import { useMediaStore } from '../../stores/mediaStore'
import { useUIStore } from '../../stores/uiStore'

const mockShowMessage = vi.fn()

const SETTING_SYNC_ENABLED = 'nikkisync.syncServerEnabled'
const SETTING_RUNTIME_ENABLED = 'nikkisync.runtimeEnabled'
const SETTING_METADATA_RESOLVER = 'nikkisync.metadataResolverEnabled'
const METADATA_TOGGLE_NAME = '解析穿搭与拍摄参数'
/** 与页面内的 STATUS_POLL_MS 同值：门控用例靠它推进定时器 */
const STATUS_POLL_MS = 2000

function makeStatus(overrides: Record<string, unknown> = {}) {
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

function makeDevice(overrides: Record<string, unknown> = {}) {
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

interface NikkiSyncServerApiStub {
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
}

let settingsGet: Mock
let settingsSet: Mock
let serverApi: NikkiSyncServerApiStub
let store: Record<string, unknown>

function installElectronApi(
  opts: {
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
  } = {}
) {
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
            directories: [{ id: 'dir_1', path: 'D:\\ExtraPhotos', mode: 'native' as const }],
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
    approveOrganizerItems: vi.fn(async () => ({ items: [], approved: 0, skipped: 0 }))
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    settings: { get: settingsGet, set: settingsSet },
    nikkisync: serverApi,
    dialog: { selectDirectory: serverApi.selectDirectory }
  }
}

function renderSection() {
  return render(
    <GlobalToastContext.Provider value={mockShowMessage}>
      <SyncServicePage />
    </GlobalToastContext.Provider>
  )
}

beforeEach(() => {
  installElectronApi()
  mockShowMessage.mockClear()
  // 轮询按 currentView 门控（用例 (r)），不进本页就一条状态都不拉
  useUIStore.setState({ currentView: 'sync-service' })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('SyncServicePage（真实 NikkiSync 服务，(a)-(p) 自设置页搬入）', () => {
  it('(a) 挂载读取 nikkisync.syncServerEnabled（缺省 false）并拉取状态与设备列表', async () => {
    renderSection()
    await waitFor(() => expect(settingsGet).toHaveBeenCalledWith(SETTING_SYNC_ENABLED, false))
    await waitFor(() => expect(serverApi.getServerStatus).toHaveBeenCalled())
    await waitFor(() => expect(serverApi.getPairedDevices).toHaveBeenCalled())
  })

  it('(b) 开关启用：服务与 Runtime 两个设置项同写，再 startServer + toast', async () => {
    renderSection()
    const toggle = await screen.findByRole('switch', { name: '启用同步服务' })
    fireEvent.click(toggle)
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(SETTING_SYNC_ENABLED, true))
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(SETTING_RUNTIME_ENABLED, true))
    await waitFor(() => expect(serverApi.startServer).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalled())
  })

  it('(c) 启动失败：两个设置项一并回滚为 false（不悬挂在已启用态）', async () => {
    installElectronApi({ startServerReject: new Error('PORT_IN_USE') })
    renderSection()
    const toggle = await screen.findByRole('switch', { name: '启用同步服务' })
    fireEvent.click(toggle)
    await waitFor(() => expect(serverApi.startServer).toHaveBeenCalledTimes(1))
    // 断言最终持久化状态而不是调用次序：回滚是两次串行写入，比 lastCalledWith 稳
    await waitFor(() => expect(store[SETTING_SYNC_ENABLED]).toBe(false))
    await waitFor(() => expect(store[SETTING_RUNTIME_ENABLED]).toBe(false))
    expect(serverApi.stopServer).not.toHaveBeenCalled()
  })

  it('(d) 运行中渲染服务地址（lanHost:port）', async () => {
    installElectronApi({ devices: [makeDevice()] })
    renderSection()
    await waitFor(() => expect(screen.getByText('192.168.1.10:28080')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('iPhone 15')).toBeInTheDocument())
  })

  it('(e) 撤销设备：确认后调用 revokeDevice 并刷新列表', async () => {
    installElectronApi({
      devices: [
        makeDevice(),
        makeDevice({ deviceId: 'dev-2', deviceName: 'Pixel 8', platform: 'android' })
      ]
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('iPhone 15')).toBeInTheDocument())
    // 每行一个撤销按钮（按名称定位第一个）
    fireEvent.click(screen.getAllByRole('button', { name: '撤销' })[0])
    const confirmBtn = await screen.findByRole('button', { name: '撤销设备' })
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(serverApi.revokeDevice).toHaveBeenCalledWith('dev-1'))
  })

  it('(f) 无设备时展示空态', async () => {
    installElectronApi({ devices: [] })
    renderSection()
    await waitFor(() => expect(screen.getByText('暂无已配对设备')).toBeInTheDocument())
  })

  it('(g) 设备列表通道失败不影响状态卡（列表降级为空，仍显示运行中）', async () => {
    installElectronApi({ pairedDevicesReject: new Error('runtime is not ready') })
    renderSection()
    await waitFor(() => expect(screen.getByText('运行中')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('暂无已配对设备')).toBeInTheDocument())
  })

  it('(h) 不虚构“已连接客户端数”（上游 WebSocketHub 无公开计数）', async () => {
    renderSection()
    await waitFor(() => expect(serverApi.getServerStatus).toHaveBeenCalled())
    expect(screen.queryByText('已连接客户端')).not.toBeInTheDocument()
  })

  it('(i) 未装配（available:false）时显示不可用而非报错', async () => {
    installElectronApi({ status: { available: false, running: false } })
    renderSection()
    await waitFor(() => expect(screen.getByText('同步组件未就绪')).toBeInTheDocument())
  })

  // ===== 阶段 4：图库数据源开关 =====

  it('(j) 切到 NikkiSync：写两个设置项 + 设定 store 分流 + 触发一次不阻塞的扫描', async () => {
    renderSection()
    const toggle = await screen.findByRole('switch', { name: '图库数据源使用 NikkiSync 资产库' })
    fireEvent.click(toggle)
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('gallery.dataSource', 'nikkisync'))
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(SETTING_RUNTIME_ENABLED, true))
    await waitFor(() => expect(serverApi.startScan).toHaveBeenCalledWith({}))
    expect(useMediaStore.getState().source).toBe('nikkisync')
    useMediaStore.getState().setSource('local')
  })

  it('(k) 持久化失败时三处状态一并回滚，不留「UI 已切、下次启动回本地」的裂口', async () => {
    settingsSet.mockImplementation(() => Promise.reject(new Error('disk full')))
    renderSection()
    const toggle = await screen.findByRole('switch', { name: '图库数据源使用 NikkiSync 资产库' })
    fireEvent.click(toggle)
    await waitFor(() => expect(useMediaStore.getState().source).toBe('local'))
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('(l) 挂载读回已持久化的 nikkisync，开关为开启态且不必再触发扫描', async () => {
    installElectronApi({ persisted: { 'gallery.dataSource': 'nikkisync' } })
    renderSection()
    const toggle = await screen.findByRole('switch', { name: '图库数据源使用 NikkiSync 资产库' })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    expect(serverApi.startScan).not.toHaveBeenCalled()
    useMediaStore.getState().setSource('local')
  })

  it('(m) 阶段6：元数据解析开关默认关，点击只写自己的设置项', async () => {
    renderSection()
    const toggle = await screen.findByRole('switch', { name: METADATA_TOGGLE_NAME })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(SETTING_METADATA_RESOLVER, true))
    // 关键隔离：这个开关不得顺带启停同步服务、不得改运行时/数据源
    // （那三件事各有自己的开关与后果，混在一起会让「开了什么」不可判定）
    expect(serverApi.startServer).not.toHaveBeenCalled()
    expect(serverApi.stopServer).not.toHaveBeenCalled()
    expect(settingsSet).not.toHaveBeenCalledWith(SETTING_SYNC_ENABLED, true)
    expect(settingsSet).not.toHaveBeenCalledWith(SETTING_RUNTIME_ENABLED, true)
    expect(settingsSet).not.toHaveBeenCalledWith('gallery.dataSource', 'nikkisync')
  })

  it('(n) 阶段6：挂载读回已持久化的开启态', async () => {
    installElectronApi({ persisted: { [SETTING_METADATA_RESOLVER]: true } })
    renderSection()
    const toggle = await screen.findByRole('switch', { name: METADATA_TOGGLE_NAME })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  })

  it('(o) 阶段6：披露文案在开关旁直接渲染（要点名第三方主机，不能只藏在悬浮提示里）', async () => {
    renderSection()
    await screen.findByRole('switch', { name: METADATA_TOGGLE_NAME })
    const disclosure = await screen.findByText(/nuan5\.pro/)
    expect(String(disclosure.textContent)).toMatch(/已配对设备/)
    expect(String(disclosure.textContent)).toMatch(/局域网/)
  })

  it('(p) 阶段6：持久化失败 ⇒ 开关回滚为关闭态并报错', async () => {
    installElectronApi()
    settingsSet.mockImplementation((key: string, value: unknown) => {
      if (key === SETTING_METADATA_RESOLVER) {
        void value
        return Promise.reject(new Error('disk full'))
      }
      return Promise.resolve()
    })
    renderSection()
    const toggle = await screen.findByRole('switch', { name: METADATA_TOGGLE_NAME })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
  })

  // ===== 搬移带出的新契约 =====

  it('(q) 三段层级：页头 h2 + 控制/配对/设备三个 h3 同页存在', async () => {
    renderSection()
    await screen.findByRole('switch', { name: '启用同步服务' })
    expect(
      screen.getByRole('heading', { level: 2, name: '同步服务' }),
      '二级页必须有自己的 h2 页头（层级 2 的视觉与语义起点）'
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: '同步服务' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: '配对新设备' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: '已配对设备' })).toBeInTheDocument()
    // 配对入口按钮落在配对区内，而不是挤在开关区里
    expect(screen.getByRole('button', { name: '配对新设备' })).toBeInTheDocument()
  })

  it('(r) 状态轮询按 currentView 门控：不在本页时一次都不拉，回到本页才恢复 2s 轮询', async () => {
    useUIStore.setState({ currentView: 'gallery' })
    renderSection()
    await act(async () => {
      await Promise.resolve()
    })
    expect(
      serverApi.getServerStatus,
      '页面切走仍轮询 = keep-alive 下后台常驻定时器'
    ).not.toHaveBeenCalled()

    vi.useFakeTimers()
    useUIStore.setState({ currentView: 'sync-service' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(serverApi.getServerStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(STATUS_POLL_MS * 2)
    })
    expect(serverApi.getServerStatus.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  // ===== K1：启动阶段观测 =====

  it('(s) K1：启动阶段行按 i18n 映射展示，未知阶段回退原样英文串；无阶段时不渲染该行', async () => {
    installElectronApi({
      runtimeStatus: {
        state: 'running',
        startupStages: [
          { stage: 'scanner', at: '2026-10-25T08:00:00.000Z' },
          { stage: 'runtime-ready', at: '2026-10-25T08:00:01.000Z' },
          { stage: 'lan-listen', at: '2026-10-25T08:00:02.000Z' },
          { stage: 'cached-metadata', at: '2026-10-25T08:00:03.000Z' },
          { stage: 'custom-x', at: '2026-10-25T08:00:04.000Z' }
        ]
      }
    })
    renderSection()
    await waitFor(() => expect(serverApi.getRuntimeStatus).toHaveBeenCalled())
    expect(screen.getByText('启动阶段')).toBeInTheDocument()
    expect(screen.getByText('扫描器')).toBeInTheDocument()
    expect(screen.getByText('运行时就绪')).toBeInTheDocument()
    expect(screen.getByText('局域网监听')).toBeInTheDocument()
    expect(screen.getByText('缓存元数据升级')).toBeInTheDocument()
    // 未知阶段不谎报：原样展示上游英文短码，交由用户/日志判断
    expect(screen.getByText('custom-x')).toBeInTheDocument()
  })

  it('(s2) K1：无已发生阶段（未启动/中断）时不渲染启动阶段行', async () => {
    installElectronApi({ runtimeStatus: { state: 'idle' } })
    renderSection()
    await waitFor(() => expect(serverApi.getRuntimeStatus).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('运行状态')).toBeInTheDocument())
    expect(screen.queryByText('启动阶段')).not.toBeInTheDocument()
  })

  // ===== K2：在线解析同意 =====

  it('(t) K2：解析开关关闭时不渲染同意块（同意面只在解析开启的会话上存在）', async () => {
    installElectronApi({ consent: null })
    renderSection()
    await waitFor(() => expect(screen.getByText('运行状态')).toBeInTheDocument())
    expect(screen.queryByText('在线参数解析说明')).not.toBeInTheDocument()
  })

  it('(u) K2：解析开启且同意可用 ⇒ 渲染端点/策略版本/字段清单；勾选携带页面 policyVersion 提交', async () => {
    installElectronApi({
      persisted: { [SETTING_METADATA_RESOLVER]: true },
      consent: { enabled: false }
    })
    renderSection()
    const toggle = await screen.findByRole('switch', { name: '同意发送照片参数' })
    await waitFor(() => expect(screen.getByText('在线参数解析说明')).toBeInTheDocument())
    expect(screen.getByText(/nuan5\.pro\/api\/decode-photo2/)).toBeInTheDocument()
    expect(screen.getByText('2026-10-13.1')).toBeInTheDocument()
    expect(screen.getByText('photo UID')).toBeInTheDocument()
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(serverApi.setMetadataConsent).toHaveBeenCalledWith({
        enabled: true,
        policyVersion: '2026-10-13.1'
      })
    )
  })

  it('(v) K2：提交失败（policyVersion 过期）⇒ 开关回滚为原态并报错', async () => {
    installElectronApi({
      persisted: { [SETTING_METADATA_RESOLVER]: true },
      consent: { enabled: false }
    })
    serverApi.setMetadataConsent.mockRejectedValueOnce(new Error('policy version mismatch'))
    renderSection()
    const toggle = await screen.findByRole('switch', { name: '同意发送照片参数' })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
  })

  // ===== K4：连接诊断折叠卡 =====

  it('(w) K4：诊断卡渲染指纹摘要/设备数/加密态/端口，端口占用时带最近错误行', async () => {
    installElectronApi({
      status: {
        ...makeStatus(),
        error: 'PORT_IN_USE',
        diagnostics: {
          ...(makeStatus().diagnostics as Record<string, unknown>),
          lastError: 'PORT_IN_USE'
        }
      }
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('连接诊断')).toBeInTheDocument())
    expect(screen.getByText('abcd1234')).toBeInTheDocument()
    expect(screen.getByText('HTTPS（TLS）')).toBeInTheDocument()
    expect(screen.getByText('28080')).toBeInTheDocument()
    expect(screen.getByText('PORT_IN_USE')).toBeInTheDocument()
  })

  it('(x) K4：未装配（available:false，无诊断段）时不渲染诊断卡', async () => {
    installElectronApi({ status: { available: false, running: false, diagnostics: undefined } })
    renderSection()
    await waitFor(() => expect(screen.getByText('同步组件未就绪')).toBeInTheDocument())
    expect(screen.queryByText('连接诊断')).not.toBeInTheDocument()
  })

  // ===== K7：扫描诊断观测面（并入 K4 诊断卡；纯计数，上游承诺无路径/UID/错误原文） =====

  /** 与上游 scanDiagnosticSummary 输出同形（见 electron-api.ts K7 JSDoc 与 IPC_CONTRACT §8.1.5）。 */
  function makeScanDiagnostics() {
    return {
      lastScan: {
        filesObserved: 31,
        resourcesAccepted: 25,
        resourcesIgnored: 4,
        assetsCreated: 20,
        assetsUpdated: 3,
        assetsDeleted: 2,
        errorCount: 1
      },
      timestamp: '2026-10-25T08:00:00.000Z',
      status: 'running',
      installationFound: true,
      scanRootCount: 2,
      automaticRootCount: 1,
      extraRootCount: 1
    }
  }

  it('(x2) K7：runtime-status 带 scanDiagnostics ⇒ 诊断卡内渲染「上次扫描」七项计数行', async () => {
    installElectronApi({
      status: makeStatus(),
      runtimeStatus: { scanDiagnostics: makeScanDiagnostics() }
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('连接诊断')).toBeInTheDocument())
    expect(screen.getByText('上次扫描')).toBeInTheDocument()
    expect(screen.getByText(/观察\s*31/)).toBeInTheDocument()
    expect(screen.getByText(/收录\s*25/)).toBeInTheDocument()
    expect(screen.getByText(/忽略\s*4/)).toBeInTheDocument()
    expect(screen.getByText(/新建\s*20/)).toBeInTheDocument()
    expect(screen.getByText(/更新\s*3/)).toBeInTheDocument()
    expect(screen.getByText(/删除\s*2/)).toBeInTheDocument()
    expect(screen.getByText(/错误\s*1/)).toBeInTheDocument()
  })

  it('(x3) K7：无 scanDiagnostics 段（未扫描/老链接）⇒ 诊断卡照常但不出现「上次扫描」行', async () => {
    installElectronApi()
    renderSection()
    await waitFor(() => expect(screen.getByText('连接诊断')).toBeInTheDocument())
    expect(screen.queryByText('上次扫描')).not.toBeInTheDocument()
  })

  // ===== K6：额外照片目录 =====

  it('(y) K6：目录列表渲染（path/mode/移除）+ 作用域说明；移除按 id 调用', async () => {
    installElectronApi()
    renderSection()
    await waitFor(() => expect(screen.getByText('额外照片目录')).toBeInTheDocument())
    expect(screen.getByText(/仅作用于/)).toBeInTheDocument()
    expect(screen.getByText(/D:\\ExtraPhotos/)).toBeInTheDocument()
    expect(screen.getByText('native')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '移除目录' }))
    await waitFor(() =>
      expect(serverApi.removeExtraDirectory).toHaveBeenCalledWith({ id: 'dir_1' })
    )
  })

  it('(y2) K6：会话未挂面（老链接）⇒ 预期内的拒绝隐藏整节而非报错', async () => {
    installElectronApi({ extraReject: true })
    renderSection()
    await waitFor(() => expect(screen.getByText('已配对设备')).toBeInTheDocument())
    expect(screen.queryByText('额外照片目录')).not.toBeInTheDocument()
  })

  it('(z) K6：添加流程 selectDirectory → inspect 预览（images/videos）→ 确认携带提案 id add；手动重扫调用 rescan', async () => {
    installElectronApi()
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: '添加目录' }))
    await waitFor(() => expect(serverApi.selectDirectory).toHaveBeenCalled())
    await waitFor(() =>
      expect(serverApi.inspectExtraDirectory).toHaveBeenCalledWith({ path: 'D:\\NewPhotos' })
    )
    // 预览数字可见后确认
    expect(await screen.findByText('识别到 12 张照片 / 2 个视频')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认添加' }))
    await waitFor(() => expect(serverApi.addExtraDirectory).toHaveBeenCalledWith({ id: 'prop_1' }))
    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }))
    await waitFor(() => expect(serverApi.rescanExtraDirectories).toHaveBeenCalled())
  })

  // ===== K8：整理队列（批量删除，破坏性能力） =====

  /** 与上游 DeletionQueue.list() 行同形（message 已在 manager 层剔除）。 */
  function makeOrganizerItem(overrides: Record<string, unknown> = {}) {
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

  function makeOrganizerView(items = [makeOrganizerItem()]) {
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

  it('(aa) K8：开关挂载读取 organizerEnabled；拨动写回设置项（默认关 ⇒ 队列区隐藏）', async () => {
    installElectronApi({ persisted: { 'nikkisync.organizerEnabled': false } })
    renderSection()
    const toggle = await screen.findByRole('switch', { name: '整理队列（批量删除）' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByText('全部批准')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith('nikkisync.organizerEnabled', true)
    )
  })

  it('(ab) K8：开关开 ⇒ 队列列表渲染（11 态映射/文件数/online 指示/操作钮）', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueue: makeOrganizerView([
        makeOrganizerItem({ state: 'pending' }),
        makeOrganizerItem({
          id: 'del-2aaaaaaaaaaaaaaa',
          state: 'recycled',
          online: false,
          count: 1,
          files: [{ name: 'c.jpg', size: 7, folder: 'photos' }]
        })
      ])
    })
    renderSection()
    expect(await screen.findByText('等待电脑确认')).toBeInTheDocument()
    expect(screen.getByText('已移入回收站')).toBeInTheDocument()
    // 行描述是合并文本节点（"N 个文件 · 手机在线"），按子串正则断言
    expect(screen.getByText(/2 个文件/)).toBeInTheDocument()
    expect(screen.getByText(/手机在线/)).toBeInTheDocument()
    expect(screen.getByText(/手机离线/)).toBeInTheDocument()
    // 非终态行有批准/拒绝；终态行（recycled）没有
    expect(screen.getByRole('button', { name: '批准' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '全部批准' })).toBeInTheDocument()
  })

  it('(ac) K8：未知队列状态回退原样英文串（不谎报，K1 同款口径）', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueue: makeOrganizerView([makeOrganizerItem({ state: 'brand-new-state' })])
    })
    renderSection()
    expect(await screen.findByText('brand-new-state')).toBeInTheDocument()
  })

  it('(ad) K8：确认弹窗拦截——批准先弹确认（列明文件数与回收站去向），取消不调用', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueue: makeOrganizerView()
    })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: '批准' }))
    // 标题与确认按钮同名（确认移入回收站），按 role 断言弹窗出现；文案用弹窗专属长句
    expect(await screen.findByRole('button', { name: '确认移入回收站' })).toBeInTheDocument()
    expect(screen.getByText(/将把 2 个文件移入 Windows 系统回收站/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByText('确认移入回收站')).not.toBeInTheDocument())
    expect(serverApi.decideOrganizerItem).not.toHaveBeenCalled()
    expect(serverApi.approveOrganizerItems).not.toHaveBeenCalled()
  })

  it('(ae) K8：单条批准确认后调用 decideOrganizerItem(id,true)；拒绝路径无弹窗直接调用', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueue: makeOrganizerView()
    })
    renderSection()
    // 拒绝：直接调用（非破坏性）
    fireEvent.click(await screen.findByRole('button', { name: '拒绝' }))
    await waitFor(() =>
      expect(serverApi.decideOrganizerItem).toHaveBeenCalledWith({
        id: 'del-1aaaaaaaaaaaaaaa',
        approve: false
      })
    )
    // 批准：弹确认 → 确认后调用
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认移入回收站' }))
    await waitFor(() =>
      expect(serverApi.decideOrganizerItem).toHaveBeenCalledWith({
        id: 'del-1aaaaaaaaaaaaaaa',
        approve: true
      })
    )
  })

  it('(af) K8：批量批准确认后调用 approveOrganizerItems（仅 actionable 且在线的 id）', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueue: makeOrganizerView([
        makeOrganizerItem({ id: 'del-1aaaaaaaaaaaaaaa', state: 'pending', online: true }),
        makeOrganizerItem({
          id: 'del-2aaaaaaaaaaaaaaa',
          state: 'pending',
          online: false
        }),
        makeOrganizerItem({ id: 'del-3aaaaaaaaaaaaaaa', state: 'recycled', online: false })
      ])
    })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: '全部批准' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认移入回收站' }))
    await waitFor(() =>
      expect(serverApi.approveOrganizerItems).toHaveBeenCalledWith({
        ids: ['del-1aaaaaaaaaaaaaaa']
      })
    )
  })

  it('(ag) K8：开关开但队列为空 ⇒ 空态文案，无操作按钮', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueue: makeOrganizerView([])
    })
    renderSection()
    expect(await screen.findByText('暂无待整理删除项')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全部批准' })).not.toBeInTheDocument()
  })

  it('(ah) K8：队列通道失败（会话未装配）⇒ 队列区显示不可用提示而非报错弹窗', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueueReject: true
    })
    renderSection()
    expect(await screen.findByText('整理队列不可用')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全部批准' })).not.toBeInTheDocument()
  })
})
