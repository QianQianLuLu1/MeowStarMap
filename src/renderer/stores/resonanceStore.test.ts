import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useResonanceStore,
  ensureResonanceLoaded,
  previewImport,
  commitPendingImport,
  exportResonanceData,
  updateWardrobeItems,
  toggleBannerWish,
  clearAllResonanceData,
  type ResonanceState
} from './resonanceStore'
import { parseImportFileText } from '../utils/resonance/importParse'
import { MAX_COMMIT_BATCH_ROWS } from '../../shared/types/resonance'
import type {
  ResonanceBannerWishlistData,
  ResonanceGetDataResult
} from '../../shared/types/resonance'

/**
 * resonanceStore 单元测试：注入 mock electronAPI（preload call() 已解包 IpcResponse，
 * mock 返回值不含 success 字段）；beforeEach 重置 store 快照。
 */

const T = '2025-06-01 12:30:45'

const sampleData: ResonanceGetDataResult = {
  pulls: [
    { id: 1, banner_id: '2', item_id: '1020000001', obtained_at: T, source: 'json', created_at: '' }
  ],
  edits: [{ id: 1, banner_id: '3', item_id: '2020000003', obtained_at: T, created_at: '' }],
  pearpal: [],
  evo: [],
  wardrobe: {
    version: 1,
    ownedItemIds: [1020000001],
    ownedMakeupIds: [],
    ownedMomoIds: [],
    ownedPropIds: [],
    ownedEurekaColorIds: [],
    updatedAt: 'x'
  }
}

const emptyWardrobe: ResonanceGetDataResult['wardrobe'] = {
  version: 1,
  ownedItemIds: [],
  ownedMakeupIds: [],
  ownedMomoIds: [],
  ownedPropIds: [],
  ownedEurekaColorIds: [],
  updatedAt: ''
}

const emptyWishlist: ResonanceBannerWishlistData = { version: 1, entries: [] }

const sampleDataWithWishlist: ResonanceGetDataResult = {
  ...sampleData,
  wishlist: {
    version: 1,
    entries: [{ bannerId: 74 }, { bannerId: 77 }]
  }
}

function setMockApi(overrides: Record<string, unknown> = {}): void {
  ;(globalThis as Record<string, unknown>).window = {
    electronAPI: {
      resonance: {
        getData: vi.fn(() => Promise.resolve(sampleData)),
        addManualRecord: vi.fn(() => Promise.resolve({ added: true })),
        updateManualRecord: vi.fn(() => Promise.resolve({ updated: true })),
        deleteRecord: vi.fn(() => Promise.resolve({ deleted: true })),
        readImportFile: vi.fn(() => Promise.resolve({ content: '{}', sizeBytes: 2 })),
        commitImport: vi.fn(() => Promise.resolve({ imported: 0 })),
        export: vi.fn(() => Promise.resolve({ path: 'C:\\out.json', recordCount: 1 })),
        updateWardrobe: vi.fn(() => Promise.resolve({ wardrobe: sampleData.wardrobe })),
        setWishlist: vi.fn((wishlist: ResonanceBannerWishlistData) =>
          Promise.resolve({ wishlist })
        ),
        clearAll: vi.fn(() => Promise.resolve({ cleared: true })),
        ...overrides
      }
    }
  }
}

function clearMockApi(): void {
  delete (globalThis as Record<string, unknown>).window
}

/** 重置 store 到指定状态（默认空数据初始态），避免用例间状态泄漏 */
function resetStoreTo(overrides: Partial<ResonanceState> = {}): void {
  useResonanceStore.setState({
    loaded: false,
    loading: false,
    loadError: null,
    pulls: [],
    edits: [],
    pearpal: [],
    evo: [],
    wardrobe: emptyWardrobe,
    wishlist: emptyWishlist,
    activeTab: 'records',
    pendingImport: null,
    importRunning: false,
    importProgress: null,
    ...overrides
  })
}

