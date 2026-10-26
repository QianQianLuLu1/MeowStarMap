/**
 * @layer L3
 * @module src/main/ipc/handlers/nikkisync-handler
 * @coverage NikkiSync 内嵌运行时 IPC（阶段 2 只读查询 + 阶段 3 同步服务 + 阶段 4 查询面扩容）：
 *           16 条通道的注册、参数校验、DTO 原样透传、未组装/未就绪/端口占用态的错误映射。
 *
 * 断言口径：`data` 与句柄返回值**逐字段相等**（`toEqual`），以此锁死「内嵌层不做数据
 * 格式转换」这条铁律——一旦 handler 里出现字段重命名或结构包装，本文件立即变红。
 *
 * 注意：`src/main/tsconfig.json` 把测试文件排除在 `tsc -b` 之外，故本文件的类型错误
 * 不会被 `npm run typecheck` 抓到 ⇒ 句柄替身必须与 `NikkiSyncRuntimeHandle` 全量对齐。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler } from './_test-helpers'
import { registerNikkiSyncHandlers } from './nikkisync-handler'
import { pathGuard } from '../validator'
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

/** 与上游 LocalSyncServer 状态同形的服务状态替身。 */
const SERVER_STATUS = {
  running: true,
  host: '0.0.0.0',
  port: 28080,
  secure: true,
  serverId: 'server_mock',
  mdnsEnabled: true,
  tlsFingerprintSha256: 'a'.repeat(64),
  lanHost: '192.168.1.20',
  pairedDeviceCount: 1
}

const PAIRED_DEVICES = [
  {
    deviceId: 'phone_1',
    deviceName: 'Pixel 8',
    platform: 'android' as const,
    pairedAt: '2026-10-14T00:00:00.000Z',
    lastSeenAt: null
  }
]

/** K2：与上游 `MetadataOnlineConsent.state()` 同形的同意状态替身。 */
const CONSENT_STATE = {
  enabled: false,
  policyVersion: '2026-10-13.1',
  recipients: [
    {
      name: 'Nuan5 metadata service',
      endpoint: 'https://nuan5.pro/api/decode-photo2',
      fields: ['photo UID', 'NUAN5 JPEG-prefix parameter MD5 digest']
    }
  ]
}

/** K6：与上游 `ExtraScanDirectories.state()` 同形（含会被剔除的中文 message 字段）。 */
const EXTRA_DIRECTORIES_STATE = {
  directories: [{ id: 'dir_1', path: 'D:\\ExtraPhotos', mode: 'native' }],
  automaticRoots: ['C:\\game\\photos'],
  busy: false,
  message: '就绪',
  scannerStatus: 'running'
}

/** K6：与上游 `inspect()` 提案同形（含会被剔除的中文 hint 字段）。 */
const EXTRA_DIRECTORY_PROPOSAL = {
  id: 'p1',
  roots: [{ path: 'D:\\ExtraPhotos', kind: 'user' }],
  images: 12,
  videos: 2,
  limited: false,
  hint: '已识别 12 张照片'
}

/** K8：与上游 `DeletionQueue.list()` 行同形（含会被剔除的中文 message 字段；id 匹配上游正则）。 */
const ORGANIZER_ROW = {
  id: 'del-1aaaaaaaaaaaaaaa',
  assetId: 'asset_1',
  state: 'pending',
  message: '等待电脑确认',
  online: true,
  files: [{ name: 'a.jpg', size: 123, folder: 'photos' }],
  count: 1
}

