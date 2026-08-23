/**
 * @layer L3
 * @module src/main/ipc/handlers/scanner-handler
 * @coverage scanner 域 IPC handler 注册与执行（scanner:start / stop / status）
 * @dependencies electron / scannerManager / thumbnail-phash-service
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import { AppError } from '../../../shared/errors/app-error'
import { ImportRootRepository } from '../../database/import-root-repository'
import { createSchemasMock, makeCtx, getHandler } from './_test-helpers'

const { handleMock, generateThumbnailsForUnprocessedMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  generateThumbnailsForUnprocessedMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null }
}))

vi.mock('../../services/thumbnail-phash-service', () => ({
  generateThumbnailsForUnprocessed: generateThumbnailsForUnprocessedMock
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

// scanner:start 的 raw handler 会对 schemas 组合出的 zod schema 真实 safeParse，
// 故在共享 mock 基础上仅覆盖 schemas 为真实 zod（其余成员沿用共享 mock）
vi.mock('../validator', async () => ({
  ...(await import('../../../../tests/mocks/mock-validator')),
  schemas: createSchemasMock()
}))

import { registerScannerHandlers } from './scanner-handler'
import { assertFileReadPath, assertFileWritePath, pathGuard } from '../validator'

const assertFileReadPathMock = vi.mocked(assertFileReadPath)
const assertFileWritePathMock = vi.mocked(assertFileWritePath)
const pathGuardMock = {
  registerRoots: vi.mocked(pathGuard.registerRoots),
  register: vi.mocked(pathGuard.register)
}

describe('registerScannerHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    generateThumbnailsForUnprocessedMock.mockReset()
    assertFileReadPathMock.mockReset()
    assertFileWritePathMock.mockReset()
  })

  it('应注册 scanner:start / scanner:stop / scanner:status 三个 channel', () => {
    registerScannerHandlers(makeCtx({}))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('scanner:start')
    expect(channels).toContain('scanner:stop')
    expect(channels).toContain('scanner:status')
  })

  it('scanner:start 参数校验失败时广播 scanner:complete 并抛 validation', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    registerScannerHandlers(makeCtx({ mainWindow }))
    const result = (await getHandler(handleMock, 'scanner:start')([{ path: 123 }])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
    expect(sendMock).toHaveBeenCalledWith(
      'scanner:complete',
      expect.objectContaining({ success: false })
    )
  })

  it('scanner:start 成功时返回 result 并广播 scanner:complete', async () => {
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 10 }),
      stopScan: vi.fn(),
      getStatus: vi.fn(),
      on: vi.fn()
    }
    generateThumbnailsForUnprocessedMock.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    registerScannerHandlers(makeCtx({ scannerManager, mainWindow }))
    const result = (await getHandler(handleMock, 'scanner:start')([{ incremental: true }])) as {
      success: true
      data: { success: boolean; filesFound: number }
    }
    expect(scannerManager.startScan).toHaveBeenCalledWith({ incremental: true })
    expect(result.data.success).toBe(true)
    expect(sendMock).toHaveBeenCalledWith(
      'scanner:complete',
      expect.objectContaining({ success: true })
    )
  })

  it('scanner:start filesFound>0 时触发缩略图生成', async () => {
    const scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 5 }),
      stopScan: vi.fn(),
      getStatus: vi.fn(),
      on: vi.fn()
    }
    generateThumbnailsForUnprocessedMock.mockResolvedValue(undefined)
    const mainWindow = { webContents: { send: vi.fn() } }
    registerScannerHandlers(makeCtx({ scannerManager, mainWindow }))
    await getHandler(handleMock, 'scanner:start')([undefined])
    await new Promise((r) => setTimeout(r, 0))
    expect(generateThumbnailsForUnprocessedMock).toHaveBeenCalled()
  })

  it('scanner:start service 抛错时广播失败并返回 INTERNAL_ERROR', async () => {
    const scannerManager = {
      startScan: vi.fn().mockRejectedValue(new Error('扫描异常')),
      stopScan: vi.fn(),
      getStatus: vi.fn(),
      on: vi.fn()
    }
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    registerScannerHandlers(makeCtx({ scannerManager, mainWindow }))
    const result = (await getHandler(handleMock, 'scanner:start')([undefined])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
    expect(result.error.message).toContain('扫描失败')
    expect(sendMock).toHaveBeenCalledWith(
      'scanner:complete',
      expect.objectContaining({ success: false })
    )
  })

  it('scanner:stop 调用 stopScan', async () => {
    const scannerManager = {
      startScan: vi.fn(),
      stopScan: vi.fn().mockReturnValue({ stopped: true }),
      getStatus: vi.fn(),
      on: vi.fn()
    }
    registerScannerHandlers(makeCtx({ scannerManager }))
    const result = (await getHandler(handleMock, 'scanner:stop')()) as {
      success: true
      data: { stopped: boolean }
    }
    expect(scannerManager.stopScan).toHaveBeenCalled()
    expect(result.data.stopped).toBe(true)
  })

  it('scanner:status 返回 scanner 状态', async () => {
    const scannerManager = {
      startScan: vi.fn(),
      stopScan: vi.fn(),
      getStatus: vi.fn().mockReturnValue({ scanning: true }),
      on: vi.fn()
    }
    registerScannerHandlers(makeCtx({ scannerManager }))
    const result = (await getHandler(handleMock, 'scanner:status')()) as {
      success: true
      data: { scanning: boolean }
    }
    expect(result.data.scanning).toBe(true)
  })

  it('FIX(组1-1): 白名单校验失败时不得先把路径注册进 pathGuard（防自助提权）', async () => {
    // 模拟渲染进程传入未授权路径：assertFileReadPath 抛 forbidden
    assertFileReadPathMock.mockImplementation(() => {
      throw AppError.forbidden('出于安全考虑，不允许访问该路径')
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const scannerManager = {
      startScan: vi.fn(),
      stopScan: vi.fn(),
      getStatus: vi.fn(),
      on: vi.fn()
    }
    registerScannerHandlers(makeCtx({ scannerManager, mainWindow }))
    const result = (await getHandler(
      handleMock,
      'scanner:start'
    )([{ path: 'D:\\not-authorized\\album' }])) as {
      success: false
      error: { code: string }
    }
    expect(result.success).toBe(false)
    // 关键断言：校验失败时该路径不得被登记进白名单（原先先 registerRoots 再校验，
    // 校验对本 handler 永远通过，等同任意目录授权）
    expect(pathGuardMock.registerRoots).not.toHaveBeenCalled()
    expect(scannerManager.startScan).not.toHaveBeenCalled()
    expect(sendMock).toHaveBeenCalledWith(
      'scanner:complete',
      expect.objectContaining({ success: false })
    )
  })
})

// ============================================================================
// 指定目录扫描成功后登记导入根（图库 galleryHighQualityOnly 放行依赖 import_roots）
// ============================================================================

/**
 * 极简内存假库：仅支撑 import_roots 表所需 SQL（与 import-handler.test.ts 同模式）。
 * - addImportRoot 走 INSERT OR IGNORE（UNIQUE 幂等）
 * - listImportRoots 走 SELECT ... FROM import_roots
 */