describe('resonanceStore reducers', () => {
  beforeEach(() => resetStoreTo({ wardrobe: sampleData.wardrobe }))

  it('setActiveTab 切换子页', () => {
    useResonanceStore.getState().setActiveTab('stats')
    expect(useResonanceStore.getState().activeTab).toBe('stats')
  })

  it('setData 填充数据并置 loaded', () => {
    useResonanceStore.getState().setData(sampleData)
    const s = useResonanceStore.getState()
    expect(s.loaded).toBe(true)
    expect(s.pulls).toHaveLength(1)
    expect(s.wardrobe.ownedItemIds).toEqual([1020000001])
    expect(s.loadError).toBeNull()
  })

  it('reset 回到初始态', () => {
    useResonanceStore.getState().setData(sampleData)
    useResonanceStore.getState().setActiveTab('import')
    useResonanceStore.getState().reset()
    const s = useResonanceStore.getState()
    expect(s.loaded).toBe(false)
    expect(s.activeTab).toBe('records')
    expect(s.pulls).toHaveLength(0)
  })
})

describe('ensureResonanceLoaded', () => {
  beforeEach(() => resetStoreTo())
  afterEach(clearMockApi)

  it('首次加载拉取数据', async () => {
    setMockApi()
    await ensureResonanceLoaded()
    const s = useResonanceStore.getState()
    expect(s.loaded).toBe(true)
    expect(s.pulls).toHaveLength(1)
  })

  it('IPC 拒绝时写 loadError 且不污染数据', async () => {
    setMockApi({
      getData: vi.fn(() => Promise.reject(new Error('db unavailable')))
    })
    await ensureResonanceLoaded()
    const s = useResonanceStore.getState()
    expect(s.loaded).toBe(false)
    expect(s.loadError).toBe('db unavailable')
    expect(s.pulls).toHaveLength(0)
  })
})

describe('previewImport', () => {
  beforeEach(() =>
    resetStoreTo({
      loaded: true,
      pulls: sampleData.pulls,
      edits: sampleData.edits,
      wardrobe: sampleData.wardrobe,
      activeTab: 'import'
    })
  )
  afterEach(clearMockApi)

  it('解析文件并统计新增/重复', async () => {
    setMockApi({
      readImportFile: vi.fn(() =>
        Promise.resolve({
          content: JSON.stringify({
            pulls: {
              2: [[T, '1020000001']],
              3: [[T, '1020000009']]
            }
          }),
          sizeBytes: 100
        })
      )
    })
    const summary = await previewImport('C:\\f.json')
    expect(summary.format).toBe('current')
    expect(summary.counts.added).toBe(1)
    expect(summary.counts.duplicate).toBe(1)
    expect(summary.sections.pulls).toBe(true)
    // 暂存解析结果供提交
    expect(useResonanceStore.getState().pendingImport).not.toBeNull()
  })

  it('结构错误向上抛且不暂存', async () => {
    setMockApi({
      readImportFile: vi.fn(() => Promise.resolve({ content: '{broken', sizeBytes: 7 }))
    })
    await expect(previewImport('C:\\f.json')).rejects.toThrow()
    expect(useResonanceStore.getState().pendingImport).toBeNull()
  })
})

/** 构造 current 格式导入文本（pulls 指定条数 + 可选 pearpal/wardrobe 段） */
function buildImportText(options: {
  pullCount: number
  withPearpal?: boolean
  withWardrobe?: boolean
}): string {
  const pulls: string[][] = []
  for (let i = 0; i < options.pullCount; i++) {
    pulls.push([T, String(1020000000 + i)])
  }
  const payload: Record<string, unknown> = { version: 1, pulls: { 2: pulls } }
  if (options.withPearpal) {
    payload.pearpal = {
      2: [
        {
          card_pool_id: '2',
          pool_cnt: 0,
          result: '1020000001',
          times_from_last_five_stars: 3,
          times_from_last_four_stars: 1,
          rarity: '5'
        }
      ]
    }
  }
  if (options.withWardrobe) {
    payload.wardrobe = { version: 1, ownedItemIds: [1020000001], updatedAt: 'x' }
  }
  return JSON.stringify(payload)
}

/** 主进程 commitImport 批次参数（同 ResonanceCommitImportBatch，测试内便于断言） */
type CommitBatchArg = {
  pulls: Array<{ bannerId: string; itemId: string; obtainedAt: string }>
  edits: unknown[]
  pearpal: Array<{ bannerId: string; itemId: string; poolCnt: number; obtainedAt: string }>
  evo: unknown[]
  includeWardrobe?: boolean
  wardrobe?: Record<string, unknown>
  includeWishlist?: boolean
  wishlist?: ResonanceBannerWishlistData
}

