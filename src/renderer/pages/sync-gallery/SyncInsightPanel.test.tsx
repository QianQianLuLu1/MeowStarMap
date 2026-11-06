// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SyncInsightPanel } from './SyncInsightPanel'
import type { AssetSummary, MediaResource } from '../../../shared/sync/protocol'
import type { AssetEditsInfo } from '../../../shared/types/electron-api'
import type { AssetMediaFile } from '../../utils/assetViewModel'

/**
 * 同步图库「上游索引面」面板测试（02 计划 N6）。
 *
 * 这三条通道早已在契约里，缺的只是调用方，所以本文件锁的是**接线**：
 * 打到哪个通道、命中怎么呈现、失败怎么降级、以及「不展开就不发请求」。
 */

function summary(assetId: string): AssetSummary {
  return {
    assetId,
    type: 'photo',
    state: 'ready',
    capturedAt: '2026-10-01T00:00:00.000Z',
    revision: 1,
    hasMotion: false,
    hasMetadata: false
  } as unknown as AssetSummary
}

interface BackfillPlan {
  meta?: Record<string, MediaResource[]>
  paths?: Record<string, Record<string, string>>
  edits?: AssetEditsInfo[]
  metaError?: Error
  pathError?: Error
  editsError?: Error
}

interface ApiPlan {
  suits?: { items: Array<Record<string, unknown>> }
  clothing?: { items: Array<Record<string, unknown>> }
  stats?: Record<string, unknown>
  suitsError?: Error
  clothingError?: Error
  statsError?: Error
  /** 仅传入时才装配回捞能力；既有接线用例保持原夹具不变（老桥面无 getResourceRecords） */
  backfill?: BackfillPlan
}

function install(plan: ApiPlan = {}) {
  const searchSuits = vi.fn(async () => {
    if (plan.suitsError) throw plan.suitsError
    return plan.suits ?? { items: [] }
  })
  const searchClothing = vi.fn(async () => {
    if (plan.clothingError) throw plan.clothingError
    return plan.clothing ?? { items: [] }
  })
  const profileStats = vi.fn(async () => {
    if (plan.statsError) throw plan.statsError
    return plan.stats ?? { libraryRevision: 1, topSuits: [], topClothing: [] }
  })
  // 回捞假桥：仅 backfill 存在时挂到 nikkisync / assetEdits，避免改变既有用例的桥形状
  const getResourceRecords = vi.fn(async (input: { mode: string }) => {
    if (input.mode === 'meta') {
      if (plan.backfill?.metaError) throw plan.backfill.metaError
      return { byAsset: plan.backfill?.meta ?? {} }
    }
    if (plan.backfill?.pathError) throw plan.backfill.pathError
    return { byAsset: plan.backfill?.paths ?? {} }
  })
  const assetEditsList = vi.fn(async () => {
    if (plan.backfill?.editsError) throw plan.backfill.editsError
    return { edits: plan.backfill?.edits ?? [] }
  })
  // 库变更订阅面：返回退订函数，与 preload 的 subscribe() 语义一致
  const libraryListeners: Array<() => void> = []
  const onLibraryChanged = vi.fn((callback: () => void) => {
    libraryListeners.push(callback)
    return () => {
      const index = libraryListeners.indexOf(callback)
      if (index >= 0) libraryListeners.splice(index, 1)
    }
  })
  const nikkisync: Record<string, unknown> = {
    searchSuits,
    searchClothing,
    profileStats,
    onLibraryChanged
  }
  const electronAPI: Record<string, unknown> = { nikkisync }
  if (plan.backfill) {
    nikkisync.getResourceRecords = getResourceRecords
    electronAPI.assetEdits = { list: assetEditsList }
  }
  ;(window as unknown as Record<string, unknown>).electronAPI = electronAPI
  return {
    searchSuits,
    searchClothing,
    profileStats,
    onLibraryChanged,
    getResourceRecords,
    assetEditsList,
    emitLibraryChanged: () => {
      for (const callback of libraryListeners) callback()
    }
  }
}

/** 回捞所需的最小资源行（与 syncGalleryStore.test.ts 同口径） */
function resource(assetId: string): MediaResource {
  return {
    resourceId: `r-${assetId}`,
    role: 'source_high_quality',
    fileName: `${assetId}.png`,
    mimeType: 'image/png',
    fileExt: '.png',
    sizeBytes: 4096,
    sha256: 'aa',
    width: 100,
    height: 200
  } as MediaResource
}

