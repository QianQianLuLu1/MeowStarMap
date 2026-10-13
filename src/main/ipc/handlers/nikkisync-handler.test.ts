/**
 * @layer L3
 * @module src/main/ipc/handlers/nikkisync-handler
 * @coverage NikkiSync 内嵌运行时只读域 IPC（阶段 2）：5 条通道的注册、参数校验、
 *           DTO 原样透传、未组装/未就绪态的错误映射。
 *
 * 断言口径：`data` 与句柄返回值**逐字段相等**（`toEqual`），以此锁死「内嵌层不做数据
 * 格式转换」这条铁律——一旦 handler 里出现字段重命名或结构包装，本文件立即变红。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler } from './_test-helpers'
import { registerNikkiSyncHandlers } from './nikkisync-handler'
import type { NikkiSyncRuntimeHandle } from '../../nikkisync/runtime-types'
import { AppError } from '../../../shared/errors/app-error'
import { IPC_ERROR_CODES } from '../../../shared/types/ipc-types'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

interface HandleResult {
  success: boolean
  data?: unknown
  error?: { code: string; message: string }
}

function createRuntimeStub(): NikkiSyncRuntimeHandle {
  return {
    status: vi.fn(() => ({
      state: 'running',
      dbPath: '/mock/userData/nikkisync/nikkisync.db',
      linkReady: true,
      tables: ['assets', 'resources']
    })),
    start: vi.fn(async () => ({ state: 'running', dbPath: '', linkReady: true })),
    scan: vi.fn(async () => ({ scanId: 'scan_1', filesObserved: 5, assetsCreated: 2 })),
    stop: vi.fn(async () => undefined),
    listAssets: vi.fn(async (input) => ({
      items: [{ assetId: 'asset_1', input }],
      libraryRevision: 7
    })),
    getAssetDetail: vi.fn(async (assetId) => ({ asset: { assetId, resources: [] } })),
    getResource: vi.fn(async (assetId, resourceId, mode) => ({ assetId, resourceId, mode }))
  }
}

function register(runtime?: NikkiSyncRuntimeHandle) {
  handleMock.mockClear()
  const ctx = makeCtx({ nikkisyncRuntime: runtime })
  registerNikkiSyncHandlers(ctx)
  return ctx
}

beforeEach(() => {
  handleMock.mockClear()
})

describe('nikkisync handler 注册面', () => {
  it('恰好注册 5 条只读通道', () => {
    register(createRuntimeStub())
    const channels = handleMock.mock.calls.map((call) => call[0])
    expect(channels).toEqual([
      'nikkisync:runtime-status',
      'nikkisync:start-scan',
      'nikkisync:get-assets',
      'nikkisync:get-asset-detail',
      'nikkisync:get-resource'
    ])
  })

  it('未组装（sync 面板未启用）时统一给 PRECONDITION_FAILED', async () => {
    register(undefined)
    const status = getHandler(handleMock, 'nikkisync:runtime-status')
    const res = (await status({})) as HandleResult
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
  })
})

describe('nikkisync:runtime-status', () => {
  it('原样返回句柄状态快照', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:runtime-status')
    const res = (await handler({})) as HandleResult
    expect(res.success).toBe(true)
    expect(res.data).toEqual(runtime.status())
  })
})

describe('nikkisync:start-scan', () => {
  it('可缺省参数：不带实参即全量扫描', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:start-scan')
    const res = (await handler({})) as HandleResult
    expect(res.success).toBe(true)
    expect(res.data).toEqual({ scanId: 'scan_1', filesObserved: 5, assetsCreated: 2 })
    expect(runtime.scan).toHaveBeenCalledWith({})
  })

  it('透传 gameRoot 与 path（换根/按 uid 收敛由状态机决定）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:start-scan')
    await handler({}, { gameRoot: 'H:\\InfinityNikki Launcher\\InfinityNikki' })
    expect(runtime.scan).toHaveBeenCalledWith({
      gameRoot: 'H:\\InfinityNikki Launcher\\InfinityNikki'
    })
    await handler({}, { path: 'H:\\game\\GamePlayPhotos\\10001\\a.jpg' })
    expect(runtime.scan).toHaveBeenLastCalledWith({
      path: 'H:\\game\\GamePlayPhotos\\10001\\a.jpg'
    })
  })

  it('非法参数给 VALIDATION_ERROR（gameRoot 空串 / path 非字符串）', async () => {
    register(createRuntimeStub())
    const handler = getHandler(handleMock, 'nikkisync:start-scan')
    expect((await handler({}, { gameRoot: '' })) as HandleResult).toMatchObject({ success: false })
    const bad = (await handler({}, { path: 12 })) as HandleResult
    expect(bad.success).toBe(false)
    expect(bad.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
  })
})

describe('nikkisync:get-assets', () => {
  it('缺省 limit=100，其余可选参数原样下传', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-assets')
    const res = (await handler({})) as HandleResult
    expect(runtime.listAssets).toHaveBeenCalledWith({ limit: 100 })
    expect(res.success).toBe(true)
    // 响应体逐字段等于查询面输出：内嵌层零转换的可执行守卫
    expect(res.data).toEqual({
      items: [{ assetId: 'asset_1', input: { limit: 100 } }],
      libraryRevision: 7
    })

    await handler(
      {},
      { limit: 2, cursor: 'abc', type: 'motion_photo', afterRevision: 9, includeDeleted: true }
    )
    expect(runtime.listAssets).toHaveBeenLastCalledWith({
      limit: 2,
      cursor: 'abc',
      type: 'motion_photo',
      afterRevision: 9,
      includeDeleted: true
    })
  })

  it('limit 越界与非法 type 走 VALIDATION_ERROR（与上游 1..500 同界）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-assets')
    for (const input of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { type: 'unknown_kind' }]) {
      const res = (await handler({}, input)) as HandleResult
      expect(res.success).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
    expect(runtime.listAssets).not.toHaveBeenCalled()
  })
})

describe('nikkisync:get-asset-detail 与 get-resource', () => {
  it('详情：assetId 原样下传，响应等于 mapAssetDetail 结果', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-asset-detail')
    const res = (await handler({}, 'asset_7')) as HandleResult
    expect(runtime.getAssetDetail).toHaveBeenCalledWith('asset_7')
    expect(res.data).toEqual({ asset: { assetId: 'asset_7', resources: [] } })
  })

  it('详情：空 assetId 拒绝', async () => {
    register(createRuntimeStub())
    const handler = getHandler(handleMock, 'nikkisync:get-asset-detail')
    const res = (await handler({}, '')) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
  })

  it('资源：mode 缺省为 meta，path 模式单独放行', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-resource')
    await handler({}, { assetId: 'a', resourceId: 'r' })
    expect(runtime.getResource).toHaveBeenCalledWith('a', 'r', 'meta')
    await handler({}, { assetId: 'a', resourceId: 'r', mode: 'path' })
    expect(runtime.getResource).toHaveBeenLastCalledWith('a', 'r', 'path')
  })

  it('资源：mode 非法值拒绝', async () => {
    register(createRuntimeStub())
    const handler = getHandler(handleMock, 'nikkisync:get-resource')
    const res = (await handler(
      {},
      { assetId: 'a', resourceId: 'r', mode: 'stream' }
    )) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
  })
})

describe('错误映射', () => {
  it('查询面「not found」语义映射为 NOT_FOUND，未就绪映射为 PRECONDITION_FAILED', async () => {
    const runtime = createRuntimeStub()
    vi.mocked(runtime.getAssetDetail).mockRejectedValueOnce(
      new Error('NikkiSync asset not found: asset_x')
    )
    register(runtime)
    const detail = getHandler(handleMock, 'nikkisync:get-asset-detail')
    const res = (await detail({}, 'asset_x')) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.NOT_FOUND)

    const scan = getHandler(handleMock, 'nikkisync:start-scan')
    vi.mocked(runtime.scan).mockRejectedValueOnce(
      new Error('NikkiSync runtime is not ready (runtime state is idle)')
    )
    const scanRes = (await scan({})) as HandleResult
    expect(scanRes.error?.code).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
  })

  it('AppError 原样透出，其余异常归一为 INTERNAL_ERROR 且不外泄堆栈', async () => {
    const runtime = createRuntimeStub()
    vi.mocked(runtime.listAssets).mockRejectedValueOnce(AppError.conflict('revision too old'))
    vi.mocked(runtime.getAssetDetail).mockRejectedValueOnce(new Error('EACCES: permission denied'))
    register(runtime)
    const list = getHandler(handleMock, 'nikkisync:get-assets')
    const listRes = (await list({}, { limit: 5 })) as HandleResult
    expect(listRes.error?.code).toBe(IPC_ERROR_CODES.CONFLICT)

    const detail = getHandler(handleMock, 'nikkisync:get-asset-detail')
    const detailRes = (await detail({}, 'asset_1')) as HandleResult
    expect(detailRes.error?.code).toBe(IPC_ERROR_CODES.INTERNAL_ERROR)
    expect(detailRes.error?.message).toContain('nikkisync query failed')
  })
})
