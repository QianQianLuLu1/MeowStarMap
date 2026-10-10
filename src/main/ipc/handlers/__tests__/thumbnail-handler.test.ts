/**
 * @layer L3
 * @module src/main/ipc/handlers/thumbnail-handler
 * @coverage thumbnail:generate 按需生成结果回写 DB（fix-thumbnail-persist-and-ondemand N2）
 * @dependencies electron
 *
 * 缺陷：按需生成结果只存渲染层组件 state，DB thumbnail 保持 NULL → 该行生成的缓存
 * 文件不在启动孤儿清理白名单（thumbnail IS NOT NULL）内，每次启动被当孤儿删除，
 * 下个会话重新生成，形成"每次启动重复生成"死循环。
 * 修复：generate 成功（standard 档）后仅填补 thumbnail IS NULL 的行，并在实际写入时
 * 失效 media:// 协议白名单缓存（对齐 notifyMediaUpdated 既有模式）。
 * 注：错误分支用例（写库抛错不影响返回）在修复前即为绿——它是新契约的一部分，
 * 红灯由回写行为用例承担（修复前不写库 → 断言失败）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'os'
import path from 'path'
import { registerThumbnailHandlers } from '../thumbnail-handler'
import { makeCtx, getHandler } from '../_test-helpers'
import { DatabaseError } from '../../../../shared/errors/app-error'
import { logger } from '../../../utils/logger'

// pathGuard 对用户主目录始终放行（isAllowed 规则 2），测试路径取主目录下避免被拒
const TEST_FILE_PATH = path.join(os.homedir(), 'wxnn-thumb-handler-test', 'a.jpg')

const mockState = vi.hoisted(() => ({ handleMock: vi.fn() }))

// round2 N2 根因用例需要观测「用了哪个读取守卫」：媒体守卫在真实运行时对已入库媒体放行，
// 这里以不抛错等价模拟其放行分支（validator 的裸 PathGuard 保持真实实现，用于复现拒绝）
const guardMocks = vi.hoisted(() => ({
  assertMediaAccessPath: vi.fn(),
  assertMediaReadPath: vi.fn(),
  assertMediaDeletePath: vi.fn()
}))

vi.mock('../../media-read-guard', () => ({
  assertMediaAccessPath: guardMocks.assertMediaAccessPath,
  assertMediaReadPath: guardMocks.assertMediaReadPath,
  assertMediaDeletePath: guardMocks.assertMediaDeletePath
}))

vi.mock('electron', () => ({
  ipcMain: { handle: mockState.handleMock },
  app: { getPath: vi.fn(() => '') }
}))

// round2 N1：诊断日志断言需要观测 logger.warn 的入参
vi.mock('../../../utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    fault: vi.fn(),
    initLogger: vi.fn()
  }
}))

/** 内存 DB stub：仅覆盖 MediaRepository 降级同步路径用到的 prepare().run() 形态 */
function makeDbStub(changes: number, throwOnPrepare = false, throwErr?: unknown) {
  const runMock = vi.fn(() => ({ changes, lastInsertRowid: 1 }))
  const prepareMock = vi.fn(() => {
    if (throwErr !== undefined) throw throwErr
    if (throwOnPrepare) throw new Error('db down')
    return { run: runMock }
  })
  return { db: { prepare: prepareMock, exec: vi.fn(), transaction: vi.fn() }, prepareMock, runMock }
}

