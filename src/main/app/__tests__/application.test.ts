/**
 * @layer L2
 * @module src/main/app/application
 * @coverage Application.initialize / buildAppContext（AppContext 回调装配与参数透传）
 * @dependencies 16 个服务类构造、./lifecycle、./media-update、./theme、./media-protocol、./renderer-bridge
 *
 * 难点：
 * 1. buildAppContext 是 private（application.ts:120，生产唯一调用点是 initialize():110），
 *    不放开可见性、不拆结构——经 initialize() 触发后，从被 mock 的 bootstrapApplication
 *    的调用参数上取回真实 ctx，被测的就是「装配本身」而不是任何 mock 出来的替身。
 * 2. 构造函数会 new 16 个服务类，Vitest 5 下被 new 的 mock 必须是 function 形态
 *    （箭头函数不可构造），实例方法直接挂在 this 上。
 * 3. application.ts 此前无任何测试（覆盖率实测 48/48 语句未覆盖），而本目录 AGENTS.md
 *    宣称「23 个源文件全部有测试覆盖」——本文件同时消除该文档与实际的不一致。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  // —— 被 new 的服务类：function 形态构造器，需要的方法直接挂 this ——
  DatabaseManager: vi.fn(function (this: Record<string, unknown>) {
    this.getDatabase = vi.fn(() => null)
    this.getDbPath = vi.fn(() => 'C:/mock/db.sqlite')
  }),
  ScannerManager: vi.fn(function (this: Record<string, unknown>) {
    this.on = vi.fn()
    this.removeListener = vi.fn()
  }),
  ScannerWorkerBridge: vi.fn(function (this: Record<string, unknown>) {
    this.dispose = vi.fn()
  }),
  DatabaseWorkerBridge: vi.fn(function (this: Record<string, unknown>) {
    this.dispose = vi.fn()
  }),
  MediaWorkerBridge: vi.fn(function (this: Record<string, unknown>) {
    this.dispose = vi.fn()
  }),
  MediaWorkerManager: vi.fn(function (this: Record<string, unknown>) {
    this.setBatchYield = vi.fn()
    this.setThumbnailProgressNotifier = vi.fn()
  }),
  VideoEditorBridge: vi.fn(function (this: Record<string, unknown>) {
    this.dispose = vi.fn()
  }),
  DecryptionWorkerBridge: vi.fn(function (this: Record<string, unknown>) {
    this.dispose = vi.fn()
  }),
  TaskScheduler: vi.fn(function (this: Record<string, unknown>) {
    this.pause = vi.fn()
    this.resume = vi.fn()
  }),
  ThumbnailGenerator: vi.fn(function (this: Record<string, unknown>) {
    this.setWorkerBridge = vi.fn()
    this.setOnDemandActivityListener = vi.fn()
  }),
  ThumbnailWorkerBridge: vi.fn(function (this: Record<string, unknown>) {
    this.dispose = vi.fn()
  }),
  FileService: vi.fn(function (this: Record<string, unknown>) {
    this.dispose = vi.fn()
  }),
  VideoService: vi.fn(function (this: Record<string, unknown>) {
    this.dispose = vi.fn()
  }),
  WatermarkService: vi.fn(function (this: Record<string, unknown>) {
    this.dispose = vi.fn()
  }),
  // —— 普通函数依赖 ——
  BrowserWindowMock: vi.fn(),
  setDecryptionWorkerBridgeMock: vi.fn(),
  notifyMediaUpdatedMock: vi.fn(),
  applyUIThemeMock: vi.fn(),
  sendToRendererMock: vi.fn(),
  invalidateMediaPathCacheMock: vi.fn(),
  bootstrapApplicationMock: vi.fn(async () => {})
}))

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(mocks.BrowserWindowMock, {
    getAllWindows: vi.fn(() => [])
  })
}))
vi.mock('../../database/connection', () => ({ DatabaseManager: mocks.DatabaseManager }))
vi.mock('../../scanner', () => ({ ScannerManager: mocks.ScannerManager }))
vi.mock('../../scanner/scanner-worker-bridge', () => ({
  ScannerWorkerBridge: mocks.ScannerWorkerBridge
}))
vi.mock('../../database/worker/database-worker-bridge', () => ({
  DatabaseWorkerBridge: mocks.DatabaseWorkerBridge
}))
vi.mock('../../media-worker/bridge', () => ({ MediaWorkerBridge: mocks.MediaWorkerBridge }))
vi.mock('../../media-worker/manager', () => ({ MediaWorkerManager: mocks.MediaWorkerManager }))
vi.mock('../../video-editor/bridge', () => ({ VideoEditorBridge: mocks.VideoEditorBridge }))
vi.mock('../../decryption-worker/bridge', () => ({
  DecryptionWorkerBridge: mocks.DecryptionWorkerBridge
}))
vi.mock('../../services/decryption-service', () => ({
  setDecryptionWorkerBridge: mocks.setDecryptionWorkerBridgeMock
}))
vi.mock('../../scheduler/task-scheduler', () => ({ TaskScheduler: mocks.TaskScheduler }))
vi.mock('../../thumbnail/generator', () => ({ ThumbnailGenerator: mocks.ThumbnailGenerator }))
vi.mock('../../thumbnail/worker-bridge', () => ({
  ThumbnailWorkerBridge: mocks.ThumbnailWorkerBridge
}))
vi.mock('../../services/file-service', () => ({ FileService: mocks.FileService }))
vi.mock('../../services/video-service', () => ({ VideoService: mocks.VideoService }))
vi.mock('../../services/watermark-service', () => ({ WatermarkService: mocks.WatermarkService }))
vi.mock('../media-update', () => ({ notifyMediaUpdated: mocks.notifyMediaUpdatedMock }))
vi.mock('../theme', () => ({ applyUITheme: mocks.applyUIThemeMock }))
vi.mock('../renderer-bridge', () => ({ sendToRenderer: mocks.sendToRendererMock }))
vi.mock('../media-protocol', () => ({
  invalidateMediaPathCache: mocks.invalidateMediaPathCacheMock,
  registerMediaProtocol: vi.fn()
}))
vi.mock('../lifecycle', () => ({ bootstrapApplication: mocks.bootstrapApplicationMock }))

// application.ts 内部会 new 出真实类图，全部依赖已被 mock，可在 vitest 下直接引入
import { Application } from '../application'
import type { AppContext } from '../app-context'

/** 触发真实 buildAppContext()，取回生产 ctx（bootstrapApplication 的唯一实参） */
async function buildRealContext(): Promise<AppContext> {
  await new Application().initialize()
  const call = mocks.bootstrapApplicationMock.mock.calls[0]
  if (!call) throw new Error('bootstrapApplication 未被调用，AppContext 未构造')
  return call[0] as AppContext
}

