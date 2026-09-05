/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/components/scanner/ScanProgress
 * @coverage scanner:complete 兜底刷新订阅 + task:progress 索引进度过滤（batch/duplicate）
 * @dependencies @testing-library/react, vitest
 * @remarks 任务 4（P1）验证：ScanProgress 挂载时订阅 scanner.onComplete，
 *   回调内统一调用 refreshMediaAfterScan 刷新媒体列表（fetchMediaFromDatabase + setMediaFiles），
 *   作为 GalleryPage 订阅链路的兜底。
 *   索引进度修复：
 *   - 过滤条件扩展到 batch/duplicate，归一显示 worker 真实进度（§2.1/2.2）
 *   - 终态清除收紧仅针对 scan/indexing（§2.3）
 *   - batch/duplicate 不覆盖取消目标 taskIdRef（§2.4）
 *   - 无 indexing 伞活动时 duplicate 不并入浮窗（§2.3 门控）
 *
 * 测试策略：ScanProgress 默认状态（scanning=false, status='idle'）返回 null，
 *   但 useEffect 仍执行订阅注册。通过 mock window.electronAPI.scanner.onComplete
 *   捕获订阅回调，主动触发回调验证刷新链路；task.onProgress 同样捕获回调，
 *   注入 batch/duplicate/indexing 进度验证过滤与归一显示。
 *
 * 注意：刷新逻辑已抽取为 mediaStore 的 refreshMediaAfterScan（ScanButton 与 ScanProgress 共用），
 *   这里 mock 该函数以验证"组件确实委托刷新"，并由 mock 内部走 fetch + set 链路保持端到端语义。
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockedFunction } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// motion/react 已在 tests/setup.ts 全局 mock

// mock TaskProgressOverlay：暴露 progress 字段与 onCancel，便于断言传入浮窗的进度与取消链路
vi.mock('../common/TaskProgressOverlay', () => ({
  TaskProgressOverlay: (props: {
    progress: TaskProgress | null
    onCancel?: () => void
    title?: string
  }) => (
    <div data-testid="task-progress-overlay">
      <span data-testid="overlay-progress">
        {props.progress
          ? `${props.progress.current}/${props.progress.total}/${props.progress.percent}`
          : 'null'}
      </span>
      {props.title ? <span data-testid="overlay-title">{props.title}</span> : null}
      {props.onCancel ? <button data-testid="overlay-cancel" onClick={props.onCancel} /> : null}
    </div>
  )
}))

// mock refreshMediaAfterScan：验证组件把"扫描后刷新"委托给它，并复用真实的 setMediaFiles 写 store
// 保留 useMediaStore 真实实现，setMediaFiles 的真实写入仍可被 spy 捕获
vi.mock('../../stores/mediaStore', async () => {
  const actual =
    await vi.importActual<typeof import('../../stores/mediaStore')>('../../stores/mediaStore')
  const fetchMock = vi.fn().mockResolvedValue({ files: [{ id: 'mock-file' }], total: 1 })
  // refreshMediaAfterScan 的 mock 行为与实际实现一致：取数成功才写 store
  const refreshMock = vi.fn(async () => {
    const res = await fetchMock()
    if (res) actual.useMediaStore.getState().setMediaFiles(res.files)
  })
  return {
    ...actual,
    fetchMediaFromDatabase: fetchMock,
    refreshMediaAfterScan: refreshMock
  }
})

// mock useGlobalToast：捕获失败 Toast 的调用（D2 修复断言对象）
const { showMessageMock } = vi.hoisted(() => ({ showMessageMock: vi.fn() }))
vi.mock('../../pages/settings/sections', () => ({
  useGlobalToast: () => showMessageMock
}))

import { ScanProgress } from './ScanProgress'
import {
  fetchMediaFromDatabase,
  useMediaStore,
  refreshMediaAfterScan
} from '../../stores/mediaStore'
import { useUIStore } from '../../stores/uiStore'
import type { TaskProgress } from '../../../shared/types/progress'

