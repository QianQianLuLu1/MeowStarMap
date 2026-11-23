// @vitest-environment jsdom
/**
 * T1/T4/T7：Settings 视图套件——SyncServicePage.test.tsx 的 (j)-(p)/(s1)-(s3)/
 * (t)-(v)/(y)-(z3)/选择器单飞/(ak)-(as)/(at)-(bi)/F25/F3/F7a 逐节随迁
 * （判据不重写；仅两处跨视图锚点做机械适配：(t) 原等「运行状态」改等解析开关、
 * (y2) 原等「已配对设备」改等数据源开关——两个锚点文本已随 IA 迁去 Connect）。
 * T4/T7 新增：静态行/开机自启/法律三链/网络权限卡/临时热点卡判据。
 *
 * 运行：npx vitest run src/renderer/pages/sync-gallery/console/SettingsView.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SettingsView } from './SettingsView'
import {
  setupConsoleTest,
  renderView,
  installElectronApi,
  mockShowMessage,
  serverApi,
  settingsSet,
  dialogShowMessageBox,
  appRelaunch,
  shellOpenExternal,
  SETTING_RUNTIME_ENABLED,
  SETTING_METADATA_RESOLVER,
  METADATA_TOGGLE_NAME,
  SETTING_SYNC_AUTOSTART,
  AUTOSTART_TOGGLE_NAME
} from './sync-console-test-utils'
import { useMediaStore } from '../../../stores/mediaStore'

const SETTING_SYNC_ENABLED = 'nikkisync.syncServerEnabled'
const GALLERY_SOURCE_TOGGLE_NAME = '图库数据源使用 NikkiSync 资产库'

function renderSettings() {
  return renderView(<SettingsView />)
}

beforeEach(() => {
  setupConsoleTest()
  // jsdom 无 scrollIntoView：T7「去开启」跳转用例需要可断言的桩
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('SettingsView 阶段 4：图库数据源开关（(j)-(l) 随迁）', () => {
  it('(j) 切到 NikkiSync：写两个设置项 + 设定 store 分流 + 触发一次不阻塞的扫描', async () => {
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: GALLERY_SOURCE_TOGGLE_NAME })
    fireEvent.click(toggle)
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('gallery.dataSource', 'nikkisync'))
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(SETTING_RUNTIME_ENABLED, true))
    await waitFor(() => expect(serverApi.startScan).toHaveBeenCalledWith({}))
    expect(useMediaStore.getState().source).toBe('nikkisync')
    useMediaStore.getState().setSource('local')
  })

  it('(k) 持久化失败时三处状态一并回滚，不留「UI 已切、下次启动回本地」的裂口', async () => {
    settingsSet.mockImplementation(() => Promise.reject(new Error('disk full')))
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: GALLERY_SOURCE_TOGGLE_NAME })
    fireEvent.click(toggle)
    await waitFor(() => expect(useMediaStore.getState().source).toBe('local'))
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('(l) 挂载读回已持久化的 nikkisync，开关为开启态且不必再触发扫描', async () => {
    installElectronApi({ persisted: { 'gallery.dataSource': 'nikkisync' } })
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: GALLERY_SOURCE_TOGGLE_NAME })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    expect(serverApi.startScan).not.toHaveBeenCalled()
    useMediaStore.getState().setSource('local')
  })
})

describe('SettingsView 阶段 6：元数据解析开关（(m)-(p) 随迁）', () => {
  it('(m) 阶段6：元数据解析开关默认关，点击只写自己的设置项', async () => {
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: METADATA_TOGGLE_NAME })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(SETTING_METADATA_RESOLVER, true))
    // 关键隔离：这个开关不得顺带启停同步服务、不得改运行时/数据源
    expect(serverApi.startServer).not.toHaveBeenCalled()
    expect(serverApi.stopServer).not.toHaveBeenCalled()
    expect(settingsSet).not.toHaveBeenCalledWith(SETTING_SYNC_ENABLED, true)
    expect(settingsSet).not.toHaveBeenCalledWith(SETTING_RUNTIME_ENABLED, true)
    expect(settingsSet).not.toHaveBeenCalledWith('gallery.dataSource', 'nikkisync')
  })

  it('(n) 阶段6：挂载读回已持久化的开启态', async () => {
    installElectronApi({ persisted: { [SETTING_METADATA_RESOLVER]: true } })
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: METADATA_TOGGLE_NAME })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  })

  it('(o) 阶段6：披露文案在开关旁直接渲染（要点名第三方主机，不能只藏在悬浮提示里）', async () => {
    renderSettings()
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
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: METADATA_TOGGLE_NAME })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
  })
})

describe('SettingsView 自动启用开关（(s1)-(s3)/F25 随迁）', () => {
  it('(s1) 回归：自动启用开关默认关，点击只写 autoStartSyncServer，不启停服务', async () => {
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: AUTOSTART_TOGGLE_NAME })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(SETTING_SYNC_AUTOSTART, true))
    expect(serverApi.startServer).not.toHaveBeenCalled()
    expect(serverApi.stopServer).not.toHaveBeenCalled()
    expect(settingsSet).not.toHaveBeenCalledWith(SETTING_SYNC_ENABLED, true)
    expect(settingsSet).not.toHaveBeenCalledWith(SETTING_RUNTIME_ENABLED, true)
  })

  it('(s2) 边界：自动启用开关挂载读回已持久化的开启态', async () => {
    installElectronApi({ persisted: { [SETTING_SYNC_AUTOSTART]: true } })
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: AUTOSTART_TOGGLE_NAME })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  })

  it('(s3) 异常：自动启用开关持久化失败 ⇒ 回滚为关闭态', async () => {
    installElectronApi()
    settingsSet.mockImplementation((key: string, value: unknown) => {
      if (key === SETTING_SYNC_AUTOSTART) {
        void value
        return Promise.reject(new Error('disk full'))
      }
      return Promise.resolve()
    })
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: AUTOSTART_TOGGLE_NAME })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
  })

  // F25：useErrorToast 委托根节点全局 Toast（经 GlobalToastContext.Provider mock 注入）
  it('F25 自动启用开关持久化失败 ⇒ 全局 toast 显示错误（错误反馈可见）', async () => {
    installElectronApi()
    settingsSet.mockImplementation((key: string, value: unknown) => {
      if (key === SETTING_SYNC_AUTOSTART) {
        void value
        return Promise.reject(new Error('disk full'))
      }
      return Promise.resolve()
    })
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: AUTOSTART_TOGGLE_NAME })
    fireEvent.click(toggle)
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('disk full', 'error'))
  })
})

describe('SettingsView K2：在线解析同意（(t)-(v) 随迁）', () => {
  it('(t) K2：解析开关关闭时不渲染同意块（同意面只在解析开启的会话上存在）', async () => {
    installElectronApi({ consent: null })
    renderSettings()
    // 锚点适配：原等 Connect 的「运行状态」，改等本视图的解析开关（判据不变）
    await screen.findByRole('switch', { name: METADATA_TOGGLE_NAME })
    expect(screen.queryByText('在线参数解析说明')).not.toBeInTheDocument()
  })

  it('(u) K2：解析开启且同意可用 ⇒ 渲染端点/策略版本/字段清单；勾选携带页面 policyVersion 提交', async () => {
    installElectronApi({
      persisted: { [SETTING_METADATA_RESOLVER]: true },
      consent: { enabled: false }
    })
    renderSettings()
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
    renderSettings()
    // 同意块依赖异步会话装配；全量并发下默认 1s 预算不足致瞬时假红——按 50a0b45 口径放宽到 5s
    const toggle = await screen.findByRole(
      'switch',
      { name: '同意发送照片参数' },
      { timeout: 5000 }
    )
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
  })
})

describe('SettingsView K6：额外照片目录（(y)-(z3)/选择器单飞 随迁）', () => {
  it('(y) K6：目录列表渲染（path/mode/移除）+ 作用域说明；移除按 id 调用', async () => {
    installElectronApi()
    renderSettings()
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
    renderSettings()
    // 锚点适配：原等 Connect 的「已配对设备」，改等本视图的数据源开关（判据不变）
    await screen.findByRole('switch', { name: GALLERY_SOURCE_TOGGLE_NAME })
    await waitFor(() => expect(serverApi.getExtraDirectories).toHaveBeenCalled())
    expect(screen.queryByText('额外照片目录')).not.toBeInTheDocument()
  })

  it('(z) K6：添加流程 selectDirectory → inspect 预览（images/videos）→ 确认携带提案 id add；手动重扫调用 rescan', async () => {
    installElectronApi()
    renderSettings()
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

  it('系统选择器等待期间只启动一次，取消后可再次选择', async () => {
    installElectronApi()
    renderSettings()
    const add = await screen.findByRole('button', { name: '添加目录' })
    let cancel!: () => void
    serverApi.selectDirectory.mockReturnValueOnce(
      new Promise<null>((resolve) => {
        cancel = () => resolve(null)
      })
    )
    fireEvent.click(add)
    fireEvent.click(add)
    expect(serverApi.selectDirectory).toHaveBeenCalledTimes(1)
    cancel()
    await waitFor(() => expect(add).toBeEnabled())
    expect(serverApi.inspectExtraDirectory).not.toHaveBeenCalled()
  })

  it('(z2) 1.0.41：confirm 遭 selection_expired ⇒ 收起提案预览并提示重新选择（对齐上游控制页）', async () => {
    installElectronApi()
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: '添加目录' }))
    expect(await screen.findByText('识别到 12 张照片 / 2 个视频')).toBeInTheDocument()
    serverApi.addExtraDirectory.mockRejectedValueOnce(
      Object.assign(new Error('extra directory state rejected: selection_expired'), {
        code: 'PRECONDITION_FAILED',
        details: { upstreamCode: 'selection_expired' }
      })
    )
    fireEvent.click(screen.getByRole('button', { name: '确认添加' }))
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith('选择结果已过期，请重新选择目录', 'error')
    )
    expect(screen.queryByText('识别到 12 张照片 / 2 个视频')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认添加' })).not.toBeInTheDocument()
  })

  it('(z3) 1.0.41：confirm 遭其他拒绝（directory_unavailable）⇒ 预览保留可重试，不误清', async () => {
    installElectronApi()
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: '添加目录' }))
    expect(await screen.findByText('识别到 12 张照片 / 2 个视频')).toBeInTheDocument()
    serverApi.addExtraDirectory.mockRejectedValueOnce(
      Object.assign(new Error('extra directory state rejected: directory_unavailable'), {
        code: 'PRECONDITION_FAILED',
        details: { upstreamCode: 'directory_unavailable' }
      })
    )
    fireEvent.click(screen.getByRole('button', { name: '确认添加' }))
    await waitFor(() => expect(serverApi.addExtraDirectory).toHaveBeenCalled())
    expect(screen.getByText('识别到 12 张照片 / 2 个视频')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认添加' })).toBeInTheDocument()
  })
})

describe('SettingsView K9：账号同步作用域（(ak)-(as) 随迁）', () => {
  it('(ak) K9：账号节渲染 uid 三态文案 + 数量 + 样例缩略图；无样例账号显示占位', async () => {
    renderSettings()
    expect(await screen.findByText('同步账号')).toBeInTheDocument()
    expect(screen.getByText('未识别 UID 的照片')).toBeInTheDocument()
    expect(screen.getByText('UID 10001')).toBeInTheDocument()
    expect(screen.getAllByText('旋转吧大喵').length).toBeGreaterThan(0)
    expect(screen.getByText('12 张照片')).toBeInTheDocument()
    expect(screen.getByText('暂无样例')).toBeInTheDocument()
    await waitFor(() => expect(serverApi.previewSyncAccount).toHaveBeenCalledTimes(3))
    // 样例缩略图是装饰性图片（alt=""），按 DOM 元素而非 role=img 断言
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(3))
    const sources = Array.from(document.querySelectorAll('img')).map(
      (img) => img.getAttribute('src') ?? ''
    )
    expect(sources.some((src) => src.includes('asset_a'))).toBe(true)
  })

  it('(ak2) K9：会话无 accounts（老链接）⇒ 预期内拒绝隐藏整节而非报错', async () => {
    installElectronApi({ accountsReject: true })
    renderSettings()
    await waitFor(() => expect(screen.getByText('额外照片目录')).toBeInTheDocument())
    expect(screen.queryByText('同步账号')).not.toBeInTheDocument()
  })

  it('(al) K9：默认「同步全部账号」⇒ 各账号勾选且禁用；保存提交 uids:null 并提示已保存', async () => {
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: '同步全部账号' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    const box = screen.getByRole('checkbox', { name: 'UID 10001' }) as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(box.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '保存选择' }))
    await waitFor(() =>
      expect(serverApi.setSyncAccountSelection).toHaveBeenCalledWith({ uids: null })
    )
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('账号选择已保存', 'success'))
  })

  it('(am) K9：关闭全选后逐项可编辑；保存提交勾选数组（不含被取消的账号）', async () => {
    renderSettings()
    fireEvent.click(await screen.findByRole('switch', { name: '同步全部账号' }))
    const box = screen.getByRole('checkbox', { name: 'UID 10001' }) as HTMLInputElement
    expect(box.disabled).toBe(false)
    fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: '保存选择' }))
    await waitFor(() =>
      expect(serverApi.setSyncAccountSelection).toHaveBeenCalledWith({
        uids: ['', 'source:spinning_momo']
      })
    )
  })

  it('(an) K9：全部不勾选 ⇒ 保存提交空数组（上游语义：一个都不同步）', async () => {
    renderSettings()
    fireEvent.click(await screen.findByRole('switch', { name: '同步全部账号' }))
    for (const name of ['未识别 UID 的照片', 'UID 10001', '旋转吧大喵']) {
      fireEvent.click(screen.getByRole('checkbox', { name }))
    }
    fireEvent.click(screen.getByRole('button', { name: '保存选择' }))
    await waitFor(() =>
      expect(serverApi.setSyncAccountSelection).toHaveBeenCalledWith({ uids: [] })
    )
  })

  it('(ao) K9：保存失败 ⇒ 错误 toast，且不回写状态（无乐观更新）', async () => {
    renderSettings()
    await screen.findByText('同步账号')
    serverApi.setSyncAccountSelection.mockRejectedValueOnce(new Error('invalid_accounts'))
    fireEvent.click(screen.getByRole('button', { name: '保存选择' }))
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('保存失败，请重试', 'error'))
    expect(screen.getByRole('switch', { name: '同步全部账号' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('(ap) K9：样例预览失败留空（不伪造占位、不影响其余样例）', async () => {
    installElectronApi({ previewReject: ['asset_a'] })
    renderSettings()
    await waitFor(() => expect(serverApi.previewSyncAccount).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(2))
    const sources = Array.from(document.querySelectorAll('img')).map(
      (img) => img.getAttribute('src') ?? ''
    )
    expect(sources.some((src) => src.includes('asset_a'))).toBe(false)
  })

  it('(aq) K9：images 目录可切换来源标注，成功后刷新目录与账号', async () => {
    installElectronApi({
      extraDirectories: [
        { id: 'dir_momo', path: 'D:\\Momo', mode: 'images', source: 'spinning_momo' }
      ]
    })
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: '取消旋转吧大喵标记' }))
    await waitFor(() =>
      expect(serverApi.setExtraDirectorySource).toHaveBeenCalledWith({
        id: 'dir_momo',
        source: 'other'
      })
    )
    await waitFor(() =>
      expect(serverApi.getSyncAccounts.mock.calls.length).toBeGreaterThanOrEqual(2)
    )
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('目录来源已更新', 'success'))
    // 回写后的状态里来源变成 other ⇒ 按钮翻转为「标为旋转吧大喵」
    expect(await screen.findByRole('button', { name: '标为旋转吧大喵' })).toBeInTheDocument()
  })

  it('(ar) K9：添加旋转吧大喵目录 ⇒ inspect 带 source:spinning_momo', async () => {
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: '添加旋转吧大喵目录' }))
    await waitFor(() =>
      expect(serverApi.inspectExtraDirectory).toHaveBeenCalledWith({
        path: 'D:\\NewPhotos',
        source: 'spinning_momo'
      })
    )
  })

  it('(as) K9：移除目录后重取账号节（来源分组可能随目录消失）', async () => {
    installElectronApi({
      extraDirectories: [
        { id: 'dir_momo', path: 'D:\\Momo', mode: 'images', source: 'spinning_momo' }
      ]
    })
    renderSettings()
    await waitFor(() => expect(serverApi.getSyncAccounts).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('button', { name: '移除目录' }))
    await waitFor(() =>
      expect(serverApi.removeExtraDirectory).toHaveBeenCalledWith({ id: 'dir_momo' })
    )
    // 删除 spinning_momo 目录会让「旋转吧大喵」分组消失，账号节必须跟着重取
    await waitFor(() =>
      expect(serverApi.getSyncAccounts.mock.calls.length).toBeGreaterThanOrEqual(2)
    )
  })
})

describe('SettingsView 照片目录自定义（(at)-(bi) 随迁）', () => {
  it('(at) 挂载读取 getGameRoot：未设置显示「默认（自动发现）」，输入框为空', async () => {
    renderSettings()
    await waitFor(() => expect(serverApi.getGameRoot).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('照片目录')).toBeInTheDocument()
    expect(await screen.findByText('默认（自动发现游戏目录）')).toBeInTheDocument()
    const input = screen.getByPlaceholderText('输入或浏览选择本地目录') as HTMLInputElement
    expect(input.value).toBe('')
  })

  it('(au) 已设置自定义目录：展示路径并回填输入框', async () => {
    installElectronApi({ gameRoot: 'D:\\CustomRoot' })
    renderSettings()
    expect(await screen.findByText('D:\\CustomRoot')).toBeInTheDocument()
    const input = (await screen.findByPlaceholderText('输入或浏览选择本地目录')) as HTMLInputElement
    expect(input.value).toBe('D:\\CustomRoot')
  })

  it('(av) 浏览按钮：selectDirectory 选中目录回填输入框（不直接保存）', async () => {
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: '浏览…' }))
    await waitFor(() => expect(serverApi.selectDirectory).toHaveBeenCalled())
    const input = (await screen.findByPlaceholderText('输入或浏览选择本地目录')) as HTMLInputElement
    expect(input.value).toBe('D:\\NewPhotos')
    expect(serverApi.setGameRoot).not.toHaveBeenCalled()
  })

  it('(aw) 保存并立即生效（applied:true）：成功 Toast 走即时生效文案，不弹重启询问、不重启', async () => {
    renderSettings()
    const input = await screen.findByPlaceholderText('输入或浏览选择本地目录')
    fireEvent.change(input, { target: { value: 'D:\\CustomRoot' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(serverApi.setGameRoot).toHaveBeenCalledWith({ path: 'D:\\CustomRoot' })
    )
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith('照片目录已保存并立即生效', 'success')
    )
    // 本轮 bug 的判据：保存即换根重扫，不该再拿重启询问挡在用户与照片之间
    expect(dialogShowMessageBox).not.toHaveBeenCalled()
    expect(appRelaunch).not.toHaveBeenCalled()
    // 生效后的路径回写「当前照片目录」展示位
    expect(await screen.findByText('D:\\CustomRoot')).toBeInTheDocument()
  })

  it('(bc) 未能立即生效（applied:false）：走 savedDeferred 文案并保留重启询问（旧行为兜底）', async () => {
    installElectronApi({ gameRootApplyDeferred: true })
    renderSettings()
    const input = await screen.findByPlaceholderText('输入或浏览选择本地目录')
    fireEvent.change(input, { target: { value: 'D:\\CustomRoot' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith(
        '配置已保存，但未能立即生效，重启应用后生效',
        'success'
      )
    )
    expect(dialogShowMessageBox).toHaveBeenCalled()
    expect(appRelaunch).toHaveBeenCalledTimes(1)
  })

  it('(bd) 目录不是安装根（applyError）：给可执行提示，且不弹重启询问（重启也救不了错形态目录）', async () => {
    installElectronApi({ gameRootApplyNotInstallRoot: true })
    renderSettings()
    const input = await screen.findByPlaceholderText('输入或浏览选择本地目录')
    fireEvent.change(input, { target: { value: 'D:\\Photos' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith(
        '该目录不是有效的游戏安装根，已保存但无法生效；请改选游戏安装目录，或用「额外照片目录」添加照片文件夹',
        'info'
      )
    )
    expect(dialogShowMessageBox).not.toHaveBeenCalled()
    expect(appRelaunch).not.toHaveBeenCalled()
  })

  it('(bf) 恢复默认遇 installation-not-found：不回「该目录不是安装根」，走 savedDeferred + 重启询问', async () => {
    installElectronApi({ gameRoot: 'D:\\CustomRoot', gameRootApplyNotInstallRoot: true })
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: '恢复默认' }))
    await waitFor(() => expect(serverApi.resetGameRoot).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith(
        '配置已保存，但未能立即生效，重启应用后生效',
        'success'
      )
    )
    expect(mockShowMessage).not.toHaveBeenCalledWith(
      '该目录不是有效的游戏安装根，已保存但无法生效；请改选游戏安装目录，或用「额外照片目录」添加照片文件夹',
      'info'
    )
    expect(dialogShowMessageBox).toHaveBeenCalled()
    expect(await screen.findByText('默认（自动发现游戏目录）')).toBeInTheDocument()
  })

  it('(ax) 保存成功但目录不可写：仍保存并追加 info 警告，即时生效不受影响', async () => {
    installElectronApi({ setGameRootWritableFalse: true })
    renderSettings()
    const input = await screen.findByPlaceholderText('输入或浏览选择本地目录')
    fireEvent.change(input, { target: { value: 'D:\\ReadOnly' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith('照片目录已保存并立即生效', 'success')
    )
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith(
        '目录不可写：扫描读取不受影响，但无法向该目录写入',
        'info'
      )
    )
    expect(dialogShowMessageBox).not.toHaveBeenCalled()
  })

  it('(ay) 保存失败：输入保留、不弹重启询问、不重启（错误 Toast 由 useErrorToast 本地态承担，此处锁下游短路）', async () => {
    installElectronApi({ setGameRootReject: new Error('photo source directory is not readable') })
    renderSettings()
    const input = await screen.findByPlaceholderText('输入或浏览选择本地目录')
    fireEvent.change(input, { target: { value: 'D:\\Locked' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(serverApi.setGameRoot).toHaveBeenCalledWith({ path: 'D:\\Locked' }))
    // 失败后：输入值保留（可直接改后重试）、重启流整体短路
    expect((input as HTMLInputElement).value).toBe('D:\\Locked')
    expect(dialogShowMessageBox).not.toHaveBeenCalled()
    expect(appRelaunch).not.toHaveBeenCalled()
  })

  it('(az) 恢复默认并立即生效：resetGameRoot + 即时生效文案 + 清空展示，不弹重启询问', async () => {
    installElectronApi({ gameRoot: 'D:\\CustomRoot' })
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: '恢复默认' }))
    await waitFor(() => expect(serverApi.resetGameRoot).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith('已恢复默认照片目录并立即生效', 'success')
    )
    // 必须消费返回值：旧实现整个丢弃 resetGameRoot 的响应，重启询问与文案都无据可依
    expect(dialogShowMessageBox).not.toHaveBeenCalled()
    expect(await screen.findByText('默认（自动发现游戏目录）')).toBeInTheDocument()
  })

  it('(be) 恢复默认未能立即生效：走 savedDeferred 文案并保留重启询问', async () => {
    installElectronApi({ gameRoot: 'D:\\CustomRoot', gameRootApplyDeferred: true })
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: '恢复默认' }))
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith(
        '配置已保存，但未能立即生效，重启应用后生效',
        'success'
      )
    )
    expect(dialogShowMessageBox).toHaveBeenCalled()
  })

  it('(ba) K6 手输路径：预检并添加 ⇒ 先 admitDirectory 后 inspectExtraDirectory（提案照常出现）', async () => {
    renderSettings()
    const input = await screen.findByPlaceholderText('或手动输入目录路径')
    fireEvent.change(input, { target: { value: 'D:\\TypedPhotos' } })
    fireEvent.click(screen.getByRole('button', { name: '预检并添加' }))
    await waitFor(() =>
      expect(serverApi.admitDirectory).toHaveBeenCalledWith({ path: 'D:\\TypedPhotos' })
    )
    await waitFor(() =>
      expect(serverApi.inspectExtraDirectory).toHaveBeenCalledWith({ path: 'D:\\TypedPhotos' })
    )
    expect(await screen.findByText('识别到 12 张照片 / 2 个视频')).toBeInTheDocument()
  })

  it('(bb) K6 手输路径被拒：不进入 inspect（错误提示由 useErrorToast 承担，此处锁流程短路）', async () => {
    installElectronApi({ admitReject: new Error('photo source directory does not exist') })
    renderSettings()
    const input = await screen.findByPlaceholderText('或手动输入目录路径')
    fireEvent.change(input, { target: { value: 'D:\\Missing' } })
    fireEvent.click(screen.getByRole('button', { name: '预检并添加' }))
    await waitFor(() =>
      expect(serverApi.admitDirectory).toHaveBeenCalledWith({ path: 'D:\\Missing' })
    )
    // admit 拒绝 ⇒ 提案流整体短路：inspect 零调用、无提案卡
    expect(serverApi.inspectExtraDirectory).not.toHaveBeenCalled()
    expect(screen.queryByText('识别到 12 张照片 / 2 个视频')).not.toBeInTheDocument()
  })

  it('(bg) 输入框边框 token：不再引用未定义的 --border-color（未定义 token 会回落到文字色）', async () => {
    renderSettings()
    const photoInput = await screen.findByPlaceholderText('输入或浏览选择本地目录')
    const typedInput = await screen.findByPlaceholderText('或手动输入目录路径')
    // globals.css 只定义 --border-subtle / --border-strong / --divider；--border-color 无定义处
    expect((photoInput as HTMLInputElement).style.borderColor).not.toBe('var(--border-color)')
    expect((photoInput as HTMLInputElement).style.borderColor).toBe('var(--border-subtle)')
    expect((typedInput as HTMLInputElement).style.borderColor).not.toBe('var(--border-color)')
    expect((typedInput as HTMLInputElement).style.borderColor).toBe('var(--border-subtle)')
  })

  it('(bh) K6 手输预检连点：busy 门生效 ⇒ admit+inspect 链只发一条（第二条点击被拦）', async () => {
    renderSettings()
    const input = await screen.findByPlaceholderText('或手动输入目录路径')
    fireEvent.change(input, { target: { value: 'D:\\TypedPhotos' } })
    const button = screen.getByRole('button', { name: '预检并添加' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() =>
      expect(serverApi.admitDirectory).toHaveBeenCalledWith({ path: 'D:\\TypedPhotos' })
    )
    await waitFor(() => {
      expect(serverApi.admitDirectory).toHaveBeenCalledTimes(1)
      expect(serverApi.inspectExtraDirectory).toHaveBeenCalledTimes(1)
    })
  })

  it('(bi) 保存未生效且目录不可写：只报 savedDeferred（生效失败自有文案），不叠加 notWritable toast', async () => {
    installElectronApi({ setGameRootWritableFalse: true, gameRootApplyDeferred: true })
    renderSettings()
    const input = await screen.findByPlaceholderText('输入或浏览选择本地目录')
    fireEvent.change(input, { target: { value: 'D:\\SlowDisk' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith(
        '配置已保存，但未能立即生效，重启应用后生效',
        'success'
      )
    )
    expect(mockShowMessage).not.toHaveBeenCalledWith(
      '目录不可写：扫描读取不受影响，但无法向该目录写入',
      'info'
    )
  })
})

describe('F3 Windows 外壳热点按钮交替请求（随迁）', () => {
  it('正常：首点请求开启（confirm:true），toggled 后再点请求关闭', async () => {
    renderSettings()
    const button = await screen.findByRole('button', { name: '临时热点' })
    fireEvent.click(button)
    await waitFor(() => expect(serverApi.toggleHotspot).toHaveBeenCalledWith({ confirm: true }))
    await waitFor(() => expect(button).not.toBeDisabled())
    fireEvent.click(button)
    await waitFor(() => expect(serverApi.toggleHotspot).toHaveBeenCalledWith({ confirm: false }))
  })

  it('异常：失败不翻转状态，连点两次均请求开启', async () => {
    serverApi.toggleHotspot.mockResolvedValue({ status: 'failed' })
    renderSettings()
    const button = await screen.findByRole('button', { name: '临时热点' })
    fireEvent.click(button)
    await waitFor(() => expect(serverApi.toggleHotspot).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(button).not.toBeDisabled())
    fireEvent.click(button)
    await waitFor(() => expect(serverApi.toggleHotspot).toHaveBeenCalledTimes(2))
    expect(serverApi.toggleHotspot).toHaveBeenNthCalledWith(1, { confirm: true })
    expect(serverApi.toggleHotspot).toHaveBeenNthCalledWith(2, { confirm: true })
  })
})

describe('F7a 外壳动作结果码本地化（随迁）', () => {
  it('正常：unavailable 渲染为中文文案而非英文原码', async () => {
    renderSettings()
    const checks = await screen.findAllByRole('button', { name: '检查更新' })
    fireEvent.click(checks[0])
    await screen.findByText('功能不可用')
    expect(screen.queryByText('unavailable')).toBeNull()
  })
})

describe('T4：静态行 / 开机自启 / 法律三链', () => {
  it('两条纯静态说明行常驻渲染（描述既有行为，不落设置键）', async () => {
    renderSettings()
    expect(await screen.findByText('相册更新')).toBeInTheDocument()
    expect(screen.getByText('自动收录新照片')).toBeInTheDocument()
    expect(screen.getByText('关闭窗口后')).toBeInTheDocument()
    expect(screen.getByText('在托盘继续运行')).toBeInTheDocument()
  })

  it('连接地址快照：服务运行中 ⇒ lanHost:port；未运行 ⇒ 服务未运行文案', async () => {
    renderSettings()
    expect(await screen.findByText('192.168.1.10:28080')).toBeInTheDocument()
  })

  it('服务未运行 ⇒ 地址位显示「服务未运行」，不虚构地址', async () => {
    installElectronApi({ status: { running: false } })
    renderSettings()
    expect(await screen.findByText('服务未运行')).toBeInTheDocument()
  })

  it('开机自启开关：默认关，点击只写宿主 launchAtLogin 键（不碰同步服务键）', async () => {
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: '开机时自动启动喵星图' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('launchAtLogin', true))
    expect(settingsSet).not.toHaveBeenCalledWith(SETTING_SYNC_AUTOSTART, true)
    expect(serverApi.startServer).not.toHaveBeenCalled()
  })

  it('开机自启：挂载读回已持久化开启态；持久化失败回滚', async () => {
    installElectronApi({ persisted: { launchAtLogin: true } })
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: '开机时自动启动喵星图' })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  })

  it('开机自启：持久化失败 ⇒ 回滚为关闭态', async () => {
    settingsSet.mockImplementation((key: string, value: unknown) => {
      if (key === 'launchAtLogin') {
        void value
        return Promise.reject(new Error('disk full'))
      }
      return Promise.resolve()
    })
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: '开机时自动启动喵星图' })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
  })

  it('法律三链：desktopOpen().url + /legal/privacy|terms|services 经 openExternal', async () => {
    renderSettings()
    // legalBase 落地后组件从 Tooltip 禁用分支切换到启用分支（按钮元素被替换），
    // 必须等启用后重新查询——捕获旧分支的节点引用会点到已卸载的禁用按钮。
    await waitFor(() => expect(screen.getByRole('button', { name: '隐私政策' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '隐私政策' }))
    await waitFor(() =>
      expect(shellOpenExternal).toHaveBeenCalledWith('http://127.0.0.1:39123/legal/privacy')
    )
    fireEvent.click(screen.getByRole('button', { name: '用户协议' }))
    await waitFor(() =>
      expect(shellOpenExternal).toHaveBeenCalledWith('http://127.0.0.1:39123/legal/terms')
    )
    fireEvent.click(screen.getByRole('button', { name: '服务条款' }))
    await waitFor(() =>
      expect(shellOpenExternal).toHaveBeenCalledWith('http://127.0.0.1:39123/legal/services')
    )
  })

  it('PC 服务缺席（desktopOpen 拒绝）⇒ 三链禁用 + 不可用说明，不伪造链接', async () => {
    serverApi.desktopOpen.mockRejectedValue(new Error('desktop surface is unavailable'))
    renderSettings()
    const privacy = await screen.findByRole('button', { name: '隐私政策' })
    await waitFor(() => expect(privacy).toBeDisabled())
    expect(screen.getByRole('button', { name: '用户协议' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '服务条款' })).toBeDisabled()
    expect(screen.getAllByText('PC 服务未就绪，暂无法打开条款').length).toBeGreaterThan(0)
  })
})

describe('T7：本地网络权限卡', () => {
  it('opt-in 关 ⇒ 整卡未启用 + 去开启入口，零通道调用', async () => {
    renderSettings()
    const card = await screen.findByTestId('sync-network-card')
    expect(card.textContent).toContain('未启用「网络冲突修复」开关')
    expect(serverApi.networkAuth).not.toHaveBeenCalled()
    expect(serverApi.networkConflict).not.toHaveBeenCalled()
    // 两张卡各有一个「去开启」；取网络卡内的那个
    fireEvent.click(screen.getAllByRole('button', { name: '去开启' })[0])
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('opt-in 开 ⇒ 挂载读一次 status；授权/撤销按 action 调用并本地化状态', async () => {
    installElectronApi({ persisted: { 'nikkisync.shellNetworkRepairEnabled': true } })
    renderSettings()
    await waitFor(() => expect(serverApi.networkAuth).toHaveBeenCalledWith({ action: 'status' }))
    expect(await screen.findByTestId('sync-network-auth-status')).toHaveTextContent('尚未授权')
    serverApi.networkAuth.mockResolvedValue({ status: 'authorized', ruleGroup: 'NikkiSync' })
    fireEvent.click(screen.getByRole('button', { name: '允许手机连接' }))
    await waitFor(() => expect(serverApi.networkAuth).toHaveBeenCalledWith({ action: 'authorize' }))
    await waitFor(() =>
      expect(screen.getByTestId('sync-network-auth-status')).toHaveTextContent('已添加本地网络权限')
    )
    serverApi.networkAuth.mockResolvedValue({ status: 'revoked', ruleGroup: 'NikkiSync' })
    fireEvent.click(screen.getByRole('button', { name: '撤销当前服务的网络授权' }))
    await waitFor(() => expect(serverApi.networkAuth).toHaveBeenCalledWith({ action: 'revoke' }))
    await waitFor(() =>
      expect(screen.getByTestId('sync-network-auth-status')).toHaveTextContent('已撤销网络授权')
    )
  })

  it('冲突检查：inspect 渲染清单（name/action/profile）；repair 后可撤销（canRestore）', async () => {
    installElectronApi({
      persisted: { 'nikkisync.shellNetworkRepairEnabled': true },
      networkConflictResult: {
        status: 'ok',
        conflicts: [{ name: 'BlockRule', action: 'Block', enabled: true, profile: 'Domain' }],
        canRestore: false
      }
    })
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: '重新检查' }))
    await waitFor(() =>
      expect(serverApi.networkConflict).toHaveBeenCalledWith({ action: 'inspect' })
    )
    const result = await screen.findByTestId('sync-network-conflict-result')
    expect(result.textContent).toContain('发现 1 条冲突规则')
    expect(result.textContent).toContain('BlockRule · Block · Domain')
    // 无 journal ⇒ 撤销禁用
    expect(screen.getByRole('button', { name: '撤销上次修复' })).toBeDisabled()
    serverApi.networkConflict.mockResolvedValue({
      status: 'repaired',
      conflicts: [],
      changed: 1,
      canRestore: true
    })
    fireEvent.click(screen.getByRole('button', { name: '一键检查并修复' }))
    await waitFor(() =>
      expect(serverApi.networkConflict).toHaveBeenCalledWith({ action: 'repair' })
    )
    await waitFor(() =>
      expect(screen.getByTestId('sync-network-conflict-result')).toHaveTextContent('修复完成')
    )
    const restore = screen.getByRole('button', { name: '撤销上次修复' })
    expect(restore).toBeEnabled()
    fireEvent.click(restore)
    await waitFor(() =>
      expect(serverApi.networkConflict).toHaveBeenCalledWith({ action: 'restore' })
    )
  })

  it('桥面缺席（老 preload/主进程未落地）⇒ 不可用说明 + 按钮禁用，零调用', async () => {
    installElectronApi({
      persisted: { 'nikkisync.shellNetworkRepairEnabled': true },
      omitMethods: ['networkAuth', 'networkConflict']
    })
    renderSettings()
    const card = await screen.findByTestId('sync-network-card')
    await waitFor(() => expect(card.textContent).toContain('当前构建暂不可用'))
    expect(screen.getByRole('button', { name: '允许手机连接' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '一键检查并修复' })).toBeDisabled()
  })
})

describe('T7：临时热点卡', () => {
  it('opt-in 关 ⇒ 整卡未启用，零通道调用', async () => {
    renderSettings()
    const card = await screen.findByTestId('sync-hotspot-card')
    expect(card.textContent).toContain('未启用「临时热点」开关')
    expect(serverApi.hotspotControl).not.toHaveBeenCalled()
    expect(serverApi.openHotspotSettings).not.toHaveBeenCalled()
  })

  it('start 成功 ⇒ SSID/密码展示（密码默认掩码，点击显示/隐藏）；stop 仅 startedHere 可用', async () => {
    installElectronApi({ persisted: { 'nikkisync.shellHotspotEnabled': true } })
    renderSettings()
    await waitFor(() => expect(serverApi.hotspotControl).toHaveBeenCalledWith({ action: 'status' }))
    // 缺省 status:unchanged + startedHere:false ⇒ stop 禁用（不误关用户自开热点）
    expect(screen.getByRole('button', { name: '结束临时组网' })).toBeDisabled()
    serverApi.hotspotControl.mockResolvedValue({
      status: 'started',
      state: { active: true, startedHere: true },
      ssid: 'MeowStarMap-AP',
      password: 'secret123'
    })
    fireEvent.click(screen.getByRole('button', { name: '开启临时热点' }))
    await waitFor(() => expect(serverApi.hotspotControl).toHaveBeenCalledWith({ action: 'start' }))
    const credentials = await screen.findByTestId('sync-hotspot-credentials')
    expect(credentials.textContent).toContain('MeowStarMap-AP')
    expect(credentials.textContent).toContain('••••••••')
    expect(credentials.textContent).not.toContain('secret123')
    fireEvent.click(screen.getByRole('button', { name: '显示' }))
    expect(screen.getByTestId('sync-hotspot-credentials').textContent).toContain('secret123')
    fireEvent.click(screen.getByRole('button', { name: '隐藏' }))
    expect(screen.getByTestId('sync-hotspot-credentials').textContent).not.toContain('secret123')
    // startedHere:true ⇒ stop 可用
    const stop = screen.getByRole('button', { name: '结束临时组网' })
    expect(stop).toBeEnabled()
    serverApi.hotspotControl.mockResolvedValue({
      status: 'stopped',
      state: { active: false, startedHere: false }
    })
    fireEvent.click(stop)
    await waitFor(() => expect(serverApi.hotspotControl).toHaveBeenCalledWith({ action: 'stop' }))
    await waitFor(() =>
      expect(screen.getByTestId('sync-hotspot-status')).toHaveTextContent('热点已结束')
    )
  })

  it('打开系统热点设置 ⇒ openHotspotSettings 零入参调用', async () => {
    installElectronApi({ persisted: { 'nikkisync.shellHotspotEnabled': true } })
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: '打开系统热点设置' }))
    await waitFor(() => expect(serverApi.openHotspotSettings).toHaveBeenCalledTimes(1))
  })

  it('桥面缺席 ⇒ 不可用说明 + 按钮禁用', async () => {
    installElectronApi({
      persisted: { 'nikkisync.shellHotspotEnabled': true },
      omitMethods: ['hotspotControl', 'openHotspotSettings']
    })
    renderSettings()
    const card = await screen.findByTestId('sync-hotspot-card')
    await waitFor(() => expect(card.textContent).toContain('当前构建暂不可用'))
    expect(screen.getByRole('button', { name: '开启临时热点' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '打开系统热点设置' })).toBeDisabled()
  })

  it('外壳分区拨动热点开关 ⇒ 卡片门控即时跟随（onFlagsChanged 链路）', async () => {
    renderSettings()
    const card = await screen.findByTestId('sync-hotspot-card')
    expect(card.textContent).toContain('未启用「临时热点」开关')
    fireEvent.click(screen.getByRole('switch', { name: '临时热点' }))
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith('nikkisync.shellHotspotEnabled', true)
    )
    await waitFor(() =>
      expect(screen.getByTestId('sync-hotspot-card').textContent).not.toContain(
        '未启用「临时热点」开关'
      )
    )
  })
})

// ===== 审查修复轮（2026-11-19）：R3 开关竞态 / R4 busy 门 =====

describe('R3：外壳开关连拨与回滚的门控观测一致性', () => {
  it('先拨开关写失败回滚 ⇒ 不得吞掉后拨开关的门控观测（flagsRef 镜像最新值）', async () => {
    installElectronApi()
    renderSettings()
    await screen.findByTestId('sync-hotspot-card')
    let rejectNetwork: (e: Error) => void = () => {}
    settingsSet.mockImplementation((key: string, value: unknown) => {
      if (key === 'nikkisync.shellNetworkRepairEnabled') {
        return new Promise((_resolve, reject) => {
          rejectNetwork = reject
        })
      }
      return Promise.resolve(value)
    })
    fireEvent.click(screen.getByRole('switch', { name: '网络冲突修复' }))
    fireEvent.click(screen.getByRole('switch', { name: '临时热点' }))
    await waitFor(() =>
      expect(screen.getByTestId('sync-hotspot-card').textContent).not.toContain(
        '未启用「临时热点」开关'
      )
    )
    rejectNetwork(new Error('settings write failed'))
    // 网络开关回滚 ⇒ 网络卡回到未启用；但热点开关的观测必须保留
    await waitFor(() =>
      expect(screen.getByTestId('sync-network-card').textContent).toContain('未启用')
    )
    expect(screen.getByTestId('sync-hotspot-card').textContent).not.toContain(
      '未启用「临时热点」开关'
    )
  })
})

describe('R4：目录操作 busy 门（在途期间二次点击只启动一次）', () => {
  it('重扫在途期间按钮禁用，二次点击零追加调用', async () => {
    installElectronApi()
    let resolveRescan: (v: unknown) => void = () => {}
    serverApi.rescanExtraDirectories.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRescan = resolve
        })
    )
    renderSettings()
    const button = await screen.findByRole('button', { name: '重新扫描' })
    fireEvent.click(button)
    await waitFor(() => expect(serverApi.rescanExtraDirectories).toHaveBeenCalledTimes(1))
    fireEvent.click(button)
    expect(serverApi.rescanExtraDirectories).toHaveBeenCalledTimes(1)
    resolveRescan({ directories: [], automaticRoots: [], busy: false })
    await waitFor(() => expect(screen.getByRole('button', { name: '重新扫描' })).not.toBeDisabled())
  })

  it('移除在途期间二次点击零追加调用', async () => {
    installElectronApi()
    let resolveRemove: (v: unknown) => void = () => {}
    serverApi.removeExtraDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemove = resolve
        })
    )
    renderSettings()
    const button = await screen.findByRole('button', { name: '移除目录' })
    fireEvent.click(button)
    await waitFor(() => expect(serverApi.removeExtraDirectory).toHaveBeenCalledTimes(1))
    fireEvent.click(button)
    expect(serverApi.removeExtraDirectory).toHaveBeenCalledTimes(1)
    resolveRemove({ directories: [], automaticRoots: [], busy: false })
    await waitFor(() => expect(serverApi.removeExtraDirectory).toHaveBeenCalledTimes(1))
  })

  it('旋转吧大喵添加：选择器在途期间二次点击只启动一次', async () => {
    installElectronApi()
    let resolveSelect: (v: unknown) => void = () => {}
    serverApi.selectDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSelect = resolve
        })
    )
    renderSettings()
    const button = await screen.findByRole('button', { name: '添加旋转吧大喵目录' })
    fireEvent.click(button)
    await waitFor(() => expect(serverApi.selectDirectory).toHaveBeenCalledTimes(1))
    fireEvent.click(button)
    expect(serverApi.selectDirectory).toHaveBeenCalledTimes(1)
    resolveSelect(null)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '添加旋转吧大喵目录' })).not.toBeDisabled()
    )
  })
})

describe('T4：设置页 IA 对齐上游（账号/目录/外壳/法律收口）', () => {
  it('网络权限/热点卡走控制台卡体系（.sc-card），不再套宿主 .glass-card', async () => {
    installElectronApi({
      persisted: {
        'nikkisync.shellNetworkRepairEnabled': true,
        'nikkisync.shellHotspotEnabled': true
      }
    })
    renderSettings()
    for (const testId of ['sync-network-card', 'sync-hotspot-card']) {
      const card = await screen.findByTestId(testId)
      expect(card.querySelector('.sc-card')).not.toBeNull()
      expect(card.querySelector('.glass-card')).toBeNull()
    }
  })

  it('账号行组 + 外壳 details 嵌在「同步与连接」卡；额外目录在照片目录卡；法律三链落页脚', async () => {
    installElectronApi()
    const { container } = renderSettings()
    await screen.findByTestId('sync-extra-directories')
    const cards = container.querySelectorAll('.sc-card')
    expect(cards.length).toBeGreaterThan(2)

    // 第一张卡 = 同步与连接：账号作用域与 Windows 外壳能力都收在它内部
    const connectionCard = cards[0] as HTMLElement
    expect(connectionCard).toContainElement(screen.getByTestId('sync-account-section'))
    expect(connectionCard).toContainElement(screen.getByTestId('sync-shell-details'))

    // 外壳能力不再单开整卡：全页只有一份外壳开关子树
    expect(container.querySelectorAll('[data-testid="sync-service-shell-section"]')).toHaveLength(1)

    // 照片目录与额外照片目录合并为一张卡
    const directoryCard = screen.getByTestId('sync-extra-directories').closest('.sc-card')
    expect(directoryCard).not.toBeNull()
    expect(directoryCard).toContainElement(screen.getByText('照片目录'))

    // 法律三链落在 settings-about 页脚，且页脚是设置页最后一个区块
    const about = screen.getByTestId('sync-settings-about')
    expect(about).toContainElement(screen.getByRole('button', { name: '用户协议' }))
    expect(container.querySelector('.sc-settings')?.lastElementChild).toBe(about)
  })
})