describe('thumbnail:generate 按需生成结果回写（fix-thumbnail-persist-and-ondemand N2）', () => {
  beforeEach(() => {
    mockState.handleMock.mockClear()
  })

  function setup(
    generateResult: string | null,
    changes = 1,
    throwOnPrepare = false,
    throwErr?: unknown
  ) {
    const { db, prepareMock, runMock } = makeDbStub(changes, throwOnPrepare, throwErr)
    const generate = vi.fn(async () => generateResult)
    const ctx = makeCtx({
      thumbnailGen: { generate, getCacheDir: vi.fn(() => 'C:\\mock\\cache') },
      db
    })
    registerThumbnailHandlers(ctx)
    const handler = getHandler(mockState.handleMock, 'thumbnail:generate')
    return { ctx, generate, prepareMock, runMock, handler }
  }

  it('正常：generate 成功（standard 档）→ thumbnail IS NULL 行回写 + 失效协议白名单缓存', async () => {
    const filePath = TEST_FILE_PATH
    const { ctx, generate, prepareMock, runMock, handler } = setup('C:\\mock\\cache\\abc.jpg', 1)
    const res = (await handler(undefined, filePath, undefined)) as {
      success: boolean
      data: string | null
    }
    expect(res.success).toBe(true)
    expect(res.data).toBe('C:\\mock\\cache\\abc.jpg')
    expect(generate).toHaveBeenCalledWith(filePath, undefined)
    // 回写 SQL 必须只填补 thumbnail IS NULL 的行（不覆盖扫描/批量写入值）
    expect(prepareMock.mock.calls[0][0]).toContain('UPDATE media_files SET thumbnail = ?')
    expect(prepareMock.mock.calls[0][0]).toContain('thumbnail IS NULL')
    expect(runMock).toHaveBeenCalledWith(['C:\\mock\\cache\\abc.jpg', filePath])
    expect(ctx.invalidateMediaPathCache).toHaveBeenCalledTimes(1)
    expect(ctx.invalidateMediaPathCache).toHaveBeenCalledWith(['C:\\mock\\cache\\abc.jpg'])
  })

  it('异常：generate 返回 null → 不写库、不失效缓存，仍正常返回 null', async () => {
    const { ctx, runMock, handler } = setup(null)
    const res = (await handler(undefined, TEST_FILE_PATH, undefined)) as {
      success: boolean
      data: string | null
    }
    expect(res.success).toBe(true)
    expect(res.data).toBeNull()
    expect(runMock).not.toHaveBeenCalled()
    expect(ctx.invalidateMediaPathCache).not.toHaveBeenCalled()
  })

  it('边界：quality=low / high 是派生档位 → 不写库', async () => {
    for (const quality of ['low', 'high'] as const) {
      const { runMock, handler } = setup('C:\\mock\\cache\\abc.jpg')
      await handler(undefined, TEST_FILE_PATH, quality)
      expect(runMock).not.toHaveBeenCalled()
    }
  })

  it('边界：UPDATE 未命中行（changes=0，行已有值或路径不存在）→ 不失效缓存', async () => {
    const { ctx, handler } = setup('C:\\mock\\cache\\abc.jpg', 0)
    await handler(undefined, TEST_FILE_PATH, undefined)
    expect(ctx.invalidateMediaPathCache).not.toHaveBeenCalled()
  })

  it('异常：写库抛错 → 不影响 IPC 正常返回生成路径', async () => {
    const { handler } = setup('C:\\mock\\cache\\abc.jpg', 1, true)
    const res = (await handler(undefined, TEST_FILE_PATH, undefined)) as {
      success: boolean
      data: string | null
    }
    expect(res.success).toBe(true)
    expect(res.data).toBe('C:\\mock\\cache\\abc.jpg')
  })
})

/**
 * round2 N1：回写失败必须打印可判定的原因。
 *
 * 现象：本机 logs/*.log 有 138 条「按需生成结果回写数据库失败（不影响本次返回）: {}」，
 * 原因字段恒为 `{}` —— electron-log 的默认序列化只取可枚举自身属性，而 Error 的
 * message/stack 都定义在原型上，因此被序列化成空对象，真实原因（SQLITE_BUSY / 写失败
 * 转译 / 参数错误 …）在日志里彻底丢失，导致「每会话重复生成」死循环无法定位。
 * 这三条用例锁定：告警文本必须自带错误码 / message / cause，不再依赖对象序列化。
 */
