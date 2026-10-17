/**
 * @layer L2
 * @module src/main/ipc/handlers/_trash-utils
 * @coverage 缩略图清理目标收集与执行（#fix-gallery-delete-thumbnail-cleanup）
 *
 * 覆盖两类清理目标：
 * 1. 应用缩略图缓存：DB thumbnail 列位于 cacheDir 前缀内 → 引用文件 + ${hash}.jpg/_low/_high 三档位
 * 2. 游戏原生 LQ 缩略图：由 file_path 经 resolveNativeThumbnailPath 严格推导（GPP + NikkiPhotos_HighQuality
 *    双段命中才推导），并联动硬删该 LQ 的 DB 记录（LQ 文件本身也是入库媒体记录）
 *
 * 安全边界锁：thumbnail 列不得作为触碰缓存外文件的依据；非 GPP+HQ 路径绝不推导。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'

const { pathExistsMock, unlinkMock, loggerWarnMock } = vi.hoisted(() => ({
  pathExistsMock: vi.fn(),
  unlinkMock: vi.fn().mockResolvedValue(undefined),
  loggerWarnMock: vi.fn()
}))

vi.mock('../../utils/file-utils', () => ({
  pathExists: pathExistsMock
}))
// 仅替换 unlink，其余 fs/promises 保持真实实现（与 media.test.ts 同一口径）
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const mocked = { ...actual, unlink: unlinkMock }
  return { ...mocked, default: mocked }
})
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: loggerWarnMock, error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

import {
  collectThumbnailCleanupTargets,
  cleanupThumbnailsForRows,
  makeNativeThumbRecordCleaner,
  type ThumbnailCleanupTarget
} from './_trash-utils'

const CACHE_DIR = 'C:\\cache\\thumbnails'
const HQ_PATH = 'C:\\game\\X6Game\\Saved\\GamePlayPhotos\\1001\\NikkiPhotos_HighQuality\\p.jpg'
const LQ_PATH = 'C:\\game\\X6Game\\Saved\\GamePlayPhotos\\1001\\NikkiPhotos_LowQuality\\p.jpg'
const SS_PATH = 'C:\\game\\X6Game\\ScreenShot\\p.jpg'
const SS_SAVED_PATH = 'C:\\game\\X6Game\\Saved\\ScreenShot\\p.jpg'

/** 提取某类目标的路径列表（断言辅助） */
function pathsOf(targets: ThumbnailCleanupTarget[], kind: 'cache' | 'native'): string[] {
  return targets.filter((t) => t.kind === kind).map((t) => t.path)
}

