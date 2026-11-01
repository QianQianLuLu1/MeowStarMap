/**
 * @layer L3
 * @module src/main/ipc/handlers/nikkisync-handler
 * @coverage NikkiSync 内嵌运行时 IPC（阶段 2 只读查询 + 阶段 3 同步服务 + 阶段 4 查询面扩容）：
 *           35 条通道的注册、参数校验、DTO 原样透传、未组装/未就绪/端口占用态的错误映射、
 *           照片目录自定义四通道（game-root 三条不依赖运行时 + admit 校验登记）。
 *
 * 断言口径：`data` 与句柄返回值**逐字段相等**（`toEqual`），以此锁死「内嵌层不做数据
 * 格式转换」这条铁律——一旦 handler 里出现字段重命名或结构包装，本文件立即变红。
 *
 * 注意：`src/main/tsconfig.json` 把测试文件排除在 `tsc -b` 之外，故本文件的类型错误
 * 不会被 `npm run typecheck` 抓到 ⇒ 句柄替身必须与 `NikkiSyncRuntimeHandle` 全量对齐。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, getHandler } from './_test-helpers'
import { isBareDirectoryRoot, registerNikkiSyncHandlers } from './nikkisync-handler'
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

/**
 * K9：与上游 `AccountSyncSettings.state()` 同形（label 为上游中文文案，handler 必须剔除）。
 * 三个分组覆盖 `uid` 的三态：空串（未识别）/ 纯数字 UID / `source:spinning_momo`。
 */
const SYNC_ACCOUNTS_STATE = {
  all: true,
  accounts: [
    { uid: '', label: '未识别 UID 的照片', count: 3, selected: true, samples: [] },
    { uid: '10001', label: 'UID 10001', count: 12, selected: true, samples: ['a1', 'a2', 'a3'] },
    {
      uid: 'source:spinning_momo',
      label: '旋转吧大喵',
      count: 2,
      selected: true,
      samples: ['m1']
    }
  ]
}

