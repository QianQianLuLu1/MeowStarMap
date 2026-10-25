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
    setMetadataConsent: vi.fn(() => CONSENT_STATE)
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
  it('恰好注册 18 条通道（阶段2 五查询 + 阶段4 五扩容 + 阶段3 六服务 + K2 两条同意）', () => {
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
      'nikkisync:set-metadata-consent'
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