describe('collectThumbnailCleanupTargets（目标收集）', () => {
  it('A1 正常：GPP HQ 行推导出同图衍生文件全集（LQ + ScreenShot + Saved\\ScreenShot）；thumbnail 为 LQ 路径（缓存外）不产生缓存目标', () => {
    const targets = collectThumbnailCleanupTargets(
      [{ file_path: HQ_PATH, thumbnail: LQ_PATH }],
      CACHE_DIR
    )
    expect(pathsOf(targets, 'native')).toEqual([LQ_PATH, SS_PATH, SS_SAVED_PATH])
    expect(pathsOf(targets, 'cache')).toEqual([])
  })

  it('A2 正常：缓存内 thumbnail 产出三档位（引用文件 + _low + _high），无原生目标', () => {
    const targets = collectThumbnailCleanupTargets(
      [{ file_path: 'C:\\media\\x.jpg', thumbnail: path.join(CACHE_DIR, 'abc123.jpg') }],
      CACHE_DIR
    )
    expect(pathsOf(targets, 'cache')).toEqual([
      path.join(CACHE_DIR, 'abc123.jpg'),
      path.join(CACHE_DIR, 'abc123_low.jpg'),
      path.join(CACHE_DIR, 'abc123_high.jpg')
    ])
    expect(pathsOf(targets, 'native')).toEqual([])
  })

  it('A3 边界：thumbnail 为 _low 档位时按 hash 规范化还原三档位（含引用文件去重）', () => {
    const targets = collectThumbnailCleanupTargets(
      [{ file_path: 'C:\\media\\x.jpg', thumbnail: path.join(CACHE_DIR, 'abc123_low.jpg') }],
      CACHE_DIR
    )
    const cachePaths = pathsOf(targets, 'cache')
    expect(cachePaths).toContain(path.join(CACHE_DIR, 'abc123.jpg'))
    expect(cachePaths).toContain(path.join(CACHE_DIR, 'abc123_low.jpg'))
    expect(cachePaths).toContain(path.join(CACHE_DIR, 'abc123_high.jpg'))
    expect(cachePaths).toHaveLength(3)
  })

  it('A4 边界：file_path 本身是 LQ 路径（无 HQ 段）不推导（防自指），thumbnail 为 null 无目标', () => {
    const targets = collectThumbnailCleanupTargets(
      [{ file_path: LQ_PATH, thumbnail: null }],
      CACHE_DIR
    )
    expect(targets).toEqual([])
  })

  it('A5 边界：推导 LQ 与批内另一行的 file_path 相同时排除（由其自身行的删除流程处理）；其余副本仍保留', () => {
    const targets = collectThumbnailCleanupTargets(
      [
        { file_path: HQ_PATH, thumbnail: LQ_PATH },
        { file_path: LQ_PATH, thumbnail: null }
      ],
      CACHE_DIR
    )
    expect(pathsOf(targets, 'native')).not.toContain(LQ_PATH)
    expect(pathsOf(targets, 'native')).toEqual([SS_PATH, SS_SAVED_PATH])
  })

  it('A6 边界：thumbnail 在缓存目录外且 file_path 非 GPP HQ → 无任何目标', () => {
    const targets = collectThumbnailCleanupTargets(
      [{ file_path: 'C:\\media\\i.jpg', thumbnail: 'C:\\game\\NikkiPhotos_LowQuality\\i.jpg' }],
      CACHE_DIR
    )
    expect(targets).toEqual([])
  })

  it('A7 组合：GPP HQ 行同时具备缓存 thumbnail（历史数据）与同图衍生文件 → 缓存三档位 + 三个衍生目标并存', () => {
    const targets = collectThumbnailCleanupTargets(
      [{ file_path: HQ_PATH, thumbnail: path.join(CACHE_DIR, 'abc123.jpg') }],
      CACHE_DIR
    )
    expect(pathsOf(targets, 'cache')).toHaveLength(3)
    expect(pathsOf(targets, 'native')).toEqual([LQ_PATH, SS_PATH, SS_SAVED_PATH])
  })

  it('A8 去重：重复行与大小写差异的同名 HQ 只保留一组同图衍生目标（LQ + 两个 ScreenShot）', () => {
    const hqUpper = HQ_PATH.replace('HighQuality', 'HIGHQUALITY')
    const targets = collectThumbnailCleanupTargets(
      [
        { file_path: HQ_PATH, thumbnail: null },
        { file_path: HQ_PATH, thumbnail: null },
        { file_path: hqUpper, thumbnail: null }
      ],
      CACHE_DIR
    )
    expect(pathsOf(targets, 'native')).toHaveLength(3)
  })

  it('A9 边界：cacheDir 为空串直接返回空', () => {
    const targets = collectThumbnailCleanupTargets([{ file_path: HQ_PATH }], '')
    expect(targets).toEqual([])
  })

  it('A10 兼容：行缺 file_path 字段（旧调用方）时仅按 thumbnail 做缓存清理', () => {
    const targets = collectThumbnailCleanupTargets(
      [{ thumbnail: path.join(CACHE_DIR, 'abc123.jpg') } as { thumbnail: string }],
      CACHE_DIR
    )
    expect(pathsOf(targets, 'cache')).toHaveLength(3)
    expect(pathsOf(targets, 'native')).toEqual([])
  })
})

