/**
 * @layer L3
 * @module src/main/ipc/handlers/import-handler
 * @coverage import 域 IPC handler（import:preview / run）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../../shared/errors/app-error'
import { ImportRootRepository } from '../../database/import-root-repository'
import { createSchemasMock, makeCtx, getHandler } from './_test-helpers'

const { handleMock, assertFileReadPathMock, assertFileWritePathMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  assertFileReadPathMock: vi.fn(),
  assertFileWritePathMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

vi.mock('../validator', () => ({
  wrapHandler: vi.fn(
    (ctx: unknown, _schema: unknown, handler: (args: unknown[]) => unknown) =>
      async (...args: unknown[]) => {
        try {
          const data = await handler(args.length === 1 && Array.isArray(args[0]) ? args[0] : args)
          return { success: true as const, data }
        } catch (e) {
          if (e instanceof AppError) return { success: false as const, error: e.toIpcError() }
          return {
            success: false as const,
            error: {
              code: 'IPC_INTERNAL_ERROR',
              message: e instanceof Error ? e.message : String(e)
            }
          }
        }
      }
  ),
  wrapHandlerNoArgs: vi.fn(),
  wrapHandlerRaw: vi.fn(),
  schemas: createSchemasMock(),
  assertFileReadPath: assertFileReadPathMock,
  assertFileWritePath: assertFileWritePathMock,
  // 实现调用 pathGuard.register 登记导入目录（import-handler.ts:35,50,53）
  pathGuard: { register: vi.fn(), setRootMediaDir: vi.fn() }
}))

import { registerImportHandlers } from './import-handler'

describe('registerImportHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    assertFileReadPathMock.mockReset()
    assertFileWritePathMock.mockReset()
  })

  it('应注册 import:preview / import:run channel', () => {
    registerImportHandlers(makeCtx({}))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('import:preview')
    expect(channels).toContain('import:run')
  })

  it('import:preview 调用 fileService.previewImport', async () => {
    const fileService = {
      previewImport: vi.fn().mockResolvedValue({ items: [] }),
      importFiles: vi.fn()
    }
    registerImportHandlers(makeCtx({ fileService }))
    const result = (await getHandler(handleMock, 'import:preview')(['/src'])) as {
      success: true
      data: { items: unknown[] }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/src')
    expect(fileService.previewImport).toHaveBeenCalledWith('/src')
    expect(result.data.items).toEqual([])
  })

  it('import:run 成功时返回 result 并触发 notifyMediaUpdated', async () => {
    const fileService = {
      previewImport: vi.fn(),
      importFiles: vi
        .fn()
        .mockImplementation(
          async (
            _srcs: string[],
            _dst: string,
            _opts: unknown,
            onProgress: (c: number, t: number) => void
          ) => {
            onProgress(1, 2)
            return { imported: [{ path: '/d/a' }], skipped: [], failed: [] }
          }
        )
    }
    const ctx = makeCtx({ fileService })
    registerImportHandlers(ctx)
    const opts = { namingRule: 'keep', categorize: 'flat', conflictStrategy: 'skip' }
    const result = (await getHandler(handleMock, 'import:run')([['/s'], '/d', opts])) as {
      success: true
      data: { imported: unknown[] }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/s')
    expect(assertFileWritePathMock).toHaveBeenCalledWith('/d')
    expect(fileService.importFiles).toHaveBeenCalled()
    expect(ctx.notifyMediaUpdated).toHaveBeenCalled()
    expect(result.data.imported).toHaveLength(1)
  })

  it('import:run 无导入项时不触发 notifyMediaUpdated', async () => {
    const fileService = {
      previewImport: vi.fn(),
      importFiles: vi.fn().mockResolvedValue({ imported: [], skipped: [], failed: [] })
    }
    const ctx = makeCtx({ fileService })
    registerImportHandlers(ctx)
    const opts = { namingRule: 'keep', categorize: 'flat', conflictStrategy: 'skip' }
    await getHandler(handleMock, 'import:run')([['/s'], '/d', opts])
    expect(ctx.notifyMediaUpdated).not.toHaveBeenCalled()
  })

  it('import:run service 抛错时返回 INTERNAL_ERROR', async () => {
    const fileService = {
      previewImport: vi.fn(),
      importFiles: vi.fn().mockRejectedValue(new Error('磁盘满'))
    }
    registerImportHandlers(makeCtx({ fileService }))
    const opts = { namingRule: 'keep', categorize: 'flat', conflictStrategy: 'skip' }
    const result = (await getHandler(handleMock, 'import:run')([['/s'], '/d', opts])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
    expect(result.error.message).toContain('导入失败')
  })
})

// ============================================================================
// A2：导入成功后登记导入根并触发增量扫描
// ============================================================================

/**
 * 极简内存假库：仅支撑 import_roots / media_files 两张表所需 SQL。
 * - addImportRoot 走 INSERT OR IGNORE（UNIQUE 幂等）
 * - listImportRoots 走 SELECT ... FROM import_roots
 * - scanRoot 模拟实现向 media_files 写一条记录
 * 不加载 better-sqlite3 原生模块（Node 下 ABI 不兼容），用最小语义复刻。
 */
