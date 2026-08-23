/**
 * misc 域拆分后的共享测试辅助。
 * 提供真实 zod schemas mock（让 handler 内 zod 校验正常工作）与通用 ctx/handler 查找工具。
 */
import { vi } from 'vitest'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import type { AppContext } from '../../app/app-context'

/**
 * 真实 zod schema 集合：handler 在模块级用 z.object/z.array/z.tuple 组合 schemas，
 * 必须提供真实 ZodType 才能让 zod 安全构造与 safeParse 正常工作。
 */
export function createSchemasMock() {
  const filePath = z.string().min(1).max(1024)
  const filePathArray = z.array(filePath).min(1).max(1000)
  const positiveIntId = z.number().int().positive()
  const httpUrl = z
    .string()
    .min(1)
    .max(2048)
    .url()
    .refine((u: string) => u.startsWith('http://') || u.startsWith('https://'))
  const uiTheme = z.enum(['default', 'soft-pink-luxury'])
  const thumbnailQuality = z.enum(['low', 'standard', 'high']).optional()
  const backupFilename = z.string().regex(/.+/)
  const cacheLimitBytes = z.number().finite().positive()
  const rating = z.number().int().min(0).max(5)
  const mediaId = z.number().int().positive()
  const mediaIdArray = z.array(mediaId).min(1).max(1000)
  const shortString = (max = 64) => z.string().min(1).max(max)
  const uid = z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9]+$/)
  return {
    filePath,
    filePathArray,
    positiveIntId,
    httpUrl,
    uiTheme,
    thumbnailQuality,
    backupFilename,
    cacheLimitBytes,
    rating,
    mediaId,
    mediaIdArray,
    shortString,
    uid
  }
}

/**
 * 链式 mock 类型：任意属性访问与方法调用均返回可继续链式调用的值。
 * 原先各 handler 测试在 vi.hoisted() 内构造 schemasProxy 时使用；
 * 现由共享 mock（tests/mocks/mock-validator.ts）的 schemas 链式 Proxy 使用
 * （type-only import 编译期擦除无运行时依赖）。
 */
export interface Chainable {
  (...args: unknown[]): Chainable
  [key: string]: Chainable
}

interface ScannerManagerStub {
  startScan: ReturnType<typeof vi.fn>
  stopScan: ReturnType<typeof vi.fn>
  getStatus: ReturnType<typeof vi.fn>
  scanRoot: ReturnType<typeof vi.fn>
  // FIX(组2-3): scanner-handler 注册时监听 restoredComplete（崩溃恢复扫描的完成事件）
  on: ReturnType<typeof vi.fn>
}

interface ThumbnailGenStub {
  generate: ReturnType<typeof vi.fn>
  getCacheDir: ReturnType<typeof vi.fn>
}

interface FileServiceStub {
  previewImport: ReturnType<typeof vi.fn>
  importFiles: ReturnType<typeof vi.fn>
}

interface DbStub {
  exec: ReturnType<typeof vi.fn>
  prepare: ReturnType<typeof vi.fn>
  transaction: ReturnType<typeof vi.fn>
}

export interface MakeCtxOpts {
  scannerManager?: ScannerManagerStub
  thumbnailGen?: ThumbnailGenStub
  fileService?: FileServiceStub
  db?: DbStub | null
  mainWindow?: unknown
}

export function makeCtx(opts: MakeCtxOpts): HandlerContext {
  return {
    scannerManager: opts.scannerManager ?? {
      startScan: vi.fn(),
      stopScan: vi.fn(),
      getStatus: vi.fn(),
      scanRoot: vi.fn(),
      on: vi.fn()
    },
    thumbnailGen: opts.thumbnailGen ?? {
      generate: vi.fn(),
      getCacheDir: vi.fn(() => '/mock/cache')
    },
    fileService: opts.fileService ?? { previewImport: vi.fn(), importFiles: vi.fn() },
    dbManager: {
      getDatabase: vi.fn(() => (opts.db === undefined ? {} : opts.db)),
      getSetting: vi.fn(),
      setSetting: vi.fn(),
      // R8：operation-history-handler 创建 MediaRepository 需要 workerBridge + dbPath
      getWorkerBridge: vi.fn(() => null),
      getDbPath: vi.fn(() => '/mock/db/test.db')
    },
    getMainWindow: () => opts.mainWindow ?? null,
    notifyMediaUpdated: vi.fn(),
    invalidateMediaPathCache: vi.fn(),
    applyUITheme: vi.fn(),
    isThumbnailsGenerating: () => false,
    setThumbnailsGenerating: vi.fn()
  } as unknown as HandlerContext
}

export function getHandler(
  handleMock: ReturnType<typeof vi.fn>,
  channel: string
): (...args: unknown[]) => Promise<unknown> {
  for (const call of handleMock.mock.calls) {
    if (call[0] === channel) return call[1]
  }
  throw new Error(`æœªæ‰¾åˆ° channel: ${channel}`)
}