describe('commitPendingImport', () => {
  beforeEach(() =>
    resetStoreTo({
      loaded: true,
      pulls: sampleData.pulls,
      edits: sampleData.edits,
      wardrobe: sampleData.wardrobe,
      activeTab: 'import'
    })
  )
  afterEach(clearMockApi)

  it('无暂存数据时拒绝执行', async () => {
    setMockApi()
    await expect(commitPendingImport({ includeWardrobe: false })).rejects.toThrow()
  })

  it('按 MAX_COMMIT_BATCH_ROWS 分批提交、pearpal 合成时间、提交后刷新并清空暂存', async () => {
    const onProgress = vi.fn()
    const commitImport = vi.fn((batch: CommitBatchArg) =>
      Promise.resolve({ imported: batch.pulls.length + batch.pearpal.length })
    )
    const getData = vi.fn(() => Promise.resolve(sampleData))
    setMockApi({ commitImport, getData })

    const parsed = parseImportFileText(
      buildImportText({ pullCount: MAX_COMMIT_BATCH_ROWS + 1, withPearpal: true })
    )
    useResonanceStore.getState().setPendingImport(parsed)

    const imported = await commitPendingImport({ includeWardrobe: false, onProgress })
    expect(imported).toBe(MAX_COMMIT_BATCH_ROWS + 1 + 1)
    expect(commitImport).toHaveBeenCalledTimes(2)
    const first = commitImport.mock.calls[0]![0]
    const second = commitImport.mock.calls[1]![0]
    expect(first.pulls).toHaveLength(MAX_COMMIT_BATCH_ROWS)
    expect(second.pulls).toHaveLength(1)
    // pearpal 记录无真实时间：以处理时刻合成占位（切片按批窗口独立进行，1 条落在第一批）
    expect(first.pearpal).toHaveLength(1)
    expect(first.pearpal[0]!.obtainedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(second.pearpal).toHaveLength(0)
    expect(second.includeWardrobe).toBeUndefined()
    // 进度回调按累计行数推进
    expect(onProgress).toHaveBeenLastCalledWith(
      MAX_COMMIT_BATCH_ROWS + 1 + 1,
      MAX_COMMIT_BATCH_ROWS + 1 + 1
    )
    // 提交后重拉数据并清空暂存
    expect(getData).toHaveBeenCalled()
    expect(useResonanceStore.getState().pendingImport).toBeNull()
    expect(useResonanceStore.getState().importRunning).toBe(false)
  })

  it('includeWardrobe 时衣橱随最后一个批次提交', async () => {
    const commitImport = vi.fn((_batch: CommitBatchArg) => Promise.resolve({ imported: 1 }))
    setMockApi({ commitImport })
    const parsed = parseImportFileText(buildImportText({ pullCount: 1, withWardrobe: true }))
    useResonanceStore.getState().setPendingImport(parsed)

    await commitPendingImport({ includeWardrobe: true })
    expect(commitImport).toHaveBeenCalledTimes(1)
    const batch = commitImport.mock.calls[0]![0]
    expect(batch.includeWardrobe).toBe(true)
    expect(batch.wardrobe).toBeDefined()
    expect(batch.wardrobe!.ownedItemIds).toContain(1020000001)
  })

  it('isCancelled 返回 true 时中止后续批次（已写入部分保留，暂存清空）', async () => {
    const commitImport = vi.fn((batch: CommitBatchArg) =>
      Promise.resolve({ imported: batch.pulls.length })
    )
    setMockApi({ commitImport })
    const parsed = parseImportFileText(buildImportText({ pullCount: MAX_COMMIT_BATCH_ROWS + 1 }))
    useResonanceStore.getState().setPendingImport(parsed)

    let checks = 0
    const imported = await commitPendingImport({
      includeWardrobe: false,
      isCancelled: () => ++checks > 1
    })
    expect(commitImport).toHaveBeenCalledTimes(1)
    expect(imported).toBe(MAX_COMMIT_BATCH_ROWS)
    expect(useResonanceStore.getState().pendingImport).toBeNull()
  })
})

describe('exportResonanceData', () => {
  afterEach(clearMockApi)

  it('有数据时组装载荷并写盘', async () => {
    resetStoreTo({ ...sampleData })
    const exportFn = vi.fn((_filePath: string, _payload: unknown) =>
      Promise.resolve({ path: 'C:\\out.json', recordCount: 2 })
    )
    setMockApi({ export: exportFn })
    const result = await exportResonanceData({
      filePath: 'C:\\out.json',
      includePulls: true,
      includeEdits: true,
      includePearpal: true,
      includeEvo: true,
      includeWardrobe: true
    })
    expect(exportFn).toHaveBeenCalledTimes(1)
    expect(exportFn.mock.calls[0]![0]).toBe('C:\\out.json')
    expect(result).toEqual({ path: 'C:\\out.json', recordCount: 2 })
  })

  it('无可导出内容时返回 null 且不调用 IPC', async () => {
    resetStoreTo()
    const exportFn = vi.fn()
    setMockApi({ export: exportFn })
    const result = await exportResonanceData({
      filePath: 'C:\\out.json',
      includePulls: true,
      includeEdits: true,
      includePearpal: true,
      includeEvo: true,
      includeWardrobe: true
    })
    expect(result).toBeNull()
    expect(exportFn).not.toHaveBeenCalled()
  })
})

describe('updateWardrobeItems / clearAllResonanceData', () => {
  afterEach(clearMockApi)

  it('updateWardrobeItems 调用 IPC 并更新本地衣橱', async () => {
    resetStoreTo({ ...sampleData })
    const updated = { ...emptyWardrobe, ownedItemIds: [1020000002], updatedAt: 'y' }
    const updateWardrobe = vi.fn(() => Promise.resolve({ wardrobe: updated }))
    setMockApi({ updateWardrobe })
    const result = await updateWardrobeItems([{ category: 'item', itemId: 1020000002 }], [])
    expect(updateWardrobe).toHaveBeenCalledWith([{ category: 'item', itemId: 1020000002 }], [])
    expect(result).toEqual(updated)
    expect(useResonanceStore.getState().wardrobe).toEqual(updated)
  })

  it('clearAllResonanceData 调用 IPC、复位 store 并重拉空数据', async () => {
    resetStoreTo({ ...sampleData })
    const clearAll = vi.fn(() => Promise.resolve({ cleared: true }))
    const getData = vi.fn(() =>
      Promise.resolve({ pulls: [], edits: [], pearpal: [], evo: [], wardrobe: emptyWardrobe })
    )
    setMockApi({ clearAll, getData })
    await clearAllResonanceData()
    expect(clearAll).toHaveBeenCalledTimes(1)
    // reset 后立即重拉，避免容器停留在加载态
    expect(getData).toHaveBeenCalled()
    const s = useResonanceStore.getState()
    expect(s.loaded).toBe(true)
    expect(s.pulls).toHaveLength(0)
    expect(s.wardrobe).toEqual(emptyWardrobe)
  })
})

describe('resonanceStore 卡池心愿单', () => {
  afterEach(clearMockApi)

  it('getData 返回的 wishlist 进入 store；缺该字段时回退空表', async () => {
    setMockApi({ getData: vi.fn(() => Promise.resolve(sampleDataWithWishlist)) })
    await ensureResonanceLoaded(true)
    expect(useResonanceStore.getState().wishlist).toEqual({
      version: 1,
      entries: [{ bannerId: 74 }, { bannerId: 77 }]
    })

    setMockApi({ getData: vi.fn(() => Promise.resolve(sampleData)) })
    await ensureResonanceLoaded(true)
    expect(useResonanceStore.getState().wishlist).toEqual(emptyWishlist)
  })

  it('toggleBannerWish 加入后再点移除，本地状态以 IPC 回传值为准', async () => {
    resetStoreTo({ loaded: true, wishlist: emptyWishlist })
    const setWishlist = vi.fn((wishlist: ResonanceBannerWishlistData) =>
      Promise.resolve({ wishlist })
    )
    setMockApi({ setWishlist })

    await toggleBannerWish(74)
    expect(setWishlist).toHaveBeenCalledWith({ version: 1, entries: [{ bannerId: 74 }] })
    expect(useResonanceStore.getState().wishlist).toEqual({
      version: 1,
      entries: [{ bannerId: 74 }]
    })

    await toggleBannerWish(74)
    expect(useResonanceStore.getState().wishlist).toEqual(emptyWishlist)
  })

  it('写通道失败时回滚乐观更新并向上抛出', async () => {
    const previous: ResonanceBannerWishlistData = { version: 1, entries: [{ bannerId: 30 }] }
    resetStoreTo({ loaded: true, wishlist: previous })
    setMockApi({
      setWishlist: vi.fn(() => Promise.reject(new Error('wishlist write failed')))
    })

    await expect(toggleBannerWish(74)).rejects.toThrow('wishlist write failed')
    expect(useResonanceStore.getState().wishlist).toEqual(previous)
  })

  it('includeWishlist 时心愿单随最后一个批次提交；未勾选则不携带', async () => {
    const parsed = parseImportFileText(
      JSON.stringify({
        pulls: { 2: [[T, '1020000001']] },
        bannerWishlist: { version: 1, entries: [{ bannerId: 76 }] }
      })
    )

    const commitImport = vi.fn((_batch: CommitBatchArg) => Promise.resolve({ imported: 1 }))
    resetStoreTo({ loaded: true, activeTab: 'import', pendingImport: parsed })
    setMockApi({ commitImport })
    await commitPendingImport({ includeWardrobe: false, includeWishlist: true })
    expect(commitImport.mock.calls[0]![0].includeWishlist).toBe(true)
    expect(commitImport.mock.calls[0]![0].wishlist).toEqual({
      version: 1,
      entries: [{ bannerId: 76 }]
    })

    const commitImport2 = vi.fn((_batch: CommitBatchArg) => Promise.resolve({ imported: 1 }))
    resetStoreTo({ loaded: true, activeTab: 'import', pendingImport: parsed })
    setMockApi({ commitImport: commitImport2 })
    await commitPendingImport({ includeWardrobe: false })
    expect(commitImport2.mock.calls[0]![0].wishlist).toBeUndefined()
  })

  it('导出把 store 内 wishlist 送进载荷（仅勾选时）', async () => {
    const exportFn = vi.fn((_filePath: string, _payload: Record<string, unknown>) =>
      Promise.resolve({ path: 'C:\\o.json', recordCount: 0 })
    )
    resetStoreTo({
      loaded: true,
      wishlist: { version: 1, entries: [{ bannerId: 74 }] }
    })
    setMockApi({ export: exportFn })

    await exportResonanceData({
      filePath: 'C:\\o.json',
      includePulls: false,
      includeEdits: false,
      includePearpal: false,
      includeEvo: false,
      includeWardrobe: false,
      includeWishlist: true
    })
    const payload = exportFn.mock.calls[0]![1] as unknown as {
      bannerWishlist?: ResonanceBannerWishlistData
    }
    expect(payload.bannerWishlist).toEqual({ version: 1, entries: [{ bannerId: 74 }] })

    await exportResonanceData({
      filePath: 'C:\\o.json',
      includePulls: false,
      includeEdits: false,
      includePearpal: false,
      includeEvo: false,
      includeWardrobe: false
    })
    // 未勾选 → 载荷为空 → 直接返回 null，不调用写盘通道
    expect(exportFn).toHaveBeenCalledTimes(1)
  })

  it('previewImport 把 bannerWishlist 段标记为可导入', async () => {
    setMockApi({
      readImportFile: vi.fn(() =>
        Promise.resolve({
          content: JSON.stringify({
            pulls: { 2: [[T, '1020000001']] },
            bannerWishlist: { version: 1, entries: [{ bannerId: 76 }] }
          }),
          sizeBytes: 100
        })
      )
    })
    const summary = await previewImport('C:\\f.json')
    expect(summary.sections.wishlist).toBe(true)

    setMockApi({
      readImportFile: vi.fn(() =>
        Promise.resolve({
          content: JSON.stringify({ pulls: { 2: [[T, '1020000001']] } }),
          sizeBytes: 40
        })
      )
    })
    const noWish = await previewImport('C:\\f.json')
    expect(noWish.sections.wishlist).toBe(false)
  })

  it('clearAll 后 wishlist 回到空表', async () => {
    resetStoreTo({ loaded: true, wishlist: { version: 1, entries: [{ bannerId: 74 }] } })
    setMockApi()
    await clearAllResonanceData()
    expect(useResonanceStore.getState().wishlist).toEqual(emptyWishlist)
  })
})
