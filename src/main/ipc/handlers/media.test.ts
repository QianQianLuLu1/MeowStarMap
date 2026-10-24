/**
 * @layer L3
 * @module src/main/ipc/handlers/media
 * @coverage 媒体域 IPC handler 注册与执行
 * @dependencies electron / MediaRepository / file-utils / phash / duplicate-scoring
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'
import type { ScanResult, PhashResult, MarkDuplicatesResult } from '../../../shared/types/duplicate'

const {
  handleMock,
  showMessageBoxMock,
  shellTrashItemMock,
  pathExistsMock,
  unlinkMock,
  calculateFileHashMock,
  hammingDistanceMock,
  pickBestIdMock,
  repoMock,
  generatePhashForUnprocessedMock,
  markDuplicatesMock,
  loggerWarnMock
} = vi.hoisted(() => {
  return {
    handleMock: vi.fn(),
    showMessageBoxMock: vi.fn(),
    shellTrashItemMock: vi.fn(),
    pathExistsMock: vi.fn(),
    // #fix-permanent-delete-error-toast：缩略图清理 best-effort unlink（仅缓存目录内）
    unlinkMock: vi.fn().mockResolvedValue(undefined),
    calculateFileHashMock: vi.fn(),
    hammingDistanceMock: vi.fn(),
    pickBestIdMock: vi.fn(),
    repoMock: {
      updateRating: vi.fn(),
      updateFavorite: vi.fn(),
      updateTags: vi.fn(),
      updateNotes: vi.fn(),
      updateCategory: vi.fn(),
      updateOutfit: vi.fn(),
      updateSceneTime: vi.fn(),
      hardDelete: vi.fn(),
      softDeleteBatch: vi.fn(),
      restoreBatch: vi.fn(),
      softDeleteForPermanentDelete: vi.fn(),
      hardDeleteBatch: vi.fn(),
      cleanupMissingRecords: vi.fn().mockReturnValue(0),
      cleanupCorruptedRecords: vi.fn().mockReturnValue(0),
      removeMissingRecord: vi.fn().mockReturnValue(true),
      // sync-integration 阶段5：清理前候选 id 查询（journal asset.deleted 需要 id 列表）
      listCleanupCandidateIds: vi.fn().mockReturnValue([]),
      getOutfitAggStats: vi.fn().mockReturnValue([]),
      getLatestOutfitMedia: vi.fn(),
      getDuplicateCandidates: vi.fn().mockReturnValue([]),
      getPhashRows: vi.fn().mockReturnValue([]),
      getGroupCounts: vi.fn().mockReturnValue([]),
      createCategory: vi.fn().mockReturnValue(1),
      updateCategoryFields: vi.fn(),
      // FIX(组8-1): category:delete 新增系统分类前置查询，mock 默认非系统分类
      isSystemCategory: vi.fn().mockReturnValue(false),
      deleteCategoryCascade: vi.fn(),
      reorderCategories: vi.fn(),
      listCategories: vi.fn().mockReturnValue([]),
      listProfiles: vi.fn().mockReturnValue([]),
      addProfile: vi.fn(),
      updateProfileFields: vi.fn(),
      deleteProfileAndReassign: vi.fn(),
      touchProfileActive: vi.fn(),
      getProfileByUid: vi.fn(),
      transferFilesToProfile: vi.fn(),
      getProfileBaseStats: vi.fn().mockReturnValue({}),
      getProfileTopOutfits: vi.fn().mockReturnValue([]),
      getProfileTopScenes: vi.fn().mockReturnValue([]),
      getProfileTimeDistribution: vi.fn().mockReturnValue([]),
      getMediaForSceneAnalysis: vi.fn().mockReturnValue([]),
      getMediaPathsByIds: vi.fn().mockReturnValue([]),
      getSoftDeletedMediaPaths: vi.fn().mockReturnValue([]),
      // #fix-gallery-delete-thumbnail-cleanup：原生 LQ 记录联动硬删（按路径查 id）
      getMediaIdByPath: vi.fn().mockReturnValue(undefined),
      listMedia: vi
        .fn()
        .mockReturnValue({ rows: [], total: 0, page: 1, pageSize: 50, hasMore: false }),
      getDuplicateGroupRows: vi.fn().mockReturnValue([]),
      getOriginalsByIds: vi.fn().mockReturnValue([])
    },
    generatePhashForUnprocessedMock: vi.fn(),
    markDuplicatesMock: vi.fn(),
    loggerWarnMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  dialog: { showMessageBox: showMessageBoxMock },
  shell: { trashItem: shellTrashItemMock },
  // ProgressThrottle / taskRegistry 内部调用 BrowserWindow.getAllWindows 推送进度
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../../utils/file-utils', () => ({
  calculateFileHash: calculateFileHashMock,
  pathExists: pathExistsMock
}))
// #fix-permanent-delete-error-toast：仅替换 unlink，其余 fs/promises 保持真实实现
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const mocked = { ...actual, unlink: unlinkMock }
  return { ...mocked, default: mocked }
})
vi.mock('../../utils/phash', () => ({ hammingDistance: hammingDistanceMock }))
vi.mock('../../utils/duplicate-scoring', () => ({ pickBestId: pickBestIdMock }))
vi.mock('../../utils/concurrency', () => ({
  runWithConcurrency: vi.fn(async (tasks: (() => unknown)[], _n: number) => {
    for (const t of tasks) await t()
  })
}))

vi.mock('../../database/media-repository', () => ({
  // vitest 5：生产代码以 new MediaRepository(...) 使用桩，箭头函数不可构造会抛
  // "is not a constructor"，必须用 function 表达式返回实例
  MediaRepository: vi.fn(function createMediaRepositoryMock() {
    return repoMock
  })
}))

vi.mock('../../services/thumbnail-phash-service', () => ({
  generatePhashForUnprocessed: generatePhashForUnprocessedMock,
  markDuplicates: markDuplicatesMock
}))

// sync-integration 阶段5：analyzeSceneTime journal 用例需要行数据触发动态 import，
// mock 掉 sharp 依赖的场景亮度分析
vi.mock('../../utils/scene-brightness', () => ({
  analyzeSceneBrightness: vi.fn(async () => 'day')
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: loggerWarnMock, error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerMediaMetadataHandlers } from './media-handler'
import { registerMediaLifecycleHandlers } from './media-lifecycle-handler'
import { registerMediaCleanupHandlers } from './media-cleanup-handler'
import { registerDuplicateHandlers } from './duplicate-handler'
import { registerSimilarHandlers } from './similar-handler'
import { registerSearchIndexHandlers } from './search-index-handler'
import { registerCategoryHandlers } from './category-handler'
import { registerProfileHandlers } from './profile-handler'

// 拆分后保留兼容包装：等价于原 registerMediaHandlers(ctx) 的全量注册
function registerMediaHandlers(ctx: HandlerContext): void {
  registerMediaMetadataHandlers(ctx)
  registerMediaLifecycleHandlers(ctx)
  registerMediaCleanupHandlers(ctx)
  registerDuplicateHandlers(ctx)
  registerSimilarHandlers(ctx)
  registerSearchIndexHandlers(ctx)
  registerCategoryHandlers(ctx)
  registerProfileHandlers(ctx)
}

function makeCtx(db?: unknown): HandlerContext {
  return {
    dbManager: {
      getDatabase: vi.fn(() => db ?? {}),
      // 数据库写操作进程拆分：handler getRepo() 会读取 workerBridge 与 dbPath
      getWorkerBridge: vi.fn(() => undefined),
      getDbPath: vi.fn(() => '/mock/db.sqlite')
    },
    // #fix-permanent-delete-error-toast：缩略图清理需限定在缓存目录内
    thumbnailGen: { getCacheDir: () => 'C:\\cache\\thumbnails' },
    getMainWindow: () => null,
    notifyMediaUpdated: vi.fn(),
    invalidateMediaPathCache: vi.fn(),
    applyUITheme: vi.fn(),
    isThumbnailsGenerating: () => false,
    setThumbnailsGenerating: vi.fn()
  } as unknown as HandlerContext
}

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  for (const call of handleMock.mock.calls) {
    if (call[0] === channel) return call[1]
  }
  throw new Error(`未找到 channel: ${channel}`)
}

/**
 * 模拟 preload call() 的解包行为（预防措施 6.2）
 *
 * preload 的 call() 收到 IpcResponse 后：
 * - success=true → 返回 data（前端拿到的就是 handler 的原始返回值）
 * - success=false → 抛错
 *
 * 此 helper 让测试能验证前端实际接收到的值，
 * 确保 data 内层包含 success 字段（本次 bug 的根因）。
 */
async function simulateCall<T>(handlerResult: unknown): Promise<T> {
  const res = handlerResult as { success: boolean; data: T; error?: { message: string } }
  if (res && res.success) return res.data
  throw new Error(res?.error?.message ?? 'IPC 调用失败')
}