/** 乱序夹具：searchSuits 的响应由测试按调用序号外部放行，用于构造「后发先至」 */
function installDeferred() {
  const queue: Array<{ resolve: (value: unknown) => void }> = []
  const searchSuits = vi.fn(
    () =>
      new Promise((resolve) => {
        queue.push({ resolve })
      })
  )
  const searchClothing = vi.fn(async () => ({ items: [] }))
  const profileStats = vi.fn(async () => ({ libraryRevision: 1, topSuits: [], topClothing: [] }))
  ;(window as unknown as Record<string, unknown>).electronAPI = {
    nikkisync: { searchSuits, searchClothing, profileStats }
  }
  return {
    searchSuits,
    searchClothing,
    profileStats,
    /** 放行第 index 条请求的响应（序号自 0 起） */
    settle: (index: number, value: unknown) => {
      const handle = queue[index]
      if (!handle) throw new Error(`乱序夹具缺少第 ${index} 条请求`)
      handle.resolve(value)
    }
  }
}

const TITLE = '套装/服装检索与档案统计'

function submit(term: string, api: unknown): void {
  // 经 searchbox 定位所属 form：按钮文案在检索中会变成「检索中…」，按名字找会在第二次提交时落空
  const box = screen.getByRole('searchbox')
  fireEvent.change(box, { target: { value: term } })
  fireEvent.submit((box.closest('form') ?? box) as HTMLElement)
  void api
}

/** 冲刷微任务与 pending 回调，让已放行的响应真正跑到 .then */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  install()
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as Record<string, unknown>).electronAPI
})