type CompleteCallback = () => void
type ProgressCallback = (progress: unknown) => void
type UnsubscribeFn = () => void
type OnCompleteFn = (cb: CompleteCallback) => UnsubscribeFn
type OnProgressFn = (cb: ProgressCallback) => UnsubscribeFn
type CancelFn = (taskId: string) => Promise<unknown>

/** 构造最小 TaskProgress 测试对象 */
const makeProgress = (overrides: Partial<TaskProgress>): TaskProgress => ({
  taskId: 'task-1',
  taskType: 'scan',
  phase: 'processing',
  current: 1,
  total: 10,
  percent: 10,
  startedAt: Date.now(),
  canCancel: true,
  ...overrides
})

describe('ScanProgress scanner:complete 兜底刷新（任务 4）', () => {
  let onCompleteCallback: CompleteCallback | null = null
  let unsubscribeSpy: UnsubscribeFn
  let onCompleteSpy: MockedFunction<OnCompleteFn>

  beforeEach(() => {
    vi.clearAllMocks()
    onCompleteCallback = null
    unsubscribeSpy = vi.fn()
    onCompleteSpy = vi.fn((cb: CompleteCallback) => {
      onCompleteCallback = cb
      return unsubscribeSpy
    })

    const onProgressSpy = vi.fn(((_cb: (progress: unknown) => void) => () => {}) as OnProgressFn)

    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      scanner: { onComplete: onCompleteSpy },
      task: { onProgress: onProgressSpy }
    }

    // 重置 mediaStore 到默认非扫描状态
    useMediaStore.setState({
      scanProgress: { scanning: false, scanned: 0, found: 0, currentPath: '', status: 'idle' }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('组件挂载时应订阅 scanner.onComplete', () => {
    render(<ScanProgress />)
    expect(onCompleteSpy).toHaveBeenCalledTimes(1)
  })

  it('组件卸载时应解绑 scanner.onComplete 订阅', () => {
    const { unmount } = render(<ScanProgress />)
    expect(onCompleteSpy).toHaveBeenCalledTimes(1)
    unmount()
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1)
  })

  it('scanner:complete 回调触发时应调用 refreshMediaAfterScan 刷新媒体列表', async () => {
    render(<ScanProgress />)
    expect(onCompleteCallback).not.toBeNull()

    // 主动触发 scanner:complete 回调
    onCompleteCallback!()

    // 等待微任务执行（refreshMediaAfterScan 是异步）
    await vi.waitFor(() => {
      expect(refreshMediaAfterScan).toHaveBeenCalled()
    })
  })

  it('scanner:complete 回调触发后应 setMediaFiles 写入刷新结果', async () => {
    const setMediaFilesSpy = vi.spyOn(useMediaStore.getState(), 'setMediaFiles')

    render(<ScanProgress />)
    onCompleteCallback!()

    await vi.waitFor(() => {
      expect(setMediaFilesSpy).toHaveBeenCalledWith([{ id: 'mock-file' }])
    })

    setMediaFilesSpy.mockRestore()
  })

  it('fetchMediaFromDatabase 返回 null（取数失败）时应静默降级、不写入且已委托刷新', async () => {
    // 生产环境 fetchMediaFromDatabase 失败返回 null（内部已记录日志），不会抛错
    vi.mocked(fetchMediaFromDatabase).mockResolvedValueOnce(null)
    const setMediaFilesSpy = vi.spyOn(useMediaStore.getState(), 'setMediaFiles')

    render(<ScanProgress />)
    // 不应抛出
    expect(() => onCompleteCallback!()).not.toThrow()

    // 组件仍委托了刷新；取数失败则不应写 store
    await vi.waitFor(() => {
      expect(refreshMediaAfterScan).toHaveBeenCalled()
    })
    expect(setMediaFilesSpy).not.toHaveBeenCalled()

    setMediaFilesSpy.mockRestore()
  })
})

describe('ScanProgress task:progress 索引进度过滤（fix-indexing-progress）', () => {
  let onProgressCallback: ProgressCallback | null = null
  let onProgressUnsubscribeSpy: UnsubscribeFn
  let onProgressSpy: MockedFunction<OnProgressFn>
  let cancelSpy: MockedFunction<CancelFn>

  beforeEach(() => {
    vi.clearAllMocks()
    onProgressCallback = null
    onProgressUnsubscribeSpy = vi.fn()
    onProgressSpy = vi.fn((cb: ProgressCallback) => {
      onProgressCallback = cb
      return onProgressUnsubscribeSpy
    })
    cancelSpy = vi.fn().mockResolvedValue({ ok: true })

    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      scanner: { onComplete: vi.fn(() => () => {}) },
      task: { onProgress: onProgressSpy, cancel: cancelSpy }
    }

    // 重置 mediaStore 到默认非扫描状态
    useMediaStore.setState({
      scanProgress: { scanning: false, scanned: 0, found: 0, currentPath: '', status: 'idle' }
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('收到 batch（processing）且 indexing 伞活动时，浮窗渲染 worker 真实 current/total/percent', () => {
    render(<ScanProgress />)
    // 先置 indexing 伞活动（2.3 门控前提）
    act(() => {
      onProgressCallback!(
        makeProgress({
          taskId: 'indexing-1',
          taskType: 'indexing',
          phase: 'preparing',
          current: 0,
          total: 100,
          percent: 0
        })
      )
    })
    act(() => {
      onProgressCallback!(
        makeProgress({
          taskId: 'batch-1',
          taskType: 'batch',
          phase: 'processing',
          current: 123,
          total: 456,
          percent: 26
        })
      )
    })
    expect(screen.getByTestId('overlay-progress').textContent).toBe('123/456/26')
  })

  it('收到 duplicate（processing）且 indexing 伞活动时，浮窗渲染 worker 真实 current/total/percent', () => {
    render(<ScanProgress />)
    act(() => {
      onProgressCallback!(
        makeProgress({
          taskId: 'indexing-1',
          taskType: 'indexing',
          phase: 'preparing',
          current: 0,
          total: 100,
          percent: 0
        })
      )
    })
    act(() => {
      onProgressCallback!(
        makeProgress({
          taskId: 'phash-1',
          taskType: 'duplicate',
          phase: 'processing',
          current: 50,
          total: 100,
          percent: 50
        })
      )
    })
    expect(screen.getByTestId('overlay-progress').textContent).toBe('50/100/50')
  })

  it('batch 收到 done 终态且 indexing 仍在 → 不触发 1.5s 清空（浮窗不被置 null）', () => {
    vi.useFakeTimers()
    render(<ScanProgress />)
    act(() => {
      onProgressCallback!(
        makeProgress({
          taskId: 'indexing-1',
          taskType: 'indexing',
          phase: 'preparing',
          current: 0,
          total: 100,
          percent: 0
        })
      )
    })
    act(() => {
      onProgressCallback!(
        makeProgress({
          taskId: 'batch-1',
          taskType: 'batch',
          phase: 'processing',
          current: 100,
          total: 100,
          percent: 100
        })
      )
    })
    act(() => {
      onProgressCallback!(
        makeProgress({
          taskId: 'batch-1',
          taskType: 'batch',
          phase: 'done',
          current: 100,
          total: 100,
          percent: 100
        })
      )
    })
    // batch 终态是单阶段收尾，不调度 1.5s 清空；推进时间后浮窗仍在
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.queryByTestId('task-progress-overlay')).not.toBeNull()
  })

  it('indexing 终态仍触发 1.5s 后清空浮窗（对照组）', () => {
    vi.useFakeTimers()
    render(<ScanProgress />)
    act(() => {
      onProgressCallback!(
        makeProgress({
          taskId: 'indexing-1',
          taskType: 'indexing',
          phase: 'done',
          current: 100,
          total: 100,
          percent: 100
        })
      )
    })
    expect(screen.queryByTestId('task-progress-overlay')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(1600)
    })
    expect(screen.queryByTestId('task-progress-overlay')).toBeNull()
  })

  it('batch/duplicate 的 taskId 不覆盖 taskIdRef：取消仍指向 indexing 伞 taskId', async () => {
    render(<ScanProgress />)
    act(() => {
      onProgressCallback!(
        makeProgress({
          taskId: 'indexing-1',
          taskType: 'indexing',
          phase: 'preparing',
          current: 0,
          total: 100,
          percent: 0
        })
      )
    })
    act(() => {
      onProgressCallback!(
        makeProgress({
          taskId: 'batch-1',
          taskType: 'batch',
          phase: 'processing',
          current: 10,
          total: 100,
          percent: 10
        })
      )
    })
    // 点取消：应调用 task.cancel(indexing-1)，而非 batch-1（§2.4）
    await act(async () => {
      fireEvent.click(screen.getByTestId('overlay-cancel'))
    })
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(cancelSpy).toHaveBeenCalledWith('indexing-1')
  })

  it('手动重复检测（无 indexing 伞活动）的 duplicate 进度不并入本浮窗', () => {
    render(<ScanProgress />)
    act(() => {
      onProgressCallback!(
        makeProgress({
          taskId: 'dup-1',
          taskType: 'duplicate',
          phase: 'processing',
          current: 5,
          total: 10,
          percent: 50
        })
      )
    })
    // 2.3 门控：无 indexing 伞活动时不并入，避免与 DuplicatesPage 自绘进度双浮窗打架
    expect(screen.queryByTestId('task-progress-overlay')).toBeNull()
  })
})

describe('ScanProgress 扫描失败 Toast + task:getActive 快照（fix-startup-autoscan-packaged）', () => {
  type ScanResult = { success: boolean; message?: string }
  type ScanCompleteCallback = (result?: ScanResult) => void
  let onCompleteCallback: ScanCompleteCallback | null = null
  let getActiveMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    onCompleteCallback = null
    getActiveMock = vi.fn().mockResolvedValue(null)

    const onCompleteSpy = vi.fn((cb: ScanCompleteCallback) => {
      onCompleteCallback = cb
      return vi.fn()
    })
    const onProgressSpy = vi.fn((_cb: (progress: unknown) => void) => vi.fn())

    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      scanner: { onComplete: onCompleteSpy },
      task: { onProgress: onProgressSpy, getActive: getActiveMock }
    }

    // 重置 mediaStore 到默认非扫描状态（manualScan=false 模拟启动自动扫描场景）
    useMediaStore.setState({
      scanProgress: {
        scanning: false,
        scanned: 0,
        found: 0,
        currentPath: '',
        status: 'idle',
        manualScan: false
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('T3：onComplete({success:false}) 触发一次 error Toast（启动自动扫描失败的兜底提示）', async () => {
    render(<ScanProgress />)
    expect(onCompleteCallback).not.toBeNull()

    act(() => {
      onCompleteCallback!({ success: false, message: 'x' })
    })

    expect(showMessageMock).toHaveBeenCalledTimes(1)
    // 同款文案结构："扫描失败: <原因>"，类型为 error
    expect(showMessageMock).toHaveBeenCalledWith(expect.stringContaining(': x'), 'error')
    // 兜底刷新照常执行
    await vi.waitFor(() => {
      expect(refreshMediaAfterScan).toHaveBeenCalled()
    })
  })

  it('T3：onComplete({success:true}) 不触发 Toast', () => {
    render(<ScanProgress />)

    act(() => {
      onCompleteCallback!({ success: true })
    })

    expect(showMessageMock).not.toHaveBeenCalled()
  })

  it('T3：手动触发的扫描（manualScan=true）失败不在此提示，避免与 ScanButton 双弹', () => {
    useMediaStore.setState({
      scanProgress: {
        scanning: true,
        scanned: 0,
        found: 0,
        currentPath: '',
        status: 'running',
        manualScan: true
      }
    })
    render(<ScanProgress />)

    act(() => {
      onCompleteCallback!({ success: false, message: 'x' })
    })

    expect(showMessageMock).not.toHaveBeenCalled()
  })

  it('U7：挂载后收到 task:getActive 快照（taskType=scan，发现阶段 scanned=0）即渲染浮窗，不依赖 scanProgress.scanning', async () => {
    getActiveMock.mockResolvedValue(
      makeProgress({
        taskId: 'startup-scan-1',
        taskType: 'scan',
        phase: 'processing',
        current: 0,
        total: 0,
        percent: 0,
        message: '正在搜索游戏目录…'
      })
    )

    await act(async () => {
      render(<ScanProgress />)
    })

    await vi.waitFor(() => {
      expect(screen.queryByTestId('task-progress-overlay')).not.toBeNull()
    })
    // 发现阶段 message 经 title 透传展示
    expect(screen.getByTestId('overlay-title').textContent).toBe('正在搜索游戏目录…')
  })
})

describe('ScanProgress 扫描成功但图库仍空引导 Toast（T3/D5）', () => {
  type ScanResult = { success: boolean; message?: string; filesFound?: number }
  type ScanCompleteCallback = (result?: ScanResult) => void
  let onCompleteCallback: ScanCompleteCallback | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    onCompleteCallback = null

    const onCompleteSpy = vi.fn((cb: ScanCompleteCallback) => {
      onCompleteCallback = cb
      return vi.fn()
    })
    const onProgressSpy = vi.fn((_cb: (progress: unknown) => void) => vi.fn())
    const getActiveMock = vi.fn().mockResolvedValue(null)

    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      scanner: { onComplete: onCompleteSpy },
      task: { onProgress: onProgressSpy, getActive: getActiveMock }
    }

    // 重置 mediaStore：非扫描状态 + 空媒体列表（模拟“扫描完成但图库无游戏截图”）
    useMediaStore.setState({
      mediaFiles: [],
      scanProgress: {
        scanning: false,
        scanned: 0,
        found: 0,
        currentPath: '',
        status: 'idle',
        manualScan: false
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('U-E：扫描成功（发现 30 个文件）但刷新后图库为空 → 弹 info 引导 Toast（含真实数量），且会话内去重不重复弹', async () => {
    // 刷新后媒体列表为空（图库按设计过滤启动器缓存图 → 空态）
    vi.mocked(fetchMediaFromDatabase).mockResolvedValueOnce({
      files: [],
      categories: [],
      total: 0,
      hasMore: false
    })

    render(<ScanProgress />)
    expect(onCompleteCallback).not.toBeNull()

    act(() => {
      onCompleteCallback!({ success: true, filesFound: 30, message: 'x' })
    })

    // setup.ts 已初始化 zh-CN i18n，t() 返回真实文案，可断言实际插值后的文案
    await vi.waitFor(() => {
      expect(showMessageMock).toHaveBeenCalledWith(
        expect.stringContaining('扫描完成：发现 30 个文件'),
        'info'
      )
    })

    // 再次触发 onComplete（同参数）：galleryEmptyHintShownRef 去重，info 仍只弹一次
    act(() => {
      onCompleteCallback!({ success: true, filesFound: 30, message: 'x' })
    })
    // flush 第二次 afterRefresh 的微任务链（此时 refresh 走默认 mock → mediaFiles 非空，且 ref 已置位）
    await act(async () => {
      await Promise.resolve()
    })
    const infoCalls = showMessageMock.mock.calls.filter(([, type]) => type === 'info')
    expect(infoCalls).toHaveLength(1)
  })

  it('U-F①：刷新后图库非空 → 不弹 info 引导 Toast', async () => {
    // 默认 fetchMock 返回 [{ id: 'mock-file' }]（非空），无需额外 mock
    render(<ScanProgress />)

    act(() => {
      onCompleteCallback!({ success: true, filesFound: 30, message: 'x' })
    })

    await vi.waitFor(() => {
      expect(refreshMediaAfterScan).toHaveBeenCalled()
    })
    // flush afterRefresh 微任务链，确认非空时不弹 info
    await act(async () => {
      await Promise.resolve()
    })
    const infoCalls = showMessageMock.mock.calls.filter(([, type]) => type === 'info')
    expect(infoCalls).toHaveLength(0)
  })

  it('U-F②：success 且 filesFound 缺省 → 弹 scanCompletedNoGameShots 分支文案（info）', async () => {
    vi.mocked(fetchMediaFromDatabase).mockResolvedValueOnce({
      files: [],
      categories: [],
      total: 0,
      hasMore: false
    })

    render(<ScanProgress />)

    act(() => {
      onCompleteCallback!({ success: true })
    })

    await vi.waitFor(() => {
      expect(showMessageMock).toHaveBeenCalledWith(
        expect.stringContaining('扫描完成：未发现游戏内截图'),
        'info'
      )
    })
  })

  it('U-F③：success:false → 既有 D2 error Toast 行为不变（不弹 info）', async () => {
    render(<ScanProgress />)

    act(() => {
      onCompleteCallback!({ success: false, message: 'x' })
    })

    // 与既有 D2 用例一致：error Toast 同款文案结构（"扫描失败: x"）
    expect(showMessageMock).toHaveBeenCalledWith(expect.stringContaining(': x'), 'error')
    // 兜底刷新照常执行，且失败路径不弹 info 引导
    await vi.waitFor(() => {
      expect(refreshMediaAfterScan).toHaveBeenCalled()
    })
    await act(async () => {
      await Promise.resolve()
    })
    const infoCalls = showMessageMock.mock.calls.filter(([, type]) => type === 'info')
    expect(infoCalls).toHaveLength(0)
  })
})

describe('ScanProgress D5 引导 Toast 视图限定（评审修复批次 B / D1）', () => {
  type ScanResult = { success: boolean; message?: string; filesFound?: number }
  type ScanCompleteCallback = (result?: ScanResult) => void
  let onCompleteCallback: ScanCompleteCallback | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    onCompleteCallback = null

    const onCompleteSpy = vi.fn((cb: ScanCompleteCallback) => {
      onCompleteCallback = cb
      return vi.fn()
    })
    const onProgressSpy = vi.fn((_cb: (progress: unknown) => void) => vi.fn())
    const getActiveMock = vi.fn().mockResolvedValue(null)

    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      scanner: { onComplete: onCompleteSpy },
      task: { onProgress: onProgressSpy, getActive: getActiveMock }
    }

    // 重置 mediaStore：非扫描状态 + 空媒体列表
    useMediaStore.setState({
      mediaFiles: [],
      scanProgress: {
        scanning: false,
        scanned: 0,
        found: 0,
        currentPath: '',
        status: 'idle',
        manualScan: false
      }
    })
    // 重置视图到默认 gallery（防止其他用例残留非 gallery 视图污染本组判定）
    useUIStore.setState({ currentView: 'gallery' })
  })

  afterEach(() => {
    cleanup()
    // 恢复默认视图：store 是模块级单例，避免跨 describe 的状态泄漏
    useUIStore.setState({ currentView: 'gallery' })
  })

  it('U-H：非 gallery 视图（launcher-cache）下扫描成功且刷新后列表为空 → 不弹 info 引导 Toast', async () => {
    // 用户停留在空的「缓存」板块：mediaFiles 按 currentView 过滤（launcher 源），
    // 刷新后为空只代表该板块空，不代表图库空——不应触发「图库仍为空」引导
    useUIStore.setState({ currentView: 'launcher-cache' })
    vi.mocked(fetchMediaFromDatabase).mockResolvedValueOnce({
      files: [],
      categories: [],
      total: 0,
      hasMore: false
    })

    render(<ScanProgress />)
    expect(onCompleteCallback).not.toBeNull()

    act(() => {
      onCompleteCallback!({ success: true, filesFound: 30, message: 'x' })
    })

    // 兜底刷新照常执行（视图限定只影响 Toast 判定，不影响刷新链路）
    await vi.waitFor(() => {
      expect(refreshMediaAfterScan).toHaveBeenCalled()
    })
    // flush afterRefresh 完整微任务链：refreshMock 内部 setMediaFiles([]) 后，
    // 判定代码在 refresh promise resolve 后的续体里同步执行，多 flush 确保已跑完
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const infoCalls = showMessageMock.mock.calls.filter(([, type]) => type === 'info')
    expect(infoCalls).toHaveLength(0)
  })
})