describe('thumbnail:generate 回写失败诊断日志（round2 N1）', () => {
  beforeEach(() => {
    mockState.handleMock.mockClear()
    vi.mocked(logger.warn).mockClear()
  })

  function setupWithError(err: unknown) {
    const generate = vi.fn(async () => 'C:\\mock\\cache\\abc.jpg')
    const ctx = makeCtx({
      thumbnailGen: { generate, getCacheDir: vi.fn(() => 'C:\\mock\\cache') },
      db: makeDbStub(1, false, err).db
    })
    registerThumbnailHandlers(ctx)
    return getHandler(mockState.handleMock, 'thumbnail:generate')
  }

  function warnText(): string {
    return vi
      .mocked(logger.warn)
      .mock.calls.map((call) => String(call[0]))
      .join(' | ')
  }

  it('异常：普通 Error → 告警文本必须包含该 message', async () => {
    const handler = setupWithError(new Error('SQLITE_BUSY: database is locked'))
    await handler(undefined, TEST_FILE_PATH, undefined)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(warnText()).toContain('SQLITE_BUSY: database is locked')
  })

  it('异常：AppError（DatabaseError）→ 告警文本必须同时包含错误码与 message', async () => {
    const handler = setupWithError(new DatabaseError('写请求被 worker 拒绝'))
    await handler(undefined, TEST_FILE_PATH, undefined)
    const text = warnText()
    expect(text).toContain('DATABASE_ERROR')
    expect(text).toContain('写请求被 worker 拒绝')
  })

  it('边界：错误链带 cause → 告警文本必须展开 cause，否则真实原因仍不可见', async () => {
    const handler = setupWithError(
      new DatabaseError('写请求失败', undefined, { cause: new Error('no such table: media_files') })
    )
    await handler(undefined, TEST_FILE_PATH, undefined)
    expect(warnText()).toContain('no such table: media_files')
  })

  it('边界：抛出非 Error（字符串）→ 不得打印 undefined，仍要原样带出', async () => {
    const handler = setupWithError('thrown-string')
    await handler(undefined, TEST_FILE_PATH, undefined)
    expect(warnText()).toContain('thrown-string')
  })

  it('正常：回写成功 → 不得产生回写失败告警', async () => {
    const generate = vi.fn(async () => 'C:\\mock\\cache\\abc.jpg')
    const ctx = makeCtx({
      thumbnailGen: { generate, getCacheDir: vi.fn(() => 'C:\\mock\\cache') },
      db: makeDbStub(1).db
    })
    registerThumbnailHandlers(ctx)
    const handler = getHandler(mockState.handleMock, 'thumbnail:generate')
    await handler(undefined, TEST_FILE_PATH, undefined)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

/**
 * round2 N2：读取守卫口径（真实数据取证的根因，非推测）。
 *
 * 本机打包态对照实验（同一批已入库媒体路径）：
 * - file:getExif（走 assertMediaReadPath/媒体白名单）→ 全部成功
 * - thumbnail:generate（走裸 assertFileReadPath）→ 4/4 报
 *   「路径不在白名单内，禁止 读取 操作」，0~1ms 即失败
 * 游戏装在未注册进 pathGuard.roots 的 H: 盘时，按需生成**永远**被拒 → DB thumbnail 恒
 * NULL（本机 62/153 图片行）→ 渲染层 hasFailed 命中，卡片停在骨架（重复板块 20 张、
 * 缓存板块 40 张 10s 后仍不归零）→ 每次进板块重走一遍必然失败的请求，即用户报的
 * 「每次启动/切板块都要重新等一遍」。
 * 修法与 file:delete / 导出通道同口径：媒体读取走「已授权媒体」守卫。
 */
describe('thumbnail:generate 读取守卫口径（round2 N2 根因）', () => {
  beforeEach(() => {
    mockState.handleMock.mockClear()
    guardMocks.assertMediaAccessPath.mockReset()
  })

  /** 不在用户主目录、也未注册进 pathGuard.roots 的媒体路径（裸 PathGuard 必然拒绝） */
  const MEDIA_OUTSIDE_ROOT = 'H:\\MockGame\\Saved\\GamePlayPhotos\\114077271\\a.jpeg'

  function setupGuardProbe() {
    const generate = vi.fn(async () => 'C:\\mock\\cache\\abc.jpg')
    const ctx = makeCtx({
      thumbnailGen: { generate, getCacheDir: vi.fn(() => 'C:\\mock\\cache') },
      db: makeDbStub(1).db
    })
    registerThumbnailHandlers(ctx)
    return { ctx, generate, handler: getHandler(mockState.handleMock, 'thumbnail:generate') }
  }

  it('异常（改前红灯）：已入库但不在 PathGuard 根内的媒体路径，必须按媒体口径放行', async () => {
    const { generate, handler } = setupGuardProbe()
    const res = (await handler(undefined, MEDIA_OUTSIDE_ROOT, undefined)) as {
      success: boolean
      data?: string | null
      error?: { message?: string }
    }
    expect(
      res.success,
      `按需生成被读取守卫误拦: ${res.error?.message ?? ''}（守卫口径与 media:// 展示不一致）`
    ).toBe(true)
    expect(res.data).toBe('C:\\mock\\cache\\abc.jpg')
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('正常：必须用「已授权媒体」守卫校验该路径（而非裸 PathGuard）', async () => {
    const { ctx, handler } = setupGuardProbe()
    await handler(undefined, MEDIA_OUTSIDE_ROOT, undefined)
    expect(guardMocks.assertMediaAccessPath).toHaveBeenCalledTimes(1)
    expect(guardMocks.assertMediaAccessPath).toHaveBeenCalledWith(ctx, MEDIA_OUTSIDE_ROOT)
  })

  it('边界：媒体守卫自身拒绝时仍不得放行（不放宽安全边界）', async () => {
    const { generate, handler } = setupGuardProbe()
    guardMocks.assertMediaAccessPath.mockImplementation(() => {
      throw new Error('forbidden-by-media-guard')
    })
    const res = (await handler(undefined, MEDIA_OUTSIDE_ROOT, undefined)) as { success: boolean }
    expect(res.success).toBe(false)
    expect(generate).not.toHaveBeenCalled()
  })
})