describe('registerMediaHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    showMessageBoxMock.mockReset()
    shellTrashItemMock.mockReset()
    pathExistsMock.mockReset()
    // #fix-permanent-delete-error-toast + #fix-recyclebin-permanent-delete：
    // unlink 承担文件物理删除与缩略图清理两种调用；mockReset 后重设默认 resolved(undefined)，
    // 防止三态用例的 rejected 实现泄漏到后续用例
    unlinkMock.mockReset().mockResolvedValue(undefined)
    calculateFileHashMock.mockReset()
    hammingDistanceMock.mockReset()
    pickBestIdMock.mockReset()
    generatePhashForUnprocessedMock.mockReset()
    markDuplicatesMock.mockReset()
    loggerWarnMock.mockClear()
    Object.values(repoMock).forEach((fn) => (fn as ReturnType<typeof vi.fn>).mockClear?.())
    // 重设默认返回值
    repoMock.cleanupMissingRecords.mockReturnValue(0)
    repoMock.removeMissingRecord.mockReturnValue(true)
    repoMock.getOutfitAggStats.mockReturnValue([])
    repoMock.getDuplicateCandidates.mockReturnValue([])
    repoMock.getPhashRows.mockReturnValue([])
    repoMock.getGroupCounts.mockReturnValue([])
    repoMock.createCategory.mockReturnValue(1)
    repoMock.listCategories.mockReturnValue([])
    repoMock.listProfiles.mockReturnValue([])
    repoMock.getProfileBaseStats.mockReturnValue({})
    repoMock.getProfileTopOutfits.mockReturnValue([])
    repoMock.getProfileTopScenes.mockReturnValue([])
    repoMock.getProfileTimeDistribution.mockReturnValue([])
    repoMock.getMediaForSceneAnalysis.mockReturnValue([])
    repoMock.getMediaPathsByIds.mockReturnValue([])
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([])
    repoMock.getMediaIdByPath.mockReturnValue(undefined)
    repoMock.listMedia.mockReturnValue({
      rows: [],
      total: 0,
      page: 1,
      pageSize: 50,
      hasMore: false
    })
    repoMock.getDuplicateGroupRows.mockReturnValue([])
    repoMock.getOriginalsByIds.mockReturnValue([])
    repoMock.getProfileByUid.mockReturnValue(null)
    repoMock.removeMissingRecord.mockReturnValue(true)
  })

  it('应注册全部 media/category/profile/duplicate channel', () => {
    registerMediaHandlers(makeCtx())
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('media:updateRating')
    expect(channels).toContain('media:updateFavorite')
    expect(channels).toContain('media:updateTags')
    expect(channels).toContain('media:updateNotes')
    expect(channels).toContain('media:updateCategory')
    expect(channels).toContain('media:updateOutfit')
    expect(channels).toContain('media:analyzeSceneTime')
    expect(channels).toContain('media:delete')
    expect(channels).toContain('media:softDelete')
    expect(channels).toContain('media:restore')
    expect(channels).toContain('media:permanentDelete')
    expect(channels).toContain('media:emptyRecycleBin')
    expect(channels).toContain('media:cleanupMissing')
    expect(channels).toContain('media:removeMissing')
    expect(channels).toContain('media:getOutfitStats')
    expect(channels).toContain('media:findDuplicates')
    expect(channels).toContain('media:findSimilar')
    expect(channels).toContain('media:generatePhash')
    expect(channels).toContain('media:markDuplicates')
    expect(channels).toContain('media:list')
    expect(channels).toContain('media:getGroupCounts')
    expect(channels).toContain('category:create')
    expect(channels).toContain('category:update')
    expect(channels).toContain('category:delete')
    expect(channels).toContain('category:reorder')
    expect(channels).toContain('category:list')
    expect(channels).toContain('profile:list')
    expect(channels).toContain('profile:add')
    expect(channels).toContain('profile:update')
    expect(channels).toContain('profile:delete')
    expect(channels).toContain('profile:setCurrent')
    expect(channels).toContain('profile:transferFiles')
    expect(channels).toContain('profile:getStats')
    expect(channels).toContain('duplicate:listGroups')
  })

  it('media:updateRating 成功时返回 { updated: true }', async () => {
    const ctx = makeCtx()
    registerMediaHandlers(ctx)
    const result = (await getHandler('media:updateRating')([1, 5])) as {
      success: true
      data: { updated: boolean }
    }
    expect(repoMock.updateRating).toHaveBeenCalledWith(1, 5)
    expect(ctx.notifyMediaUpdated).toHaveBeenCalled()
    expect(result.data.updated).toBe(true)
  })

  it('media:updateFavorite 调用 repo 并通知', async () => {
    registerMediaHandlers(makeCtx())
    await getHandler('media:updateFavorite')([1, true])
    expect(repoMock.updateFavorite).toHaveBeenCalledWith(1, true)
  })

  it('media:updateTags 调用 repo 并通知', async () => {
    registerMediaHandlers(makeCtx())
    await getHandler('media:updateTags')([1, ['tag1', 'tag2']])
    expect(repoMock.updateTags).toHaveBeenCalledWith(1, ['tag1', 'tag2'])
  })

  it('media:updateNotes 调用 repo 并通知', async () => {
    registerMediaHandlers(makeCtx())
    await getHandler('media:updateNotes')([1, '备注'])
    expect(repoMock.updateNotes).toHaveBeenCalledWith(1, '备注')
  })

  it('media:updateCategory 传 null 也支持', async () => {
    registerMediaHandlers(makeCtx())
    await getHandler('media:updateCategory')([1, null])
    expect(repoMock.updateCategory).toHaveBeenCalledWith(1, null)
  })

  it('media:updateOutfit 调用 repo 并通知', async () => {
    registerMediaHandlers(makeCtx())
    await getHandler('media:updateOutfit')([1, '套装A'])
    expect(repoMock.updateOutfit).toHaveBeenCalledWith(1, '套装A')
  })

  it('media:analyzeSceneTime 无待分析图片时返回 analyzed=0', async () => {
    repoMock.getMediaForSceneAnalysis.mockReturnValue([])
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:analyzeSceneTime')([undefined])) as {
      success: true
      data: { analyzed: number; message: string }
    }
    expect(result.data.analyzed).toBe(0)
    expect(result.data.message).toContain('没有需要分析')
  })

  it('media:delete 调用 hardDelete 并通知', async () => {
    registerMediaHandlers(makeCtx())
    await getHandler('media:delete')([1])
    expect(repoMock.hardDelete).toHaveBeenCalledWith(1)
  })

  // #fix-permanent-delete-error-toast：物理删除 DB 记录后应清理其缩略图缓存（仅缓存目录内）
  it('media:delete 物理删除后清理缓存目录内缩略图', async () => {
    repoMock.getMediaPathsByIds.mockReturnValue([
      { id: 7, file_path: 'C:\\media\\g.jpg', thumbnail: 'C:\\cache\\thumbnails\\t7.jpg' }
    ])
    pathExistsMock.mockResolvedValue(true)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:delete')([7])) as { success: boolean }
    expect(result.success).toBe(true)
    expect(repoMock.hardDelete).toHaveBeenCalledWith(7)
    expect(unlinkMock).toHaveBeenCalledWith('C:\\cache\\thumbnails\\t7.jpg')
  })

  it('media:delete 缩略图为空或不在缓存目录时跳过清理', async () => {
    repoMock.getMediaPathsByIds.mockReturnValue([
      { id: 8, file_path: 'C:\\media\\h.jpg', thumbnail: null },
      { id: 9, file_path: 'C:\\media\\i.jpg', thumbnail: 'C:\\game\\NikkiPhotos_LowQuality\\i.jpg' }
    ])
    pathExistsMock.mockResolvedValue(true)
    registerMediaHandlers(makeCtx())
    await getHandler('media:delete')([8])
    await getHandler('media:delete')([9])
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  // #fix-gallery-delete-thumbnail-cleanup 红灯 B1：永久删除 DB 记录后，除缓存缩略图外，
  // 还必须清理由 file_path 严格推导的游戏原生 LQ 缩略图文件，并同步硬删该 LQ 的 DB 记录
  //（LQ 文件本身也是入库媒体记录，scene_category='thumbnail'，只删文件会留悬空记录）。
  it('media:delete 永久删除后清理原生 LQ 缩略图文件并硬删其 DB 记录', async () => {
    const hq = 'C:\\game\\X6Game\\Saved\\GamePlayPhotos\\1001\\NikkiPhotos_HighQuality\\p.jpg'
    const lq = 'C:\\game\\X6Game\\Saved\\GamePlayPhotos\\1001\\NikkiPhotos_LowQuality\\p.jpg'
    repoMock.getMediaPathsByIds.mockReturnValue([{ id: 7, file_path: hq, thumbnail: lq }])
    repoMock.getMediaIdByPath.mockReturnValue(99)
    pathExistsMock.mockResolvedValue(true)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:delete')([7])) as { success: boolean }
    expect(result.success).toBe(true)
    expect(unlinkMock).toHaveBeenCalledWith(lq)
    expect(repoMock.getMediaIdByPath).toHaveBeenCalledWith(lq)
    expect(repoMock.hardDelete).toHaveBeenCalledWith(99)
  })

  // #fix-gallery-delete-thumbnail-cleanup 红灯 B2：缓存缩略图三档位（引用文件 + _low + _high）一并清理
  it('media:delete 永久删除后同时清理缓存缩略图 _low/_high 档位', async () => {
    repoMock.getMediaPathsByIds.mockReturnValue([
      { id: 8, file_path: 'C:\\media\\x.jpg', thumbnail: 'C:\\cache\\thumbnails\\t8.jpg' }
    ])
    pathExistsMock.mockResolvedValue(true)
    registerMediaHandlers(makeCtx())
    await getHandler('media:delete')([8])
    expect(unlinkMock).toHaveBeenCalledWith('C:\\cache\\thumbnails\\t8.jpg')
    expect(unlinkMock).toHaveBeenCalledWith('C:\\cache\\thumbnails\\t8_low.jpg')
    expect(unlinkMock).toHaveBeenCalledWith('C:\\cache\\thumbnails\\t8_high.jpg')
  })

  it('media:softDelete 批量软删除并返回消息', async () => {
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:softDelete')([[1, 2, 3]])) as {
      success: true
      data: { success: boolean; message: string }
    }
    expect(repoMock.softDeleteBatch).toHaveBeenCalledWith([1, 2, 3])
    expect(result.data.message).toContain('3')
    expect(result.data.success).toBe(true)
  })

  it('media:restore 批量恢复并返回消息', async () => {
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:restore')([[1, 2]])) as {
      success: true
      data: { message: string }
    }
    expect(repoMock.restoreBatch).toHaveBeenCalledWith([1, 2])
    expect(result.data.message).toContain('2')
  })

  // #fix-permanent-delete-error-toast：渲染端 ConfirmDialog 已承担二次确认，
  // 主进程不再弹原生对话框（修复前用户需重复确认，取消时还会误报错误）
  it('media:permanentDelete 不再弹原生确认、直接执行三阶段删除', async () => {
    repoMock.getMediaPathsByIds.mockReturnValue([{ id: 1, file_path: '/a' }])
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:permanentDelete')([[1]])) as {
      success: boolean
      data?: { deletedCount: number; failedCount: number }
    }
    expect(showMessageBoxMock).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.data?.deletedCount).toBe(1)
    expect(repoMock.softDeleteForPermanentDelete).toHaveBeenCalledWith([1])
    expect(repoMock.hardDeleteBatch).toHaveBeenCalledWith([1])
  })

  it('media:permanentDelete 确认后软删→移入系统回收站→硬删', async () => {
    repoMock.getMediaPathsByIds.mockReturnValue([
      { id: 1, file_path: '/a' },
      { id: 2, file_path: '/b' }
    ])
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:permanentDelete')([[1, 2]])) as {
      success: true
      data: { deletedCount: number; failedCount: number }
    }
    expect(repoMock.softDeleteForPermanentDelete).toHaveBeenCalledWith([1, 2])
    expect(shellTrashItemMock).toHaveBeenCalledWith('/a')
    expect(shellTrashItemMock).toHaveBeenCalledWith('/b')
    expect(repoMock.hardDeleteBatch).toHaveBeenCalledWith([1, 2])
    expect(result.data.deletedCount).toBe(2)
    expect(result.data.failedCount).toBe(0)
  })

  // #fix-empty-recyclebin-system-trash 红灯 R2：「彻底删除」必须把文件移入系统回收站
  //（shell.trashItem），不得 fsp.unlink 物理删除——回收站页确认文案承诺
  //「文件会先移至系统回收站，之后无法从本应用恢复」，a5d154c 的 unlink 实现与承诺矛盾，
  // 80d910a（软删除改纯 DB 标记、文件留在原位）后清空/彻底删除 100% 永久删除用户文件。
  it('media:permanentDelete 确认后对每个文件调用 shell.trashItem 且不以 unlink 删除媒体文件', async () => {
    repoMock.getMediaPathsByIds.mockReturnValue([{ id: 1, file_path: '/a' }])
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:permanentDelete')([[1]])) as {
      success: true
      data: { deletedCount: number; failedCount: number }
    }
    expect(shellTrashItemMock).toHaveBeenCalledWith('/a')
    expect(unlinkMock).not.toHaveBeenCalledWith('/a')
    expect(result.data.deletedCount).toBe(1)
    expect(result.data.failedCount).toBe(0)
  })

  // #fix-permanent-delete-error-toast：阶段 3 硬删后应清理缩略图缓存——
  // 仅限应用缓存目录内文件；游戏原生 LQ（NikkiPhotos_LowQuality）与外部路径绝不触碰
  it('media:permanentDelete 硬删后仅清理缓存目录内缩略图', async () => {
    repoMock.getMediaPathsByIds.mockReturnValue([
      { id: 1, file_path: '/a', thumbnail: 'C:\\cache\\thumbnails\\t1.jpg' },
      {
        id: 2,
        file_path: '/b',
        thumbnail: 'C:\\game\\X6Game\\Saved\\GamePlayPhotos\\NikkiPhotos_LowQuality\\b.jpg'
      },
      { id: 3, file_path: '/c', thumbnail: null }
    ])
    pathExistsMock.mockResolvedValue(true)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:permanentDelete')([[1, 2, 3]])) as {
      success: boolean
    }
    expect(result.success).toBe(true)
    expect(repoMock.hardDeleteBatch).toHaveBeenCalledWith([1, 2, 3])
    // #fix-empty-recyclebin-system-trash：媒体文件经 shell.trashItem 移入系统回收站（3 个），
    // 缩略图清理仍走 unlink（仅缓存目录内 1 个）
    expect(shellTrashItemMock).toHaveBeenCalledWith('/a')
    expect(shellTrashItemMock).toHaveBeenCalledWith('/b')
    expect(shellTrashItemMock).toHaveBeenCalledWith('/c')
    expect(unlinkMock).toHaveBeenCalledWith('C:\\cache\\thumbnails\\t1.jpg')
    // 缓存目录外（游戏原生 LQ）绝不触碰
    expect(unlinkMock).not.toHaveBeenCalledWith(
      'C:\\game\\X6Game\\Saved\\GamePlayPhotos\\NikkiPhotos_LowQuality\\b.jpg'
    )
  })

  // #fix-gallery-delete-thumbnail-cleanup 红灯 B3：阶段 4 还须清理由 file_path 严格推导的
  // 原生 LQ 缩略图文件并硬删其 DB 记录（本用例 file_path 命中 GPP+HQ 推导规则，
  // 与上一用例的非 GPP file_path 形成策略边界对照）
  it('media:permanentDelete 阶段 4 清理原生 LQ 文件并硬删其 DB 记录', async () => {
    const hq = 'C:\\game\\X6Game\\Saved\\GamePlayPhotos\\1001\\NikkiPhotos_HighQuality\\p.jpg'
    const lq = 'C:\\game\\X6Game\\Saved\\GamePlayPhotos\\1001\\NikkiPhotos_LowQuality\\p.jpg'
    repoMock.getMediaPathsByIds.mockReturnValue([{ id: 1, file_path: hq, thumbnail: lq }])
    repoMock.getMediaIdByPath.mockReturnValue(88)
    pathExistsMock.mockResolvedValue(true)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:permanentDelete')([[1]])) as {
      success: boolean
    }
    expect(result.success).toBe(true)
    expect(unlinkMock).toHaveBeenCalledWith(lq)
    expect(repoMock.getMediaIdByPath).toHaveBeenCalledWith(lq)
    expect(repoMock.hardDelete).toHaveBeenCalledWith(88)
  })

  it('media:permanentDelete 移入回收站失败但文件不存在时仍硬删（计 missing）', async () => {
    repoMock.getMediaPathsByIds.mockReturnValue([{ id: 1, file_path: '/missing' }])
    shellTrashItemMock.mockRejectedValue(new Error('Failed to perform delete operation'))
    // 文件不存在：pathExists 返回 false → 视为 missing，可安全删 DB
    pathExistsMock.mockResolvedValue(false)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:permanentDelete')([[1]])) as {
      success: true
      data: { deletedCount: number; failedCount: number }
    }
    expect(result.data.deletedCount).toBe(1)
    expect(result.data.failedCount).toBe(0)
  })

  it('media:permanentDelete 移入回收站失败且文件存在时计入 failedPaths', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    repoMock.getMediaPathsByIds.mockReturnValue([{ id: 1, file_path: '/exists' }])
    shellTrashItemMock.mockRejectedValue(new Error('EPERM: operation not permitted'))
    // 文件仍存在：pathExists 返回 true → 视为 failed，保留 DB 供重试
    pathExistsMock.mockResolvedValue(true)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:permanentDelete')([[1]])) as {
      success: true
      data: { deletedCount: number; failedCount: number; message: string }
    }
    expect(result.data.deletedCount).toBe(0)
    expect(result.data.failedCount).toBe(1)
    expect(result.data.message).toContain('失败')
  })

  // ── 缺陷修复：mediaId 数组 1000 人为上限导致批量删除报错 ──
  // 下游 media-repository 经 sql-chunk 的 chunkArray 已按 500 分片，可承载任意长度数组。
  it('media:softDelete 传入 1500 个合法 id 通过校验并调用 softDeleteBatch(1500)', async () => {
    registerMediaHandlers(makeCtx())
    const ids = Array.from({ length: 1500 }, (_, i) => i + 1)
    const result = (await getHandler('media:softDelete')([ids])) as {
      success: true
      data: { success: boolean; message: string }
    }
    expect(result.success).toBe(true)
    expect(repoMock.softDeleteBatch).toHaveBeenCalledWith(ids)
    expect(repoMock.softDeleteBatch.mock.calls[0][0]).toHaveLength(1500)
  })

  it('media:restore 传入 1200 个合法 id 通过校验并调用 restoreBatch(1200)', async () => {
    registerMediaHandlers(makeCtx())
    const ids = Array.from({ length: 1200 }, (_, i) => i + 1)
    const result = (await getHandler('media:restore')([ids])) as {
      success: true
      data: { message: string }
    }
    expect(result.success).toBe(true)
    expect(repoMock.restoreBatch).toHaveBeenCalledWith(ids)
    expect(repoMock.restoreBatch.mock.calls[0][0]).toHaveLength(1200)
  })

  it('media:permanentDelete 传入 2000 个合法 id 二次确认通过后分片 hardDeleteBatch', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    const ids = Array.from({ length: 2000 }, (_, i) => i + 1)
    repoMock.getMediaPathsByIds.mockReturnValue(ids.map((id) => ({ id, file_path: `/f${id}` })))
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:permanentDelete')([ids])) as {
      success: true
      data: { deletedCount: number; failedCount: number }
    }
    expect(repoMock.softDeleteForPermanentDelete).toHaveBeenCalledWith(ids)
    expect(repoMock.hardDeleteBatch).toHaveBeenCalledWith(ids)
    expect(repoMock.hardDeleteBatch.mock.calls[0][0]).toHaveLength(2000)
    expect(result.data.deletedCount).toBe(2000)
    expect(result.data.failedCount).toBe(0)
  })

  it('media:softDelete 空数组原样透传（元素级校验由 validator.test.ts 真实 schema 覆盖）', async () => {
    // 注意：media.test.ts 通过 vi.mock('../validator') 将 schemas 替换为链式 proxy、
    // wrapHandler 改为仅解包首参（不执行 zod 校验）。元素级校验（非空/正整数/1000 上限）
    // 统一由 validator.test.ts 对真实 schema 的单元测试覆盖。本用例仅验证 handler
    // 转发契约：接收到的 mediaIds 原样透传给 repo，handler 自身不施加任何长度截断。
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:softDelete')([[]])) as {
      success: true
      data: { success: boolean; message: string }
    }
    expect(result.success).toBe(true)
    expect(repoMock.softDeleteBatch).toHaveBeenCalledWith([])
  })

  it('media:softDelete 含非正整数仍原样透传（元素级校验由 validator.test.ts 覆盖）', async () => {
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:softDelete')([[1, 0, -5, 1.5, 99]])) as {
      success: true
      data: { success: boolean; message: string }
    }
    expect(result.success).toBe(true)
    expect(repoMock.softDeleteBatch).toHaveBeenCalledWith([1, 0, -5, 1.5, 99])
  })

  it('media:emptyRecycleBin 回收站为空时返回提示', async () => {
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([])
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:emptyRecycleBin')()) as {
      success: true
      data: { message: string; movedCount: number }
    }
    expect(result.data.movedCount).toBe(0)
    expect(result.data.message).toContain('为空')
  })

  it('media:emptyRecycleBin 契约锁：成功返回仅含 message（无 success 字段），渲染端据此信任 call() 解析', async () => {
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([{ id: 1, file_path: '/a' }])
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:emptyRecycleBin')()) as {
      success: true
      data: { message: string; movedCount: number }
    }
    // 契约：data 仅含 { message, movedCount, missingCount, failedCount }，不含 success 字段；
    // preload call() 解包 IpcResponse 只回传 data，渲染端不得读取 result.success（恒为 undefined）。
    expect(typeof result.data.message).toBe('string')
    expect(result.data.message.length).toBeGreaterThan(0)
    expect(result.data).not.toHaveProperty('success')
    expect('success' in result.data).toBe(false)
  })

  // 回收站语义修复 D5：清空回收站的二次确认职责完全回归渲染端 ConfirmDialog，
  // 主进程不再弹原生 dialog——旧用例「用户取消时抛 canceled」的取消路径已不存在。
  it('media:emptyRecycleBin 不弹原生确认框，任意响应下直接清空', async () => {
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([{ id: 1, file_path: '/a' }])
    // 敌意模拟：即便 showMessageBox 被误调且返回「取消」，也应照常清空
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:emptyRecycleBin')()) as {
      success: boolean
      data: { movedCount: number }
    }
    expect(showMessageBoxMock).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.data.movedCount).toBe(1)
  })

  it('media:emptyRecycleBin 用户确认后批量删除', async () => {
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([
      { id: 1, file_path: '/a' },
      { id: 2, file_path: '/b' }
    ])
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:emptyRecycleBin')()) as {
      success: true
      data: { movedCount: number }
    }
    expect(repoMock.hardDeleteBatch).toHaveBeenCalledWith([1, 2])
    expect(result.data.movedCount).toBe(2)
  })

  // #fix-empty-recyclebin-system-trash 红灯 R1：清空回收站时必须把原路径文件移入系统回收站
  //（shell.trashItem），不得 fsp.unlink 永久删除——确认文案承诺「文件会先移至系统回收站，
  // 之后无法从本应用恢复」。历史「Shell API 大批量 94.5% 瞬时失败」是旧双回收站架构产物
  //（删除时文件已被搬走，清空打的是空路径），80d910a 后文件留在原位、前提已消失。
  it('media:emptyRecycleBin 确认后对每个文件调用 shell.trashItem 且不以 unlink 删除媒体文件', async () => {
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([
      { id: 1, file_path: '/a' },
      { id: 2, file_path: '/b' }
    ])
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:emptyRecycleBin')()) as {
      success: true
      data: { movedCount: number; missingCount: number; failedCount: number }
    }
    expect(shellTrashItemMock).toHaveBeenCalledWith('/a')
    expect(shellTrashItemMock).toHaveBeenCalledWith('/b')
    expect(unlinkMock).not.toHaveBeenCalledWith('/a')
    expect(unlinkMock).not.toHaveBeenCalledWith('/b')
    expect(result.data.movedCount).toBe(2)
    expect(result.data.failedCount).toBe(0)
  })

  // #fix-recyclebin-permanent-delete 红灯 R2/R4：清空回收站删除 DB 记录后必须清理其缩略图缓存
  //（仅限缓存目录内；游戏原生 LQ 路径绝不触碰）——修复前 emptyRecycleBin 无缩略图清理阶段，
  // 缩略图缓存文件成为永久孤儿残留磁盘。
  it('media:emptyRecycleBin 删除 DB 后清理缓存目录内缩略图且不触碰 LQ 路径', async () => {
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([
      { id: 1, file_path: 'C:\\media\\a.jpg', thumbnail: 'C:\\cache\\thumbnails\\t1.jpg' },
      {
        id: 2,
        file_path: 'C:\\media\\b.jpg',
        thumbnail: 'C:\\game\\X6Game\\Saved\\GamePlayPhotos\\NikkiPhotos_LowQuality\\b.jpg'
      }
    ])
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    pathExistsMock.mockResolvedValue(true)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:emptyRecycleBin')()) as { success: boolean }
    expect(result.success).toBe(true)
    expect(repoMock.hardDeleteBatch).toHaveBeenCalledWith([1, 2])
    // 缩略图缓存清理（修复前缺失）
    expect(unlinkMock).toHaveBeenCalledWith('C:\\cache\\thumbnails\\t1.jpg')
    // 边界锁：缓存目录外（游戏原生 LQ）绝不清理
    expect(unlinkMock).not.toHaveBeenCalledWith(
      'C:\\game\\X6Game\\Saved\\GamePlayPhotos\\NikkiPhotos_LowQuality\\b.jpg'
    )
  })

  // #fix-gallery-delete-thumbnail-cleanup 红灯 B4：清空回收站阶段 4 同 permanentDelete，
  // 须清理原生 LQ 文件并硬删其 DB 记录（file_path 命中 GPP+HQ 推导规则的行）
  it('media:emptyRecycleBin 阶段 4 清理原生 LQ 文件并硬删其 DB 记录', async () => {
    const hq = 'C:\\game\\X6Game\\Saved\\GamePlayPhotos\\1001\\NikkiPhotos_HighQuality\\p.jpg'
    const lq = 'C:\\game\\X6Game\\Saved\\GamePlayPhotos\\1001\\NikkiPhotos_LowQuality\\p.jpg'
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([{ id: 1, file_path: hq, thumbnail: lq }])
    repoMock.getMediaIdByPath.mockReturnValue(66)
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    pathExistsMock.mockResolvedValue(true)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:emptyRecycleBin')()) as { success: boolean }
    expect(result.success).toBe(true)
    expect(unlinkMock).toHaveBeenCalledWith(lq)
    expect(repoMock.getMediaIdByPath).toHaveBeenCalledWith(lq)
    expect(repoMock.hardDelete).toHaveBeenCalledWith(66)
  })

  // B1 修复回归：三态覆盖——成功 / 文件不存在 / 失败（文件仍存在）
  it('media:emptyRecycleBin 文件删除成功时计 movedCount 并删除 DB', async () => {
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([{ id: 1, file_path: '/a' }])
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:emptyRecycleBin')()) as {
      success: true
      data: { movedCount: number; missingCount: number; failedCount: number }
    }
    expect(repoMock.hardDeleteBatch).toHaveBeenCalledWith([1])
    expect(result.data.movedCount).toBe(1)
    expect(result.data.missingCount).toBe(0)
    expect(result.data.failedCount).toBe(0)
  })

  // #fix-empty-recyclebin-system-trash 红灯 R3：trashItem 抛错 + 文件已不存在 → 判 missing、
  // 安全删 DB（外部已删除的记录仅清踪迹，不涉及系统回收站实体）
  it('media:emptyRecycleBin 移入回收站失败但文件不存在时仍删 DB（计 missing）', async () => {
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([{ id: 1, file_path: '/gone' }])
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    shellTrashItemMock.mockRejectedValue(new Error('Failed to perform delete operation'))
    pathExistsMock.mockResolvedValue(false)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:emptyRecycleBin')()) as {
      success: true
      data: { movedCount: number; missingCount: number; failedCount: number }
    }
    // 文件不存在 → 安全删 DB，但不算 moved，算 missing
    expect(repoMock.hardDeleteBatch).toHaveBeenCalledWith([1])
    expect(result.data.movedCount).toBe(0)
    expect(result.data.missingCount).toBe(1)
    expect(result.data.failedCount).toBe(0)
  })

  it('media:emptyRecycleBin 移入回收站失败且文件仍存在时【不】删 DB（B1 修复核心）', async () => {
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([
      { id: 1, file_path: '/locked-a' },
      { id: 2, file_path: '/ok-b' }
    ])
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    // /locked-a 持续失败（文件仍存在），/ok-b 成功。
    // 用「路径键控」而非「调用序列」模拟，使断言不依赖内部重试次数。
    shellTrashItemMock.mockImplementation(async (p: string) => {
      if (p === '/locked-a') throw new Error('EPERM: operation not permitted')
    })
    pathExistsMock.mockResolvedValue(true) // /locked-a 仍存在 → 重试用尽后判 failed
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:emptyRecycleBin')()) as {
      success: true
      data: { movedCount: number; missingCount: number; failedCount: number; message: string }
    }
    // 仅成功的 id=2 进入 hardDeleteBatch，id=1 保留 DB 供用户重试
    expect(repoMock.hardDeleteBatch).toHaveBeenCalledWith([2])
    expect(result.data.movedCount).toBe(1)
    expect(result.data.missingCount).toBe(0)
    expect(result.data.failedCount).toBe(1)
    expect(result.data.message).toContain('失败')
  })

  // ── 缺陷A 修复：移入系统回收站瞬时失败重试（占用类错误 EBUSY/EPERM 对重试敏感）
  it('media:emptyRecycleBin 首次失败但重试成功时计 movedCount 并删 DB', async () => {
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([{ id: 1, file_path: '/flaky' }])
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    // 首次瞬时失败、重试后成功（Shell 瞬时失败/文件被占用类瞬时失败的典型场景）
    shellTrashItemMock
      .mockRejectedValueOnce(new Error('EBUSY: resource busy or locked'))
      .mockResolvedValueOnce(undefined)
    pathExistsMock.mockResolvedValue(true) // 文件仍存在 → 应重试而非直接判 failed
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:emptyRecycleBin')()) as {
      success: true
      data: { movedCount: number; missingCount: number; failedCount: number }
    }
    expect(result.data.movedCount).toBe(1)
    expect(result.data.failedCount).toBe(0)
    expect(repoMock.hardDeleteBatch).toHaveBeenCalledWith([1])
  })

  // #fix-empty-recyclebin-system-trash 红灯 R4：trashItem 持续失败且文件仍存在 →
  // 重试用尽判 failed、保留 DB 供重试（B1 数据安全约定：绝不 fallback 永久删除）
  it('media:emptyRecycleBin 重试用尽仍失败时保留 DB 记录且不超过重试上限', async () => {
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([{ id: 7, file_path: '/always-locked' }])
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    shellTrashItemMock.mockRejectedValue(new Error('EPERM: operation not permitted'))
    pathExistsMock.mockResolvedValue(true) // 文件始终存在 → 重试到上限后判 failed
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:emptyRecycleBin')()) as {
      success: true
      data: { movedCount: number; failedCount: number }
    }
    expect(result.data.failedCount).toBe(1)
    expect(result.data.movedCount).toBe(0)
    // 失败项不得物理删除，保留供用户重试（B1 数据安全约定）
    expect(repoMock.hardDeleteBatch).toHaveBeenCalledWith([])
    // 首次尝试 + 2 次重试 = 3 次，防止无限重试
    expect(shellTrashItemMock).toHaveBeenCalledTimes(3)
  })

  it('media:emptyRecycleBin 重试期间文件消失时判 missing 并删 DB', async () => {
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([{ id: 9, file_path: '/vanishing' }])
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    shellTrashItemMock.mockRejectedValue(new Error('EBUSY: resource busy or locked'))
    // 首次复检仍存在（触发重试），第二次复检已消失 → 应立即判 missing 停止重试
    pathExistsMock.mockResolvedValueOnce(true).mockResolvedValue(false)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:emptyRecycleBin')()) as {
      success: true
      data: { movedCount: number; missingCount: number; failedCount: number }
    }
    expect(result.data.missingCount).toBe(1)
    expect(result.data.failedCount).toBe(0)
    expect(repoMock.hardDeleteBatch).toHaveBeenCalledWith([9])
    // 文件消失后不再重试（仅 2 次尝试，未走到第 3 次）
    expect(shellTrashItemMock).toHaveBeenCalledTimes(2)
  })

  it('media:emptyRecycleBin 多项失败时日志聚合为一条（避免刷屏）', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, file_path: `/locked-${i}` }))
    repoMock.getSoftDeletedMediaPaths.mockReturnValue(rows)
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    shellTrashItemMock.mockRejectedValue(new Error('EBUSY: resource busy or locked'))
    pathExistsMock.mockResolvedValue(true)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:emptyRecycleBin')()) as {
      success: true
      data: { failedCount: number }
    }
    expect(result.data.failedCount).toBe(5)
    // 关键：失败日志聚合为一条，而非每项一条（实测 2474 项会刷爆日志文件）
    expect(loggerWarnMock).toHaveBeenCalledTimes(1)
    expect(String(loggerWarnMock.mock.calls[0][0])).toContain('5')
  })

  it('media:emptyRecycleBin 连续失败达阈值后熔断，不再逐项重试', async () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, file_path: `/sys-fail-${i}` }))
    repoMock.getSoftDeletedMediaPaths.mockReturnValue(rows)
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    shellTrashItemMock.mockRejectedValue(new Error('EBUSY: resource busy or locked'))
    pathExistsMock.mockResolvedValue(true)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:emptyRecycleBin')()) as {
      success: true
      data: { failedCount: number }
    }
    // 正确性不变：全部失败且全部保留 DB
    expect(result.data.failedCount).toBe(14)
    expect(repoMock.hardDeleteBatch).toHaveBeenCalledWith([])
    // 系统性故障（如磁盘故障/目录被整体锁定）时熔断：总尝试数应显著小于 14*3=42，
    // 避免大批量全失败场景下重试退避累积成分钟级卡顿
    expect(shellTrashItemMock.mock.calls.length).toBeLessThan(42)
  }, 20000)

  it('media:cleanupMissing 返回清理数量', async () => {
    repoMock.cleanupMissingRecords.mockReturnValue(3)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:cleanupMissing')()) as {
      success: true
      data: { cleared: number; message: string }
    }
    expect(result.data.cleared).toBe(3)
  })

  it('media:removeMissing 记录不存在时抛 notFound', async () => {
    repoMock.removeMissingRecord.mockReturnValue(false)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:removeMissing')([1])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_NOT_FOUND')
  })

  it('media:removeMissing 记录存在时返回成功消息', async () => {
    repoMock.removeMissingRecord.mockReturnValue(true)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:removeMissing')([1])) as {
      success: true
      data: { message: string }
    }
    expect(result.data.message).toContain('已从库中移除')
  })

  it('media:getOutfitStats 聚合 stats 并查询封面', async () => {
    repoMock.getOutfitAggStats.mockReturnValue([
      { outfit: '套装A', count: 3, latest_created: '2026-01-01' }
    ])
    repoMock.getLatestOutfitMedia.mockReturnValue({ file_path: '/a', thumbnail: 'thumb' })
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:getOutfitStats')()) as {
      success: true
      data: { stats: Array<{ outfit: string; coverFilePath: string }> }
    }
    expect(result.data.stats[0].outfit).toBe('套装A')
    expect(result.data.stats[0].coverFilePath).toBe('/a')
  })

  it('media:getOutfitStats 最新媒体不存在时 cover 为空字符串', async () => {
    repoMock.getOutfitAggStats.mockReturnValue([
      { outfit: 'B', count: 1, latest_created: '2026-01-01' }
    ])
    repoMock.getLatestOutfitMedia.mockReturnValue(undefined)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:getOutfitStats')()) as {
      success: true
      data: { stats: Array<{ coverFilePath: string; coverThumbnail: null }> }
    }
    expect(result.data.stats[0].coverFilePath).toBe('')
    expect(result.data.stats[0].coverThumbnail).toBeNull()
  })

  it('media:findDuplicates 无候选时返回空结果', async () => {
    repoMock.getDuplicateCandidates.mockReturnValue([])
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:findDuplicates')()) as {
      success: true
      data: { success: boolean; totalGroups: number; totalFiles: number; wastedBytes: number }
    }
    expect(result.data.totalGroups).toBe(0)
    expect(result.data.totalFiles).toBe(0)
    expect(result.data.success).toBe(true)
  })

  it('media:findDuplicates 计算哈希后聚合重复组', async () => {
    repoMock.getDuplicateCandidates.mockReturnValue([
      {
        id: 1,
        file_path: '/a',
        file_name: 'a',
        file_type: 'image',
        file_size: 100,
        modified_at: '2026-01-01',
        width: 100,
        height: 100,
        is_favorite: 0,
        rating: 0
      },
      {
        id: 2,
        file_path: '/b',
        file_name: 'b',
        file_type: 'image',
        file_size: 100,
        modified_at: '2026-01-02',
        width: 100,
        height: 100,
        is_favorite: 0,
        rating: 0
      }
    ])
    calculateFileHashMock.mockResolvedValue('hashA')
    pickBestIdMock.mockReturnValue(1)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:findDuplicates')()) as {
      success: true
      data: {
        success: boolean
        totalGroups: number
        totalFiles: number
        wastedBytes: number
        bestItemIds: number[]
      }
    }
    expect(calculateFileHashMock).toHaveBeenCalledTimes(2)
    expect(result.data.totalGroups).toBe(1)
    expect(result.data.totalFiles).toBe(2)
    expect(result.data.wastedBytes).toBe(100)
    expect(result.data.bestItemIds).toEqual([1])
    expect(result.data.success).toBe(true)
  })

  it('media:findDuplicates 透传 thumbnail 字段（缺失时为 null）', async () => {
    repoMock.getDuplicateCandidates.mockReturnValue([
      {
        id: 1,
        file_path: '/a',
        file_name: 'a',
        file_type: 'video',
        file_size: 100,
        modified_at: '2026-01-01',
        width: 100,
        height: 100,
        is_favorite: 0,
        rating: 0,
        thumbnail: '/cache/a.jpg'
      },
      {
        id: 2,
        file_path: '/b',
        file_name: 'b',
        file_type: 'video',
        file_size: 100,
        modified_at: '2026-01-02',
        width: 100,
        height: 100,
        is_favorite: 0,
        rating: 0,
        thumbnail: null
      }
    ])
    calculateFileHashMock.mockResolvedValue('hashA')
    pickBestIdMock.mockReturnValue(1)
    registerMediaHandlers(makeCtx())
    const raw = await getHandler('media:findDuplicates')()
    const data = await simulateCall<ScanResult>(raw)
    const group = data.duplicates[0]
    const withThumb = group.find((it) => it.id === 1)!
    const withoutThumb = group.find((it) => it.id === 2)!
    expect(withThumb.thumbnail).toBe('/cache/a.jpg')
    expect(withoutThumb.thumbnail).toBeNull()
  })

  it('media:findDuplicates file_size<=0 的行被跳过', async () => {
    repoMock.getDuplicateCandidates.mockReturnValue([
      {
        id: 1,
        file_path: '/a',
        file_name: 'a',
        file_type: 'image',
        file_size: 0,
        modified_at: '2026-01-01',
        width: 100,
        height: 100,
        is_favorite: 0,
        rating: 0
      }
    ])
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:findDuplicates')()) as {
      success: true
      data: { success: boolean; totalGroups: number }
    }
    expect(result.data.totalGroups).toBe(0)
    expect(result.data.success).toBe(true)
  })

  it('media:findDuplicates 哈希计算失败时跳过该行', async () => {
    repoMock.getDuplicateCandidates.mockReturnValue([
      {
        id: 1,
        file_path: '/a',
        file_name: 'a',
        file_type: 'image',
        file_size: 100,
        modified_at: '2026-01-01',
        width: 100,
        height: 100,
        is_favorite: 0,
        rating: 0
      },
      {
        id: 2,
        file_path: '/b',
        file_name: 'b',
        file_type: 'image',
        file_size: 100,
        modified_at: '2026-01-02',
        width: 100,
        height: 100,
        is_favorite: 0,
        rating: 0
      }
    ])
    calculateFileHashMock.mockRejectedValue(new Error('读取失败'))
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:findDuplicates')()) as {
      success: true
      data: { success: boolean; totalGroups: number }
    }
    expect(result.data.totalGroups).toBe(0)
    expect(result.data.success).toBe(true)
  })

  it('media:generatePhash 调用 generatePhashForUnprocessed', async () => {
    generatePhashForUnprocessedMock.mockResolvedValue({ processed: 5, total: 10 })
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:generatePhash')()) as {
      success: true
      data: { success: boolean; processed: number; total: number }
    }
    expect(generatePhashForUnprocessedMock).toHaveBeenCalled()
    expect(result.data.processed).toBe(5)
    expect(result.data.success).toBe(true)
  })

  it('media:markDuplicates 调用 markDuplicates 并合并 message', async () => {
    markDuplicatesMock.mockResolvedValue({ groups: 2, marked: 5 })
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:markDuplicates')()) as {
      success: true
      data: { success: boolean; message: string; groups: number }
    }
    expect(markDuplicatesMock).toHaveBeenCalled()
    expect(result.data.groups).toBe(2)
    expect(result.data.message).toContain('重复标记完成')
    expect(result.data.success).toBe(true)
  })

  it('media:list 返回 files/total/page/pageSize/hasMore', async () => {
    repoMock.listMedia.mockReturnValue({
      rows: [
        { id: 1, file_path: '/a', is_favorite: 1, is_deleted: 0, is_missing: 0, is_duplicate: 0 }
      ],
      total: 1,
      page: 1,
      pageSize: 50,
      hasMore: false
    })
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:list')([undefined])) as {
      success: true
      data: { files: Array<{ id: string; is_favorite: boolean }>; total: number }
    }
    expect(result.data.files[0].id).toBe('1')
    expect(result.data.files[0].is_favorite).toBe(true)
    expect(result.data.total).toBe(1)
  })

  it('media:getGroupCounts 调用 repo 并返回 groups', async () => {
    repoMock.getGroupCounts.mockReturnValue([{ key: 'game', count: 5 }])
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('media:getGroupCounts')([
      'album_type',
      undefined,
      undefined
    ])) as {
      success: true
      data: { groups: unknown[] }
    }
    expect(repoMock.getGroupCounts).toHaveBeenCalledWith('album_type', undefined, undefined)
    expect(result.data.groups).toHaveLength(1)
  })

  it('category:create 使用默认 icon/color 调用 repo', async () => {
    repoMock.createCategory.mockReturnValue(7)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('category:create')(['新分类', undefined])) as {
      success: true
      data: { id: number }
    }
    expect(repoMock.createCategory).toHaveBeenCalledWith('新分类', 'folder', '#888888', null)
    expect(result.data.id).toBe(7)
  })

  it('category:create 传 options 时透传 icon/color/parentId', async () => {
    registerMediaHandlers(makeCtx())
    await getHandler('category:create')(['n', { icon: 'star', color: '#fff', parentId: 3 }])
    expect(repoMock.createCategory).toHaveBeenCalledWith('n', 'star', '#fff', 3)
  })

  it('category:update 仅允许特定字段并调用 updateCategoryFields', async () => {
    registerMediaHandlers(makeCtx())
    await getHandler('category:update')([
      1,
      { name: 'new', icon: 'i', color: '#000', parent_id: 2, extra: 'x' }
    ])
    expect(repoMock.updateCategoryFields).toHaveBeenCalledWith(
      1,
      ['name = ?', 'icon = ?', 'color = ?', 'parent_id = ?'],
      ['new', 'i', '#000', 2]
    )
  })

  it('category:update 无可更新字段时抛 validation', async () => {
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('category:update')([1, { extra: 'x' }])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
  })

  it('category:delete 调用 deleteCategoryCascade', async () => {
    registerMediaHandlers(makeCtx())
    await getHandler('category:delete')([1])
    expect(repoMock.deleteCategoryCascade).toHaveBeenCalledWith(1)
  })

  // FIX(组8-1): 系统分类前置拒绝——不得清空其下 media_files.category_id，也不得误报成功
  it('category:delete 系统分类时拒绝且不触发级联删除', async () => {
    repoMock.isSystemCategory.mockReturnValueOnce(true)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('category:delete')([1])) as {
      success: boolean
      error: { code: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
    expect(repoMock.deleteCategoryCascade).not.toHaveBeenCalled()
  })

  it('category:reorder 调用 reorderCategories', async () => {
    registerMediaHandlers(makeCtx())
    await getHandler('category:reorder')([[{ id: 1, sort_order: 0 }]])
    expect(repoMock.reorderCategories).toHaveBeenCalledWith([{ id: 1, sort_order: 0 }])
  })

  it('category:list 返回 categories 并将 is_system 转 boolean', async () => {
    repoMock.listCategories.mockReturnValue([{ id: 1, is_system: 1 }])
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('category:list')()) as {
      success: true
      data: { categories: Array<{ is_system: boolean }> }
    }
    expect(result.data.categories[0].is_system).toBe(true)
  })

  it('profile:list 返回 profiles', async () => {
    repoMock.listProfiles.mockReturnValue([{ uid: 'u1', nickname: 'n1' }])
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('profile:list')()) as {
      success: true
      data: { profiles: unknown[] }
    }
    expect(result.data.profiles).toHaveLength(1)
  })

  it('profile:list 透传档案 hasMedia 标记（真实/虚拟区分）', async () => {
    repoMock.listProfiles.mockReturnValue([
      {
        uid: 'u1',
        nickname: 'n1',
        avatar: null,
        created_at: '2024-01-01',
        last_active_at: null,
        hasMedia: true
      },
      {
        uid: 'ghost',
        nickname: 'g',
        avatar: null,
        created_at: '2024-01-02',
        last_active_at: null,
        hasMedia: false
      }
    ])
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('profile:list')()) as {
      success: true
      data: { profiles: Array<{ uid: string; hasMedia: boolean }> }
    }
    expect(result.data.profiles.find((p) => p.uid === 'u1')?.hasMedia).toBe(true)
    expect(result.data.profiles.find((p) => p.uid === 'ghost')?.hasMedia).toBe(false)
  })

  it('profile:add 成功时返回 { added: true }', async () => {
    repoMock.addProfile.mockImplementation(() => {})
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('profile:add')(['u1', 'n1', '/avatar.png'])) as {
      success: true
      data: { added: boolean }
    }
    expect(repoMock.addProfile).toHaveBeenCalledWith('u1', 'n1', '/avatar.png')
    expect(result.data.added).toBe(true)
  })

  it('profile:add UID 唯一约束冲突时抛 conflict', async () => {
    repoMock.addProfile.mockImplementation(() => {
      throw new Error('UNIQUE constraint failed: profiles.uid')
    })
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('profile:add')(['u1', 'n1', undefined])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_CONFLICT')
    expect(result.error.message).toContain('UID 已存在')
  })

  it('profile:add 抛非 UNIQUE 错误时直接透传', async () => {
    repoMock.addProfile.mockImplementation(() => {
      throw new Error('其他错误')
    })
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('profile:add')(['u1', 'n1', undefined])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
  })

  it('profile:update 同时传 nickname 和 avatar 时调用两个字段更新', async () => {
    registerMediaHandlers(makeCtx())
    await getHandler('profile:update')(['u1', '新名', '/a.png'])
    expect(repoMock.updateProfileFields).toHaveBeenCalledWith(
      'u1',
      ['nickname = ?', 'avatar = ?'],
      ['新名', '/a.png']
    )
  })

  it('profile:update 仅传 nickname 时只更新一个字段', async () => {
    registerMediaHandlers(makeCtx())
    await getHandler('profile:update')(['u1', '新名', undefined])
    expect(repoMock.updateProfileFields).toHaveBeenCalledWith('u1', ['nickname = ?'], ['新名'])
  })

  it('profile:update 无字段时直接返回 { updated: true }', async () => {
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('profile:update')(['u1', undefined, undefined])) as {
      success: true
      data: { updated: boolean }
    }
    expect(repoMock.updateProfileFields).not.toHaveBeenCalled()
    expect(result.data.updated).toBe(true)
  })

  it('profile:delete 删除默认档案时抛 PATH_FORBIDDEN', async () => {
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('profile:delete')(['default'])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PATH_FORBIDDEN')
  })

  it('profile:delete 非默认档案时调用 deleteProfileAndReassign', async () => {
    registerMediaHandlers(makeCtx())
    await getHandler('profile:delete')(['u1'])
    expect(repoMock.deleteProfileAndReassign).toHaveBeenCalledWith('u1')
  })

  it('profile:setCurrent 调用 touchProfileActive 与 setSetting', async () => {
    const ctx = makeCtx()
    ;(ctx.dbManager.setSetting as ReturnType<typeof vi.fn>) = vi.fn()
    registerMediaHandlers(ctx)
    await getHandler('profile:setCurrent')(['u1'])
    expect(repoMock.touchProfileActive).toHaveBeenCalledWith('u1')
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('currentProfileUid', 'u1')
  })

  it('profile:transferFiles 目标档案不存在时抛 notFound', async () => {
    repoMock.getProfileByUid.mockReturnValue(null)
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('profile:transferFiles')([[1, 2], 'u2'])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_NOT_FOUND')
    expect(result.error.message).toContain('u2')
  })

  it('profile:transferFiles 成功时返回 transferred 数量', async () => {
    repoMock.getProfileByUid.mockReturnValue({ uid: 'u2', nickname: 'n' })
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('profile:transferFiles')([[1, 2], 'u2'])) as {
      success: true
      data: { transferred: number }
    }
    expect(repoMock.transferFilesToProfile).toHaveBeenCalledWith([1, 2], 'u2')
    expect(result.data.transferred).toBe(2)
  })

  it('profile:getStats 聚合 baseStats/outfit/scene/time', async () => {
    repoMock.getProfileBaseStats.mockReturnValue({
      total_count: 10,
      image_count: 7,
      video_count: 3,
      total_size: 1024,
      earliest_time: 't1',
      latest_time: 't2'
    })
    repoMock.getProfileTopOutfits.mockReturnValue([{ outfit: 'A' }])
    repoMock.getProfileTopScenes.mockReturnValue([{ scene: 'B' }])
    repoMock.getProfileTimeDistribution.mockReturnValue([{ hour: 12 }])
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('profile:getStats')(['u1'])) as {
      success: true
      data: { stats: { totalCount: number; topOutfits: unknown[]; timeDistribution: unknown[] } }
    }
    expect(result.data.stats.totalCount).toBe(10)
    expect(result.data.stats.topOutfits).toHaveLength(1)
    expect(result.data.stats.timeDistribution).toHaveLength(1)
  })

  it('profile:getStats baseStats 为 null 时回退为 0', async () => {
    repoMock.getProfileBaseStats.mockReturnValue({})
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('profile:getStats')(['u1'])) as {
      success: true
      data: { stats: { totalCount: number; imageCount: number } }
    }
    expect(result.data.stats.totalCount).toBe(0)
    expect(result.data.stats.imageCount).toBe(0)
  })

  it('duplicate:listGroups 聚合 originalId 与 duplicates', async () => {
    repoMock.getDuplicateGroupRows.mockReturnValue([
      {
        id: 2,
        file_path: '/b',
        file_name: 'b',
        file_type: 'image',
        file_size: 100,
        modified_at: '2026-01-01',
        width: 1,
        height: 1,
        is_favorite: 0,
        rating: 0,
        original_id: 1
      }
    ])
    repoMock.getOriginalsByIds.mockReturnValue([
      {
        id: 1,
        file_path: '/a',
        file_name: 'a',
        file_type: 'image',
        file_size: 100,
        modified_at: '2026-01-02',
        width: 1,
        height: 1,
        is_favorite: 0,
        rating: 0
      }
    ])
    registerMediaHandlers(makeCtx())
    const result = (await getHandler('duplicate:listGroups')()) as {
      success: true
      data: {
        groups: Array<{
          originalId: number
          original: { id: number } | null
          duplicates: unknown[]
        }>
        totalGroups: number
      }
    }
    expect(result.data.totalGroups).toBe(1)
    expect(result.data.groups[0].originalId).toBe(1)
    expect(result.data.groups[0].original?.id).toBe(1)
    expect(result.data.groups[0].duplicates).toHaveLength(1)
  })
})