describe('cleanupThumbnailsForRows（清理执行 + 原生记录联动 hook）', () => {
  beforeEach(() => {
    unlinkMock.mockReset().mockResolvedValue(undefined)
    pathExistsMock.mockReset()
    loggerWarnMock.mockClear()
  })

  it('B1 正常：同图衍生文件删除成功后逐个触发 hook；缓存档位一并删除并计数', async () => {
    pathExistsMock.mockResolvedValue(true)
    const hook = vi.fn().mockResolvedValue(undefined)
    const deleted = await cleanupThumbnailsForRows(
      [{ file_path: HQ_PATH, thumbnail: path.join(CACHE_DIR, 'abc123.jpg') }],
      CACHE_DIR,
      { onNativeThumbnailRemoved: hook }
    )
    expect(deleted).toBe(6) // 缓存 3 档位 + 同图衍生文件 3 个（LQ / ScreenShot / Saved\ScreenShot）
    expect(unlinkMock).toHaveBeenCalledWith(LQ_PATH)
    expect(hook).toHaveBeenCalledTimes(3)
    expect(hook).toHaveBeenCalledWith(LQ_PATH)
  })

  it('B2 异常：原生 LQ unlink 失败且文件仍存在时不触发该 hook，其余目标照删并聚合告警', async () => {
    pathExistsMock.mockResolvedValue(true)
    unlinkMock.mockImplementation(async (p: string) => {
      if (p === LQ_PATH) throw new Error('EBUSY: resource busy')
    })
    const hook = vi.fn().mockResolvedValue(undefined)
    const deleted = await cleanupThumbnailsForRows(
      [{ file_path: HQ_PATH, thumbnail: path.join(CACHE_DIR, 'abc123.jpg') }],
      CACHE_DIR,
      { onNativeThumbnailRemoved: hook }
    )
    expect(deleted).toBe(5) // 缓存 3 档位 + ScreenShot 两个副本
    expect(hook.mock.calls.map((c) => c[0])).toEqual([SS_PATH, SS_SAVED_PATH])
    expect(loggerWarnMock).toHaveBeenCalledTimes(1)
    expect(loggerWarnMock.mock.calls[0][0] as string).toContain('缩略图清理')
    expect(loggerWarnMock.mock.calls[0][0] as string).toContain(LQ_PATH)
  })

  it('B3 异常：同图衍生文件本已不存在（missing）时仍触发 hook（记录此刻已悬空应移除）', async () => {
    pathExistsMock.mockResolvedValue(false)
    const hook = vi.fn().mockResolvedValue(undefined)
    const deleted = await cleanupThumbnailsForRows([{ file_path: HQ_PATH }], CACHE_DIR, {
      onNativeThumbnailRemoved: hook
    })
    expect(deleted).toBe(0)
    expect(unlinkMock).not.toHaveBeenCalled()
    expect(hook).toHaveBeenCalledTimes(3)
    expect(hook.mock.calls.map((c) => c[0])).toEqual([LQ_PATH, SS_PATH, SS_SAVED_PATH])
  })

  it('B4 异常：hook 抛错被吞掉并聚合告警，不影响删除计数与函数正常返回', async () => {
    pathExistsMock.mockResolvedValue(true)
    const hook = vi.fn().mockRejectedValue(new Error('db down'))
    const deleted = await cleanupThumbnailsForRows([{ file_path: HQ_PATH }], CACHE_DIR, {
      onNativeThumbnailRemoved: hook
    })
    expect(deleted).toBe(3)
    expect(loggerWarnMock).toHaveBeenCalledTimes(1)
  })

  it('B5 边界：无目标时直接返回 0，不触发任何 unlink 与 hook', async () => {
    pathExistsMock.mockResolvedValue(true)
    const hook = vi.fn().mockResolvedValue(undefined)
    const deleted = await cleanupThumbnailsForRows(
      [{ file_path: 'C:\\media\\i.jpg', thumbnail: 'C:\\elsewhere\\i.jpg' }],
      CACHE_DIR,
      { onNativeThumbnailRemoved: hook }
    )
    expect(deleted).toBe(0)
    expect(unlinkMock).not.toHaveBeenCalled()
    expect(hook).not.toHaveBeenCalled()
  })
})

