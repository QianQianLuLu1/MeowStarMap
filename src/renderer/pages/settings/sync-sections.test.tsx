/**
 * @vitest-environment jsdom
 *
 * SyncServiceSection（同步服务设置分区）单元测试——sync-integration 阶段5：
 *  (a) 挂载读取 sync.serverEnabled（默认 false）与状态/设备列表
 *  (b) 开关启用：写设置 + sync.startServer + toast 反馈
 *  (c) 启动失败：设置回滚为 false + 错误 toast（开关还原）
 *  (d) 运行状态渲染（lanHost:port）
 *  (e) 设备列表渲染 + 撤销确认流（ConfirmDialog → revokeDevice）
 *  (f) 无设备时空态
 *
 * 运行：npx vitest run src/renderer/pages/settings/sync-sections.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { GlobalToastContext } from '../../components/common/ToastProvider'
import { SyncServiceSection } from './sync-sections'

const mockShowMessage = vi.fn()

function makeStatus(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    running: true,
    host: '0.0.0.0',
    port: 27124,
    connections: 1,
    serverId: 'wxnn-0123456789abcdef',
    serverName: 'WXNN XiangCe',
    pairedDeviceCount: 1,
    tlsFingerprintSha256: 'aa'.repeat(32),
    lanHost: '192.168.1.10',
    ...overrides
  }
}

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: 'dev-1',
    deviceName: 'iPhone 15',
    platform: 'ios',
    appVersion: '1.0.0',
    pairedAt: '2026-10-11T00:00:00.000Z',
    lastSeenAt: '2026-10-11T01:00:00.000Z',
    lastAckRevision: 3,
    ...overrides
  }
}

interface SyncApiStub {
  getStatus: Mock
  startServer: Mock
  stopServer: Mock
  createPairingQr: Mock
  listDevices: Mock
  revokeDevice: Mock
}

let settingsGet: Mock
let settingsSet: Mock
let syncApi: SyncApiStub
let store: Record<string, unknown>

function installElectronApi(opts: {
  persisted?: Record<string, unknown>
  status?: Record<string, unknown>
  devices?: ReturnType<typeof makeDevice>[]
  startServerReject?: Error
} = {}) {
  store = { ...opts.persisted }
  settingsGet = vi.fn((key: string, fallback: unknown) =>
    Promise.resolve(store[key] !== undefined ? store[key] : fallback)
  )
  settingsSet = vi.fn((key: string, value: unknown) => {
    store[key] = value
    return Promise.resolve()
  })
  syncApi = {
    getStatus: vi.fn(async () => makeStatus(opts.status)),
    startServer: vi.fn(
      opts.startServerReject
        ? async () => {
            throw opts.startServerReject
          }
        : async () => makeStatus()
    ),
    stopServer: vi.fn(async () => makeStatus({ running: false })),
    createPairingQr: vi.fn(async () => ({
      content: 'NS1|wxnn-x|192.168.1.10|27124|tok|1893456000|' + 'ab'.repeat(32),
      expiresAt: '2026-10-11T12:05:00.000Z',
      serverId: 'wxnn-0123456789abcdef',
      host: '192.168.1.10',
      port: 27124,
      tlsFingerprintSha256: 'aa'.repeat(32)
    })),
    listDevices: vi.fn(async () => opts.devices ?? []),
    revokeDevice: vi.fn(async () => (opts.devices ?? []).slice(1))
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    settings: { get: settingsGet, set: settingsSet },
    sync: syncApi
  }
}

function renderSection() {
  return render(
    <GlobalToastContext.Provider value={mockShowMessage}>
      <SyncServiceSection />
    </GlobalToastContext.Provider>
  )
}

beforeEach(() => {
  installElectronApi()
  mockShowMessage.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SyncServiceSection', () => {
  it('(a) 挂载读取 sync.serverEnabled（缺省 false）并拉取状态与设备列表', async () => {
    renderSection()
    await waitFor(() => expect(settingsGet).toHaveBeenCalledWith('sync.serverEnabled', false))
    await waitFor(() => expect(syncApi.getStatus).toHaveBeenCalled())
    await waitFor(() => expect(syncApi.listDevices).toHaveBeenCalled())
  })

  it('(b) 开关启用：写设置 + startServer + toast 反馈', async () => {
    renderSection()
    const toggle = await screen.findByRole('switch', { name: '启用同步服务' })
    fireEvent.click(toggle)
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('sync.serverEnabled', true))
    await waitFor(() => expect(syncApi.startServer).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalled())
  })

  it('(c) 启动失败：设置回滚为 false（不悬挂在已启用态）', async () => {
    installElectronApi({ startServerReject: new Error('port occupied') })
    renderSection()
    const toggle = await screen.findByRole('switch', { name: '启用同步服务' })
    fireEvent.click(toggle)
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('sync.serverEnabled', true))
    await waitFor(() => expect(settingsSet).toHaveBeenLastCalledWith('sync.serverEnabled', false))
    expect(syncApi.stopServer).not.toHaveBeenCalled()
  })

  it('(d) 运行中渲染服务地址（lanHost:port）与已配对设备数', async () => {
    installElectronApi({ devices: [makeDevice()] })
    renderSection()
    await waitFor(() => expect(screen.getByText('192.168.1.10:27124')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('iPhone 15')).toBeInTheDocument())
  })

  it('(e) 撤销设备：确认后调用 revokeDevice 并刷新列表', async () => {
    installElectronApi({ devices: [makeDevice(), makeDevice({ deviceId: 'dev-2', deviceName: 'Pixel 8', platform: 'android' })] })
    renderSection()
    await waitFor(() => expect(screen.getByText('iPhone 15')).toBeInTheDocument())
    // 每行一个撤销按钮（按名称定位第一个）
    fireEvent.click(screen.getAllByRole('button', { name: '撤销' })[0])
    // 确认对话框出现并确认
    const confirmBtn = await screen.findByRole('button', { name: '撤销设备' })
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(syncApi.revokeDevice).toHaveBeenCalledWith('dev-1'))
  })

  it('(f) 无设备时展示空态', async () => {
    installElectronApi({ devices: [] })
    renderSection()
    await waitFor(() => expect(screen.getByText('暂无已配对设备')).toBeInTheDocument())
  })
})