function makeFakeDb() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    import_roots: []
  }
  let nextId = 1
  const prepare = (sql: string) => ({
    run(...args: unknown[]) {
      const params = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args
      if (/INSERT\s+OR\s+IGNORE\s+INTO\s+import_roots/i.test(sql)) {
        const rootPath = params[0] as string
        if (!tables.import_roots.some((r) => r.root_path === rootPath)) {
          tables.import_roots.push({ id: nextId++, root_path: rootPath, created_at: 'now' })
        }
        return { lastInsertRowid: nextId - 1, changes: 1 }
      }
      return { lastInsertRowid: 0, changes: 0 }
    },
    all() {
      if (/FROM\s+import_roots/i.test(sql)) {
        return tables.import_roots.map((r) => ({ root_path: r.root_path }))
      }
      return []
    }
  })
  return { tables, prepare: prepare as unknown as never }
}

describe('scanner:start 指定目录扫描登记导入根', () => {
  let addImportRootSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    handleMock.mockClear()
    assertFileReadPathMock.mockReset()
    assertFileWritePathMock.mockReset()
    generateThumbnailsForUnprocessedMock.mockReset()
    // handler 对缩略图返回值链式 .catch()，需提供 resolved promise
    generateThumbnailsForUnprocessedMock.mockResolvedValue(undefined)
    // spy 原型方法：默认调用原始实现（写 fakeDb），可统计调用次数/参数
    addImportRootSpy = vi.spyOn(ImportRootRepository.prototype, 'addImportRoot')
  })

  afterEach(() => {
    addImportRootSpy.mockRestore()
  })

  const makeScannerManager = (result: unknown) => ({
    startScan: vi.fn().mockResolvedValue(result),
    stopScan: vi.fn(),
    getStatus: vi.fn(),
    scanRoot: vi.fn(),
    on: vi.fn()
  })

  it('带 path 的成功扫描 → addImportRoot 以该 path 调用恰好一次且已登记', async () => {
    const fakeDb = makeFakeDb()
    const scannerManager = makeScannerManager({ success: true, filesFound: 3 })
    const ctx = makeCtx({ scannerManager, db: fakeDb as unknown as never })
    registerScannerHandlers(ctx)
    const result = (await getHandler(
      handleMock,
      'scanner:start'
    )([
      {
        path: '/photos/nikki'
      }
    ])) as { success: true; data: { success: boolean } }
    expect(result.success).toBe(true)
    expect(addImportRootSpy).toHaveBeenCalledTimes(1)
    expect(addImportRootSpy).toHaveBeenCalledWith('/photos/nikki')
    const repo = new ImportRootRepository(fakeDb as never, null, '')
    expect(repo.listImportRoots()).toContain('/photos/nikki')
  })

  it('不带 path（增量自动扫描）的成功扫描 → addImportRoot 未被调用', async () => {
    const fakeDb = makeFakeDb()
    const scannerManager = makeScannerManager({ success: true, filesFound: 2 })
    const ctx = makeCtx({ scannerManager, db: fakeDb as unknown as never })
    registerScannerHandlers(ctx)
    const result = (await getHandler(
      handleMock,
      'scanner:start'
    )([
      {
        incremental: true
      }
    ])) as { success: true; data: { success: boolean } }
    expect(result.success).toBe(true)
    expect(addImportRootSpy).not.toHaveBeenCalled()
    const repo = new ImportRootRepository(fakeDb as never, null, '')
    expect(repo.listImportRoots()).toEqual([])
  })

  it('addImportRoot reject → scanner:start 仍返回成功结果、不抛错', async () => {
    addImportRootSpy.mockRejectedValueOnce(new Error('db 写入失败'))
    const scannerManager = makeScannerManager({ success: true, filesFound: 1 })
    const ctx = makeCtx({ scannerManager })
    registerScannerHandlers(ctx)
    const result = (await getHandler(
      handleMock,
      'scanner:start'
    )([
      {
        path: '/photos/nikki'
      }
    ])) as { success: true; data: { success: boolean } }
    expect(result.success).toBe(true)
    expect(result.data.success).toBe(true)
    expect(addImportRootSpy).toHaveBeenCalledTimes(1)
    // 登记失败仍触发列表刷新（扫描本身成功）
    expect(ctx.notifyMediaUpdated).toHaveBeenCalled()
  })

  it('startScan 返回 success:false → addImportRoot 未被调用', async () => {
    const fakeDb = makeFakeDb()
    const scannerManager = makeScannerManager({ success: false, message: '扫描被中断' })
    const ctx = makeCtx({ scannerManager, db: fakeDb as unknown as never })
    registerScannerHandlers(ctx)
    await getHandler(handleMock, 'scanner:start')([{ path: '/photos/nikki' }])
    expect(addImportRootSpy).not.toHaveBeenCalled()
    const repo = new ImportRootRepository(fakeDb as never, null, '')
    expect(repo.listImportRoots()).toEqual([])
  })

  it('同一 path 重复成功扫描 → addImportRoot 每次被调用，import_roots 行数不增（幂等）', async () => {
    const fakeDb = makeFakeDb() as never
    const scannerManager = makeScannerManager({ success: true, filesFound: 1 })
    const ctx = makeCtx({ scannerManager, db: fakeDb })
    registerScannerHandlers(ctx)
    await getHandler(handleMock, 'scanner:start')([{ path: '/photos/nikki' }])
    await getHandler(handleMock, 'scanner:start')([{ path: '/photos/nikki' }])
    expect(addImportRootSpy).toHaveBeenCalledTimes(2)
    // INSERT OR IGNORE + 路径归一化保证幂等：重复登记不新增行
    const repo = new ImportRootRepository(fakeDb, null, '')
    expect(repo.listImportRoots()).toEqual(['/photos/nikki'])
  })

  it('path 为空字符串 → 在 zod 参数校验阶段被拒（success:false），addImportRoot 未被调用', async () => {
    // schemas.filePath = z.string().min(1)，空字符串不通过校验，根本到不了 registration 守卫，
    // 因此空 path 绝不可能登记导入根（与"空 path 不登记"约束一致）。
    const fakeDb = makeFakeDb() as never
    const scannerManager = makeScannerManager({ success: true, filesFound: 1 })
    const ctx = makeCtx({ scannerManager, db: fakeDb })
    registerScannerHandlers(ctx)
    const result = (await getHandler(
      handleMock,
      'scanner:start'
    )([
      {
        path: ''
      }
    ])) as { success: false; error: { code: string } }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
    // 校验失败 → 扫描未执行 → 不登记
    expect(addImportRootSpy).not.toHaveBeenCalled()
    const repo = new ImportRootRepository(fakeDb, null, '')
    expect(repo.listImportRoots()).toEqual([])
  })
})