/** K8：manager 剔除 message 后的队列视图（handler 逐字段透传锁死零转换）。 */
const ORGANIZER_VIEW = {
  items: [
    {
      id: 'del-1aaaaaaaaaaaaaaa',
      assetId: 'asset_1',
      state: 'pending',
      online: true,
      files: [{ name: 'a.jpg', size: 123, folder: 'photos' }],
      count: 1
    }
  ],
  activity: { catalogPasses: 1, catalogImages: 3, prepared: 2, recycled: 1, queued: 0, active: 0 }
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
    getResource: vi.fn(async (assetId, resourceId, mode) => ({ assetId, resourceId, mode })),
    // ---- 阶段 4：查询面扩容（批量资源 / 增量变更 / 搜索 / 统计）----
    listResourceRecords: vi.fn(async (assetIds) => ({
      byAsset: Object.fromEntries(assetIds.map((assetId) => [assetId, []]))
    })),
    listChanges: vi.fn(async (after, limit) => ({
      changes: [{ revision: after + 1, type: 'asset.updated', assetId: 'asset_1' }],
      libraryRevision: 9,
      fullResyncRequired: false,
      limit
    })),
    searchSuits: vi.fn(async (query) => ({ query, items: [] })),
    searchClothing: vi.fn(async (query) => ({ query, items: [] })),
    profileStats: vi.fn(async () => ({
      libraryRevision: 9,
      topSuits: [],
      topClothing: []
    })),
    // ---- 阶段 3 ----
    syncStatus: vi.fn(() => SERVER_STATUS),
    startSyncServer: vi.fn(async () => SERVER_STATUS),
    stopSyncServer: vi.fn(async () => ({ ...SERVER_STATUS, running: false })),
    pairingCode: vi.fn(async () => ({
      content: 'NS1|server_mock|192.168.1.20|28080|tok|1788000000|' + 'a'.repeat(64),
      expiresAt: '2026-10-14T00:05:00.000Z',
      serverId: 'server_mock',
      host: '192.168.1.20',
      port: 28080,
      tlsFingerprintSha256: 'a'.repeat(64)
    })),
    listPairedDevices: vi.fn(async () => PAIRED_DEVICES),
    revokeDevice: vi.fn(async () => []),
    // ---- K2：在线解析同意 ----
    metadataConsentState: vi.fn(() => CONSENT_STATE),
    setMetadataConsent: vi.fn(() => CONSENT_STATE),
    // ---- K3：游戏版本推断 ----
    resolveGameVersion: vi.fn(async () => ({
      version: '2.5',
      effectiveAt: '2026-04-24T03:00:00.000Z'
    })),
    // ---- K6：额外照片目录 ----
    extraDirectoriesState: vi.fn(() => EXTRA_DIRECTORIES_STATE),
    inspectExtraDirectory: vi.fn(async () => EXTRA_DIRECTORY_PROPOSAL),
    addExtraDirectory: vi.fn(async () => EXTRA_DIRECTORIES_STATE),
    removeExtraDirectory: vi.fn(async () => EXTRA_DIRECTORIES_STATE),
    rescanExtraDirectories: vi.fn(async () => EXTRA_DIRECTORIES_STATE),
    // ---- K8：整理队列（批量删除）----
    organizerStatus: vi.fn(() => ORGANIZER_VIEW),
    organizerDecide: vi.fn(async () => ORGANIZER_VIEW.items),
    organizerApproveMany: vi.fn(async () => ORGANIZER_VIEW)
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
  it('恰好注册 27 条通道（…阶段3 六服务 + K2 两同意 + K3 版本推断 + K6 五条目录 + K8 三条整理队列）', () => {
    register(createRuntimeStub())
    const channels = handleMock.mock.calls.map((call) => call[0])
    expect(channels).toEqual([
      'nikkisync:runtime-status',
      'nikkisync:start-scan',
      'nikkisync:get-assets',
      'nikkisync:get-asset-detail',
      'nikkisync:get-resource',
      'nikkisync:get-resource-records',
      'nikkisync:get-changes',
      'nikkisync:search-suits',
      'nikkisync:search-clothing',
      'nikkisync:profile-stats',
      'nikkisync:server-status',
      'nikkisync:start-server',
      'nikkisync:stop-server',
      'nikkisync:get-pairing-code',
      'nikkisync:get-paired-devices',
      'nikkisync:revoke-device',
      'nikkisync:get-metadata-consent',
      'nikkisync:set-metadata-consent',
      'nikkisync:resolve-game-version',
      'nikkisync:get-extra-directories',
      'nikkisync:inspect-extra-directory',
      'nikkisync:add-extra-directory',
      'nikkisync:remove-extra-directory',
      'nikkisync:rescan-extra-directories',
      'nikkisync:get-organizer-queue',
      'nikkisync:decide-organizer-item',
      'nikkisync:approve-organizer-items'
    ])
  })

  it('未组装（sync 面板未启用）时统一给 PRECONDITION_FAILED', async () => {
    register(undefined)
    const status = getHandler(handleMock, 'nikkisync:runtime-status')
    const res = (await status({})) as HandleResult
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
  })

  it('未组装时 server-status 给 available:false 而不抛错（UI 显示「不可用」而非弹一次错误）', async () => {
    register(undefined)
    const handler = getHandler(handleMock, 'nikkisync:server-status')
    const res = (await handler({})) as HandleResult
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({ available: false, running: false })
    // 服务类通道仍需要句柄
    const start = getHandler(handleMock, 'nikkisync:start-server')
    expect(((await start({}, {})) as HandleResult).error?.code).toBe(
      IPC_ERROR_CODES.PRECONDITION_FAILED
    )
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

  it('扫描完成后推 nikkisync:library-changed（图库据此自动刷新，无需手动重载）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const send = vi.fn()
    const handler = getHandler(handleMock, 'nikkisync:start-scan')
    const res = (await handler({ sender: { send } }, {})) as HandleResult
    expect(res.success).toBe(true)
    expect(send).toHaveBeenCalledWith('nikkisync:library-changed')
  })

  it('事件发送失败不得把成功的扫描判成失败（渲染进程可能已关闭）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:start-scan')
    const res = (await handler(
      {
        sender: {
          send: () => {
            throw new Error('window closed')
          }
        }
      },
      {}
    )) as HandleResult
    expect(res.success).toBe(true)
  })

  it('无 sender 时静默跳过推送（CLI / 探针复用同一 handler）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:start-scan')
    await expect(handler({}, {})).resolves.toMatchObject({ success: true })
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

describe('nikkisync:server-status（阶段3）', () => {
  it('逐字段透传状态机快照并补 available', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:server-status')
    const res = (await handler({})) as HandleResult
    expect(res.success).toBe(true)
    expect(res.data).toEqual({ available: true, ...SERVER_STATUS })
    expect(runtime.syncStatus).toHaveBeenCalledTimes(1)
  })
})

