import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  loadRecycleBin,
  loadNextRecycleBinPage,
  fetchNikkiRecyclePage,
  useMediaStore
} from './mediaStore'
import type { NikkiAsset } from '../../shared/sync/domain-types'
import type { AssetEditsInfo } from '../../shared/types/electron-api'

/**
 * 回收站 nikkisync 分支取数测试（T8）。
 *
 * 隐藏资产不在本地 media_files 里，回收站必须改从 asset_edits 叠加层取隐藏集
 * （listHidden），再逐条 get-asset-detail 回捞摘要 + 整页一次 path records，
 * 经 assetDetailToSummary + toAssetViewModel 映射成与本地源同口径的 MediaFile。
 */

const asset = (assetId: string): NikkiAsset => ({
  schemaVersion: 1,
  assetId,
  type: 'photo',
  state: 'ready',
  source: {
    game: 'infinity_nikki',
    uid: '101622755',
    discoveredAt: '2026-10-01T00:00:00.000Z',
    capturedAt: '2026-10-01T08:00:00.000Z'
  },
  resources: [
    {
      resourceId: `r-${assetId}`,
      role: 'source_high_quality',
      fileName: `${assetId}.png`,
      mimeType: 'image/png',
      fileExt: '.png',
      sizeBytes: 4096,
      sha256: 'aa',
      width: 100,
      height: 200
    }
  ],
  revision: 3
})

const edit = (assetId: string, over: Partial<AssetEditsInfo> = {}): AssetEditsInfo => ({
  assetId,
  isFavorite: false,
  rating: 0,
  tags: [],
  notes: '',
  categoryId: null,
  outfit: null,
  sceneCategory: null,
  sceneTime: null,
  isHidden: true,
  deletedAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...over
})

function setBridge(opts: {
  hiddenPages: Array<{ edits: AssetEditsInfo[]; total: number }>
  detail?: (assetId: string) => Promise<{ asset: NikkiAsset }>
  paths?: Record<string, Record<string, string>>
}) {
  let call = 0
  const listHidden = vi.fn().mockImplementation(async () => {
    const page = opts.hiddenPages[Math.min(call, opts.hiddenPages.length - 1)]
    call += 1
    return page
  })
  const getAssetDetail = vi
    .fn()
    .mockImplementation(opts.detail ?? (async (assetId: string) => ({ asset: asset(assetId) })))
  const getResourceRecords = vi.fn().mockResolvedValue({ byAsset: opts.paths ?? {} })
  const mediaList = vi.fn().mockResolvedValue({ files: [], total: 0, hasMore: false })
  ;(globalThis as { window?: { electronAPI?: Record<string, unknown> } }).window = {
    electronAPI: {
      nikkisync: { getAssetDetail, getResourceRecords },
      assetEdits: { listHidden, set: vi.fn() },
      media: { list: mediaList },
      category: { list: vi.fn().mockResolvedValue({ categories: [] }) }
    }
  }
  return { listHidden, getAssetDetail, getResourceRecords, mediaList }
}

beforeEach(() => {
  useMediaStore.setState({
    source: 'nikkisync',
    recycleBinFiles: [],
    recycleBinTotal: 0,
    recycleBinHasMore: false,
    recycleBinLoadingMore: false,
    recycleBinLoading: false,
    recycleBinCursor: null
  })
})

afterEach(() => {
  useMediaStore.setState({ source: 'local', recycleBinFiles: [] })
  ;(globalThis as { window?: unknown }).window = {}
})

