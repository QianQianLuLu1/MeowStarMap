/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/components/scanner/ScanProgress
 * @coverage scanner:complete 兜底刷新订阅 + task:progress 索引进度过滤（batch/duplicate）
 * @dependencies @testing-library/react, vitest
 * @remarks 任务 4（P1）验证：ScanProgress 挂载时订阅 scanner.onComplete，
 *   回调内统一调用 refreshMediaAfterScan 刷新媒体列表（fetchMediaFromDatabase + setMediaFiles），
 *   作为 GalleryPage 订阅链路的兜底。
 *   索引进度修复（docs/plans/fix-indexing-progress.md §5）：
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
  TaskProgressOverlay: (props: { progress: TaskProgress | null; onCancel?: () => void }) => (
    <div data-testid="task-progress-overlay">
      <span data-testid="overlay-progress">
        {props.progress
          ? `${props.progress.current}/${props.progress.total}/${props.progress.percent}`
          : 'null'}
      </span>
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

import { ScanProgress } from './ScanProgress'
import {
  fetchMediaFromDatabase,
  useMediaStore,
  refreshMediaAfterScan
} from '../../stores/mediaStore'
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
