/**
 * @layer L3
 * @module src/main/ipc/handlers/file
 * @coverage 文件操作域 IPC handler 注册与执行
 * @dependencies electron / FileService / DBManager
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'
import { AppError } from '../../../shared/errors/app-error'

const {
  handleMock,
  showMessageBoxMock,
  assertFileReadPathMock,
  assertFileWritePathMock,
  moveFileMock,
  schemasProxy
} = vi.hoisted(() => {
  const makeChainable = (): any => {
    const fn: any = () => makeChainable()
    return new Proxy(fn, {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        if (typeof prop === 'symbol') return undefined
        return () => makeChainable()
      }
    })
  }
  const schemasProxy: any = new Proxy(
    {},
    {
      get: (_, prop) => {
        if (typeof prop === 'symbol') return undefined
        return makeChainable()
      }
    }
  )
  return {
    handleMock: vi.fn(),
    showMessageBoxMock: vi.fn(),
    assertFileReadPathMock: vi.fn(),
    assertFileWritePathMock: vi.fn(),
    moveFileMock: vi.fn(),
    schemasProxy
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  dialog: { showMessageBox: showMessageBoxMock }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

vi.mock('../../utils/file-utils', () => ({
  moveFile: moveFileMock
}))

vi.mock('../validator', () => {
  const unwrap = (args: unknown[]) => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args)
  return {
    wrapHandler: vi.fn(
      (ctx: unknown, _schema: unknown, handler: (args: unknown[]) => unknown) =>
        async (...args: unknown[]) => {
          try {
            const data = await handler(unwrap(args))
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
    wrapHandlerNoArgs: vi.fn((ctx: unknown, handler: () => unknown) => async () => {
      try {
        const data = await handler()
        return { success: true as const, data }
      } catch (e) {
        if (e instanceof AppError) return { success: false as const, error: e.toIpcError() }
        return {
          success: false as const,
          error: { code: 'IPC_INTERNAL_ERROR', message: e instanceof Error ? e.message : String(e) }
        }
      }
    }),
    schemas: schemasProxy,
    assertFileReadPath: assertFileReadPathMock,
    assertFileWritePath: assertFileWritePathMock
  }
})

import { registerFileHandlers } from './file'

interface FileServiceStub {
  moveToRecycleBin: ReturnType<typeof vi.fn>
  copyFiles: ReturnType<typeof vi.fn>
  moveFiles: ReturnType<typeof vi.fn>
  renameFile: ReturnType<typeof vi.fn>
  batchRename: ReturnType<typeof vi.fn>
  exportFiles: ReturnType<typeof vi.fn>
  saveAs: ReturnType<typeof vi.fn>
  deletePermanent: ReturnType<typeof vi.fn>
  getExif: ReturnType<typeof vi.fn>
}

function makeCtx(fileService: FileServiceStub, db?: unknown): HandlerContext {
  return {
    fileService,
    dbManager: {
      getDatabase: vi.fn(() => db ?? null),
      getSetting: vi.fn()
    },
    getMainWindow: () => null,
    notifyMediaUpdated: vi.fn(),
    invalidateMediaPathCache: vi.fn(),
    applyUITheme: vi.fn(),
    isThumbnailsGenerating: () => false,
    setThumbnailsGenerating: vi.fn()
  } as unknown as HandlerContext
}

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  for (const call of handleMock.mock.calls) {
    if (call[0] === channel) return call[1]
  }
  throw new Error(`未找到 channel: ${channel}`)
}

describe('registerFileHandlers', () => {
  let fileService: FileServiceStub

  beforeEach(() => {
    handleMock.mockClear()
    assertFileReadPathMock.mockReset()
    assertFileWritePathMock.mockReset()
    showMessageBoxMock.mockReset()
    moveFileMock.mockReset()
    fileService = {
      moveToRecycleBin: vi.fn(),
      copyFiles: vi.fn(),
      moveFiles: vi.fn(),
      renameFile: vi.fn(),
      batchRename: vi.fn(),
      exportFiles: vi.fn(),
      saveAs: vi.fn(),
      deletePermanent: vi.fn(),
      getExif: vi.fn()
    }
  })

  it('应注册 8 个 file channel', () => {
    registerFileHandlers(makeCtx(fileService))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toEqual([
      'file:delete',
      'file:copy',
      'file:move',
      'file:rename',
      'file:batchRename',
      'file:export',
      'file:saveAs',
      'file:deletePermanent',
      'file:getExif'
    ])
  })

  it('file:delete 调用每个路径的 assertFileReadPath 并返回 service 结果', async () => {
    fileService.moveToRecycleBin.mockResolvedValue({ deleted: 2 })
    const ctx = makeCtx(fileService)
    registerFileHandlers(ctx)
    const result = (await getHandler('file:delete')([['/a', '/b']])) as {
      success: true
      data: { deleted: number }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/a')
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/b')
    expect(fileService.moveToRecycleBin).toHaveBeenCalledWith(['/a', '/b'])
    expect(result.data.deleted).toBe(2)
  })

  it('file:copy 校验所有源路径与目标目录', async () => {
    fileService.copyFiles.mockResolvedValue({ copied: 2 })
    registerFileHandlers(makeCtx(fileService))
    await getHandler('file:copy')([['/a', '/b'], '/target'])
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/a')
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/b')
    expect(assertFileWritePathMock).toHaveBeenCalledWith('/target')
    expect(fileService.copyFiles).toHaveBeenCalledWith(['/a', '/b'], '/target')
  })

  it('file:move 校验读写路径并调用 moveFiles', async () => {
    fileService.moveFiles.mockResolvedValue({ moved: 1 })
    registerFileHandlers(makeCtx(fileService))
    await getHandler('file:move')([['/a'], '/target'])
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/a')
    expect(assertFileWritePathMock).toHaveBeenCalledWith('/target')
    expect(fileService.moveFiles).toHaveBeenCalledWith(['/a'], '/target')
  })

  // FIX(组14-1): 部分失败时也要同步已成功移动的项（renamed 映射随失败结果回传）
  it('file:move 部分失败时仍同步已完成项的 renamed 映射到 DB', async () => {
    const runMock = vi.fn()
    const db = {
      prepare: vi.fn(() => ({ run: runMock })),
      transaction: vi.fn((fn: (rows: unknown[]) => void) => (rows: unknown[]) => fn(rows))
    }
    fileService.moveFiles.mockResolvedValue({
      success: false,
      message: '目标文件被占用',
      actualPaths: ['/t/a.jpg'],
      renamed: [{ oldPath: '/a.jpg', newPath: '/t/a.jpg', newFileName: 'a.jpg' }]
    })
    registerFileHandlers(makeCtx(fileService, db))
    await getHandler('file:move')([['/a.jpg', '/b.jpg'], '/t'])
    expect(fileService.moveFiles).toHaveBeenCalled()
    // 已成功移动项的 DB 同步被执行（修复前 success:false 直接跳过同步 → 破图）
    expect(runMock).toHaveBeenCalled()
  })

  it('file:rename 仅校验源路径', async () => {
    fileService.renameFile.mockResolvedValue({ newPath: '/new.png' })
    registerFileHandlers(makeCtx(fileService))
    await getHandler('file:rename')(['/old.png', 'new.png'])
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/old.png')
    expect(fileService.renameFile).toHaveBeenCalledWith('/old.png', 'new.png')
  })

  // R3：file:rename 成功后同步 DB（UPDATE media_files SET file_path/file_name WHERE file_path=oldPath）
  it('file:rename 成功后同步 DB file_path/file_name', async () => {
    const runMock = vi.fn()
    const db = {
      prepare: vi.fn(() => ({ run: runMock })),
      transaction: vi.fn((fn: (rows: unknown[]) => void) => (rows: unknown[]) => fn(rows))
    }
    fileService.renameFile.mockResolvedValue({
      success: true,
      message: 'ok',
      renamed: [{ oldPath: '/old.png', newPath: '/new.png', newFileName: 'new.png' }]
    })
    registerFileHandlers(makeCtx(fileService, db))
    const result = (await getHandler('file:rename')(['/old.png', 'new.png'])) as {
      success: true
      data: { renamed: unknown[] }
    }
    expect(db.prepare).toHaveBeenCalledWith(
      'UPDATE media_files SET file_path = ?, file_name = ? WHERE file_path = ?'
    )
    // SQL placeholder 顺序：newPath, newFileName, oldPath
    expect(runMock).toHaveBeenCalledWith('/new.png', 'new.png', '/old.png')
    expect(result.data.renamed).toHaveLength(1)
  })

  // R3：file:rename DB 失败时反向回滚磁盘成功，不写入 pending_renames
  it('file:rename DB 失败时反向回滚磁盘成功，不写入 pending_renames', async () => {
    const runMock = vi.fn(() => {
      throw new Error('DB locked')
    })
    const insertRunMock = vi.fn()
    const db = {
      prepare: vi.fn((sql: string) => {
        if (/^INSERT INTO pending_renames/.test(sql.trim())) {
          return { run: insertRunMock }
        }
        return { run: runMock }
      }),
      transaction: vi.fn((fn: (rows: unknown[]) => void) => (rows: unknown[]) => fn(rows))
    }
    fileService.renameFile.mockResolvedValue({
      success: true,
      message: 'ok',
      renamed: [{ oldPath: '/old.png', newPath: '/new.png', newFileName: 'new.png' }]
    })
    moveFileMock.mockResolvedValue(undefined) // 反向回滚成功
    registerFileHandlers(makeCtx(fileService, db))
    const result = (await getHandler('file:rename')(['/old.png', 'new.png'])) as {
      success: false
      error: { code: string }
    }
    // 反向回滚：从 newPath(/new.png) 移回 oldPath(/old.png)
    expect(moveFileMock).toHaveBeenCalledWith('/new.png', '/old.png')
    expect(insertRunMock).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
  })

  // R3：file:move 成功后同步 DB
  it('file:move 成功后同步 DB file_path/file_name', async () => {
    const runMock = vi.fn()
    const db = {
      prepare: vi.fn(() => ({ run: runMock })),
      transaction: vi.fn((fn: (rows: unknown[]) => void) => (rows: unknown[]) => fn(rows))
    }
    fileService.moveFiles.mockResolvedValue({
      success: true,
      message: 'ok',
      actualPaths: ['/target/a.png'],
      renamed: [{ oldPath: '/src/a.png', newPath: '/target/a.png', newFileName: 'a.png' }]
    })
    registerFileHandlers(makeCtx(fileService, db))
    await getHandler('file:move')([['/src/a.png'], '/target'])
    expect(runMock).toHaveBeenCalledWith('/target/a.png', 'a.png', '/src/a.png')
  })

  // R3：file:move DB 失败时反向回滚磁盘，回滚失败写入 pending_renames
  it('file:move DB 失败且反向回滚失败时写入 pending_renames', async () => {
    const runMock = vi.fn(() => {
      throw new Error('DB locked')
    })
    const insertRunMock = vi.fn()
    const db = {
      prepare: vi.fn((sql: string) => {
        if (/^INSERT INTO pending_renames/.test(sql.trim())) {
          return { run: insertRunMock }
        }
        return { run: runMock }
      }),
      transaction: vi.fn((fn: (rows: unknown[]) => void) => (rows: unknown[]) => fn(rows))
    }
    fileService.moveFiles.mockResolvedValue({
      success: true,
      message: 'ok',
      actualPaths: ['/target/a.png'],
      renamed: [{ oldPath: '/src/a.png', newPath: '/target/a.png', newFileName: 'a.png' }]
    })
    moveFileMock.mockRejectedValueOnce(new Error('EACCES')) // 反向回滚失败
    registerFileHandlers(makeCtx(fileService, db))
    const result = (await getHandler('file:move')([['/src/a.png'], '/target'])) as {
      success: false
      error: { code: string }
    }
    expect(insertRunMock).toHaveBeenCalledWith('/src/a.png', '/target/a.png', 'a.png')
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
  })

  // R3：file:copy 不主动入库（避免写入缺字段的脏记录）
  it('file:copy 成功后不调用 DB prepare', async () => {
    const prepareMock = vi.fn(() => ({ run: vi.fn() }))
    const db = { prepare: prepareMock, transaction: vi.fn() }
    fileService.copyFiles.mockResolvedValue({
      success: true,
      message: 'ok',
      actualPaths: ['/target/a.png'],
      copied: [{ sourcePath: '/src/a.png', targetPath: '/target/a.png' }]
    })
    registerFileHandlers(makeCtx(fileService, db))
    await getHandler('file:copy')([['/src/a.png'], '/target'])
    // copy 不主动入库——prepare 仅可能被 file:export 等其他流程调用，本测试不应触发
    expect(prepareMock).not.toHaveBeenCalled()
  })

  // R3：file:rename 返回无 renamed 字段（旧版 service 兼容）时不调用 DB
  it('file:rename 返回无 renamed 字段时不调用 DB', async () => {
    const prepareMock = vi.fn(() => ({ run: vi.fn() }))
    const db = { prepare: prepareMock, transaction: vi.fn() }
    fileService.renameFile.mockResolvedValue({ success: true, message: 'ok' }) // 无 renamed
    registerFileHandlers(makeCtx(fileService, db))
    await getHandler('file:rename')(['/old.png', 'new.png'])
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('file:batchRename 校验所有 oldPath 并同步数据库', async () => {
    const runMock = vi.fn()
    const db = {
      prepare: vi.fn(() => ({ run: runMock })),
      transaction: vi.fn((fn: (rows: unknown[]) => void) => (rows: unknown[]) => fn(rows))
    }
    fileService.batchRename.mockResolvedValue({
      renamed: [{ oldPath: '/a', newPath: '/b', newFileName: 'b' }],
      skipped: [],
      failed: []
    })
    registerFileHandlers(makeCtx(fileService, db))
    const result = (await getHandler('file:batchRename')([[{ oldPath: '/a', newName: 'b' }]])) as {
      success: true
      data: { renamed: unknown[] }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/a')
    expect(fileService.batchRename).toHaveBeenCalled()
    expect(db.prepare).toHaveBeenCalledWith(
      'UPDATE media_files SET file_path = ?, file_name = ? WHERE file_path = ?'
    )
    expect(runMock).toHaveBeenCalledWith('/b', 'b', '/a')
    expect(result.data.renamed).toHaveLength(1)
  })

  it('file:batchRename 数据库不存在时不报错', async () => {
    fileService.batchRename.mockResolvedValue({ renamed: [], skipped: [], failed: [] })
    registerFileHandlers(makeCtx(fileService, null))
    const result = (await getHandler('file:batchRename')([[{ oldPath: '/a', newName: 'b' }]])) as {
      success: true
      data: { renamed: unknown[] }
    }
    expect(result.data.renamed).toEqual([])
  })

  // R2 补偿机制：DB 失败 → 反向回滚磁盘 → 回滚成功时不写入 pending_renames
  it('file:batchRename DB 失败时反向回滚磁盘成功，不写入 pending_renames', async () => {
    const runMock = vi.fn(() => {
      throw new Error('DB locked')
    })
    const insertRunMock = vi.fn()
    const db = {
      prepare: vi.fn((sql: string) => {
        if (/^INSERT INTO pending_renames/.test(sql.trim())) {
          return { run: insertRunMock }
        }
        return { run: runMock }
      }),
      transaction: vi.fn((fn: (rows: unknown[]) => void) => (rows: unknown[]) => fn(rows))
    }
    fileService.batchRename.mockResolvedValue({
      renamed: [{ oldPath: '/a', newPath: '/b', newFileName: 'b' }],
      skipped: [],
      failed: []
    })
    // 反向回滚成功
    moveFileMock.mockResolvedValue(undefined)
    registerFileHandlers(makeCtx(fileService, db))
    const result = (await getHandler('file:batchRename')([[{ oldPath: '/a', newName: 'b' }]])) as {
      success: false
      error: { code: string }
    }
    // 反向回滚：从 newPath(/b) 移回 oldPath(/a)
    expect(moveFileMock).toHaveBeenCalledWith('/b', '/a')
    // 回滚成功 → 不写入 pending_renames
    expect(insertRunMock).not.toHaveBeenCalled()
    // DB 失败向上抛，让前端感知
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
  })

  // R2 补偿机制：DB 失败 + 反向回滚失败 → 写入 pending_renames 表
  it('file:batchRename DB 失败且反向回滚失败时写入 pending_renames', async () => {
    const runMock = vi.fn(() => {
      throw new Error('DB locked')
    })
    const insertRunMock = vi.fn()
    const db = {
      prepare: vi.fn((sql: string) => {
        if (/^INSERT INTO pending_renames/.test(sql.trim())) {
          return { run: insertRunMock }
        }
        return { run: runMock }
      }),
      transaction: vi.fn((fn: (rows: unknown[]) => void) => (rows: unknown[]) => fn(rows))
    }
    fileService.batchRename.mockResolvedValue({
      renamed: [
        { oldPath: '/a', newPath: '/b', newFileName: 'b' },
        { oldPath: '/c', newPath: '/d', newFileName: 'd' }
      ],
      skipped: [],
      failed: []
    })
    // 第一项反向回滚失败，第二项回滚成功
    moveFileMock.mockRejectedValueOnce(new Error('EEXIST')).mockResolvedValueOnce(undefined)
    registerFileHandlers(makeCtx(fileService, db))
    const result = (await getHandler('file:batchRename')([
      [
        { oldPath: '/a', newName: 'b' },
        { oldPath: '/c', newName: 'd' }
      ]
    ])) as { success: false; error: { code: string } }
    // 仅第一项（回滚失败的）写入 pending_renames
    // SQL: INSERT INTO pending_renames (old_path, new_path, new_file_name, created_at) VALUES (?, ?, ?, datetime('now'))
    expect(insertRunMock).toHaveBeenCalledTimes(1)
    expect(insertRunMock).toHaveBeenCalledWith('/a', '/b', 'b')
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
  })

  it('file:export useDefaultDir=true 时从 settings 读取默认路径', async () => {
    fileService.exportFiles.mockResolvedValue({ exported: 1 })
    const ctx = makeCtx(fileService, null)
    ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce('/default/export' as never)
      .mockReturnValueOnce(null as never)
    registerFileHandlers(ctx)
    await getHandler('file:export')([['/a'], '/target', { useDefaultDir: true }])
    expect(fileService.exportFiles).toHaveBeenCalledWith(
      ['/a'],
      '/default/export',
      expect.objectContaining({ useDefaultDir: true }),
      undefined
    )
  })

  it('file:export useDefaultDir=true 但未配置默认路径时抛 preconditionFailed', async () => {
    fileService.exportFiles.mockResolvedValue({ exported: 1 })
    const ctx = makeCtx(fileService, null)
    ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockReturnValue(null)
    registerFileHandlers(ctx)
    const result = (await getHandler('file:export')([
      ['/a'],
      '/target',
      { useDefaultDir: true }
    ])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
  })

  it('file:export 启用 namingPattern 时查询元数据并传给 service', async () => {
    fileService.exportFiles.mockResolvedValue({ exported: 1 })
    const allMock = vi.fn(() => [{ file_path: '/a', album_type: 'game', account_uid: 'u1' }])
    const db = { prepare: vi.fn(() => ({ all: allMock })) }
    const ctx = makeCtx(fileService, db)
    registerFileHandlers(ctx)
    await getHandler('file:export')([['/a'], '/target', { namingPattern: '{album}' }])
    const callArgs = fileService.exportFiles.mock.calls[0]
    const metadataMap = callArgs[3] as Map<string, unknown>
    expect(metadataMap).toBeInstanceOf(Map)
    expect(metadataMap.get('/a')).toEqual({ album_type: 'game', account_uid: 'u1' })
  })

  it('file:saveAs 校验读写路径', async () => {
    fileService.saveAs.mockResolvedValue({ saved: true })
    registerFileHandlers(makeCtx(fileService))
    await getHandler('file:saveAs')(['/src', '/target', 'new.png'])
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/src')
    expect(assertFileWritePathMock).toHaveBeenCalledWith('/target')
    expect(fileService.saveAs).toHaveBeenCalledWith('/src', '/target', 'new.png')
  })

  it('file:saveAs newName 省略时传 undefined', async () => {
    fileService.saveAs.mockResolvedValue({ saved: true })
    registerFileHandlers(makeCtx(fileService))
    await getHandler('file:saveAs')(['/src', '/target', undefined])
    expect(fileService.saveAs).toHaveBeenCalledWith('/src', '/target', undefined)
  })

  it('file:deletePermanent 用户取消时抛 canceled', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    registerFileHandlers(makeCtx(fileService))
    const result = (await getHandler('file:deletePermanent')([['/a']])) as {
      success: false
      error: { code: string }
    }
    expect(showMessageBoxMock).toHaveBeenCalled()
    expect(fileService.deletePermanent).not.toHaveBeenCalled()
    expect(result.error.code).toBe('IPC_CANCELED')
  })

  it('file:deletePermanent 用户确认时调用 deletePermanent', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    fileService.deletePermanent.mockResolvedValue({ deleted: 1 })
    registerFileHandlers(makeCtx(fileService))
    const result = (await getHandler('file:deletePermanent')([['/a']])) as {
      success: true
      data: { deleted: number }
    }
    expect(fileService.deletePermanent).toHaveBeenCalledWith(['/a'])
    expect(result.data.deleted).toBe(1)
  })

  it('file:getExif 调用 service 返回 exif 数据', async () => {
    fileService.getExif.mockResolvedValue({ make: 'Nikon' })
    registerFileHandlers(makeCtx(fileService))
    const result = (await getHandler('file:getExif')(['/img.jpg'])) as {
      success: true
      data: { make: string }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/img.jpg')
    expect(fileService.getExif).toHaveBeenCalledWith('/img.jpg')
    expect(result.data.make).toBe('Nikon')
  })
})