describe('makeNativeThumbRecordCleaner（LQ 记录联动硬删）', () => {
  it('C1 正常：LQ 路径命中记录时硬删该记录 id', async () => {
    const repo = {
      getMediaIdByPath: vi.fn((p: string) => (p === LQ_PATH ? 99 : undefined)),
      hardDelete: vi.fn().mockResolvedValue(undefined)
    }
    const cleaner = makeNativeThumbRecordCleaner(repo)
    await cleaner(LQ_PATH)
    expect(repo.getMediaIdByPath).toHaveBeenCalledWith(LQ_PATH)
    expect(repo.hardDelete).toHaveBeenCalledWith(99)
  })

  it('C2 边界：路径无对应记录时为 no-op，不调用 hardDelete', async () => {
    const repo = {
      getMediaIdByPath: vi.fn().mockReturnValue(undefined),
      hardDelete: vi.fn().mockResolvedValue(undefined)
    }
    const cleaner = makeNativeThumbRecordCleaner(repo)
    await cleaner(LQ_PATH)
    expect(repo.hardDelete).not.toHaveBeenCalled()
  })
})

describe('同图衍生文件清理（#fix-permanent-delete-game-photo-variants）', () => {
  beforeEach(() => {
    unlinkMock.mockReset().mockResolvedValue(undefined)
    pathExistsMock.mockReset()
    loggerWarnMock.mockClear()
  })

  it('D1 正常：HQ 行的原生目标包含 X6Game\\ScreenShot 与 X6Game\\Saved\\ScreenShot 同名副本', () => {
    const targets = collectThumbnailCleanupTargets(
      [{ file_path: HQ_PATH, thumbnail: null }],
      CACHE_DIR
    )
    expect(pathsOf(targets, 'native')).toEqual([LQ_PATH, SS_PATH, SS_SAVED_PATH])
  })

  it('D2 正常：完全删除 HQ 照片时三个目录的同名文件全部被 unlink', async () => {
    pathExistsMock.mockResolvedValue(true)
    const deleted = await cleanupThumbnailsForRows(
      [{ file_path: HQ_PATH, thumbnail: null }],
      CACHE_DIR
    )
    expect(deleted).toBe(3)
    expect(unlinkMock).toHaveBeenCalledWith(LQ_PATH)
    expect(unlinkMock).toHaveBeenCalledWith(SS_PATH)
    expect(unlinkMock).toHaveBeenCalledWith(SS_SAVED_PATH)
  })

  it('D3 边界：副本文件不存在（目录不齐备）时跳过 unlink、不报错、不计入失败', async () => {
    // 仅 LQ 存在
    pathExistsMock.mockImplementation(async (p: string) => p === LQ_PATH)
    const deleted = await cleanupThumbnailsForRows(
      [{ file_path: HQ_PATH, thumbnail: null }],
      CACHE_DIR
    )
    expect(deleted).toBe(1)
    expect(unlinkMock).toHaveBeenCalledTimes(1)
    expect(unlinkMock).toHaveBeenCalledWith(LQ_PATH)
    expect(loggerWarnMock).not.toHaveBeenCalled()
  })

  it('D4 正常：每个被移除的副本都触发记录清理钩子（联动硬删其 DB 记录）', async () => {
    pathExistsMock.mockResolvedValue(true)
    const hook = vi.fn().mockResolvedValue(undefined)
    await cleanupThumbnailsForRows([{ file_path: HQ_PATH, thumbnail: null }], CACHE_DIR, {
      onNativeThumbnailRemoved: hook
    })
    expect(hook).toHaveBeenCalledTimes(3)
    expect(hook.mock.calls.map((c) => c[0])).toEqual([LQ_PATH, SS_PATH, SS_SAVED_PATH])
  })

  it('D5 异常：ScreenShot 副本 unlink 失败且仍存在 → 其余照删、聚合一条告警、该副本不触发钩子', async () => {
    pathExistsMock.mockResolvedValue(true)
    unlinkMock.mockImplementation(async (p: string) => {
      if (p === SS_PATH) throw new Error('EBUSY: resource busy')
    })
    const hook = vi.fn().mockResolvedValue(undefined)
    const deleted = await cleanupThumbnailsForRows(
      [{ file_path: HQ_PATH, thumbnail: null }],
      CACHE_DIR,
      {
        onNativeThumbnailRemoved: hook
      }
    )
    expect(deleted).toBe(2)
    expect(hook.mock.calls.map((c) => c[0])).toEqual([LQ_PATH, SS_SAVED_PATH])
    expect(loggerWarnMock).toHaveBeenCalledTimes(1)
    expect(loggerWarnMock.mock.calls[0][0] as string).toContain(SS_PATH)
  })

  it('D6 防误伤：用户自建同名目录（无 X6Game\\Saved 锚点）不产出副本目标', () => {
    const targets = collectThumbnailCleanupTargets(
      [
        {
          file_path: 'C:\\backup\\GamePlayPhotos\\1001\\NikkiPhotos_HighQuality\\p.jpg',
          thumbnail: null
        }
      ],
      CACHE_DIR
    )
    expect(targets).toEqual([])
  })

  it('D7 边界：空 file_path / 非官方路径不产出副本目标', () => {
    expect(collectThumbnailCleanupTargets([{ file_path: '' }], CACHE_DIR)).toEqual([])
    expect(collectThumbnailCleanupTargets([{ file_path: 'C:\\media\\p.jpg' }], CACHE_DIR)).toEqual(
      []
    )
  })

  it('D8 边界：推导副本与批内另一行 file_path 相同时排除，避免重复删除', () => {
    const targets = collectThumbnailCleanupTargets(
      [
        { file_path: HQ_PATH, thumbnail: null },
        { file_path: SS_PATH, thumbnail: null }
      ],
      CACHE_DIR
    )
    expect(pathsOf(targets, 'native')).toEqual([LQ_PATH, SS_SAVED_PATH])
  })

  it('D9 边界：副本目标落在缓存目录内属异常数据，不删', () => {
    const targets = collectThumbnailCleanupTargets(
      [
        {
          file_path: path.join(
            CACHE_DIR,
            'X6Game\\Saved\\GamePlayPhotos\\1001\\NikkiPhotos_HighQuality\\p.jpg'
          )
        }
      ],
      CACHE_DIR
    )
    expect(pathsOf(targets, 'native')).toEqual([])
  })

  it('D10 正常：副本记录清理钩子按 cacheDir 清理其缓存三档位后再硬删记录', async () => {
    pathExistsMock.mockResolvedValue(true)
    const repo = {
      getMediaIdByPath: vi.fn().mockReturnValue(77),
      getThumbnailByPath: vi.fn().mockReturnValue(path.join(CACHE_DIR, 'abc123.jpg')),
      hardDelete: vi.fn().mockResolvedValue(undefined)
    }
    const cleaner = makeNativeThumbRecordCleaner(repo, CACHE_DIR)
    await cleaner(SS_PATH)
    expect(unlinkMock).toHaveBeenCalledWith(path.join(CACHE_DIR, 'abc123.jpg'))
    expect(unlinkMock).toHaveBeenCalledWith(path.join(CACHE_DIR, 'abc123_low.jpg'))
    expect(unlinkMock).toHaveBeenCalledWith(path.join(CACHE_DIR, 'abc123_high.jpg'))
    expect(repo.hardDelete).toHaveBeenCalledWith(77)
  })

  it('D11 边界：未提供 cacheDir 或 thumbnail 为空时仅硬删记录，不触碰缓存', async () => {
    pathExistsMock.mockResolvedValue(true)
    const repo = {
      getMediaIdByPath: vi.fn().mockReturnValue(78),
      getThumbnailByPath: vi.fn().mockReturnValue(null),
      hardDelete: vi.fn().mockResolvedValue(undefined)
    }
    const cleanerNoCache = makeNativeThumbRecordCleaner(repo)
    await cleanerNoCache(SS_PATH)
    const cleanerNoThumb = makeNativeThumbRecordCleaner(repo, CACHE_DIR)
    await cleanerNoThumb(LQ_PATH)
    expect(unlinkMock).not.toHaveBeenCalled()
    expect(repo.hardDelete).toHaveBeenCalledTimes(2)
  })
})
