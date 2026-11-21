// @vitest-environment jsdom
/**
 * T1/T3：Connect 视图套件——SyncServicePage.test.tsx 的 (a)-(i)/(q)/(r)/(s)/(s2)/
 * (w)/(x)/(x2)/(x3)/(ai)/(aj)/(bj)/(bk)/(bl) 与 N7/F12 逐节随迁（判据不重写，
 * 仅渲染锚点从整页改为 Connect 视图直渲染）；T3 新增统计卡/firstRun 内联码/
 * 自查掉线展开/微信折叠持久化/Android 外链/导出诊断的判据。
 *
 * 运行：npx vitest run src/renderer/pages/sync-gallery/console/ConnectView.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ConnectView } from './ConnectView'
import { UPSTREAM_ANDROID_APK_URL } from './upstream-links'
import {
  setupConsoleTest,
  renderView,
  installElectronApi,
  makeStatus,
  makeDevice,
  mockShowMessage,
  serverApi,
  settingsGet,
  settingsSet,
  store,
  logExportZip,
  shellOpenExternal,
  SETTING_SYNC_ENABLED,
  SETTING_RUNTIME_ENABLED,
  STATUS_POLL_MS
} from './sync-console-test-utils'
import { useUIStore } from '../../../stores/uiStore'

const mockNavigate = vi.fn()

function renderConnect() {
  return renderView(<ConnectView onNavigate={mockNavigate} />)
}

beforeEach(() => {
  setupConsoleTest()
  mockNavigate.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ConnectView（(a)-(i) 自 SyncServicePage 随迁）', () => {
  it('(a) 挂载读取 nikkisync.syncServerEnabled（缺省 false）并拉取状态与设备列表', async () => {
    renderConnect()
    await waitFor(() => expect(settingsGet).toHaveBeenCalledWith(SETTING_SYNC_ENABLED, false))
    await waitFor(() => expect(serverApi.getServerStatus).toHaveBeenCalled())
    await waitFor(() => expect(serverApi.getPairedDevices).toHaveBeenCalled())
  })

  it('(b) 开关启用：服务与 Runtime 两个设置项同写，再 startServer + toast', async () => {
    renderConnect()
    const toggle = await screen.findByRole('switch', { name: '启用同步服务' })
    fireEvent.click(toggle)
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(SETTING_SYNC_ENABLED, true))
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(SETTING_RUNTIME_ENABLED, true))
    await waitFor(() => expect(serverApi.startServer).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalled())
  })

  it('(c) 启动失败：两个设置项一并回滚为 false（不悬挂在已启用态）', async () => {
    installElectronApi({ startServerReject: new Error('PORT_IN_USE') })
    renderConnect()
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
    renderConnect()
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
    renderConnect()
    await waitFor(() => expect(screen.getByText('iPhone 15')).toBeInTheDocument())
    // 每行一个撤销按钮（按名称定位第一个）
    fireEvent.click(screen.getAllByRole('button', { name: '撤销' })[0])
    const confirmBtn = await screen.findByRole('button', { name: '撤销设备' })
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(serverApi.revokeDevice).toHaveBeenCalledWith('dev-1'))
  })

  it('(f) 无设备时展示空态', async () => {
    installElectronApi({ devices: [] })
    renderConnect()
    await waitFor(() => expect(screen.getByText('暂无已配对设备')).toBeInTheDocument())
  })

  it('(g) 设备列表通道失败不影响状态卡（列表降级为空，仍显示运行中）', async () => {
    installElectronApi({ pairedDevicesReject: new Error('runtime is not ready') })
    renderConnect()
    await waitFor(() => expect(screen.getByText('运行中')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('暂无已配对设备')).toBeInTheDocument())
  })

  it('(h) 不虚构“已连接客户端数”（上游 WebSocketHub 无公开计数）', async () => {
    renderConnect()
    await waitFor(() => expect(serverApi.getServerStatus).toHaveBeenCalled())
    expect(screen.queryByText('已连接客户端')).not.toBeInTheDocument()
  })

  it('(i) 未装配（available:false）时显示不可用而非报错', async () => {
    installElectronApi({ status: { available: false, running: false } })
    renderConnect()
    await waitFor(() => expect(screen.getByText('同步组件未就绪')).toBeInTheDocument())
  })

  it('(q) 三段层级：页头 h2 由 Layout 承担；控制/配对/设备三个 h3 同视图存在', async () => {
    // 锚点适配：h2 页头钉在 SyncConsoleLayout（见其套件），视图内三段 h3 判据不变
    renderConnect()
    await screen.findByRole('switch', { name: '启用同步服务' })
    expect(screen.getByRole('heading', { level: 3, name: '同步服务' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: '配对新设备' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: '已配对设备' })).toBeInTheDocument()
    // 配对入口按钮落在配对区内，而不是挤在开关区里
    expect(screen.getByRole('button', { name: '配对新设备' })).toBeInTheDocument()
  })

  it('(r) 状态轮询按 currentView 门控：不在本页时一次都不拉，回到本页才恢复 2s 轮询', async () => {
    useUIStore.setState({ currentView: 'gallery' })
    renderConnect()
    await act(async () => {
      await Promise.resolve()
    })
    expect(
      serverApi.getServerStatus,
      '页面切走仍轮询 = keep-alive 下后台常驻定时器'
    ).not.toHaveBeenCalled()

    vi.useFakeTimers()
    useUIStore.setState({ currentView: 'sync-gallery' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(serverApi.getServerStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(STATUS_POLL_MS * 2)
    })
    expect(serverApi.getServerStatus.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

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
    renderConnect()
    // 等「渲染出结果」而不是「发起了调用」：refresh() 把三个通道放进同一个 Promise.all，
    // setStartupStages 落在其后的微任务里。只 waitFor 调用发生就断言文本，在全量套件的
    // CPU 争用下会随机读到尚未提交的渲染，同文件 (s2)/(x2) 都是按落地结果等待的口径。
    await waitFor(() => expect(screen.getByText('启动阶段')).toBeInTheDocument())
    expect(screen.getByText('扫描器')).toBeInTheDocument()
    expect(screen.getByText('运行时就绪')).toBeInTheDocument()
    expect(screen.getByText('局域网监听')).toBeInTheDocument()
    expect(screen.getByText('缓存元数据升级')).toBeInTheDocument()
    // 未知阶段不谎报：原样展示上游英文短码，交由用户/日志判断
    expect(screen.getByText('custom-x')).toBeInTheDocument()
  })

  it('(s2) K1：无已发生阶段（未启动/中断）时不渲染启动阶段行', async () => {
    installElectronApi({ runtimeStatus: { state: 'idle' } })
    renderConnect()
    await waitFor(() => expect(serverApi.getRuntimeStatus).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('运行状态')).toBeInTheDocument())
    expect(screen.queryByText('启动阶段')).not.toBeInTheDocument()
  })

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
    renderConnect()
    await waitFor(() => expect(screen.getByText('连接诊断')).toBeInTheDocument())
    expect(screen.getByText('abcd1234')).toBeInTheDocument()
    expect(screen.getByText('HTTPS（TLS）')).toBeInTheDocument()
    expect(screen.getByText('28080')).toBeInTheDocument()
    expect(screen.getByText('PORT_IN_USE')).toBeInTheDocument()
  })

  it('(x) K4：未装配（available:false，无诊断段）时不渲染诊断卡', async () => {
    installElectronApi({ status: { available: false, running: false, diagnostics: undefined } })
    renderConnect()
    await waitFor(() => expect(screen.getByText('同步组件未就绪')).toBeInTheDocument())
    expect(screen.queryByText('连接诊断')).not.toBeInTheDocument()
  })

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
    renderConnect()
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
    renderConnect()
    await waitFor(() => expect(screen.getByText('连接诊断')).toBeInTheDocument())
    expect(screen.queryByText('上次扫描')).not.toBeInTheDocument()
  })

  it('(ai) 历史非布尔持久化值不得把同步服务开关显示为开启（与主进程形态收敛同口径）', async () => {
    // app_settings 历史值可能是字符串（nikkisync-runtime-setup.ts 的 settingsFrom 为此
    // 显式做 `typeof value === 'boolean' ? value : fallback` 收敛 ⇒ 主进程视作关闭、
    // 不会自启）。渲染层必须同一判据，否则 UI 挂着「已启用」而服务端根本没起。
    installElectronApi({ persisted: { 'nikkisync.syncServerEnabled': 'true' } })
    renderConnect()
    const toggle = await screen.findByRole('switch', { name: '启用同步服务' })
    await waitFor(() => expect(settingsGet).toHaveBeenCalledWith(SETTING_SYNC_ENABLED, false))
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('(aj) 持久化失败：同步服务开关不得悬挂在已启用态，且不得留下未捕获 rejection', async () => {
    settingsSet.mockImplementation(() => Promise.reject(new Error('disk full')))
    renderConnect()
    const toggle = await screen.findByRole('switch', { name: '启用同步服务' })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect(serverApi.startServer).not.toHaveBeenCalled()
    expect(store[SETTING_SYNC_ENABLED]).not.toBe(true)
    expect(store[SETTING_RUNTIME_ENABLED]).not.toBe(true)
  })

  it('(bj) 灵感同步 v1 能力位：上游挂载时状态区如实给出一行', async () => {
    installElectronApi({ status: { inspirationV1: true } })
    renderConnect()
    expect(await screen.findByText('灵感同步 v1')).toBeInTheDocument()
    expect(screen.getByText('端点已挂载')).toBeInTheDocument()
  })

  it('(bk) 能力位缺席 ⇒ 不留该行，也不谎报「未启用」（缺席只代表老构建，不是用户关的）', async () => {
    renderConnect()
    await waitFor(() => expect(serverApi.getServerStatus).toHaveBeenCalled())
    expect(screen.queryByText('灵感同步 v1')).not.toBeInTheDocument()
  })

  it('(bl) 灵感库面板不在 Connect 视图渲染（控制台 Inspiration 视图复用，能力位观测行保留）', async () => {
    renderConnect()
    await waitFor(() => expect(serverApi.getServerStatus).toHaveBeenCalled())
    expect(screen.queryByTestId('sync-inspiration-summary')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sync-inspiration-panel')).not.toBeInTheDocument()
  })
})

describe('ConnectView PC 端分区（N7/F12 随迁）', () => {
  it('渲染 PC 端入口：打开控制页 / 微信画廊启停 / 状态与二维码区', async () => {
    renderConnect()
    expect(await screen.findByTestId('sync-service-pc-section')).toBeInTheDocument()
    expect(screen.getByTestId('pc-open-desktop')).toBeInTheDocument()
    expect(screen.getByTestId('pc-wechat-start')).toBeInTheDocument()
    expect(screen.getByTestId('pc-wechat-stop')).toBeInTheDocument()
  })

  // F12：父页 keep-alive 不卸载本分区，仅挂载取一次会让画廊状态整会话陈旧
  // （控制页启停画廊后 UI 永不更新）。与页头服务状态卡同口径按 2s 轮询。
  it('F12 微信画廊状态随轮询刷新，不得只取挂载那一次', async () => {
    vi.useFakeTimers()
    try {
      renderConnect()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      const callsAtMount = serverApi.wechatStatus.mock.calls.length
      expect(callsAtMount).toBeGreaterThanOrEqual(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 2)
      })
      expect(serverApi.wechatStatus.mock.calls.length).toBeGreaterThan(callsAtMount + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('T3：资产总览统计卡（useSyncOverview）', () => {
  it('available ⇒ 渲染素材数与配对设备数；通道失败 ⇒ 诚实不可用文案', async () => {
    installElectronApi({ overview: { available: true, assets: 342, pairedDevices: 7 } })
    renderConnect()
    const stats = await screen.findByTestId('sync-console-stats')
    await waitFor(() => expect(stats.textContent).toContain('342'))
    expect(stats.textContent).toContain('7')
  })

  it('overviewReject ⇒ 不可用文案，不虚构计数', async () => {
    installElectronApi({ overviewReject: true })
    renderConnect()
    await waitFor(() =>
      expect(screen.getByTestId('sync-console-stats').textContent).toContain('资产总览不可用')
    )
  })

  it('轮询门控：不在本页零调用；可见时 2s 轮询；卸载后定时器清零', async () => {
    vi.useFakeTimers()
    try {
      useUIStore.setState({ currentView: 'gallery' })
      const { unmount } = renderConnect()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(serverApi.getLibraryOverview).not.toHaveBeenCalled()

      useUIStore.setState({ currentView: 'sync-gallery' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(serverApi.getLibraryOverview).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 2)
      })
      expect(serverApi.getLibraryOverview.mock.calls.length).toBeGreaterThanOrEqual(3)

      unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('老桥面（getLibraryOverview 缺席）⇒ 零调用且统计卡不可用，不报错', async () => {
    installElectronApi({ omitMethods: ['getLibraryOverview'] })
    renderConnect()
    await waitFor(() =>
      expect(screen.getByTestId('sync-console-stats').textContent).toContain('资产总览不可用')
    )
    expect(serverApi.getServerStatus).toHaveBeenCalled()
  })
})

describe('T3：firstRun 内联首次配对二维码', () => {
  it('firstRun 且服务在跑 ⇒ 内联二维码卡出现并走 getPairingCode', async () => {
    installElectronApi({
      overview: { available: true, assets: 0, pairedDevices: 0, firstRun: true }
    })
    renderConnect()
    expect(await screen.findByTestId('sync-first-run-qr')).toBeInTheDocument()
    await waitFor(() => expect(serverApi.getPairingCode).toHaveBeenCalled())
  })

  it('firstRun:false ⇒ 不渲染内联码（不骚扰已配对用户）', async () => {
    installElectronApi()
    renderConnect()
    await waitFor(() => expect(serverApi.getServerStatus).toHaveBeenCalled())
    expect(screen.queryByTestId('sync-first-run-qr')).not.toBeInTheDocument()
  })

  it('服务未运行 ⇒ 即使 firstRun 也不生成（无内容可编）', async () => {
    installElectronApi({
      status: { running: false },
      overview: { available: true, assets: 0, pairedDevices: 0, firstRun: true }
    })
    renderConnect()
    await waitFor(() => expect(serverApi.getLibraryOverview).toHaveBeenCalled())
    expect(screen.queryByTestId('sync-first-run-qr')).not.toBeInTheDocument()
    expect(serverApi.getPairingCode).not.toHaveBeenCalled()
  })
})

describe('T3：SelfCheckCard 掉线自动展开', () => {
  function selfCheckDetails(): HTMLDetailsElement {
    return screen.getByTestId('sync-self-check') as HTMLDetailsElement
  }

  it('运行中 ⇒ 默认折叠；轮询观测到掉线（true→false）⇒ 自动展开', async () => {
    vi.useFakeTimers()
    try {
      renderConnect()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(selfCheckDetails().open).toBe(false)
      serverApi.getServerStatus.mockResolvedValue(makeStatus({ running: false }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STATUS_POLL_MS)
      })
      expect(selfCheckDetails().open).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('初始即离线 ⇒ 不自动展开（未启用是常态，不是事故）', async () => {
    installElectronApi({ status: { running: false } })
    renderConnect()
    await waitFor(() => expect(serverApi.getServerStatus).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('已停止')).toBeInTheDocument())
    expect(selfCheckDetails().open).toBe(false)
  })

  it('自查跳转按钮 ⇒ onNavigate(settings)', async () => {
    renderConnect()
    await screen.findByTestId('sync-self-check')
    selfCheckDetails().open = true
    fireEvent.click(screen.getByRole('button', { name: '检查连接权限' }))
    expect(mockNavigate).toHaveBeenCalledWith('settings')
  })
})

describe('T3：微信卡折叠持久化（momo.wechat-entry.seen.v1）', () => {
  function wechatDetails(): HTMLDetailsElement {
    return document.querySelector('.sc-wechat-entry-code') as HTMLDetailsElement
  }

  it('首次展开态；手动收起 ⇒ 落盘 1；重挂载读回仍收起', async () => {
    const { unmount } = renderConnect()
    await screen.findByTestId('sync-service-pc-section')
    expect(wechatDetails().open).toBe(true)
    const details = wechatDetails()
    details.open = false
    fireEvent(details, new Event('toggle'))
    expect(window.localStorage.getItem('momo.wechat-entry.seen.v1')).toBe('1')
    unmount()
    renderConnect()
    await screen.findByTestId('sync-service-pc-section')
    expect(wechatDetails().open).toBe(false)
  })

  it('重新展开 ⇒ 清除持久化键（下次回到展开态）', async () => {
    window.localStorage.setItem('momo.wechat-entry.seen.v1', '1')
    renderConnect()
    await screen.findByTestId('sync-service-pc-section')
    expect(wechatDetails().open).toBe(false)
    const details = wechatDetails()
    details.open = true
    fireEvent(details, new Event('toggle'))
    expect(window.localStorage.getItem('momo.wechat-entry.seen.v1')).toBeNull()
  })

  it('画廊连上（state:connected）⇒ 自动收起并落盘', async () => {
    serverApi.wechatStatus.mockResolvedValue({ status: { state: 'connected' } })
    renderConnect()
    await waitFor(() => expect(wechatDetails().open).toBe(false))
    expect(window.localStorage.getItem('momo.wechat-entry.seen.v1')).toBe('1')
  })
})

describe('T3：Android 卡与导出诊断', () => {
  it('APK 直链 ⇒ shell.openExternal 逐字上游地址', async () => {
    renderConnect()
    fireEvent.click(await screen.findByRole('button', { name: /下载 Android APK/ }))
    await waitFor(() => expect(shellOpenExternal).toHaveBeenCalledWith(UPSTREAM_ANDROID_APK_URL))
  })

  it('导出诊断包 ⇒ log.exportZip + 成功 Toast 带落盘路径', async () => {
    renderConnect()
    fireEvent.click(await screen.findByRole('button', { name: /导出诊断包/ }))
    await waitFor(() => expect(logExportZip).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith(
        '诊断包已导出：C:/diagnostics/nikkisync.zip',
        'success'
      )
    )
  })

  it('服务未运行 ⇒ 生成新二维码按钮禁用（无内容可编）', async () => {
    installElectronApi({ status: { running: false } })
    renderConnect()
    const button = await screen.findByRole('button', { name: '生成新二维码' })
    expect(button).toBeDisabled()
  })
})