describe('SyncInsightPanel', () => {
  it('桥缺失时整块不渲染（不谎报「没有命中」）', () => {
    ;(window as unknown as Record<string, unknown>).electronAPI = {}
    render(<SyncInsightPanel />)
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('正常：套装检索命中 ⇒ 渲染套装名与照片数，且打的是 searchSuits', async () => {
    const api = install({
      suits: {
        items: [
          {
            suitId: 'suit_swan',
            suitName: '天鹅童话',
            observedPartCount: 2,
            photoCount: 3,
            photos: [
              { asset: summary('a1'), matchedParts: [{ clothingId: 'c1', name: '天鹅之裙' }] }
            ]
          }
        ]
      }
    })
    render(<SyncInsightPanel />)
    fireEvent.click(screen.getByText(TITLE))
    submit('天鹅', api)
    await waitFor(() => expect(api.searchSuits).toHaveBeenCalledWith({ query: '天鹅' }))
    expect(await screen.findByText('天鹅童话')).toBeInTheDocument()
    expect(screen.getByText('3 张')).toBeInTheDocument()
    expect(screen.getByText('天鹅之裙')).toBeInTheDocument()
    expect(api.searchClothing).not.toHaveBeenCalled()
  })

  it('正常：切到服装作用域后打 searchClothing，并显示所属套装', async () => {
    const api = install({
      clothing: {
        items: [
          {
            clothingId: 'cloth_star',
            name: '星夜长发',
            category: 'hair',
            suitName: '星夜回响',
            photoCount: 5,
            photos: []
          }
        ]
      }
    })
    render(<SyncInsightPanel />)
    fireEvent.click(screen.getByText(TITLE))
    fireEvent.change(screen.getByLabelText('检索范围'), { target: { value: 'clothing' } })
    submit('星夜', api)
    await waitFor(() => expect(api.searchClothing).toHaveBeenCalledWith({ query: '星夜' }))
    expect(await screen.findByText('星夜长发')).toBeInTheDocument()
    expect(screen.getByText('星夜回响')).toBeInTheDocument()
    expect(api.searchSuits).not.toHaveBeenCalled()
  })

  it('边界：空关键词不发起请求；无命中给出空态文案而非报错', async () => {
    const api = install()
    render(<SyncInsightPanel />)
    fireEvent.click(screen.getByText(TITLE))
    fireEvent.submit(screen.getByRole('button', { name: '检索' }).closest('form') as HTMLElement)
    expect(api.searchSuits).not.toHaveBeenCalled()

    submit('不存在', api)
    await waitFor(() => expect(api.searchSuits).toHaveBeenCalled())
    expect(await screen.findByText('没有命中')).toBeInTheDocument()
  })

  it('异常：检索失败只在本面板内联提示，不影响其余区块', async () => {
    const api = install({ suitsError: new Error('runtime is not ready') })
    render(<SyncInsightPanel />)
    fireEvent.click(screen.getByText(TITLE))
    submit('天鹅', api)
    expect(await screen.findByText('检索失败')).toBeInTheDocument()
  })

  it('档案统计：折叠时一次都不拉；首次展开才发请求并渲染两组榜', async () => {
    const api = install({
      stats: {
        libraryRevision: 7,
        topSuits: [{ suitId: 's1', suitName: '天鹅童话', photoCount: 9 }],
        topClothing: [{ clothingId: 'c1', name: '星夜长发', photoCount: 4 }]
      }
    })
    render(<SyncInsightPanel />)
    expect(api.profileStats).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(TITLE))
    await waitFor(() => expect(api.profileStats).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('最常穿的套装')).toBeInTheDocument()
    expect(screen.getByText('天鹅童话')).toBeInTheDocument()
    expect(screen.getByText('最常穿的衣服')).toBeInTheDocument()
    expect(screen.getByText('星夜长发')).toBeInTheDocument()
    // 重复展开不再发第二次（懒加载只做一次）
    fireEvent.click(screen.getByText(TITLE))
    await waitFor(() => expect(api.profileStats).toHaveBeenCalledTimes(1))
  })

  it('档案统计：读取失败降级为内联文案，不抛穿渲染', async () => {
    const api = install({ statsError: new Error('boom') })
    void api
    render(<SyncInsightPanel />)
    fireEvent.click(screen.getByText(TITLE))
    expect(await screen.findByText('统计读取失败')).toBeInTheDocument()
  })

  it('竞态：慢的旧响应后到，不得改写新命中、也不得掐掉在途查询的 loading', async () => {
    const api = installDeferred()
    render(<SyncInsightPanel />)
    fireEvent.click(screen.getByText(TITLE))
    submit('旧', api)
    submit('新', api)
    await waitFor(() => expect(api.searchSuits).toHaveBeenCalledTimes(2))

    // 第 1 条（旧关键词）晚到：此时第 2 条仍在途 ⇒ 过期代次一律不得改状态
    api.settle(0, { items: [{ suitId: 's_old', suitName: '旧结果', photoCount: 1, photos: [] }] })
    await flush()
    expect(screen.queryByText('旧结果')).not.toBeInTheDocument()
    expect(screen.getByText('检索中…')).toBeInTheDocument()

    api.settle(1, { items: [{ suitId: 's_new', suitName: '新结果', photoCount: 2, photos: [] }] })
    await flush()
    expect(screen.getByText('新结果')).toBeInTheDocument()
    expect(screen.queryByText('旧结果')).not.toBeInTheDocument()
    expect(screen.queryByText('检索中…')).not.toBeInTheDocument()
  })

  it('异常：切换检索范围立即清空上一作用域命中（服装页不得残留套装行）', async () => {
    const api = install({
      suits: {
        items: [{ suitId: 's_suit', suitName: '天鹅童话', photoCount: 3, photos: [] }]
      }
    })
    render(<SyncInsightPanel />)
    fireEvent.click(screen.getByText(TITLE))
    submit('天鹅', api)
    expect(await screen.findByText('天鹅童话')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('检索范围'), { target: { value: 'clothing' } })
    expect(screen.queryByText('天鹅童话')).not.toBeInTheDocument()
    expect(screen.getByText('输入关键词后检索')).toBeInTheDocument()
  })

  it('库变更到货：展开态下重新拉档案统计，不再永久缓存', async () => {
    const api = install({
      stats: {
        libraryRevision: 1,
        topSuits: [{ suitId: 's1', suitName: '旧榜套装', photoCount: 1 }],
        topClothing: []
      }
    })
    render(<SyncInsightPanel />)
    fireEvent.click(screen.getByText(TITLE))
    await waitFor(() => expect(api.profileStats).toHaveBeenCalledTimes(1))
    expect(screen.getByText('旧榜套装')).toBeInTheDocument()

    await act(async () => {
      api.emitLibraryChanged()
    })
    await waitFor(() => expect(api.profileStats).toHaveBeenCalledTimes(2))
  })

  it('边界：面板收起时库变更只复位缓存，不追加 IPC（懒加载不得退化成每次开合都拉）', async () => {
    const api = install({
      stats: {
        libraryRevision: 1,
        topSuits: [{ suitId: 's1', suitName: '旧榜套装', photoCount: 1 }]
      }
    })
    render(<SyncInsightPanel />)
    fireEvent.click(screen.getByText(TITLE))
    await waitFor(() => expect(api.profileStats).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByText(TITLE))
    const details = screen.getByRole('group') as HTMLDetailsElement
    expect(details.open, '第二次点击未把 <details> 收起，本例的「收起态」前提不成立').toBe(false)

    await act(async () => {
      api.emitLibraryChanged()
    })
    expect(api.profileStats).toHaveBeenCalledTimes(1)
  })

  // ===== N5：命中照片回捞资源记录 → 经 onHits 铺进网格 =====

  it('search hits are resolved into gallery items via getResourceRecords', async () => {
    const onHits = vi.fn()
    const api = install({
      suits: {
        items: [
          {
            suitId: 'suit_swan',
            suitName: '天鹅童话',
            observedPartCount: 1,
            photoCount: 2,
            photos: [
              { asset: summary('a1'), matchedParts: [] },
              { asset: summary('a2'), matchedParts: [] }
            ]
          }
        ]
      },
      backfill: {
        meta: { a1: [resource('a1')], a2: [resource('a2')] },
        paths: {
          a1: { 'r-a1': 'D:/Game/a1.png' },
          a2: { 'r-a2': 'D:/Game/a2.png' }
        }
      }
    })
    render(<SyncInsightPanel onHits={onHits} />)
    fireEvent.click(screen.getByText(TITLE))
    submit('天鹅', api)
    await waitFor(() =>
      expect(api.getResourceRecords).toHaveBeenCalledWith({
        assetIds: ['a1', 'a2'],
        mode: 'meta'
      })
    )
    expect(api.getResourceRecords).toHaveBeenCalledWith({
      assetIds: ['a1', 'a2'],
      mode: 'path'
    })
    await waitFor(() => expect(onHits).toHaveBeenCalledTimes(1))
    const files = onHits.mock.calls[0][0] as AssetMediaFile[]
    expect(files.map((file) => file.id)).toEqual(['a1', 'a2'])
    expect(files[0].file_path).toBe('D:/Game/a1.png')
  })

  it('failed resource backfill keeps text hits and shows inline notice', async () => {
    const onHits = vi.fn()
    const api = install({
      suits: {
        items: [
          {
            suitId: 'suit_swan',
            suitName: '天鹅童话',
            observedPartCount: 1,
            photoCount: 1,
            photos: [{ asset: summary('a1'), matchedParts: [] }]
          }
        ]
      },
      backfill: { metaError: new Error('runtime is not ready') }
    })
    render(<SyncInsightPanel onHits={onHits} />)
    fireEvent.click(screen.getByText(TITLE))
    submit('天鹅', api)
    expect(await screen.findByText('天鹅童话')).toBeInTheDocument()
    expect(await screen.findByTestId('insight-backfill-notice')).toBeInTheDocument()
    expect(onHits).not.toHaveBeenCalled()
  })

  it('empty hits and repeated submit do not issue duplicate IPC', async () => {
    const onHits = vi.fn()
    // 空命中：即便装配了回捞能力，也不得发 getResourceRecords
    const emptyApi = install({ backfill: { meta: {}, paths: {} } })
    const emptyView = render(<SyncInsightPanel onHits={onHits} />)
    fireEvent.click(screen.getByText(TITLE))
    submit('不存在', emptyApi)
    await waitFor(() => expect(emptyApi.searchSuits).toHaveBeenCalled())
    expect(emptyApi.getResourceRecords).not.toHaveBeenCalled()
    emptyView.unmount()

    // 重复提交同一批命中：回捞 IPC 只发一轮（meta + path），不得翻倍
    const api = install({
      suits: {
        items: [
          {
            suitId: 's1',
            suitName: '天鹅童话',
            observedPartCount: 1,
            photoCount: 1,
            photos: [{ asset: summary('a1'), matchedParts: [] }]
          }
        ]
      },
      backfill: {
        meta: { a1: [resource('a1')] },
        paths: { a1: { 'r-a1': 'D:/Game/a1.png' } }
      }
    })
    render(<SyncInsightPanel onHits={onHits} />)
    fireEvent.click(screen.getByText(TITLE))
    submit('天鹅', api)
    await waitFor(() => expect(onHits).toHaveBeenCalled())
    expect(api.getResourceRecords).toHaveBeenCalledTimes(2)
    submit('天鹅', api)
    await flush()
    expect(api.getResourceRecords).toHaveBeenCalledTimes(2)
  })
})