/**
 * 集成测试：模拟 preload 解包行为，验证前端实际接收的值（预防措施 6.2）
 *
 * 这些测试通过 simulateCall 模拟 preload call() 的解包，
 * 验证解包后的 data 包含 success: true —— 即前端 DuplicatesPage
 * 检查 res.success 时能正确判断为成功，不再误显「扫描失败」。
 */
describe('preload 解包集成测试（simulateCall）', () => {
  beforeEach(() => {
    handleMock.mockClear()
    Object.values(repoMock).forEach((fn) => (fn as ReturnType<typeof vi.fn>).mockClear?.())
    calculateFileHashMock.mockReset()
    hammingDistanceMock.mockReset()
    pickBestIdMock.mockReset()
    generatePhashForUnprocessedMock.mockReset()
    markDuplicatesMock.mockReset()
  })

  it('findDuplicates 解包后 data.success === true（前端不再误判失败）', async () => {
    repoMock.getDuplicateCandidates.mockReturnValue([])
    registerMediaHandlers(makeCtx())
    const raw = await getHandler('media:findDuplicates')()
    const data = await simulateCall<ScanResult>(raw)
    expect(data.success).toBe(true)
    expect(data.totalGroups).toBe(0)
    expect(Array.isArray(data.duplicates)).toBe(true)
  })

  it('findDuplicates 有重复时解包后 data 含完整分组结构', async () => {
    repoMock.getDuplicateCandidates.mockReturnValue([
      {
        id: 1,
        file_path: '/a',
        file_name: 'a',
        file_type: 'image',
        file_size: 100,
        modified_at: '2026-01-01',
        width: 100,
        height: 100,
        is_favorite: 0,
        rating: 0
      },
      {
        id: 2,
        file_path: '/b',
        file_name: 'b',
        file_type: 'image',
        file_size: 100,
        modified_at: '2026-01-02',
        width: 100,
        height: 100,
        is_favorite: 0,
        rating: 0
      }
    ])
    calculateFileHashMock.mockResolvedValue('sameHash')
    pickBestIdMock.mockReturnValue(1)
    registerMediaHandlers(makeCtx())
    const raw = await getHandler('media:findDuplicates')()
    const data = await simulateCall<ScanResult>(raw)
    expect(data.success).toBe(true)
    expect(data.totalGroups).toBe(1)
    expect(data.duplicates).toHaveLength(1)
    expect(data.duplicates[0]).toHaveLength(2)
    expect(data.bestItemIds).toEqual([1])
  })

  it('generatePhash 解包后 data.success === true', async () => {
    generatePhashForUnprocessedMock.mockResolvedValue({ processed: 3, total: 8 })
    registerMediaHandlers(makeCtx())
    const raw = await getHandler('media:generatePhash')()
    const data = await simulateCall<PhashResult>(raw)
    expect(data.success).toBe(true)
    expect(data.processed).toBe(3)
    expect(data.total).toBe(8)
  })

  it('markDuplicates 解包后 data.success === true', async () => {
    markDuplicatesMock.mockResolvedValue({ markedDuplicates: 5, totalGroups: 2 })
    registerMediaHandlers(makeCtx())
    const raw = await getHandler('media:markDuplicates')()
    const data = await simulateCall<MarkDuplicatesResult>(raw)
    expect(data.success).toBe(true)
    expect(data.markedDuplicates).toBe(5)
    expect(data.totalGroups).toBe(2)
  })

  it('softDelete 解包后 data 包含 success 字段', async () => {
    repoMock.softDeleteBatch.mockReturnValue({ changes: 2 })
    registerMediaHandlers(makeCtx())
    const raw = await getHandler('media:softDelete')([[1, 2]])
    const data = await simulateCall<{ success: boolean; message: string }>(raw)
    expect(data.success).toBe(true)
    expect(data.message).toBeTruthy()
  })
})

