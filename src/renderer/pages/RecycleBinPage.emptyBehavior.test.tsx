/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/pages/RecycleBinPage
 * @coverage 清空回收站的**行为**：failedCount>0 必须判失败、必须给出重试与「跳过系统回收站」出路
 *
 * 为什么要新写一个行为套件（而不是补强 RecycleBinPage.empty.test.tsx）：
 * 既有 .empty.test.tsx 是把 .tsx 当字符串做正则/contain 的**源码结构断言**，它只能证明
 * "代码里没写那行"，无法证明"运行时把失败当成功"。本次缺陷（主进程返回 failedCount=41
 * 却弹绿色成功 Toast）正是运行时行为，结构断言看不见 ⇒ 96 个主进程用例全绿也拦不住。
 * 本文件用真实 render() 复现，harness 沿用 RecycleBinPage.permanentDelete.test.tsx。
 *
 * #fix-empty-recyclebin-failed-as-success 回归防线：
 * - 修复前 handleEmptyRecycleBin 从不读 result.failedCount（preload 与 vite-env 把返回类型
 *   收窄成 { message: string }，类型层面拦住了读取），staged.run 返回 phase='done' 即判成功；
 * - 修复前错误分支不调 setFailedAction('empty') ⇒ 「重试清空」按钮与 handleRetry 的 empty
 *   分支是死代码；
 * - mock 一律用 media:emptyRecycleBin 的真实契约 data
 *   { message, movedCount, missingCount, failedCount, forceDeletedCount }（**无 success 字段**）。
 *
 * 审查轮 F2 追加：ConfirmDialog mock 把 title/message 落进 DOM，用来判「不可逆操作的确认框
 * 有没有说谎」——原文案断言「这 N 项文件当前无法移入系统回收站」，而 force 的作用集来自
 * getSoftDeletedMediaPaths() 的当前全部软删除记录（失败后新软删除的条目也在内），
 * 对未遍历过的项该句是假话。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

// jsdom 无 ResizeObserver，useContainerSize 需要
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub

/**
 * toast 隔离：每次 beforeEach 换一个全新的 spy 实例。
 * 必要性：失败用例会在断言处中途中止，页面里尚未 drain 的异步链（staged.run 之后的
 * showMessage / loadRecycleBin）会落到下一个用例，污染其断言（实测把上一用例的
 * 「已彻底删除 41 项」打进当前用例的第一次调用）。换实例后遗留调用只会打进旧 spy。
 */
const showMessageMock = vi.hoisted(() => vi.fn())
vi.mock('./settings/sections', () => ({
  useGlobalToast: () => showMessageMock
}))

vi.mock('react-virtuoso', () => {
  const React = require('react')
  return {
    VirtuosoGrid: ({
      data,
      itemContent
    }: {
      data?: unknown[]
      itemContent?: (index: number, row: unknown) => React.ReactNode
    }) => {
      const items = data ?? []
      return React.createElement(
        'div',
        { 'data-testid': 'virtuoso-grid' },
        items.map((row, i) =>
          React.createElement(React.Fragment, { key: i }, itemContent ? itemContent(i, row) : null)
        )
      )
    },
    Virtuoso: () => null
  }
})
// 仅当 open 为真时渲染确认按钮，便于触发 onConfirm；title/message 一并落到 DOM，
// 让「确认框有没有对用户说谎」成为可判定的断言（F2 的判据载体）
vi.mock('../components/common/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    message,
    onConfirm
  }: {
    open: boolean
    title: string
    message: string
    onConfirm: () => void
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <p data-testid="confirm-message">{message}</p>
        <button data-testid="confirm-ok" onClick={onConfirm} />
      </div>
    ) : null
}))
vi.mock('../components/common/TaskProgressOverlay', () => ({
  TaskProgressOverlay: () => null
}))
vi.mock('../hooks/useRefreshMedia', () => ({
  useRefreshMedia: () => vi.fn().mockResolvedValue(undefined)
}))

import { RecycleBinPage } from './RecycleBinPage'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'

/**
 * 契约类型探针：以 preload 声明的返回类型为唯一真相源。
 * 修复前声明是 { message: string }，此处构造的对象带 failedCount/forceDeletedCount
 * ⇒ excess property check 直接报 TS 错，npm run typecheck 在修复前即为红。
 */