describe('nikkisync:start-server / stop-server（阶段3）', () => {
  it('缺省参数即按构造期配置启动，响应等于状态快照', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:start-server')
    const res = (await handler({}, {})) as HandleResult
    expect(runtime.startSyncServer).toHaveBeenCalledWith({})
    expect(res.data).toEqual({ available: true, ...SERVER_STATUS })
  })

  it('透传 port 与 mdnsEnabled（键缺失时不注入 undefined，交由状态机沿用当前配置）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:start-server')
    await handler({}, { port: 39139, mdnsEnabled: false })
    expect(runtime.startSyncServer).toHaveBeenLastCalledWith({ port: 39139, mdnsEnabled: false })
    await handler({}, undefined)
    expect(runtime.startSyncServer).toHaveBeenLastCalledWith({})
  })

  it('端口非法一律 VALIDATION_ERROR 且绝不调用状态机', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:start-server')
    for (const input of [
      { port: 0 },
      { port: 65536 },
      { port: 28080.5 },
      { port: '28080' },
      { mdnsEnabled: 'yes' }
    ]) {
      const res = (await handler({}, input)) as HandleResult
      expect(res.success).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
    expect(runtime.startSyncServer).not.toHaveBeenCalled()
  })

  it('端口占用：状态机不外抛 ⇒ handler 按状态合成 PRECONDITION_FAILED 并保留 PORT_IN_USE', async () => {
    const runtime = createRuntimeStub()
    vi.mocked(runtime.startSyncServer).mockResolvedValueOnce({
      ...SERVER_STATUS,
      running: false,
      error: 'PORT_IN_USE'
    })
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:start-server')
    const res = (await handler({}, {})) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
    expect(res.error?.message).toContain('PORT_IN_USE')
  })

  it('非端口类启动失败归一为 INTERNAL_ERROR（不吞原因）', async () => {
    const runtime = createRuntimeStub()
    vi.mocked(runtime.startSyncServer).mockResolvedValueOnce({
      ...SERVER_STATUS,
      running: false,
      error: 'listen EACCES: permission denied'
    })
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:start-server')
    const res = (await handler({}, {})) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.INTERNAL_ERROR)
    expect(res.error?.message).toContain('EACCES')
  })

  it('stop-server 返回停止后的状态（available:true, running:false）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:stop-server')
    const res = (await handler({})) as HandleResult
    expect(runtime.stopSyncServer).toHaveBeenCalledTimes(1)
    expect(res.data).toMatchObject({ available: true, running: false })
  })
})

describe('nikkisync:get-pairing-code（阶段3）', () => {
  it('原样透出上游 NS1 七段串（本层不重编码、不改字段）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-pairing-code')
    const res = (await handler({})) as HandleResult
    const data = res.data as { content: string; port: number }
    expect(data.content.split('|')).toHaveLength(7)
    expect(data.content.startsWith('NS1|server_mock|')).toBe(true)
    expect(data.port).toBe(28080)
  })

  it('服务未运行时上游原生抛错 ⇒ 映射为 PRECONDITION_FAILED（不是 INTERNAL）', async () => {
    const runtime = createRuntimeStub()
    vi.mocked(runtime.pairingCode).mockRejectedValueOnce(
      new Error('Server must be started before creating a pairing payload')
    )
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-pairing-code')
    const res = (await handler({})) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
  })
})

describe('nikkisync:get-paired-devices / revoke-device（阶段3）', () => {
  it('列表原样返回上游 paired_devices 行（管理视图，不含公钥/凭据哈希）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-paired-devices')
    const res = (await handler({})) as HandleResult
    expect(res.data).toEqual(PAIRED_DEVICES)
    expect(JSON.stringify(res.data)).not.toMatch(/public_key|credential/)
  })

  it('未就绪时列表与撤销都给 PRECONDITION_FAILED', async () => {
    const runtime = createRuntimeStub()
    vi.mocked(runtime.listPairedDevices).mockRejectedValueOnce(
      new Error('NikkiSync runtime is not ready (runtime state is idle)')
    )
    vi.mocked(runtime.revokeDevice).mockRejectedValueOnce(
      new Error('NikkiSync runtime is not ready (runtime state is idle)')
    )
    register(runtime)
    const list = getHandler(handleMock, 'nikkisync:get-paired-devices')
    expect(((await list({})) as HandleResult).error?.code).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
    const revoke = getHandler(handleMock, 'nikkisync:revoke-device')
    expect(((await revoke({}, 'phone_1')) as HandleResult).error?.code).toBe(
      IPC_ERROR_CODES.PRECONDITION_FAILED
    )
  })

  it('撤销：合法 id 下传并返回新列表；不存在映射为 NOT_FOUND', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:revoke-device')
    const res = (await handler({}, 'phone_1')) as HandleResult
    expect(runtime.revokeDevice).toHaveBeenCalledWith('phone_1')
    expect(res.data).toEqual([])

    vi.mocked(runtime.revokeDevice).mockRejectedValueOnce(
      new Error('NikkiSync device not found or already revoked: ghost')
    )
    const missing = (await handler({}, 'ghost')) as HandleResult
    expect(missing.error?.code).toBe(IPC_ERROR_CODES.NOT_FOUND)
  })

  it('撤销：deviceId 空串 / 超长 / 非字符串一律 VALIDATION_ERROR 且不调用句柄', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:revoke-device')
    for (const raw of ['', '   ', 12, null, 'x'.repeat(129)]) {
      const res = (await handler({}, raw)) as HandleResult
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
    expect(runtime.revokeDevice).not.toHaveBeenCalled()
  })
})