/** K9：上游 `preview(assetId)` 返回的 DB 资源行（handler 只投影三键）。 */
const ACCOUNT_PREVIEW_ROW = {
  resource_id: 'res_1',
  mime_type: 'image/jpeg',
  source_path: 'D:\\Photos\\a1.jpg',
  role: 'derived_thumbnail'
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
    applyGameRoot: vi.fn(async () => ({ scanId: 'scan_full', filesObserved: 3 })),
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
    setExtraDirectorySource: vi.fn(async () => EXTRA_DIRECTORIES_STATE),
    // ---- K9：账号同步作用域 ----
    listSyncAccounts: vi.fn(async () => SYNC_ACCOUNTS_STATE),
    previewSyncAccount: vi.fn(async () => ACCOUNT_PREVIEW_ROW),
    setSyncAccountSelection: vi.fn(async () => SYNC_ACCOUNTS_STATE),
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
  it('恰好注册 35 条通道（…阶段3 六服务 + K2 两同意 + K3 版本推断 + K6 六条目录 + 照片目录四通道 + K9 三条账号 + K8 三条整理队列）', () => {
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
      'nikkisync:set-extra-directory-source',
      'nikkisync:rescan-extra-directories',
      'nikkisync:get-game-root',
      'nikkisync:set-game-root',
      'nikkisync:reset-game-root',
      'nikkisync:admit-directory',
      'nikkisync:get-sync-accounts',
      'nikkisync:preview-sync-account',
      'nikkisync:set-sync-account-selection',
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
    expect(runtime.inspectExtraDirectory).toHaveBeenCalledWith('D:\\ExtraPhotos', undefined)
    const data = res.data as Record<string, unknown>
    expect(data.id).toBe('p1')
    expect(data.images).toBe(12)
    expect('hint' in data).toBe(false)

    // 1.0.27：来源标注走同一通道（渲染层「添加旋转吧大喵目录」按钮）；inspect 只接受这一取值
    pathGuard.registerUserPickedDir('D:\\SpinningMomo')
    await handler({}, { path: 'D:\\SpinningMomo', source: 'spinning_momo' })
    expect(runtime.inspectExtraDirectory).toHaveBeenLastCalledWith(
      'D:\\SpinningMomo',
      'spinning_momo'
    )

    for (const bad of [
      { path: 'relative/path' },
      { path: '' },
      { path: 'x'.repeat(4097) },
      { path: 'D:\\SpinningMomo', source: 'other' }
    ]) {
      const rejected = (await handler({}, bad)) as HandleResult
      expect(rejected.error?.code, JSON.stringify(bad)).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
    expect(runtime.inspectExtraDirectory).toHaveBeenCalledTimes(2)
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

  // review-fix：上游在 add/remove 成功路径同样 onSourcesChanged（已保存选择时 bump
  // revision），与 set-extra-directory-source 同属「作用域变更」——不推送则 keep-alive 的
  // 同步图库停在旧作用域，切页才自愈。
  it('review-fix：add/remove 成功后推 nikkisync:library-changed（作用域变更）；失败与发送异常都不改变结果', async () => {
    const runtime = createRuntimeStub()
    register(runtime)

    const add = getHandler(handleMock, 'nikkisync:add-extra-directory')
    const addSend = vi.fn()
    const added = (await add({ sender: { send: addSend } }, { id: 'p1' })) as HandleResult
    expect(added.success).toBe(true)
    expect(
      addSend,
      '新增目录改变来源分组 ⇒ 图库须重取（与 set-extra-directory-source 同判据）'
    ).toHaveBeenCalledWith('nikkisync:library-changed')

    const remove = getHandler(handleMock, 'nikkisync:remove-extra-directory')
    const removeSend = vi.fn()
    const removed = (await remove(
      { sender: { send: removeSend } },
      { id: 'dir_1' }
    )) as HandleResult
    expect(removed.success).toBe(true)
    expect(removeSend).toHaveBeenCalledWith('nikkisync:library-changed')

    // 上游拒绝 ⇒ 库没变，不得推送
    vi.mocked(runtime.addExtraDirectory).mockRejectedValueOnce(new Error('too_many_directories'))
    const failed = (await add({ sender: { send: addSend } }, { id: 'p2' })) as HandleResult
    expect(failed.error?.code).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
    expect(addSend).toHaveBeenCalledTimes(1)

    // 发送方已关闭（send 抛错）⇒ 通知尽力而为，操作仍判成功
    const throwing = vi.fn(() => {
      throw new Error('sender closed')
    })
    const stillOk = (await add({ sender: { send: throwing } }, { id: 'p3' })) as HandleResult
    expect(stillOk.success).toBe(true)
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

  it('未装配 ⇒ 六通道统一 PRECONDITION_FAILED', async () => {
    register(undefined)
    const cases: Array<[string, unknown]> = [
      ['nikkisync:get-extra-directories', undefined],
      ['nikkisync:inspect-extra-directory', { path: 'D:\\X' }],
      ['nikkisync:add-extra-directory', { id: 'p1' }],
      ['nikkisync:remove-extra-directory', { id: 'dir_1' }],
      ['nikkisync:set-extra-directory-source', { id: 'dir_1', source: 'spinning_momo' }],
      ['nikkisync:rescan-extra-directories', undefined]
    ]
    for (const [channel, input] of cases) {
      const handler = getHandler(handleMock, channel)
      const res = (await handler({}, input)) as HandleResult
      expect(res.error?.code, channel).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
    }
  })
})

// ============================================================================
// 照片目录自定义四通道（game-root 三条 + K6 手输预检 admit-directory）
// 语义：gameRoot 持久化值为 '' ⇒ 交给上游 game-directory-discovery（默认路径回退）；
// admit 在主进程完成「绝对路径 + 敏感目录黑名单 + 存在/目录/可读」校验后，只登记**同步域
// 专用集合**（isSyncPhotoDir），因此 inspect-extra-directory 放行、而 scanner:start /
// settings:set / media:// 的短路判据一律不受影响。
// 可写探测 fail-open：仅随 set-game-root 响应返回 writable 布尔，不阻断保存。
// ============================================================================

describe('nikkisync:game-root / admit-directory（照片目录自定义）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 系统临时目录下造真实存在的唯一子目录（非敏感目录，跨平台可过存在性/可读校验）。 */
  async function makeTempDir(): Promise<string> {
    return fs.promises.mkdtemp(path.join(os.tmpdir(), 'wxnn-gameroot-'))
  }

  // ---- 正常 ----

  it('set-game-root：真实目录 → 持久化设置键并返回 writable 布尔', async () => {
    const ctx = register(createRuntimeStub())
    const dir = await makeTempDir()
    const handler = getHandler(handleMock, 'nikkisync:set-game-root')
    const res = (await handler({}, { path: dir })) as HandleResult
    expect(res.success).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.gameRoot).toBe(dir)
    expect(typeof data.writable).toBe('boolean')
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('nikkisync.gameRoot', dir)
  })

  // ---- 运行期生效通道（本轮 bug 的主判据）----
  // 保存只落库时，设置键的唯一原生读者是进程启动那一次 buildSessionOptions：
  // 同步图库会停在旧根，且工具栏 startScan() 无参也读同一份旧快照 ⇒ 应用内没有任何动作能生效。
  // 以下钉住「落库 + 运行期生效 + 广播库变更」三件事成套，以及生效失败时不谎报也不误判失败。

  it('set-game-root：落库后立即换根重扫（applied:true / needRestart:false）并推 library-changed', async () => {
    const runtime = createRuntimeStub()
    const ctx = register(runtime)
    const dir = await makeTempDir()
    const send = vi.fn()
    const res = (await getHandler(handleMock, 'nikkisync:set-game-root')(
      { sender: { send } },
      { path: dir }
    )) as HandleResult
    expect(res.success).toBe(true)
    expect(res.data as Record<string, unknown>).toMatchObject({
      gameRoot: dir,
      applied: true,
      needRestart: false
    })
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('nikkisync.gameRoot', dir)
    expect(runtime.applyGameRoot).toHaveBeenCalledWith(dir)
    expect(send).toHaveBeenCalledWith('nikkisync:library-changed')
  })

  it('set-game-root：目录不是安装根 ⇒ 仍落库、applied:false + applyError，不判成失败也不广播', async () => {
    const runtime = createRuntimeStub()
    runtime.applyGameRoot = vi.fn(async () => {
      throw new Error('Infinity Nikki installation was not found')
    })
    const ctx = register(runtime)
    const dir = await makeTempDir()
    const send = vi.fn()
    const res = (await getHandler(handleMock, 'nikkisync:set-game-root')(
      { sender: { send } },
      { path: dir }
    )) as HandleResult
    expect(res.success).toBe(true)
    expect(res.data as Record<string, unknown>).toMatchObject({
      gameRoot: dir,
      applied: false,
      needRestart: true,
      applyError: 'installation-not-found'
    })
    expect(
      ctx.dbManager.setSetting,
      '值仍已持久化（下次进程按既有语义生效），不谎称丢配置'
    ).toHaveBeenCalledWith('nikkisync.gameRoot', dir)
    expect(
      send,
      '库未变化 ⇒ 不发 library-changed（与 start-scan「只在成功后发」同口径）'
    ).not.toHaveBeenCalled()
  })

  it('set-game-root：生效的其他故障归一 scan-failed（已成功的保存不被改判为失败）', async () => {
    const runtime = createRuntimeStub()
    runtime.applyGameRoot = vi.fn(async () => {
      throw new Error('EACCES: permission denied')
    })
    register(runtime)
    const dir = await makeTempDir()
    const res = (await getHandler(handleMock, 'nikkisync:set-game-root')(
      {},
      {
        path: dir
      }
    )) as HandleResult
    expect(res.success).toBe(true)
    expect(res.data as Record<string, unknown>).toMatchObject({
      applied: false,
      needRestart: true,
      applyError: 'scan-failed'
    })
  })

  // N3：分类判据必须与 runtime-manager 同源。`installation-not-found` 的真实特征只有
  // `installNotfoundMessage` 那一条串；此前用宽正则 `/not found/i` 扫上游错误原文，
  // 于是任何含 "not found" 的下游故障（缺表、缺资源行）都被误判成「目录不是安装根」，
  // 让渲染层给出「请改选游戏安装目录」这种无效指向，而不是本该保留的重启兜底。
  it('set-game-root：含无关 "not found" 的故障归 scan-failed，不得误判成安装根问题', async () => {
    const runtime = createRuntimeStub()
    runtime.applyGameRoot = vi.fn(async () => {
      throw new Error('SqliteError: no such table: assets not found')
    })
    register(runtime)
    const dir = await makeTempDir()
    const res = (await getHandler(handleMock, 'nikkisync:set-game-root')(
      {},
      { path: dir }
    )) as HandleResult
    expect(res.success).toBe(true)
    expect(res.data as Record<string, unknown>).toMatchObject({
      applied: false,
      needRestart: true,
      applyError: 'scan-failed'
    })
  })

  it('set-game-root：runtime 未装配时不调生效通道，保持旧「重启后生效」语义', async () => {
    const ctx = register(undefined)
    const dir = await makeTempDir()
    const send = vi.fn()
    const res = (await getHandler(handleMock, 'nikkisync:set-game-root')(
      { sender: { send } },
      { path: dir }
    )) as HandleResult
    expect(res.success).toBe(true)
    // D4：契约把 runtime-unavailable 定义为「Runtime 未装配 / 未建链」，未装配支必须如实回
    // 该分类码（渲染层仍按 needRestart 走重启兜底，补码只为诊断与契约成真）
    expect(res.data as Record<string, unknown>).toMatchObject({
      applied: false,
      needRestart: true,
      applyError: 'runtime-unavailable'
    })
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('nikkisync.gameRoot', dir)
    expect(send).not.toHaveBeenCalled()
  })

  it('set-game-root：校验失败时既不落库也不生效', async () => {
    const runtime = createRuntimeStub()
    const ctx = register(runtime)
    const res = (await getHandler(handleMock, 'nikkisync:set-game-root')(
      {},
      {
        path: 'relative/path'
      }
    )) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    expect(ctx.dbManager.setSetting).not.toHaveBeenCalled()
    expect(runtime.applyGameRoot).not.toHaveBeenCalled()
  })

  it('reset-game-root：清空设置键后按空串走同一生效通道并广播（恢复默认也不再等重启）', async () => {
    const runtime = createRuntimeStub()
    const ctx = register(runtime)
    const send = vi.fn()
    const res = (await getHandler(
      handleMock,
      'nikkisync:reset-game-root'
    )({
      sender: { send }
    })) as HandleResult
    expect(res.success).toBe(true)
    expect(res.data as Record<string, unknown>).toMatchObject({ applied: true, needRestart: false })
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('nikkisync.gameRoot', '')
    expect(runtime.applyGameRoot).toHaveBeenCalledWith('')
    expect(send).toHaveBeenCalledWith('nikkisync:library-changed')
  })

  it('get-game-root：回读持久化值；历史非字符串值回退空串（默认自动发现）', async () => {
    const ctx = register(createRuntimeStub())
    ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce('D:\\CustomRoot')
      .mockReturnValueOnce(123)
      .mockReturnValueOnce(undefined)
    const handler = getHandler(handleMock, 'nikkisync:get-game-root')
    const first = (await handler({})) as HandleResult
    expect(first.data).toEqual({ gameRoot: 'D:\\CustomRoot' })
    const dirty = (await handler({})) as HandleResult
    expect(dirty.data).toEqual({ gameRoot: '' })
    const missing = (await handler({})) as HandleResult
    expect(missing.data).toEqual({ gameRoot: '' })
  })

  it('reset-game-root：清空设置键（空串=回退默认路径）', async () => {
    const ctx = register(createRuntimeStub())
    const handler = getHandler(handleMock, 'nikkisync:reset-game-root')
    const res = (await handler({})) as HandleResult
    expect(res.success).toBe(true)
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('nikkisync.gameRoot', '')
    // needRestart 的取值随「能否立即生效」而变（原为恒 true），由上面两条生效通道用例分别钉住：
    // applied:true ⇒ needRestart:false；applied:false ⇒ needRestart:true。这里不再断言恒值。
  })

  it('admit-directory：校验通过并登记同步域集合，随后 inspect 无需预登记即放行', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const dir = await makeTempDir()
    const admit = getHandler(handleMock, 'nikkisync:admit-directory')
    const res = (await admit({}, { path: dir })) as HandleResult
    expect(res.success).toBe(true)
    expect((res.data as Record<string, unknown>).path).toBe(dir)
    // 未 admit 时同路径 inspect 会 PATH_FORBIDDEN（见 K6 伪造路径用例）；登记后必须放行
    const inspect = getHandler(handleMock, 'nikkisync:inspect-extra-directory')
    const proposal = (await inspect({}, { path: dir })) as HandleResult
    expect(proposal.success).toBe(true)
    expect(runtime.inspectExtraDirectory).toHaveBeenCalledWith(dir, undefined)
  })

  // F1（审查发现）：admit 的入参是**渲染层任意传入**的串，不是真实对话框的返回值。
  // `registerUserPickedDir` 一次写入的是三个全局集合——`roots`（`addUserPicked` 内部
  // `this.register(p)`）、`userPicked`、`userPickedDirs`，且 `matchesPicked` 按**前缀**命中，
  // 而 `scanner:start` / `settings:set`(customScanPaths) / `assertMediaAccessPath` / `media://`
  // 规则 0 全拿它做「跳过黑名单」的短路。因此一次 `admit(D:\)` 就让整盘免检、且无需用户手势。
  // 本组用例锁死收窄后的边界：admit 只授予同步域（inspect 放行），不得触碰全局授权集合。
  it('admit-directory：不得写全局 user-picked 集合（registerUserPickedDir 未被调用）', async () => {
    register(createRuntimeStub())
    const spy = vi.spyOn(pathGuard, 'registerUserPickedDir')
    const dir = await makeTempDir()
    const admit = getHandler(handleMock, 'nikkisync:admit-directory')
    const res = (await admit({}, { path: dir })) as HandleResult
    // 校验通过、预检本身仍要成功（收窄不能削掉功能，见上一条 inspect 放行用例）
    expect(res.success).toBe(true)
    expect(spy, 'admit 传入的是渲染层任意串，不构成对话框显式授权').not.toHaveBeenCalled()
  })

  it('admit-directory：通过后全局 isUserPicked/isUserPickedDir 均不命中（含子路径放大）', async () => {
    register(createRuntimeStub())
    const dir = await makeTempDir()
    const admit = getHandler(handleMock, 'nikkisync:admit-directory')
    expect(((await admit({}, { path: dir })) as HandleResult).success).toBe(true)
    // 目录本身与目录下的子路径都不算「用户显式选择」——后者正是前缀短路把授权
    // 放大到整棵子树的地方（盘根/用户目录被 admit 时波及面即全部文件）。
    expect(pathGuard.isUserPicked(dir)).toBe(false)
    expect(pathGuard.isUserPickedDir(dir)).toBe(false)
    expect(pathGuard.isUserPicked(path.join(dir, 'photo.jpg'))).toBe(false)
  })

  it('四通道均不依赖运行时装配（nikkisyncRuntime 未注入也可用）', async () => {
    const ctx = register(undefined)
    const dir = await makeTempDir()
    const got = (await getHandler(handleMock, 'nikkisync:get-game-root')({})) as HandleResult
    expect(got.success).toBe(true)
    const set = (await getHandler(handleMock, 'nikkisync:set-game-root')(
      {},
      { path: dir }
    )) as HandleResult
    expect(set.success).toBe(true)
    const reset = (await getHandler(handleMock, 'nikkisync:reset-game-root')({})) as HandleResult
    expect(reset.success).toBe(true)
    const admit = (await getHandler(handleMock, 'nikkisync:admit-directory')(
      {},
      { path: dir }
    )) as HandleResult
    expect(admit.success).toBe(true)
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('nikkisync.gameRoot', dir)
  })

  // ---- 异常 ----

  it('set-game-root：相对路径/不存在/文件非目录 ⇒ VALIDATION 且不写设置', async () => {
    const ctx = register(createRuntimeStub())
    const handler = getHandler(handleMock, 'nikkisync:set-game-root')
    const dir = await makeTempDir()
    const filePath = path.join(dir, 'plain.txt')
    await fs.promises.writeFile(filePath, 'x')
    const missingDir = path.join(dir, 'does-not-exist')
    for (const bad of [{ path: 'relative/path' }, { path: missingDir }, { path: filePath }]) {
      const res = (await handler({}, bad)) as HandleResult
      expect(res.error?.code, JSON.stringify(bad)).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
    expect(ctx.dbManager.setSetting).not.toHaveBeenCalled()
  })

  it('set-game-root：系统敏感目录 ⇒ PATH_FORBIDDEN（任意盘符系统目录均拦）', async () => {
    const ctx = register(createRuntimeStub())
    const handler = getHandler(handleMock, 'nikkisync:set-game-root')
    for (const bad of ['C:\\Windows\\System32', 'C:\\Program Files\\SomeGame', 'D:\\ProgramData']) {
      const res = (await handler({}, { path: bad })) as HandleResult
      expect(res.error?.code, bad).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    }
    expect(ctx.dbManager.setSetting).not.toHaveBeenCalled()
  })

  it('set-game-root：目录不可读（access R_OK 拒绝）⇒ PATH_FORBIDDEN 且不写设置', async () => {
    const ctx = register(createRuntimeStub())
    const realAccess = fs.promises.access.bind(fs.promises)
    vi.spyOn(fs.promises, 'access').mockImplementation(async (p, mode) => {
      if (mode === fs.constants.R_OK) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      }
      return realAccess(p, mode)
    })
    const dir = await makeTempDir()
    const handler = getHandler(handleMock, 'nikkisync:set-game-root')
    const res = (await handler({}, { path: dir })) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    expect(ctx.dbManager.setSetting).not.toHaveBeenCalled()
  })

  it('set-game-root：可写探测失败 fail-open —— 仅 writable:false，不阻断保存', async () => {
    register(createRuntimeStub())
    const realAccess = fs.promises.access.bind(fs.promises)
    vi.spyOn(fs.promises, 'access').mockImplementation(async (p, mode) => {
      if (mode === fs.constants.W_OK) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      }
      return realAccess(p, mode)
    })
    const dir = await makeTempDir()
    const handler = getHandler(handleMock, 'nikkisync:set-game-root')
    const res = (await handler({}, { path: dir })) as HandleResult
    expect(res.success).toBe(true)
    expect((res.data as Record<string, unknown>).writable).toBe(false)
    // needRestart 已不再恒 true（生效成功即为 false）：这里必须证明「只读目录」既不阻断保存、
    // 也不阻断生效（照片源目录扫描只读，W_OK 失败本身不构成拒绝理由）。
    expect(res.data as Record<string, unknown>).toMatchObject({ applied: true, needRestart: false })
  })

  it('admit-directory：四类非法输入一律拒绝且不登记（随后 inspect 仍 PATH_FORBIDDEN）', async () => {
    register(createRuntimeStub())
    const dir = await makeTempDir()
    const filePath = path.join(dir, 'plain.txt')
    await fs.promises.writeFile(filePath, 'x')
    const admit = getHandler(handleMock, 'nikkisync:admit-directory')
    for (const bad of [
      { path: 'relative/path' },
      { path: path.join(dir, 'does-not-exist') },
      { path: filePath },
      { path: 'C:\\Windows\\System32' }
    ]) {
      const res = (await admit({}, bad)) as HandleResult
      expect(
        [IPC_ERROR_CODES.VALIDATION_ERROR, IPC_ERROR_CODES.PATH_FORBIDDEN],
        JSON.stringify(bad)
      ).toContain(res.error?.code)
    }
    // 未登记 ⇒ inspect 的白名单门禁仍拒绝（admit 的登记只发生在校验全过之后）。
    // 用敏感路径做该断言：若 admit 误登记，isUserPickedDir / isSyncPhotoDir 会短路放行
    // 使本断言变红；tmpdir 位于主目录下（isAllowed 恒放行），不能用作「未登记」的证明。
    const inspect = getHandler(handleMock, 'nikkisync:inspect-extra-directory')
    const proposal = (await inspect({}, { path: 'C:\\Windows\\System32' })) as HandleResult
    expect(proposal.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
  })

  // D3：盘根/UNC 根可以合法通过「非敏感 + 存在 + 是目录 + 可读」四关（`isSensitivePath`
  // 只拦 windows/program files 等首段，盘根本身不在其列），于是 `admit(D:\)` 会把**整块盘**
  // 登记成同步照片源并递给上游当扫描根。上一轮已把全局 `registerUserPickedDir` 收窄为
  // 同步域集合，这一档是它的残留。
  //
  // 判据必须落在「拒于盘根判据」而不是「拒于目录不存在」：Windows 上 `D:\` 确实存在，
  // Linux 上它压根 stat 不到——两侧都回 VALIDATION_ERROR，只断 code 会让 Linux 因错误的
  // 原因假绿，故同时钉住错误文案不含「不存在」这条 stat 支的特征。
  it('admit-directory：盘根/UNC 根一律拒绝，且拒于盘根判据本身（不是目录不存在）', async () => {
    register(createRuntimeStub())
    const admit = getHandler(handleMock, 'nikkisync:admit-directory')
    // 第二元 = 该形态能否通过绝对路径 schema 抵达盘根闸：能抵达的必须拒于「盘根判据」
    // 文案本身；单个 `\` 过不了 schema（`\\` 分支要求两段），在 zod 层即被拒，只钉码与不登记。
    const bareRoots: Array<[string, boolean]> = [
      ['D:\\', true],
      ['C:/', true],
      ['\\\\nas\\share', true],
      ['/', true],
      ['//', true],
      ['///', true],
      ['\\', false]
    ]
    for (const [root, reachesGate] of bareRoots) {
      const res = (await admit({}, { path: root })) as HandleResult
      expect(res.success, `盘根必须被拒：${root}`).toBe(false)
      expect(res.error?.code, `盘根 ${root} 的错误码`).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
      if (reachesGate) {
        expect(
          res.error?.message ?? '',
          `盘根 ${root} 必须拒于盘根判据本身，而不是下游校验`
        ).toMatch(/盘根|UNC 根/)
        expect(
          res.error?.message ?? '',
          `盘根 ${root} 不得靠 stat「目录不存在」蒙过本用例`
        ).not.toMatch(/does not exist|no such file|ENOENT/i)
      }
      expect(pathGuard.isSyncPhotoDir(root), `盘根 ${root} 不得登记进同步域`).toBe(false)
    }
  })

  it('isBareDirectoryRoot：直接判据——合法深路径一律 false，裸分隔符根（含 // 与 ///）一律 true', () => {
    // 合法子目录：盘根下、UNC 共享下、POSIX 深路径都放行（收窄只砍「整盘当照片源」）
    expect(isBareDirectoryRoot('D:\\Photos')).toBe(false)
    expect(isBareDirectoryRoot('D:\\X6Game')).toBe(false)
    expect(isBareDirectoryRoot('\\\\nas\\share\\photos')).toBe(false)
    // `//`/`///`：POSIX 语义等同 `/` 且 stat 可过，必须与 `/` 同判——这道缝不补，
    // Linux 装置会把 `//` 登记成同步照片源
    expect(isBareDirectoryRoot('//')).toBe(true)
    expect(isBareDirectoryRoot('///')).toBe(true)
    expect(isBareDirectoryRoot('  /  ')).toBe(true)
    expect(isBareDirectoryRoot('D:')).toBe(true)
  })

  // N1（复查缺陷）：四个校验 throw 此前把完整路径拼进 message 且不带 userMessage——
  // ValidationError/PermissionError 又没有默认 userMessage ⇒ 跨进程还原后渲染层只能
  // 拿英文技术串 + 完整盘路径弹 toast。钉死三条脱敏口径：message 不含裸路径、
  // details.path 只留末 2 段（<...> 开头）、userMessage 非空。
  it('照片目录校验错误：message 不含裸路径、details.path 走 maskPath 脱敏、userMessage 非空', async () => {
    register(createRuntimeStub())
    const admit = getHandler(handleMock, 'nikkisync:admit-directory')
    const dir = await makeTempDir()
    const filePath = path.join(dir, 'a-file.txt')
    fs.writeFileSync(filePath, 'x')
    const cases: Array<{ input: string; label: string }> = [
      { input: 'C:\\Windows\\System32', label: '敏感目录' },
      { input: path.join(dir, 'does-not-exist'), label: '目录不存在' },
      { input: filePath, label: '不是目录' }
    ]
    for (const { input, label } of cases) {
      const res = (await admit({}, { path: input })) as HandleResult
      expect(res.success, `${label} 必须被拒`).toBe(false)
      const message = res.error?.message ?? ''
      expect(message, `${label} 的 message 不得携带裸路径`).not.toContain(input)
      expect(message, `${label} 的 message 必须是用户可读文案`).toBeTruthy()
      const details = res.error?.details as { path?: string } | undefined
      expect(
        typeof details?.path === 'string' && details.path.startsWith('<...>'),
        `${label} 的 details.path 必须是 maskPath 脱敏形态`
      ).toBe(true)
      expect(
        typeof res.error?.userMessage === 'string' && res.error.userMessage.length > 0,
        `${label} 必须显式携带 userMessage`
      ).toBe(true)
    }
  })

  it('admit-directory：边界——盘根下的真实子目录与 UNC 共享下的目录照常放行', async () => {
    register(createRuntimeStub())
    const dir = await makeTempDir()
    const admit = getHandler(handleMock, 'nikkisync:admit-directory')
    // 收窄只能砍掉「整盘当照片源」，不能砍掉合法的深层目录（含 tmpdir 下的真实目录）
    const res = (await admit({}, { path: dir })) as HandleResult
    expect(res.success).toBe(true)
    expect(pathGuard.isSyncPhotoDir(dir)).toBe(true)
  })

  // ---- 边界 ----

  it('set-game-root：512 为长度上界（与 scanSchema.gameRoot 同界）；前后空白 trim 后入库；重复 set 幂等', async () => {
    const ctx = register(createRuntimeStub())
    const handler = getHandler(handleMock, 'nikkisync:set-game-root')
    // 513 字符绝对路径 ⇒ zod 上界拒绝（512 界与 start-scan 的 gameRoot 同规）
    const over = (await handler({}, { path: 'D:\\' + 'x'.repeat(510) })) as HandleResult
    expect(over.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    // trim：zod .trim() 归一后校验与持久化都用净值
    const dir = await makeTempDir()
    const trimmed = (await handler({}, { path: `  ${dir}  ` })) as HandleResult
    expect(trimmed.success).toBe(true)
    expect((trimmed.data as Record<string, unknown>).gameRoot).toBe(dir)
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('nikkisync.gameRoot', dir)
    // 重复设置同值：两次都成功（幂等）
    const again = (await handler({}, { path: dir })) as HandleResult
    expect(again.success).toBe(true)
    expect(ctx.dbManager.setSetting).toHaveBeenCalledTimes(2)
  })
})

// ===== K9：账号同步作用域（1.0.27 上游 AccountSyncSettings）三通道 + 目录来源 =====

describe('nikkisync:get-sync-accounts / preview-sync-account / set-sync-account-selection（K9）', () => {
  it('get：剔除上游中文 label，all/count/selected/samples 原样透传', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-sync-accounts')
    const res = (await handler({})) as HandleResult
    expect(res.success).toBe(true)
    expect(res.data).toEqual({
      all: true,
      accounts: [
        { uid: '', count: 3, selected: true, samples: [] },
        { uid: '10001', count: 12, selected: true, samples: ['a1', 'a2', 'a3'] },
        { uid: 'source:spinning_momo', count: 2, selected: true, samples: ['m1'] }
      ]
    })
    expect(JSON.stringify(res.data)).not.toMatch(/[\u4e00-\u9fff]/)
    expect(runtime.listSyncAccounts).toHaveBeenCalledTimes(1)
  })

  it('get：会话未装配 accounts（老链接）⇒ 上游式 unavailable 映射为 PRECONDITION_FAILED', async () => {
    const runtime = createRuntimeStub()
    vi.mocked(runtime.listSyncAccounts).mockRejectedValueOnce(
      new Error('sync account scope is unavailable (session not assembled)')
    )
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:get-sync-accounts')
    const res = (await handler({})) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
  })

  it('preview：assetId 下传，DB 资源行只投影 resourceId/mimeType/sourcePath 三键', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:preview-sync-account')
    const res = (await handler({}, { assetId: 'a1' })) as HandleResult
    expect(runtime.previewSyncAccount).toHaveBeenCalledWith('a1')
    expect(res.data).toEqual({
      resourceId: 'res_1',
      mimeType: 'image/jpeg',
      sourcePath: 'D:\\Photos\\a1.jpg'
    })

    // 无 source_path 的资源（如内存/派生资源）不伪造空串键
    vi.mocked(runtime.previewSyncAccount).mockResolvedValueOnce({
      resource_id: 'res_2',
      mime_type: 'image/png'
    })
    const bare = (await handler({}, { assetId: 'a2' })) as HandleResult
    expect(bare.data).toEqual({ resourceId: 'res_2', mimeType: 'image/png' })
  })

  it('preview：资产不存在 ⇒ NOT_FOUND；assetId 空串/超长 ⇒ VALIDATION 且句柄零调用', async () => {
    const runtime = createRuntimeStub()
    vi.mocked(runtime.previewSyncAccount).mockRejectedValueOnce(
      new Error('NikkiSync asset not found: ghost')
    )
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:preview-sync-account')
    const res = (await handler({}, { assetId: 'ghost' })) as HandleResult
    expect(res.error?.code).toBe(IPC_ERROR_CODES.NOT_FOUND)
    for (const bad of ['', ' ', 'x'.repeat(129)]) {
      const rejected = (await handler({}, { assetId: bad })) as HandleResult
      expect(rejected.error?.code, JSON.stringify(bad)).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
    expect(runtime.previewSyncAccount).toHaveBeenCalledTimes(1)
  })

  it('set-selection：null（全部）/ []（零个）/ 数组逐字下传，返回剔除 label 的新状态', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:set-sync-account-selection')
    const all = (await handler({}, { uids: null })) as HandleResult
    expect(runtime.setSyncAccountSelection).toHaveBeenNthCalledWith(1, null)
    expect(JSON.stringify(all.data)).not.toMatch(/[\u4e00-\u9fff]/)

    await handler({}, { uids: [] })
    expect(runtime.setSyncAccountSelection).toHaveBeenNthCalledWith(2, [])

    await handler({}, { uids: ['10001', 'source:spinning_momo'] })
    expect(runtime.setSyncAccountSelection).toHaveBeenNthCalledWith(3, [
      '10001',
      'source:spinning_momo'
    ])

    // 上游 `invalid_accounts`（uid 键非法）⇒ VALIDATION_ERROR，中文原文不透传
    vi.mocked(runtime.setSyncAccountSelection).mockRejectedValueOnce(new Error('invalid_accounts'))
    const rejected = (await handler({}, { uids: ['not-a-uid'] })) as HandleResult
    expect(rejected.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
  })

  it('set-selection：uids 非数组 / 超 200 ⇒ zod 先拒（VALIDATION，句柄零调用）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:set-sync-account-selection')
    const tooMany = Array.from({ length: 201 }, (_, i) => String(i))
    for (const bad of [{ uids: '10001' }, { uids: tooMany }, { uids: [1, 2] }]) {
      const res = (await handler({}, bad)) as HandleResult
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
    expect(runtime.setSyncAccountSelection).not.toHaveBeenCalled()
  })

  it('set-selection 成功后推 nikkisync:library-changed（作用域变更让图库重取）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const send = vi.fn()
    const handler = getHandler(handleMock, 'nikkisync:set-sync-account-selection')
    const res = (await handler({ sender: { send } }, { uids: ['10001'] })) as HandleResult
    expect(res.success).toBe(true)
    expect(send).toHaveBeenCalledWith('nikkisync:library-changed')

    // 保存失败不得推送（库没变，UI 不该刷）
    vi.mocked(runtime.setSyncAccountSelection).mockRejectedValueOnce(new Error('invalid_accounts'))
    await handler({ sender: { send } }, { uids: ['bad uid'] })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('未装配 ⇒ 三通道统一 PRECONDITION_FAILED', async () => {
    register(undefined)
    const cases: Array<[string, unknown]> = [
      ['nikkisync:get-sync-accounts', undefined],
      ['nikkisync:preview-sync-account', { assetId: 'a1' }],
      ['nikkisync:set-sync-account-selection', { uids: null }]
    ]
    for (const [channel, input] of cases) {
      const handler = getHandler(handleMock, channel)
      const res = (await handler({}, input)) as HandleResult
      expect(res.error?.code, channel).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
    }
  })
})

describe('nikkisync:set-extra-directory-source（K9 目录来源标注）', () => {
  it('id/source 逐字下传并返回剔除中文 message 的状态', async () => {
    const runtime = createRuntimeStub()
    const marker = { ...EXTRA_DIRECTORIES_STATE, directories: [] }
    vi.mocked(runtime.setExtraDirectorySource).mockResolvedValueOnce(marker)
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:set-extra-directory-source')
    const res = (await handler({}, { id: 'dir_1', source: 'other' })) as HandleResult
    expect(runtime.setExtraDirectorySource).toHaveBeenCalledWith('dir_1', 'other')
    expect(res.data).toEqual({
      directories: [],
      automaticRoots: EXTRA_DIRECTORIES_STATE.automaticRoots,
      busy: false,
      scannerStatus: 'running'
    })
    expect('message' in (res.data as Record<string, unknown>)).toBe(false)
  })

  it('成功后推 nikkisync:library-changed（来源分组变化 = 作用域变更）；失败与发送异常都不改变结果', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:set-extra-directory-source')

    const send = vi.fn()
    const ok = (await handler(
      { sender: { send } },
      { id: 'dir_1', source: 'spinning_momo' }
    )) as HandleResult
    expect(ok.success).toBe(true)
    expect(send).toHaveBeenCalledWith('nikkisync:library-changed')

    // 上游拒绝 ⇒ 库没变，不得推送
    vi.mocked(runtime.setExtraDirectorySource).mockRejectedValueOnce(new Error('invalid_source'))
    const failed = (await handler(
      { sender: { send } },
      { id: 'dir_1', source: 'other' }
    )) as HandleResult
    expect(failed.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    expect(send).toHaveBeenCalledTimes(1)

    // 发送方已关闭（send 抛错）⇒ 通知尽力而为，操作仍判成功
    const throwing = vi.fn(() => {
      throw new Error('sender closed')
    })
    const stillOk = (await handler(
      { sender: { send: throwing } },
      { id: 'dir_1', source: 'spinning_momo' }
    )) as HandleResult
    expect(stillOk.success).toBe(true)
  })

  it('source 非法 / id 形态非法 ⇒ zod 先拒（VALIDATION，句柄零调用）', async () => {
    const runtime = createRuntimeStub()
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:set-extra-directory-source')
    for (const bad of [
      { id: 'dir_1', source: 'native' },
      { id: 'dir_1' },
      { id: '', source: 'other' },
      { id: 'x'.repeat(129), source: 'spinning_momo' }
    ]) {
      const res = (await handler({}, bad)) as HandleResult
      expect(res.error?.code, JSON.stringify(bad)).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
    expect(runtime.setExtraDirectorySource).not.toHaveBeenCalled()
  })

  it('上游错误映射：invalid_source→VALIDATION、directory_not_found→PRECONDITION', async () => {
    const runtime = createRuntimeStub()
    vi.mocked(runtime.setExtraDirectorySource).mockRejectedValueOnce(new Error('invalid_source'))
    vi.mocked(runtime.setExtraDirectorySource).mockRejectedValueOnce(
      new Error('directory_not_found')
    )
    register(runtime)
    const handler = getHandler(handleMock, 'nikkisync:set-extra-directory-source')
    expect(
      ((await handler({}, { id: 'dir_1', source: 'other' })) as HandleResult).error?.code
    ).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    expect(
      ((await handler({}, { id: 'dir_1', source: 'other' })) as HandleResult).error?.code
    ).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
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