type EmptyResult = Awaited<
  ReturnType<NonNullable<Window['electronAPI']>['mediaAction']['emptyRecycleBin']>
>
function makeEmptyResult(overrides: Partial<EmptyResult> = {}): EmptyResult {
  return {
    message: '',
    movedCount: 0,
    missingCount: 0,
    failedCount: 0,
    forceDeletedCount: 0,
    ...overrides
  }
}

function makeRecycleFile(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    id: '1',
    file_path: 'H:\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\ScreenShot\\p.jpeg',
    file_name: 'p.jpeg',
    file_type: 'image',
    file_ext: '.jpeg',
    file_size: 6259129,
    created_at: '2026-01-01T00:00:00.000Z',
    modified_at: '2026-01-01T00:00:00.000Z',
    deleted_at: '2026-01-02T00:00:00.000Z',
    thumbnail: 'C:\\cache\\thumbnails\\p.jpg',
    tags: [],
    rating: 0,
    is_favorite: false,
    notes: '',
    scene_category: 'other',
    width: 1920,
    height: 1080,
    ...overrides
  }
}

const recycleFile = makeRecycleFile()

/** 真机 2026-11-01 17:25 的实际返回：41 项移入系统回收站全部失败，DB 记录被保留 */
const REAL_FAILURE = makeEmptyResult({
  message: '已移入系统回收站 0 项（41 项移入失败，已保留记录供手动处理）',
  movedCount: 0,
  missingCount: 0,
  failedCount: 41
})

const electron = {
  media: {
    list: vi.fn().mockResolvedValue({
      files: [recycleFile],
      total: 41,
      hasMore: false,
      nextCursor: null,
      page: 1,
      pageSize: 200
    })
  },
  mediaAction: {
    emptyRecycleBin: vi.fn(),
    permanentDelete: vi.fn().mockResolvedValue({ message: '', deletedCount: 0, failedCount: 0 }),
    restore: vi.fn().mockResolvedValue({ message: '' }),
    softDelete: vi.fn().mockResolvedValue({ message: '' })
  }
}

function setupElectron(): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = electron
}

async function clickEmptyAndConfirm(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '清空回收站' }))
  await waitFor(() => expect(screen.getByTestId('confirm-ok')).toBeInTheDocument())
  fireEvent.click(screen.getByTestId('confirm-ok'))
}