// ============================================================================
// 阶段 4（UI Bridge）：查询面扩容的五条通道。
//
// 断言口径升级：既有用例用 `toEqual` 锁「字段一致」，本组新用例改用 **`toBe` 身份相等**——
// 只要 handler 里出现 `{...data}`、字段改名或再包一层，返回的就是另一个对象，立即变红。
// 这是「IPC 桥接是薄转发层」最直接的守卫形式。
// ============================================================================

describe('nikkisync:get-resource-records（阶段4 批量资源）', () => {
  it('响应体与句柄返回值同一身份；mode 缺省 meta', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-resource-records')
    const sentinel = { byAsset: { 'a/1': [{ resourceId: 'r1' }] } }
    vi.mocked(runtime.listResourceRecords).mockResolvedValueOnce(sentinel)
    const res = (await handler({}, { assetIds: ['a/1'] })) as HandleResult
    expect(runtime.listResourceRecords).toHaveBeenCalledWith(['a/1'], 'meta')
    expect(res.success).toBe(true)
    expect(res.data).toBe(sentinel)
  })

  it('mode:path 逐字下传，路径表原样透出', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-resource-records')
    await handler({}, { assetIds: ['a/1', 'a/2'], mode: 'path' })
    expect(runtime.listResourceRecords).toHaveBeenCalledWith(['a/1', 'a/2'], 'path')
  })

  it('assetIds 空数组 / 超 500 / 含空串 / 非数组 ⇒ VALIDATION_ERROR 且不调句柄', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-resource-records')
    const badInputs: unknown[] = [
      { assetIds: [] },
      { assetIds: Array.from({ length: 501 }, (_, i) => `a${i}`) },
      { assetIds: [''] },
      { assetIds: 'a/1' },
      { assetIds: ['a/1'], mode: 'bytes' },
      {}
    ]
    for (const input of badInputs) {
      const res = (await handler({}, input)) as HandleResult
      expect(res.success, JSON.stringify(input)).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
    expect(runtime.listResourceRecords).not.toHaveBeenCalled()
  })
})

describe('nikkisync:get-changes（阶段4 增量变更）', () => {
  it('after 必填、limit 缺省 1000，响应原样透出', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-changes')
    const sentinel = {
      changes: [{ revision: 41, type: 'asset.updated', assetId: 'a/1', occurredAt: 'x' }],
      libraryRevision: 41,
      fullResyncRequired: false
    }
    vi.mocked(runtime.listChanges).mockResolvedValueOnce(sentinel)
    const res = (await handler({}, { after: 40 })) as HandleResult
    expect(runtime.listChanges).toHaveBeenCalledWith(40, 1000)
    expect(res.data).toBe(sentinel)
  })

  it('fullResyncRequired:true 不被改写（前端据此才重置游标重取首页）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-changes')
    const sentinel = { changes: [], libraryRevision: 90, fullResyncRequired: true }
    vi.mocked(runtime.listChanges).mockResolvedValueOnce(sentinel)
    const res = (await handler({}, { after: 0, limit: 500 })) as HandleResult
    expect(runtime.listChanges).toHaveBeenCalledWith(0, 500)
    expect(res.data).toBe(sentinel)
    expect((res.data as typeof sentinel).fullResyncRequired).toBe(true)
  })

  it('after 缺失/负数/小数 与 limit 越界 ⇒ VALIDATION_ERROR 且不调句柄', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-changes')
    for (const input of [
      {},
      { after: -1 },
      { after: 1.5 },
      { after: 0, limit: 0 },
      { after: 0, limit: 1001 }
    ]) {
      const res = (await handler({}, input)) as HandleResult
      expect(res.error?.code, JSON.stringify(input)).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
    expect(runtime.listChanges).not.toHaveBeenCalled()
  })
})

