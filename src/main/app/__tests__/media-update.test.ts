/**
 * @layer L1
 * @module src/main/app/media-update
 * @coverage notifyMediaUpdated 节流逻辑 + 缓存失效 + fire-and-forget 缓存刷新
 * @dependencies database/media-repository（mock）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeAppCtx } from '../../ipc/handlers/_test-helpers'

// MediaRepository mock：构造函数被 spy，refreshMediaCountCache / markMediaCountStale 返回可控 promise
// pathGuard mock：registerRoots 被 spy，验证 refreshPathGuardRoots 的注册行为
const {
  refreshMediaCountCacheMock,
  markMediaCountStaleMock,
  MediaRepositoryMock,
  registerRootsMock
} = vi.hoisted(() => ({
  refreshMediaCountCacheMock: vi.fn(),
  markMediaCountStaleMock: vi.fn(),
  MediaRepositoryMock: vi.fn(),
  registerRootsMock: vi.fn()
}))

vi.mock('../../database/media-repository', () => ({
  MediaRepository: MediaRepositoryMock
}))

vi.mock('../../ipc/validator', () => ({
  pathGuard: { registerRoots: registerRootsMock }
}))

import { notifyMediaUpdated, refreshPathGuardRoots } from '../media-update'

describe('notifyMediaUpdated', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MediaRepositoryMock.mockReset()
    refreshMediaCountCacheMock.mockReset()
    markMediaCountStaleMock.mockReset()
    registerRootsMock.mockReset()
    // 默认：MediaRepository 构造返回带 refreshMediaCountCache / markMediaCountStale 的实例
    // vitest 5：生产代码以 `new MediaRepository(...)` 使用桩，箭头实现不可构造
    MediaRepositoryMock.mockImplementation(function createMediaRepositoryMock() {
      return {
        refreshMediaCountCache: refreshMediaCountCacheMock,
        markMediaCountStale: markMediaCountStaleMock
      }
    })
    refreshMediaCountCacheMock.mockResolvedValue(undefined)
    markMediaCountStaleMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('1. 调用时立即触发 invalidateMediaPathCache', () => {
    const ctx = makeAppCtx()
    notifyMediaUpdated(ctx)
    expect(ctx.invalidateMediaPathCache).toHaveBeenCalledTimes(1)
  })

  it('2. db 存在时构造 MediaRepository 并 fire-and-forget refreshMediaCountCache', async () => {
    const db = { prepare: vi.fn() }
    const ctx = makeAppCtx({ db })
    notifyMediaUpdated(ctx)
    // MediaRepository 构造与 refreshMediaCountCache 均发生在节流定时器回调内（100ms 后），
    // 同步阶段不应构造
    expect(MediaRepositoryMock).not.toHaveBeenCalled()
    expect(refreshMediaCountCacheMock).not.toHaveBeenCalled()
    // 推进 100ms 触发节流回调
    vi.advanceTimersByTime(100)
    expect(MediaRepositoryMock).toHaveBeenCalledTimes(1)
    // 构造参数：(db, getWorkerBridge()=null, getDbPath()=mock 路径)
    expect(MediaRepositoryMock).toHaveBeenCalledWith(db, null, '/mock/db/meow_star_map.db')
    // fire-and-forget：节流回调内已调用，promise 已挂起
    await Promise.resolve()
    expect(refreshMediaCountCacheMock).toHaveBeenCalledTimes(1)
  })

  it('3. db 为 null 时跳过缓存刷新，不构造 MediaRepository', () => {
    const ctx = makeAppCtx({ db: null })
    notifyMediaUpdated(ctx)
    expect(MediaRepositoryMock).not.toHaveBeenCalled()
    expect(refreshMediaCountCacheMock).not.toHaveBeenCalled()
  })

  it('4. refreshMediaCountCache reject 时不影响主流程（节流定时器仍设置）', async () => {
    refreshMediaCountCacheMock.mockRejectedValue(new Error('worker crashed'))
    const ctx = makeAppCtx()
    expect(() => notifyMediaUpdated(ctx)).not.toThrow()
    // 节流定时器应已设置（刷新已并入节流回调）
    expect(ctx.getMediaUpdateTimer()).not.toBeNull()
    // 推进 100ms 触发节流回调，执行 refresh 链
    vi.advanceTimersByTime(100)
    // R5：刷新失败应触发 markMediaCountStale（fire-and-forget，需多次 await 刷新微任务链）
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(markMediaCountStaleMock).toHaveBeenCalledTimes(1)
  })

  it('4b. R5 refreshMediaCountCache 失败且 markMediaCountStale 也失败时不抛错', async () => {
    refreshMediaCountCacheMock.mockRejectedValue(new Error('worker crashed'))
    markMediaCountStaleMock.mockRejectedValue(new Error('worker still crashed'))
    const ctx = makeAppCtx()
    expect(() => notifyMediaUpdated(ctx)).not.toThrow()
    // 推进 100ms 触发节流回调，执行 refresh 链
    vi.advanceTimersByTime(100)
    // 等待 fire-and-forget 链完成
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(markMediaCountStaleMock).toHaveBeenCalledTimes(1)
  })

  it('4c. R5 refreshMediaCountCache 成功时不调用 markMediaCountStale', async () => {
    const ctx = makeAppCtx()
    notifyMediaUpdated(ctx)
    // 推进 100ms 触发节流回调，执行 refresh 链
    vi.advanceTimersByTime(100)
    await Promise.resolve()
    expect(refreshMediaCountCacheMock).toHaveBeenCalledTimes(1)
    expect(markMediaCountStaleMock).not.toHaveBeenCalled()
  })

  it('5. 首次调用设置 100ms 节流定时器', () => {
    const ctx = makeAppCtx()
    notifyMediaUpdated(ctx)
    expect(ctx.setMediaUpdateTimer).toHaveBeenCalledTimes(1)
    expect(ctx.getMediaUpdateTimer()).not.toBeNull()
  })

  it('6. 100ms 内再次调用直接返回，不重设定时器', () => {
    const ctx = makeAppCtx()
    notifyMediaUpdated(ctx)
    expect(ctx.setMediaUpdateTimer).toHaveBeenCalledTimes(1)
    // 第二次调用：getMediaUpdateTimer 返回非 null，应短路
    notifyMediaUpdated(ctx)
    expect(ctx.setMediaUpdateTimer).toHaveBeenCalledTimes(1)
  })

  it('7. 定时器触发后向 mainWindow.webContents 发送 media:updated', () => {
    const sendMock = vi.fn()
    const mainWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false), send: sendMock }
    }
    const ctx = makeAppCtx({ mainWindow })
    notifyMediaUpdated(ctx)
    // 定时器未触发前，send 不应被调用
    expect(sendMock).not.toHaveBeenCalled()
    // 推进 100ms
    vi.advanceTimersByTime(100)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('media:updated')
    // 定时器触发后被清空
    expect(ctx.getMediaUpdateTimer()).toBeNull()
  })

  it('8. mainWindow 为 null 时定时器触发后不抛错', () => {
    const ctx = makeAppCtx({ mainWindow: null })
    notifyMediaUpdated(ctx)
    expect(() => vi.advanceTimersByTime(100)).not.toThrow()
    expect(ctx.getMediaUpdateTimer()).toBeNull()
  })

  it('9. pathGuard 白名单刷新已并入节流（同步阶段不注册，100ms 回调内才注册）', () => {
    const ctx = makeAppCtx()
    notifyMediaUpdated(ctx)
    // registerRoots 已移入节流回调，同步阶段不应注册
    expect(registerRootsMock).not.toHaveBeenCalled()
    // 推进 100ms 触发节流回调后才注册
    vi.advanceTimersByTime(100)
    expect(registerRootsMock).toHaveBeenCalledTimes(1)
  })
})

// ============================================================================
// refreshPathGuardRoots
// ============================================================================
describe('refreshPathGuardRoots', () => {
  beforeEach(() => {
    registerRootsMock.mockReset()
  })

  it('1. db 为 null 时直接返回，不调用 registerRoots', () => {
    const ctx = makeAppCtx({ db: null })
    refreshPathGuardRoots(ctx)
    expect(registerRootsMock).not.toHaveBeenCalled()
  })

  it('2. 从 media_files.source_path 注册根目录到 pathGuard', () => {
    const allMock = vi.fn(() => [{ source_path: 'H:\\Photos' }, { source_path: 'D:\\Camera' }])
    const db = { prepare: vi.fn(() => ({ all: allMock })) }
    const ctx = makeAppCtx({ db })
    ctx.dbManager.getSetting.mockReturnValue([])

    refreshPathGuardRoots(ctx)

    expect(registerRootsMock).toHaveBeenCalledTimes(1)
    expect(registerRootsMock).toHaveBeenCalledWith(['H:\\Photos', 'D:\\Camera'])
  })

  it('3. customScanPaths 也被注册到 pathGuard', () => {
    const allMock = vi.fn(() => [{ source_path: 'E:\\Gallery' }])
    const db = { prepare: vi.fn(() => ({ all: allMock })) }
    const ctx = makeAppCtx({ db })
    ctx.dbManager.getSetting.mockReturnValue(['F:\\Custom'])

    refreshPathGuardRoots(ctx)

    expect(registerRootsMock).toHaveBeenCalledWith(['E:\\Gallery', 'F:\\Custom'])
  })

  it('4. db.prepare 抛错时静默，registerRoots 仍以空数组调用', () => {
    const db = {
      prepare: vi.fn(() => {
        throw new Error('table missing')
      })
    }
    const ctx = makeAppCtx({ db })
    ctx.dbManager.getSetting.mockReturnValue([])

    expect(() => refreshPathGuardRoots(ctx)).not.toThrow()
    expect(registerRootsMock).toHaveBeenCalledWith([])
  })

  it('5. getSetting 返回非数组时跳过 customScanPaths', () => {
    const allMock = vi.fn(() => [{ source_path: 'H:\\Photos' }])
    const db = { prepare: vi.fn(() => ({ all: allMock })) }
    const ctx = makeAppCtx({ db })
    ctx.dbManager.getSetting.mockReturnValue('not-an-array')

    refreshPathGuardRoots(ctx)

    expect(registerRootsMock).toHaveBeenCalledWith(['H:\\Photos'])
  })
})