beforeEach(() => {
  vi.clearAllMocks()
  // 必须 mockReset 而非只 clearAllMocks：clearAllMocks **不清** mockResolvedValueOnce 队列。
  // 失败用例会中途中止，把排队的下一个返回值留给后续用例——实测正是它污染了「全部成功」用例
  // （本该成功的用例收到了上一用例的「已彻底删除 41 项」）。
  electron.mediaAction.emptyRecycleBin.mockReset()
  electron.media.list.mockReset().mockResolvedValue({
    files: [recycleFile],
    total: 41,
    hasMore: false,
    nextCursor: null,
    page: 1,
    pageSize: 200
  })
  setupElectron()
  useMediaStore.setState({
    recycleBinFiles: [],
    recycleBinTotal: 0,
    recycleBinLoading: false,
    recycleBinHasMore: false,
    recycleBinLoadingMore: false
  })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('RecycleBinPage 清空回收站运行时行为（#fix-empty-recyclebin-failed-as-success）', () => {
  it('移入系统回收站失败（failedCount>0）必须判失败：红色 Toast，且绝不误报成功', async () => {
    electron.mediaAction.emptyRecycleBin.mockResolvedValue(REAL_FAILURE)
    render(<RecycleBinPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: '清空回收站' })).toBeEnabled())

    await clickEmptyAndConfirm()

    await waitFor(() => {
      expect(showMessageMock).toHaveBeenCalledWith(REAL_FAILURE.message, 'error')
    })
    // 修复前正是这一行成立：failedCount=41 却弹 success
    expect(showMessageMock).not.toHaveBeenCalledWith(expect.any(String), 'success')
  })

  it('移入系统回收站失败后必须给出「重试清空」出路（修复前 setFailedAction 从未置 empty ⇒ 死代码）', async () => {
    electron.mediaAction.emptyRecycleBin.mockResolvedValue(REAL_FAILURE)
    render(<RecycleBinPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: '清空回收站' })).toBeEnabled())

    await clickEmptyAndConfirm()

    await waitFor(() => expect(screen.getByText('重试清空')).toBeInTheDocument())
  })

  it('失败后提供「跳过系统回收站，直接彻底删除」，二次确认后以 force=true 重新调用', async () => {
    electron.mediaAction.emptyRecycleBin
      .mockResolvedValueOnce(REAL_FAILURE)
      .mockResolvedValueOnce(
        makeEmptyResult({ message: '已彻底删除 41 项', forceDeletedCount: 41 })
      )
    render(<RecycleBinPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: '清空回收站' })).toBeEnabled())

    await clickEmptyAndConfirm()
    await waitFor(() => expect(screen.getByText('重试清空')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '跳过系统回收站，直接彻底删除' }))
    await waitFor(() => expect(screen.getByTestId('confirm-ok')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('confirm-ok'))

    // 首次为普通清空（不带 force），第二次必须是用户显式同意的 force。
    // 用 args[0] 判定而非 toHaveBeenNthCalledWith(1)，避免「不传参」与「传 undefined」两种
    // 合法实现写法把断言变成脆的。
    await waitFor(() => expect(electron.mediaAction.emptyRecycleBin).toHaveBeenCalledTimes(2))
    expect(electron.mediaAction.emptyRecycleBin.mock.calls[0][0]).toBeFalsy()
    expect(electron.mediaAction.emptyRecycleBin.mock.calls[1][0]).toBe(true)
    await waitFor(() => expect(showMessageMock).toHaveBeenCalledWith('已彻底删除 41 项', 'success'))
  })

  it('永久删除确认框只陈述已证实的事实（审查轮 F2）', async () => {
    electron.mediaAction.emptyRecycleBin.mockResolvedValue(REAL_FAILURE)
    render(<RecycleBinPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: '清空回收站' })).toBeEnabled())

    await clickEmptyAndConfirm()
    await waitFor(() => expect(screen.getByText('重试清空')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '跳过系统回收站，直接彻底删除' }))
    await waitFor(() => expect(screen.getByTestId('confirm-ok')).toBeInTheDocument())

    const copy = screen.getByTestId('confirm-message').textContent ?? ''
    // 必须如实披露的两件事：不可恢复、影响面是回收站**当前全部**条目
    expect(copy).toContain('不经过系统回收站')
    expect(copy).toContain('全部 41 项')
    // 修复前这里断言「这 41 项文件当前无法移入系统回收站」——force 作用集来自
    // getSoftDeletedMediaPaths()（失败后新软删除的条目也在内），该句对未遍历过的项是假话
    expect(copy).not.toContain('当前无法移入系统回收站')
  })

  it('全部成功（failedCount=0）判成功且不显示重试出路', async () => {
    electron.mediaAction.emptyRecycleBin.mockResolvedValue(
      makeEmptyResult({ message: '已清空回收站（共 41 项）', movedCount: 41 })
    )
    render(<RecycleBinPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: '清空回收站' })).toBeEnabled())

    await clickEmptyAndConfirm()

    await waitFor(() => {
      expect(showMessageMock).toHaveBeenCalledWith('已清空回收站（共 41 项）', 'success')
    })
    expect(screen.queryByText('重试清空')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '跳过系统回收站，直接彻底删除' })
    ).not.toBeInTheDocument()
  })

  it('IPC 抛错（如数据库异常）同样判失败并给出重试', async () => {
    electron.mediaAction.emptyRecycleBin.mockRejectedValue(new Error('数据库被锁定'))
    render(<RecycleBinPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: '清空回收站' })).toBeEnabled())

    await clickEmptyAndConfirm()

    await waitFor(() => expect(screen.getByText('重试清空')).toBeInTheDocument())
    expect(showMessageMock).not.toHaveBeenCalledWith(expect.any(String), 'success')
  })

  it('回收站为空时主进程返回 movedCount=0/failedCount=0，不得误判为失败', async () => {
    electron.mediaAction.emptyRecycleBin.mockResolvedValue(
      makeEmptyResult({ message: '回收站为空，无需清理' })
    )
    render(<RecycleBinPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: '清空回收站' })).toBeEnabled())

    await clickEmptyAndConfirm()

    await waitFor(() => {
      expect(showMessageMock).toHaveBeenCalledWith('回收站为空，无需清理', 'success')
    })
    expect(screen.queryByText('重试清空')).not.toBeInTheDocument()
  })
})