describe('Bug B 回归：scanner:start 扫描前登记扫描根到 pathGuard 白名单', () => {
  let scannerManager: {
    startScan: ReturnType<typeof vi.fn>
    stopScan: ReturnType<typeof vi.fn>
    getStatus: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    pathGuardMock.registerRoots.mockClear()
    pathGuardMock.register.mockClear()
    scannerManager = {
      startScan: vi.fn().mockResolvedValue({ success: true, filesFound: 2 }),
      stopScan: vi.fn(),
      getStatus: vi.fn(),
      on: vi.fn()
    }
    // 仅保留本 describe 的注册，确保 getHandler 取到使用本 ctx（含 mock scannerManager）的 handler
    handleMock.mockClear()
    registerScannerHandlers(makeCtx({ scannerManager }))
  })

  it('带 path + customKnownPaths 时，应先 registerRoots 再调用 startScan（关闭白名单拦截缺口）', async () => {
    const handler = getHandler(handleMock, 'scanner:start')
    await handler([
      { path: '/photos/nikki', customKnownPaths: ['/photos/nikki2', '/photos/nikki3'] }
    ])
    // 扫描根（path + customKnownPaths）应被登记进白名单，且经过 path.resolve 归一化
    expect(pathGuardMock.registerRoots).toHaveBeenCalledWith(
      expect.arrayContaining([
        path.resolve('/photos/nikki'),
        path.resolve('/photos/nikki2'),
        path.resolve('/photos/nikki3')
      ])
    )
    // startScan 应被实际调用（说明登记发生在校验通过之后、扫描之前，不再被白名单拦截）
    expect(scannerManager.startScan).toHaveBeenCalledTimes(1)
  })

  it('无扫描根时不应调用 registerRoots（避免对无关路径登记）', async () => {
    const handler = getHandler(handleMock, 'scanner:start')
    await handler([{}])
    expect(pathGuardMock.registerRoots).not.toHaveBeenCalled()
    expect(scannerManager.startScan).toHaveBeenCalledTimes(1)
  })
})