describe('loadRecycleBin 的 nikkisync 分支', () => {
  it('正常回捞：id=assetId、deleted_at 来自 edit、file_path 来自 path records', async () => {
    const api = setBridge({
      hiddenPages: [{ edits: [edit('a/1'), edit('a/2')], total: 2 }],
      paths: {
        'a/1': { 'r-a/1': 'D:/Game/a1.png' },
        'a/2': { 'r-a/2': 'D:/Game/a2.png' }
      }
    })
    const files = await loadRecycleBin()
    expect(api.listHidden).toHaveBeenCalledWith({ limit: 200, offset: 0 })
    expect(api.mediaList).not.toHaveBeenCalled()
    expect(files?.map((file) => file.id)).toEqual(['a/1', 'a/2'])
    expect(files?.[0].file_path).toBe('D:/Game/a1.png')
    expect(files?.[0].deleted_at).toBe('2026-11-01T00:00:00.000Z')
    expect(files?.[0].is_deleted).toBe(true)
    expect(useMediaStore.getState().recycleBinTotal).toBe(2)
    expect(useMediaStore.getState().recycleBinHasMore).toBe(false)
  })

  it('单资产 detail 失败（上游已删）跳过，其余照常回捞', async () => {
    setBridge({
      hiddenPages: [{ edits: [edit('a/1'), edit('a/2')], total: 2 }],
      detail: async (assetId) => {
        if (assetId === 'a/2') throw new Error('not found')
        return { asset: asset(assetId) }
      },
      paths: { 'a/1': { 'r-a/1': 'D:/Game/a1.png' } }
    })
    const files = await loadRecycleBin()
    expect(files?.map((file) => file.id)).toEqual(['a/1'])
    expect(useMediaStore.getState().recycleBinTotal).toBe(2)
  })

  // 契约同步：旧断言「整页 detail 全失败 ⇒ 返回 null 且保留现有列表」属于
  // #fix-nikkisync-recycle-orphan-page 之前的 null 契约；本轮统一为「消费该页」，
  // 等价替换并新增 total / hasMore / loading 断言（强化，非弱化覆盖）。
  it('整页 detail 全失败 ⇒ 消费该页返回空列表，按 total 判定 hasMore', async () => {
    setBridge({
      hiddenPages: [{ edits: [edit('a/1')], total: 1 }],
      detail: async () => {
        throw new Error('runtime gone')
      }
    })
    const files = await loadRecycleBin()
    expect(files).toEqual([])
    expect(useMediaStore.getState().recycleBinFiles).toEqual([])
    expect(useMediaStore.getState().recycleBinTotal).toBe(1)
    expect(useMediaStore.getState().recycleBinHasMore).toBe(false)
    expect(useMediaStore.getState().recycleBinLoading).toBe(false)
  })

  it('空隐藏集 ⇒ 空列表 total=0', async () => {
    setBridge({ hiddenPages: [{ edits: [], total: 0 }] })
    const files = await loadRecycleBin()
    expect(files).toEqual([])
    expect(useMediaStore.getState().recycleBinTotal).toBe(0)
    expect(useMediaStore.getState().recycleBinHasMore).toBe(false)
  })

  it('续页：offset 按已消费行数推进，去重追加，末页 hasMore 置假', async () => {
    const api = setBridge({
      hiddenPages: [
        { edits: [edit('a/1'), edit('a/2')], total: 3 },
        { edits: [edit('a/3')], total: 3 }
      ],
      paths: {
        'a/1': { 'r-a/1': 'D:/Game/a1.png' },
        'a/2': { 'r-a/2': 'D:/Game/a2.png' },
        'a/3': { 'r-a/3': 'D:/Game/a3.png' }
      }
    })
    await loadRecycleBin()
    expect(useMediaStore.getState().recycleBinHasMore).toBe(true)
    await loadNextRecycleBinPage()
    expect(api.listHidden).toHaveBeenNthCalledWith(2, { limit: 200, offset: 2 })
    expect(useMediaStore.getState().recycleBinFiles.map((file) => file.id)).toEqual([
      'a/1',
      'a/2',
      'a/3'
    ])
    expect(useMediaStore.getState().recycleBinHasMore).toBe(false)
  })

  it('local 源仍走 media.list(deletedOnly)，不碰叠加层', async () => {
    useMediaStore.setState({ source: 'local' })
    const api = setBridge({ hiddenPages: [{ edits: [], total: 0 }] })
    await loadRecycleBin()
    expect(api.mediaList).toHaveBeenCalledWith(
      expect.objectContaining({ deletedOnly: true, cursor: null })
    )
    expect(api.listHidden).not.toHaveBeenCalled()
  })
})

// #fix-nikkisync-recycle-orphan-page：整页孤儿行（上游资产已删、detail 全失败）
// 必须按「已消费行数」推进分页，不能当作遍历结束或真取数失败。
describe('整页孤儿行的分页推进（#fix-nikkisync-recycle-orphan-page）', () => {
  it('R1 fetchNikkiRecyclePage 整页孤儿 ⇒ 返回消费该页的空结果，而非 null', async () => {
    setBridge({
      hiddenPages: [{ edits: [edit('a/1')], total: 3 }],
      detail: async () => {
        throw new Error('runtime gone')
      }
    })
    const page = await fetchNikkiRecyclePage(0)
    expect(page).not.toBeNull()
    expect(page?.files).toEqual([])
    expect(page?.consumed).toBe(1)
    expect(page?.total).toBe(3)
  })

  it('R2 首页有效 → 第2页整页孤儿 → 第3页有效：续页必须推进到后续页', async () => {
    const api = setBridge({
      hiddenPages: [
        { edits: [edit('a/1'), edit('a/2')], total: 4 },
        { edits: [edit('a/3')], total: 4 },
        { edits: [edit('a/4')], total: 4 }
      ],
      detail: async (assetId) => {
        if (assetId === 'a/3') throw new Error('runtime gone')
        return { asset: asset(assetId) }
      },
      paths: {
        'a/1': { 'r-a/1': 'D:/Game/a1.png' },
        'a/2': { 'r-a/2': 'D:/Game/a2.png' },
        'a/4': { 'r-a/4': 'D:/Game/a4.png' }
      }
    })
    await loadRecycleBin()
    expect(useMediaStore.getState().recycleBinHasMore).toBe(true)
    await loadNextRecycleBinPage()
    await loadNextRecycleBinPage()
    // 第 3 次 listHidden 必须以消费后的 offset=3 取页（孤儿页 consumed=1 需计入）
    expect(api.listHidden).toHaveBeenNthCalledWith(3, { limit: 200, offset: 3 })
    expect(useMediaStore.getState().recycleBinFiles.map((f) => f.id)).toEqual(['a/1', 'a/2', 'a/4'])
    expect(useMediaStore.getState().recycleBinHasMore).toBe(false)
  })

  it('R3 边界：空页 consumed=0 且 total>offset ⇒ hasMore 置假，不重复取同一页', async () => {
    const api = setBridge({
      hiddenPages: [
        { edits: [edit('a/1')], total: 2 },
        { edits: [], total: 2 }
      ],
      paths: { 'a/1': { 'r-a/1': 'D:/Game/a1.png' } }
    })
    await loadRecycleBin()
    expect(useMediaStore.getState().recycleBinHasMore).toBe(true)
    await loadNextRecycleBinPage()
    expect(useMediaStore.getState().recycleBinHasMore).toBe(false)
    const callsAfter = api.listHidden.mock.calls.length
    await loadNextRecycleBinPage()
    expect(api.listHidden).toHaveBeenCalledTimes(callsAfter)
  })
})