describe('Application.buildAppContext — AppContext 回调装配', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('1. invalidateMediaPathCache(paths) 必须把 paths 透传给 media-protocol 实现', async () => {
    // B1 回归：装配层曾用零参箭头 `() => invalidateMediaPathCacheFn()` 接住签名，
    // TS 不报错（少参函数可赋值给多参签名），但实参被丢弃——渲染层每张新生成的缩略图
    // 仍触发整表全清，"仅定向失效新增路径"的修复在生产里等于没发生。
    const ctx = await buildRealContext()
    const thumbnailPath = 'C:\\mock\\thumbnails\\0b03f8487491743f.jpg'

    ctx.invalidateMediaPathCache([thumbnailPath])

    expect(mocks.invalidateMediaPathCacheMock).toHaveBeenCalledTimes(1)
    expect(mocks.invalidateMediaPathCacheMock).toHaveBeenCalledWith([thumbnailPath])
  })

  it('2. 缺省调用仍到达实现且零实参，保住 notifyMediaUpdated 的全清语义', async () => {
    // media-update.ts:77 的 ctx.invalidateMediaPathCache() 依赖「不传参 = 全清」分支；
    // 这里锁住装配层不会把缺省调用转成别的形态（例如误传 undefined 数组）。
    const ctx = await buildRealContext()

    ctx.invalidateMediaPathCache()

    expect(mocks.invalidateMediaPathCacheMock).toHaveBeenCalledTimes(1)
    expect(mocks.invalidateMediaPathCacheMock).toHaveBeenCalledWith()
  })

  it('3. 构造期完成 worker 桥注入与批量让位/进度回调接线', async () => {
    // 守护装配契约不被改坏：decryption 桥必须在构造期就注入 service 模块单例，
    // thumbnail 生成器必须拿到桥与按需活动监听器。
    const ctx = await buildRealContext()

    expect(mocks.setDecryptionWorkerBridgeMock).toHaveBeenCalledTimes(1)
    expect(mocks.ThumbnailGenerator).toHaveBeenCalledTimes(1)
    const genInstance = mocks.ThumbnailGenerator.mock.instances[0] as Record<string, unknown>
    expect(genInstance.setWorkerBridge).toHaveBeenCalledTimes(1)
    expect(genInstance.setOnDemandActivityListener).toHaveBeenCalledTimes(1)
    expect(mocks.MediaWorkerManager.mock.instances[0]).toHaveProperty(
      'setThumbnailProgressNotifier'
    )
    expect(ctx.thumbnailGen).toBeTruthy()
    expect(ctx.getMainWindow()).toBeNull()
  })
})