describe('nikkisync:search-suits / search-clothing / profile-stats（阶段4）', () => {
  it('query 原样下传（trim 与空判归上游索引内部），响应同一身份', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const suits = getHandler(handleMock, 'nikkisync:search-suits')
    const clothing = getHandler(handleMock, 'nikkisync:search-clothing')
    const suitSentinel = { query: '  花 ', items: [{ suitName: 'x' }] }
    const clothingSentinel = { query: '  花 ', items: [] }
    vi.mocked(runtime.searchSuits).mockResolvedValueOnce(suitSentinel)
    vi.mocked(runtime.searchClothing).mockResolvedValueOnce(clothingSentinel)
    const a = (await suits({}, { query: '  花 ' })) as HandleResult
    expect(runtime.searchSuits).toHaveBeenCalledWith('  花 ')
    expect(a.data).toBe(suitSentinel)
    const b = (await clothing({}, { query: '  花 ' })) as HandleResult
    expect(runtime.searchClothing).toHaveBeenCalledWith('  花 ')
    expect(b.data).toBe(clothingSentinel)
  })

  it('query 空串 / 全空白 / 超长 ⇒ VALIDATION_ERROR 且不调句柄', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    for (const channel of ['nikkisync:search-suits', 'nikkisync:search-clothing']) {
      const handler = getHandler(handleMock, channel)
      for (const input of [{}, { query: '' }, { query: '   ' }, { query: 'x'.repeat(129) }]) {
        const res = (await handler({}, input)) as HandleResult
        expect(res.error?.code, `${channel} ${JSON.stringify(input)}`).toBe(
          IPC_ERROR_CODES.VALIDATION_ERROR
        )
      }
    }
    expect(runtime.searchSuits).not.toHaveBeenCalled()
    expect(runtime.searchClothing).not.toHaveBeenCalled()
  })

  it('profile-stats 无参调用并原样返回', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:profile-stats')
    const sentinel = { libraryRevision: 9, topSuits: [{ suitName: 'x', photoCount: 2 }] }
    vi.mocked(runtime.profileStats).mockResolvedValueOnce(sentinel)
    const res = (await handler({})) as HandleResult
    expect(runtime.profileStats).toHaveBeenCalledTimes(1)
    expect(res.data).toBe(sentinel)
  })
})

describe('阶段4 扩容通道的未装配态', () => {
  it('五条新通道统一给 PRECONDITION_FAILED（不降级成 INTERNAL_ERROR，也不静默空列表）', async () => {
    register(undefined)
    const cases: Array<[string, unknown]> = [
      ['nikkisync:get-resource-records', { assetIds: ['a/1'] }],
      ['nikkisync:get-changes', { after: 0 }],
      ['nikkisync:search-suits', { query: '花' }],
      ['nikkisync:search-clothing', { query: '花' }],
      ['nikkisync:profile-stats', undefined]
    ]
    for (const [channel, input] of cases) {
      const handler = getHandler(handleMock, channel)
      const res = (await handler({}, input)) as HandleResult
      expect(res.success, channel).toBe(false)
      expect(res.error?.code, channel).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
    }
  })

  it('上游 not found 类错误仍映射 NOT_FOUND（与既有三面同口径）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-changes')
    vi.mocked(runtime.listChanges).mockRejectedValueOnce(new Error('journal table not found'))
    const res = (await handler({}, { after: 0 })) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.NOT_FOUND)
  })
})

// ============================================================================
// K2：在线解析同意通道（get / set-metadata-consent）
// ============================================================================

describe('nikkisync:get-metadata-consent（K2）', () => {
  it('原样透传同意状态（endpoint 已由上游脱敏、fields 为技术字段清单）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-metadata-consent')
    const res = (await handler({})) as HandleResult
    expect(res.success).toBe(true)
    expect(res.data).toBe(CONSENT_STATE)
  })

  it('未装配会话 ⇒ PRECONDITION_FAILED', async () => {
    register(undefined)
    const handler = getHandler(handleMock, 'nikkisync:get-metadata-consent')
    const res = (await handler({})) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
  })

  it('会话未挂同意面（解析关闭）⇒ PRECONDITION_FAILED 而非 INTERNAL', async () => {
    const runtime = createRuntimeStub()
    vi.mocked(runtime.metadataConsentState).mockImplementationOnce(() => {
      throw new Error('metadata consent is unavailable (resolver disabled)')
    })
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-metadata-consent')
    const res = (await handler({})) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
  })
})