// ============================================================================
// sync-integration 阶段5：删除/修改接线同步变更日志
// 红灯→绿灯：media-cleanup 4 通道硬删 media_files 行但不写 journal（asset.deleted
// 缺失）；media:analyzeSceneTime 批量修改但不写 journal（asset.updated 缺失）。
// ============================================================================

describe('media 域 — sync 变更日志接线（阶段5）', () => {
  function makeSyncCtx() {
    const ctx = makeCtx()
    const syncEvents = {
      recordAssetChange: vi.fn(async () => undefined),
      recordAssetChanges: vi.fn(async (changes: unknown[]) => changes.length),
      broadcastRescanStarted: vi.fn(async () => undefined),
      broadcastRescanCompleted: vi.fn(async () => undefined)
    }
    ;(ctx as unknown as { syncEvents: unknown }).syncEvents = syncEvents
    return { ctx, syncEvents }
  }

  beforeEach(() => {
    // 本 describe 的 getHandler 必须命中"携带 syncEvents 的本次注册"——
    // 文件级 handleMock 跨用例累积，先清空再注册
    handleMock.mockClear()
    repoMock.listCleanupCandidateIds.mockReset()
    repoMock.listCleanupCandidateIds.mockReturnValue([])
    repoMock.cleanupMissingRecords.mockReset()
    repoMock.cleanupMissingRecords.mockReturnValue(0)
    repoMock.cleanupCorruptedRecords.mockReset()
    repoMock.cleanupCorruptedRecords.mockReturnValue(0)
    repoMock.getMediaForSceneAnalysis.mockReset()
    repoMock.getMediaForSceneAnalysis.mockReturnValue([])
    repoMock.updateSceneTime.mockReset()
  })

  it('CL1(红灯→绿灯): media:cleanupMissing → 删前候选 id 批量 journal asset.deleted', async () => {
    repoMock.listCleanupCandidateIds.mockReturnValue([1, 2, 3])
    repoMock.cleanupMissingRecords.mockReturnValue(3)
    const { ctx, syncEvents } = makeSyncCtx()
    registerMediaHandlers(ctx)
    await getHandler('media:cleanupMissing')()
    expect(syncEvents.recordAssetChanges).toHaveBeenCalledWith([
      { eventType: 'asset.deleted', assetId: '1' },
      { eventType: 'asset.deleted', assetId: '2' },
      { eventType: 'asset.deleted', assetId: '3' }
    ])
  })

  it('CL2(红灯→绿灯): media:cleanupCorrupted → 同款批量 journal asset.deleted', async () => {
    repoMock.listCleanupCandidateIds.mockReturnValue([7, 8])
    repoMock.cleanupCorruptedRecords.mockReturnValue(2)
    const { ctx, syncEvents } = makeSyncCtx()
    registerMediaHandlers(ctx)
    await getHandler('media:cleanupCorrupted')()
    expect(syncEvents.recordAssetChanges).toHaveBeenCalledWith([
      { eventType: 'asset.deleted', assetId: '7' },
      { eventType: 'asset.deleted', assetId: '8' }
    ])
  })

  it('CL3(红灯→绿灯): media:removeMissing 成功删除 → 单条 journal asset.deleted', async () => {
    repoMock.removeMissingRecord.mockReturnValue(true)
    const { ctx, syncEvents } = makeSyncCtx()
    registerMediaHandlers(ctx)
    await getHandler('media:removeMissing')([5])
    expect(syncEvents.recordAssetChange).toHaveBeenCalledWith('asset.deleted', '5')
  })

  it('CL4(红灯→绿灯): media:removeMissing 记录不存在 → 不 journal', async () => {
    repoMock.removeMissingRecord.mockReturnValue(false)
    const { ctx, syncEvents } = makeSyncCtx()
    registerMediaHandlers(ctx)
    await getHandler('media:removeMissing')([5])
    expect(syncEvents.recordAssetChange).not.toHaveBeenCalled()
  })

  it('ST1(红灯→绿灯): media:analyzeSceneTime → 批量 journal asset.updated', async () => {
    repoMock.getMediaForSceneAnalysis.mockReturnValue([
      { id: 1, file_path: 'D:\\a.jpg' },
      { id: 2, file_path: 'D:\\b.jpg' }
    ])
    repoMock.updateSceneTime.mockResolvedValue(undefined)
    const { ctx, syncEvents } = makeSyncCtx()
    registerMediaHandlers(ctx)
    const result = (await getHandler('media:analyzeSceneTime')([undefined])) as {
      success: boolean
    }
    expect(result.success).toBe(true)
    expect(syncEvents.recordAssetChanges).toHaveBeenCalledWith([
      { eventType: 'asset.updated', assetId: '1' },
      { eventType: 'asset.updated', assetId: '2' }
    ])
  })
})
