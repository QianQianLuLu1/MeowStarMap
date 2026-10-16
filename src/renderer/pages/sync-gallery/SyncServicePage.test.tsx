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
  startServer: Mock
  stopServer: Mock
  getPairingCode: Mock
  getPairedDevices: Mock
  revokeDevice: Mock
  startScan: Mock
}

let settingsGet: Mock
let settingsSet: Mock
let serverApi: NikkiSyncServerApiStub
let store: Record<string, unknown>

function installElectronApi(
  opts: {
    persisted?: Record<string, unknown>
    status?: Record<string, unknown>
    devices?: ReturnType<typeof makeDevice>[]
    startServerReject?: Error
    pairedDevicesReject?: Error
    startScanReject?: Error
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
    )
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    settings: { get: settingsGet, set: settingsSet },
    nikkisync: serverApi
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
})