function makeFakeDb() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    import_roots: [],
    media_files: []
  }
  let nextId = 1
  const prepare = (sql: string) => ({
    run(...args: unknown[]) {
      // 兼容 better-sqlite3 语义：stmt.run(params数组) 或 stmt.run(...args)
      const params = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args
      if (/INSERT\s+OR\s+IGNORE\s+INTO\s+import_roots/i.test(sql)) {
        const rootPath = params[0] as string
        if (!tables.import_roots.some((r) => r.root_path === rootPath)) {
          tables.import_roots.push({ id: nextId++, root_path: rootPath, created_at: 'now' })
        }
        return { lastInsertRowid: nextId - 1, changes: 1 }
      }
      if (/INSERT\s+INTO\s+media_files/i.test(sql)) {
        tables.media_files.push({ id: nextId++, file_path: params[0] as string })
        return { lastInsertRowid: nextId - 1, changes: 1 }
      }
      if (/DELETE\s+FROM\s+import_roots/i.test(sql)) {
        const rootPath = String(params[0] as string).toLowerCase()
        tables.import_roots = tables.import_roots.filter(
          (r) => String(r.root_path).toLowerCase() !== rootPath
        )
        return { lastInsertRowid: 0, changes: 1 }
      }
      return { lastInsertRowid: 0, changes: 0 }
    },
    all() {
      if (/FROM\s+import_roots/i.test(sql)) {
        return tables.import_roots.map((r) => ({ root_path: r.root_path }))
      }
      if (/FROM\s+media_files/i.test(sql)) {
        return tables.media_files.map((r) => ({ file_path: r.file_path }))
      }
      return []
    }
  })
  return { tables, prepare: prepare as unknown as never }
}

describe('import:run 后登记导入根并触发扫描（A2）', () => {
  beforeEach(() => {
    handleMock.mockClear()
    assertFileReadPathMock.mockReset()
    assertFileWritePathMock.mockReset()
  })

  it('导入成功后 listImportRoots 含该目录且扫描后 media_files 有对应记录', async () => {
    const fakeDb = makeFakeDb()
    const fileService = {
      previewImport: vi.fn(),
      importFiles: vi.fn().mockResolvedValue({
        imported: [{ path: '/d/a.jpg' }],
        skipped: [],
        failed: []
      })
    }
    const scannerManager = {
      startScan: vi.fn(),
      stopScan: vi.fn(),
      getStatus: vi.fn(),
      // 模拟 scanner 针对该根扫描入库：向 media_files 写一条记录
      scanRoot: vi.fn(async (dir: string) => {
        fakeDb.prepare('INSERT INTO media_files (file_path) VALUES (?)').run(dir + '/a.jpg')
        return { success: true, message: 'ok', filesFound: 1 }
      })
    }
    const ctx = makeCtx({ fileService, scannerManager, db: fakeDb as unknown as never })
    registerImportHandlers(ctx)
    const opts = { namingRule: 'keep', categorize: 'flat', conflictStrategy: 'skip' }
    const result = (await getHandler(handleMock, 'import:run')([['/s'], '/d', opts])) as {
      success: true
      data: { imported: unknown[] }
    }
    expect(result.success).toBe(true)
    expect(result.data.imported).toHaveLength(1)
    // 导入根已登记
    const repo = new ImportRootRepository(fakeDb as never, null, '')
    expect(repo.listImportRoots()).toContain('/d')
    // 扫描入库后 media_files 有对应记录
    expect(fakeDb.prepare('SELECT * FROM media_files').all()).toEqual([{ file_path: '/d/a.jpg' }])
    // 扫描入口针对该根被调用
    expect(scannerManager.scanRoot).toHaveBeenCalledWith('/d')
    // 导入成功返回后仍触发列表刷新
    expect(ctx.notifyMediaUpdated).toHaveBeenCalled()
  })

  it('扫描失败时仍返回导入成功且导入根已登记', async () => {
    const fakeDb = makeFakeDb()
    const fileService = {
      previewImport: vi.fn(),
      importFiles: vi.fn().mockResolvedValue({
        imported: [{ path: '/d/a.jpg' }],
        skipped: [],
        failed: []
      })
    }
    const scannerManager = {
      startScan: vi.fn(),
      stopScan: vi.fn(),
      getStatus: vi.fn(),
      scanRoot: vi.fn(async () => {
        throw new Error('scanner worker 启动失败')
      })
    }
    const ctx = makeCtx({ fileService, scannerManager, db: fakeDb as unknown as never })
    registerImportHandlers(ctx)
    const opts = { namingRule: 'keep', categorize: 'flat', conflictStrategy: 'skip' }
    const result = (await getHandler(handleMock, 'import:run')([['/s'], '/d', opts])) as {
      success: true
      data: { imported: unknown[] }
    }
    // 导入成功返回不被扫描失败影响
    expect(result.success).toBe(true)
    expect(result.data.imported).toHaveLength(1)
    // 导入根已登记（addImportRoot 在 scanRoot 之前，scanRoot 失败不影响）
    const repo = new ImportRootRepository(fakeDb as never, null, '')
    expect(repo.listImportRoots()).toContain('/d')
    // 扫描未成功，media_files 无记录
    expect(fakeDb.prepare('SELECT * FROM media_files').all()).toEqual([])
    // 列表刷新仍发生
    expect(ctx.notifyMediaUpdated).toHaveBeenCalled()
  })
})