describe('nikkisync:set-metadata-consent（K2）', () => {
  it('合法入参下传并返回更新后的状态', async () => {
    const runtime = createRuntimeStub()
    vi.mocked(runtime.setMetadataConsent).mockImplementationOnce(() => ({
      ...CONSENT_STATE,
      enabled: true
    }))
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:set-metadata-consent')
    const res = (await handler(
      {},
      { enabled: true, policyVersion: '2026-10-13.1' }
    )) as HandleResult
    expect(runtime.setMetadataConsent).toHaveBeenCalledWith(true, '2026-10-13.1')
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({ enabled: true })
  })

  it('入参非法（enabled 非布尔 / policyVersion 空/超长/非串）⇒ VALIDATION_ERROR 且不调句柄', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:set-metadata-consent')
    for (const input of [
      {},
      { enabled: 'yes', policyVersion: 'v' },
      { enabled: true },
      { enabled: true, policyVersion: '' },
      { enabled: true, policyVersion: 'x'.repeat(65) },
      { enabled: true, policyVersion: 12 }
    ]) {
      const res = (await handler({}, input)) as HandleResult
      expect(res.success, JSON.stringify(input)).toBe(false)
      expect(res.error?.code, JSON.stringify(input)).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
    expect(runtime.setMetadataConsent).not.toHaveBeenCalled()
  })

  it('上游 policyVersion 不匹配（中文原生文案）⇒ VALIDATION_ERROR 且不透传中文', async () => {
    const runtime = createRuntimeStub()
    vi.mocked(runtime.setMetadataConsent).mockImplementationOnce(() => {
      throw new Error('请先阅读并同意当前在线解析说明')
    })
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:set-metadata-consent')
    const res = (await handler({}, { enabled: true, policyVersion: 'stale' })) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    expect(res.error?.message).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('未装配 / 同意面缺席 ⇒ PRECONDITION_FAILED', async () => {
    register(undefined)
    const missing = getHandler(handleMock, 'nikkisync:set-metadata-consent')
    const res = (await missing(
      {},
      { enabled: true, policyVersion: '2026-10-13.1' }
    )) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
  })
})

// ============================================================================
// K3：游戏版本推断通道（纯本地静态表，无出站）
// ============================================================================

describe('nikkisync:resolve-game-version（K3）', () => {
  it('capturedAt 原样下传、结果同一身份透出', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:resolve-game-version')
    const sentinel = { version: '2.5', effectiveAt: '2026-04-24T03:00:00.000Z' }
    vi.mocked(runtime.resolveGameVersion).mockResolvedValueOnce(sentinel)
    const res = (await handler({}, { capturedAt: '2026-05-01T00:00:00.000Z' })) as HandleResult
    expect(runtime.resolveGameVersion).toHaveBeenCalledWith('2026-05-01T00:00:00.000Z')
    expect(res.success).toBe(true)
    expect(res.data).toBe(sentinel)
  })

  it('无参调用放行（capturedAt=undefined 交上游判「无法推断」）；非法输入不抛错、返回缺省', async () => {
    const runtime = createRuntimeStub()
    vi.mocked(runtime.resolveGameVersion).mockResolvedValueOnce({})
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:resolve-game-version')
    const missing = (await handler({}, {})) as HandleResult
    expect(missing.success).toBe(true)
    expect(runtime.resolveGameVersion).toHaveBeenCalledWith(undefined)

    // ISO 8601 之外的输入原样下传由上游判缺省，本层不做日期格式校验（纯查询无副作用）
    const garbage = (await handler({}, { capturedAt: 'not-a-date' })) as HandleResult
    expect(garbage.success).toBe(true)
    expect(runtime.resolveGameVersion).toHaveBeenLastCalledWith('not-a-date')
  })

  it('capturedAt 超长（>64）⇒ VALIDATION_ERROR 且不调句柄；未装配 ⇒ PRECONDITION_FAILED', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:resolve-game-version')
    const bad = (await handler({}, { capturedAt: 'x'.repeat(65) })) as HandleResult
    expect(bad.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    expect(runtime.resolveGameVersion).not.toHaveBeenCalled()

    register(undefined)
    const unprepared = getHandler(handleMock, 'nikkisync:resolve-game-version')
    const res = (await unprepared({})) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
  })
})

// ============================================================================
// K6：额外照片目录五通道（上游 ExtraScanDirectories；仅作用于同步库扫描器）
// ============================================================================

describe('nikkisync:*-extra-directories（K6）', () => {
  it('get：状态透传但剔除上游中文 message（含 scannerStatus 汇总）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-extra-directories')
    const res = (await handler({})) as HandleResult
    expect(res.success).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.directories).toEqual(EXTRA_DIRECTORIES_STATE.directories)
    expect(data.automaticRoots).toEqual(EXTRA_DIRECTORIES_STATE.automaticRoots)
    expect('message' in data).toBe(false)
    expect(JSON.stringify(data)).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('inspect：path 原样下传、提案剔除中文 hint；相对路径/空串/超长 ⇒ VALIDATION 且不调句柄', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    // 真实流程里这条路径来自 dialog:selectDirectory（同步服务页「添加目录」），主进程侧
    // 由 dialog-handler 登记为 userPickedDir；此处按同一事实造桩，不靠放宽校验让它通过。
    pathGuard.registerUserPickedDir('D:\\ExtraPhotos')
    const handler = getHandler(handleMock, 'nikkisync:inspect-extra-directory')
    const res = (await handler({}, { path: 'D:\\ExtraPhotos' })) as HandleResult
    expect(runtime.inspectExtraDirectory).toHaveBeenCalledWith('D:\\ExtraPhotos')
    const data = res.data as Record<string, unknown>
    expect(data.id).toBe('p1')
    expect(data.images).toBe(12)
    expect('hint' in data).toBe(false)

    for (const bad of ['relative/path', '', 'x'.repeat(4097)]) {
      const rejected = (await handler({}, { path: bad })) as HandleResult
      expect(rejected.error?.code, JSON.stringify(bad)).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
    expect(runtime.inspectExtraDirectory).toHaveBeenCalledTimes(1)
  })

  it('inspect：绝对但未登记的伪造路径 ⇒ PATH_FORBIDDEN 且不调句柄（渲染层路径必须先过白名单）', async () => {
    // 硬规则：涉及文件路径的通道要按读写语义校验。inspect 的入参是渲染层给的绝对路径，
    // 且会交给上游真去枚举目录（并可被提升为长期扫描根 ⇒ 其内容随后经 media:// 可读），
    // 只校验「是不是绝对路径」等于把一个可信目录选择器换成任意目录探针。
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:inspect-extra-directory')
    // 刻意与上一条已登记的 D:\ExtraPhotos 不同：pathGuard 是模块级单例，同路径会互相污染
    const res = (await handler({}, { path: 'D:\\ForgedPhotos' })) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    expect(runtime.inspectExtraDirectory).not.toHaveBeenCalled()
  })

  it('add / remove：id 下传并返回状态；id 空串/超长 ⇒ VALIDATION 且不调句柄', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const add = getHandler(handleMock, 'nikkisync:add-extra-directory')
    await add({}, { id: 'p1' })
    expect(runtime.addExtraDirectory).toHaveBeenCalledWith('p1')
    const remove = getHandler(handleMock, 'nikkisync:remove-extra-directory')
    await remove({}, { id: 'dir_1' })
    expect(runtime.removeExtraDirectory).toHaveBeenCalledWith('dir_1')
    for (const bad of ['', ' ', 'x'.repeat(129)]) {
      const rejected = (await add({}, { id: bad })) as HandleResult
      expect(rejected.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
    expect(runtime.addExtraDirectory).toHaveBeenCalledTimes(1)
  })

  it('rescan：无参调用并返回状态', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:rescan-extra-directories')
    const res = (await handler({})) as HandleResult
    expect(runtime.rescanExtraDirectories).toHaveBeenCalledTimes(1)
    expect(res.success).toBe(true)
  })

  it('九错误短码逐码映射（输入类→VALIDATION，状态类→PRECONDITION），中文原文不透传', async () => {
    const validationCodes = [
      'invalid_directory',
      'choose_subfolder',
      'thumbnail_only',
      'choose_photo_folder',
      'already_covered'
    ]
    const preconditionCodes = [
      'directory_unavailable',
      'too_many_directories',
      'selection_expired',
      'directory_not_found'
    ]
    const runtime = createRuntimeStub()
    for (const code of validationCodes) {
      vi.mocked(runtime.inspectExtraDirectory).mockRejectedValueOnce(new Error(code))
    }
    for (const code of preconditionCodes) {
      vi.mocked(runtime.inspectExtraDirectory).mockRejectedValueOnce(new Error(code))
    }
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:inspect-extra-directory')
    // D:\X 是「用户挑完目录、上游按内容判形不合格」的场景桩：本用例只锁错误短码映射，
    // 与白名单无关，故按真实流程登记为 userPickedDir，让守卫不先拦掉映射断言。
    pathGuard.registerUserPickedDir('D:\\X')
    for (const code of validationCodes) {
      const res = (await handler({}, { path: 'D:\\X' })) as HandleResult
      expect(res.error?.code, code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
    for (const code of preconditionCodes) {
      const res = (await handler({}, { path: 'D:\\X' })) as HandleResult
      expect(res.error?.code, code).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
    }
  })

  it('未装配 ⇒ 五通道统一 PRECONDITION_FAILED', async () => {
    register(undefined)
    const cases: Array<[string, unknown]> = [
      ['nikkisync:get-extra-directories', undefined],
      ['nikkisync:inspect-extra-directory', { path: 'D:\\X' }],
      ['nikkisync:add-extra-directory', { id: 'p1' }],
      ['nikkisync:remove-extra-directory', { id: 'dir_1' }],
      ['nikkisync:rescan-extra-directories', undefined]
    ]
    for (const [channel, input] of cases) {
      const handler = getHandler(handleMock, channel)
      const res = (await handler({}, input)) as HandleResult
      expect(res.error?.code, channel).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
    }
  })
})

// ===== K8：整理队列（批量删除）三通道 =====

describe('nikkisync 整理队列三通道（K8，破坏性能力）', () => {
  /** 开关开：ctx.dbManager.getSetting 对 organizerEnabled 返回 true。 */
  function registerWithSwitch(enabled: boolean, runtime?: NikkiSyncRuntimeHandle) {
    const ctx = register(runtime ?? createRuntimeStub())
    ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string, fallback: unknown) =>
        key === 'nikkisync.organizerEnabled' ? enabled : fallback
    )
    return ctx
  }

  it('开关门：nikkisync.organizerEnabled 缺省（false）⇒ 三通道全拒 PRECONDITION_FAILED 且句柄零调用', async () => {
    const runtime = createRuntimeStub()
    registerWithSwitch(false, runtime)
    const cases: Array<[string, unknown]> = [
      ['nikkisync:get-organizer-queue', undefined],
      ['nikkisync:decide-organizer-item', { id: ORGANIZER_ROW.id, approve: true }],
      ['nikkisync:approve-organizer-items', { ids: [ORGANIZER_ROW.id] }]
    ]
    for (const [channel, input] of cases) {
      const handler = getHandler(handleMock, channel)
      const res = (await handler({}, input)) as HandleResult
      expect(res.success, channel).toBe(false)
      expect(res.error?.code, channel).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
      expect(res.error?.message, channel).toContain('organizer is disabled')
    }
    expect(runtime.organizerStatus).not.toHaveBeenCalled()
    expect(runtime.organizerDecide).not.toHaveBeenCalled()
    expect(runtime.organizerApproveMany).not.toHaveBeenCalled()
  })

  it('开关开：get-organizer-queue 数据与句柄返回值逐字段相等（零转换铁律）', async () => {
    const runtime = createRuntimeStub()
    registerWithSwitch(true, runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-organizer-queue')
    const res = (await handler({})) as HandleResult
    expect(res.success).toBe(true)
    expect(res.data).toEqual(runtime.organizerStatus())
    expect(res.data).toEqual(ORGANIZER_VIEW)
  })

  it('开关开：decide-organizer-item 参数逐字透传（批准/拒绝两支）', async () => {
    const runtime = createRuntimeStub()
    registerWithSwitch(true, runtime)
    const handler = getHandler(handleMock, 'nikkisync:decide-organizer-item')
    await handler({}, { id: ORGANIZER_ROW.id, approve: true })
    await handler({}, { id: ORGANIZER_ROW.id, approve: false })
    expect(runtime.organizerDecide).toHaveBeenNthCalledWith(1, ORGANIZER_ROW.id, true)
    expect(runtime.organizerDecide).toHaveBeenNthCalledWith(2, ORGANIZER_ROW.id, false)
  })

  it('开关开：approve-organizer-items ids 逐字透传', async () => {
    const runtime = createRuntimeStub()
    registerWithSwitch(true, runtime)
    const handler = getHandler(handleMock, 'nikkisync:approve-organizer-items')
    const ids = ['del-1aaaaaaaaaaaaaaa', 'del-2aaaaaaaaaaaaaaa']
    await handler({}, { ids })
    expect(runtime.organizerApproveMany).toHaveBeenCalledWith(ids)
  })

  it('入参校验：id 不匹配上游同规正则 ⇒ VALIDATION_ERROR 且句柄零调用；ids 空/超 500 同拒', async () => {
    const runtime = createRuntimeStub()
    registerWithSwitch(true, runtime)
    const decideHandler = getHandler(handleMock, 'nikkisync:decide-organizer-item')
    const badIds = ['short', 'del_1!', ORGANIZER_ROW.id + 'x'.repeat(70)]
    for (const id of badIds) {
      const res = (await decideHandler({}, { id, approve: true })) as HandleResult
      expect(res.error?.code, id).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
    expect(runtime.organizerDecide).not.toHaveBeenCalled()

    const approveHandler = getHandler(handleMock, 'nikkisync:approve-organizer-items')
    const empty = (await approveHandler({}, { ids: [] })) as HandleResult
    expect(empty.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    const tooMany = (await approveHandler(
      {},
      { ids: Array.from({ length: 501 }, (_, i) => `del-${String(i).padStart(20, '0')}`) }
    )) as HandleResult
    expect(tooMany.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    expect(runtime.organizerApproveMany).not.toHaveBeenCalled()
  })

  it('上游错误显式映射：not_pending/invalid_ids→VALIDATION、phone_offline→PRECONDITION、stopping→CANCELED', async () => {
    const runtime = createRuntimeStub()
    registerWithSwitch(true, runtime)
    const decideHandler = getHandler(handleMock, 'nikkisync:decide-organizer-item')
    vi.mocked(runtime.organizerDecide).mockRejectedValueOnce(new Error('not_pending'))
    vi.mocked(runtime.organizerDecide).mockRejectedValueOnce(new Error('phone_offline'))
    expect(
      ((await decideHandler({}, { id: ORGANIZER_ROW.id, approve: true })) as HandleResult).error
        ?.code
    ).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    expect(
      ((await decideHandler({}, { id: ORGANIZER_ROW.id, approve: true })) as HandleResult).error
        ?.code
    ).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
    const approveHandler = getHandler(handleMock, 'nikkisync:approve-organizer-items')
    vi.mocked(runtime.organizerApproveMany).mockRejectedValueOnce(new Error('invalid_ids'))
    vi.mocked(runtime.organizerApproveMany).mockRejectedValueOnce(new Error('stopping'))
    expect(
      ((await approveHandler({}, { ids: [ORGANIZER_ROW.id] })) as HandleResult).error?.code
    ).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    expect(
      ((await approveHandler({}, { ids: [ORGANIZER_ROW.id] })) as HandleResult).error?.code
    ).toBe(IPC_ERROR_CODES.CANCELED)
  })

  it('未装配 ⇒ 三通道统一 PRECONDITION_FAILED（开关开也拦在句柄层）', async () => {
    const ctx = register(undefined)
    ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string, fallback: unknown) => (key === 'nikkisync.organizerEnabled' ? true : fallback)
    )
    const cases: Array<[string, unknown]> = [
      ['nikkisync:get-organizer-queue', undefined],
      ['nikkisync:decide-organizer-item', { id: ORGANIZER_ROW.id, approve: true }],
      ['nikkisync:approve-organizer-items', { ids: [ORGANIZER_ROW.id] }]
    ]
    for (const [channel, input] of cases) {
      const handler = getHandler(handleMock, channel)
      const res = (await handler({}, input)) as HandleResult
      expect(res.error?.code, channel).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
    }
  })
})