// ============================================================================
// makeAppCtx()ï¼šæž„é€ AppContext mockï¼Œå¤ç”¨ makeCtx çš„ HandlerContext éƒ¨åˆ†ï¼Œè¿½åŠ  4 ä¸ª worker bridge ä¸Ž 5 ä¸ªå¯å˜çŠ¶æ€å­—æ®µã€‚
// ============================================================================

interface WorkerBridgeStub {
  // 使用 ReturnType<typeof vi.fn> 保持与项目其他 stub 一致，赋值时用 as 断言
  onCrash: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

export interface MakeAppCtxOpts extends MakeCtxOpts {
  // 4 ä¸ª worker bridgesï¼ˆé»˜è®¤æ��ä¾› stubï¼‰
  scannerWorkerBridge?: WorkerBridgeStub
  databaseWorkerBridge?: WorkerBridgeStub
  mediaWorkerBridge?: WorkerBridgeStub
  // FIX(组17-1)：解密网络解码子进程 bridge
  decryptionWorkerBridge?: WorkerBridgeStub
  thumbnailWorkerBridge?: Pick<WorkerBridgeStub, 'dispose'>
  // å¯å˜çŠ¶æ€åˆå€¼
  startupTimers?: NodeJS.Timeout[]
  isCleaningUp?: boolean
  pendingRecoveryEvents?: import('../../app/app-context').PendingRecoveryEvent[]
  mediaUpdateTimer?: NodeJS.Timeout | null
  // AppContext æ‰©å±•æœ�åŠ¡ï¼ˆå¯è¦†ç›–ï¼‰
  taskScheduler?: {
    pause: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
    cancelAllLow: ReturnType<typeof vi.fn>
    enqueueLow: ReturnType<typeof vi.fn>
  }
  mediaWorkerManager?: { dispose: ReturnType<typeof vi.fn>; setDbPath: ReturnType<typeof vi.fn> }
  videoEditorBridge?: { dispose: ReturnType<typeof vi.fn> }
  videoService?: { setCorruptedMarker: ReturnType<typeof vi.fn> }
  thumbnailGenExt?: {
    stopLruBackgroundTask?: ReturnType<typeof vi.fn>
    flushAccessTimes?: ReturnType<typeof vi.fn>
    setCorruptedMarker?: ReturnType<typeof vi.fn>
  }
}

/**
 * æž„é€ AppContext mockï¼š
 * - å¤�ç”¨ makeCtx æ��ä¾›çš„ HandlerContext å­—æ®µï¼ˆscannerManager / thumbnailGen / fileService / dbManager ç­‰ï¼‰
 * - è¿½åŠ  4 ä¸ª worker bridgeï¼ˆonCrash + disposeï¼‰
 * - mainWindow ç”¨ getter ä¿�æŒ�å®žæ—¶æ€§ï¼ˆsetMainWindow å�Ž ctx.mainWindow ç«‹å�³è¿”å›žæ–°å€¼ï¼‰
 * - startupTimers / pendingRecoveryEvents é»˜è®¤æŒ‡å�‘ç©ºæ•°ç»„ï¼ŒsetMainWindow ä¸�æ›¿æ�¢å¼•ç”¨ï¼Œå�ª push/splice
 * - getMediaUpdateTimer / setMediaUpdateTimer ç”¨é—­åŒ…å�˜é‡�ä¿�å­˜
 */
export function makeAppCtx(opts: MakeAppCtxOpts = {}): AppContext {
  // é—­åŒ…å�˜é‡�ï¼šmainWindow / isCleaningUp / mediaUpdateTimer
  let mainWindow: unknown = opts.mainWindow ?? null
  let isCleaningUp = opts.isCleaningUp ?? false
  let mediaUpdateTimer: NodeJS.Timeout | null = opts.mediaUpdateTimer ?? null

  // å�¯å�˜çŠ¶æ€�æ•°ç»„ï¼šé»˜è®¤æŒ‡å�‘ç©ºæ•°ç»„ï¼ˆå¤–éƒ¨å�¯ç›´æŽ¥ push/spliceï¼‰
  const startupTimers: NodeJS.Timeout[] = opts.startupTimers ? [...opts.startupTimers] : []
  const pendingRecoveryEvents: import('../../app/app-context').PendingRecoveryEvent[] =
    opts.pendingRecoveryEvents ? [...opts.pendingRecoveryEvents] : []

  // å¤�ç”¨ makeCtx æž„é€ HandlerContext éƒ¨åˆ†ï¼ˆé€šè¿‡ spread å�–å‡ºï¼‰
  const handlerCtx = makeCtx(opts)

  // worker bridges stubï¼šonCrash è¿”å›žä¸€ä¸ª unsubscribe å‡½æ•°ï¼Œdispose è¿”å›ž resolved promise
  const makeBridgeStub = (): WorkerBridgeStub => ({
    onCrash: vi.fn(() => () => {}) as ReturnType<typeof vi.fn>,
    dispose: vi.fn(() => Promise.resolve()) as ReturnType<typeof vi.fn>
  })

  const scannerWorkerBridge = opts.scannerWorkerBridge ?? makeBridgeStub()
  const databaseWorkerBridge = opts.databaseWorkerBridge ?? makeBridgeStub()
  const mediaWorkerBridge = opts.mediaWorkerBridge ?? makeBridgeStub()
  const decryptionWorkerBridge = opts.decryptionWorkerBridge ?? makeBridgeStub()
  const thumbnailWorkerBridge = opts.thumbnailWorkerBridge ?? {
    dispose: vi.fn(() => Promise.resolve())
  }

  // AppContext æ‰©å±•æœ�åŠ¡ stub
  // AppContext extended services stub
  // enqueueLow resolves by default: lifecycle phase-8 timer callbacks chain .catch() on
  // the return value; returning undefined throws TypeError once the callback runs
  // (not exposed while timers are never advanced).
  const taskScheduler = opts.taskScheduler ?? {
    pause: vi.fn(),
    resume: vi.fn(),
    cancelAllLow: vi.fn(),
    enqueueLow: vi.fn(() => Promise.resolve())
  }
  const mediaWorkerManager = opts.mediaWorkerManager ?? {
    dispose: vi.fn(),
    setDbPath: vi.fn()
  }
  const videoEditorBridge = opts.videoEditorBridge ?? { dispose: vi.fn() }
  const videoService = opts.videoService ?? { setCorruptedMarker: vi.fn() }

  // 把 thumbnailGen 和 dbManager 从 handlerCtx 取出（makeCtx 内部已构造）
  const thumbnailGen = {
    ...handlerCtx.thumbnailGen,
    ...opts.thumbnailGenExt
  }
  // 扩展 dbManager：在 makeCtx 基础上追加 getWorkerBridge / getDbPath / close 等方法
  // makeCtx 仅提供 getDatabase / getSetting / setSetting，AppContext 下模块需要更多
  const dbManager = {
    ...handlerCtx.dbManager,
    getWorkerBridge: vi.fn(() => null),
    getDbPath: vi.fn(() => '/mock/db/wxnn_photo_manager.db'),
    close: vi.fn(),
    initialize: vi.fn(() => Promise.resolve()),
    addRecoveryListener: vi.fn(),
    getLastRecovery: vi.fn(() => null),
    // lifecycle.ts 阶段 1 调用：注入 database worker bridge
    setWorkerBridge: vi.fn(),
    // lifecycle.ts before-quit 调用：动态计算超时（WAL > 10MB 时延长到 5s）
    getWalFileSize: vi.fn(() => 0),
    // 启动性能优化：干净退出标志 / 分级完整性自检
    // 默认干净退出路径（标志存在）→ 不触发后台全量，保持既有用例定时器计数不变
    markCleanExit: vi.fn(),
    shouldRunFullIntegrityCheck: vi.fn(() => false),
    runFullIntegrityCheck: vi.fn(() => ({ ok: true }))
  }

  const ctx: unknown = {
    ...handlerCtx,
    thumbnailGen,
    dbManager,
    taskScheduler,
    mediaWorkerManager,
    videoEditorBridge,
    videoService,
    // 4 ä¸ª worker bridges
    scannerWorkerBridge,
    databaseWorkerBridge,
    mediaWorkerBridge,
    decryptionWorkerBridge,
    thumbnailWorkerBridge,
    // å�¯å�˜çŠ¶æ€�ï¼ˆgetter å½¢å¼�ï¼Œä¿�æŒ�å¼•ç”¨å®žæ—¶æ€§ï¼‰
    get mainWindow(): unknown {
      return mainWindow
    },
    startupTimers,
    get isCleaningUp(): boolean {
      return isCleaningUp
    },
    pendingRecoveryEvents,
    // çŠ¶æ€è®¿é—®å™¨ï¼šç”¨ vi.fn åŒ…è£¹ï¼Œä¿æŒé—­åŒ…åé‡åŒæ¥ï¼Œä¾¿äºŽ toHaveBeenCalledXxx æ–è¨€
    setMainWindow: vi.fn((win: unknown): void => {
      mainWindow = win
    }),
    setCleaningUp: vi.fn((v: boolean): void => {
      isCleaningUp = v
    }),
    getMediaUpdateTimer: vi.fn((): NodeJS.Timeout | null => mediaUpdateTimer),
    setMediaUpdateTimer: vi.fn((t: NodeJS.Timeout | null): void => {
      mediaUpdateTimer = t
    })
  }

  return ctx as AppContext
}
