import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 共鸣录 handler 单元测试：捕获 ipcMain.handle 注册闭包后直调，
 * 走真实 wrapHandler（zod 校验）；ResonanceRepository 与 node:fs 打桩。
 */

const { handleMock, repoMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  repoMock: {
    getAllData: vi.fn(),
    addManualEdit: vi.fn(),
    updateEditTime: vi.fn(),
    deleteRecord: vi.fn(),
    importPullsBatch: vi.fn(),
    importEditsBatch: vi.fn(),
    importPearpalBatch: vi.fn(),
    importEvo: vi.fn(),
    replaceWardrobe: vi.fn(),
    updateWardrobe: vi.fn(),
    getWardrobe: vi.fn(),
    clearAll: vi.fn()
  }
}))

const fsMock = vi.hoisted(() => {
  const stat = vi.fn()
  const readFile = vi.fn()
  const writeFile = vi.fn()
  const promises = {
    stat,
    readFile,
    writeFile,
    appendFile: vi.fn(() => Promise.resolve()),
    readdir: vi.fn(() => Promise.resolve([])),
    unlink: vi.fn(() => Promise.resolve())
  }
  // logger（同模块图依赖）会调用 mkdirSync/appendFile 等方法，逐一兜底
  return {
    stat,
    readFile,
    writeFile,
    promises,
    mkdirSync: vi.fn(),
    appendFile: vi.fn(),
    appendFileSync: vi.fn(),
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isFile: () => true, isDirectory: () => true, size: 0 })),
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    createWriteStream: vi.fn(() => ({ write: vi.fn(), end: vi.fn(), on: vi.fn() })),
    readdirSync: vi.fn(() => [])
  }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/userdata'), isPackaged: false },
  ipcMain: { handle: handleMock },
  BrowserWindow: {}
}))

vi.mock('../../database/resonance-repository', () => ({
  ResonanceRepository: vi.fn(() => repoMock)
}))

vi.mock('node:fs', () => {
  const full = fsMock as unknown as Record<string, unknown>
  return { default: full, ...full }
})

import { registerResonanceHandlers } from './resonance-handler'
import { pathGuard } from '../validator'
import { IPC_ERROR_CODES } from '../../../shared/types/ipc-types'
import type { HandlerContext } from '../../handler-context'

const ROOT = 'C:\\test\\root'

function makeCtx(): HandlerContext {
  return {
    dbManager: {
      getDatabase: vi.fn(() => ({})),
      getSetting: vi.fn(),
      setSetting: vi.fn(),
      getWorkerBridge: vi.fn(() => undefined),
      getDbPath: vi.fn(() => '/mock/db.sqlite')
    },
    getMainWindow: () => null,
    notifyMediaUpdated: vi.fn(),
    invalidateMediaPathCache: vi.fn()
  } as unknown as HandlerContext
}

type WrappedFn = (...args: unknown[]) => Promise<unknown>

function getHandler(channel: string): WrappedFn {
  for (const call of handleMock.mock.calls) {
    if (call[0] === channel) return call[1] as WrappedFn
  }
  throw new Error(`未找到 channel: ${channel}`)
}

interface IpcResponseLike {
  success: boolean
  data?: unknown
  error?: { code: string; message: string }
}

const T = '2025-06-01 12:30:45'

describe('resonance handler', () => {
  beforeEach(() => {
    handleMock.mockClear()
    vi.clearAllMocks()
    pathGuard.register(ROOT)
    registerResonanceHandlers(makeCtx())
  })

  it('注册全部 9 个通道', () => {
    const channels = handleMock.mock.calls.map((call) => call[0])
    expect(channels).toEqual(
      expect.arrayContaining([
        'resonance:getData',
        'resonance:addManualRecord',
        'resonance:updateManualRecord',
        'resonance:deleteRecord',
        'resonance:readImportFile',
        'resonance:commitImport',
        'resonance:export',
        'resonance:updateWardrobe',
        'resonance:clearAll'
      ])
    )
  })

  describe('resonance:getData', () => {
    it('返回仓储全量数据', async () => {
      const sample = {
        pulls: [],
        edits: [],
        pearpal: [],
        evo: [],
        wardrobe: {
          version: 1,
          ownedItemIds: [],
          ownedMakeupIds: [],
          ownedMomoIds: [],
          ownedPropIds: [],
          ownedEurekaColorIds: [],
          updatedAt: ''
        }
      }
      repoMock.getAllData.mockReturnValue(sample)
      const res = (await getHandler('resonance:getData')({})) as IpcResponseLike
      expect(res.success).toBe(true)
      expect(res.data).toEqual(sample)
    })
  })

  describe('resonance:addManualRecord', () => {
    it('正常路径写入', async () => {
      repoMock.addManualEdit.mockResolvedValue(undefined)
      const res = (await getHandler('resonance:addManualRecord')(
        {},
        '2',
        '2020000002',
        T
      )) as IpcResponseLike
      expect(res.success).toBe(true)
      expect(repoMock.addManualEdit).toHaveBeenCalledWith('2', '2020000002', T)
    })

    it('UNIQUE 冲突映射为 CONFLICT', async () => {
      repoMock.addManualEdit.mockRejectedValue(
        new Error('UNIQUE constraint failed: resonance_edits')
      )
      const res = (await getHandler('resonance:addManualRecord')(
        {},
        '2',
        '2020000002',
        T
      )) as IpcResponseLike
      expect(res.success).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.CONFLICT)
    })

    it('校验失败返回 VALIDATION_ERROR 且不落库', async () => {
      const res = (await getHandler('resonance:addManualRecord')(
        {},
        'bad-banner',
        '1',
        'not-a-time'
      )) as IpcResponseLike
      expect(res.success).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
      expect(repoMock.addManualEdit).not.toHaveBeenCalled()
    })
  })

  describe('resonance:deleteRecord', () => {
    it('正常删除', async () => {
      repoMock.deleteRecord.mockResolvedValue(undefined)
      const res = (await getHandler('resonance:deleteRecord')(
        {},
        { kind: 'pull', id: 3 }
      )) as IpcResponseLike
      expect(res.success).toBe(true)
      expect(repoMock.deleteRecord).toHaveBeenCalledWith('pull', 3)
    })

    it('记录不存在映射为 NOT_FOUND', async () => {
      const err = new Error('not found') as Error & { code?: string }
      err.code = 'RESONANCE_RECORD_NOT_FOUND'
      repoMock.deleteRecord.mockRejectedValue(err)
      const res = (await getHandler('resonance:deleteRecord')(
        {},
        { kind: 'edit', id: 3 }
      )) as IpcResponseLike
      expect(res.error?.code).toBe(IPC_ERROR_CODES.NOT_FOUND)
    })
  })

  describe('resonance:readImportFile', () => {
    it('白名单路径读取成功', async () => {
      fsMock.stat.mockResolvedValue({ isFile: () => true, size: 128 })
      fsMock.readFile.mockResolvedValue('{"pulls":{}}')
      const res = (await getHandler('resonance:readImportFile')(
        {},
        `${ROOT}\\export.json`
      )) as IpcResponseLike
      expect(res.success).toBe(true)
      expect(res.data).toEqual({ content: '{"pulls":{}}', sizeBytes: 128 })
    })

    it('非白名单路径被拒绝', async () => {
      const res = (await getHandler('resonance:readImportFile')(
        {},
        'C:\\Windows\\system32\\evil.json'
      )) as IpcResponseLike
      expect(res.success).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    })

    it('文件不存在映射为 NOT_FOUND', async () => {
      fsMock.stat.mockRejectedValue(new Error('ENOENT'))
      const res = (await getHandler('resonance:readImportFile')(
        {},
        `${ROOT}\\missing.json`
      )) as IpcResponseLike
      expect(res.success).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.NOT_FOUND)
    })
  })

  describe('resonance:commitImport', () => {
    it('批次写入各表并返回写入数', async () => {
      repoMock.importPullsBatch.mockReturnValue(2)
      repoMock.importEditsBatch.mockReturnValue(1)
      const res = (await getHandler('resonance:commitImport')(
        {},
        {
          pulls: [
            { bannerId: '2', itemId: '1020000001', obtainedAt: T },
            { bannerId: '2', itemId: '2020000002', obtainedAt: T }
          ],
          edits: [{ bannerId: '3', itemId: '2020000003', obtainedAt: T }],
          pearpal: [],
          evo: []
        }
      )) as IpcResponseLike
      expect(res.success).toBe(true)
      expect(res.data).toEqual({ imported: 3 })
      expect(repoMock.importPullsBatch).toHaveBeenCalledTimes(1)
      expect(repoMock.importEditsBatch).toHaveBeenCalledTimes(1)
      expect(repoMock.replaceWardrobe).not.toHaveBeenCalled()
    })

    it('末批携带 wardrobe 时全量覆盖', async () => {
      repoMock.importPullsBatch.mockReturnValue(0)
      const res = (await getHandler('resonance:commitImport')(
        {},
        {
          pulls: [],
          edits: [],
          pearpal: [],
          evo: [],
          includeWardrobe: true,
          wardrobe: {
            version: 1,
            ownedItemIds: [1020000001],
            ownedMakeupIds: [],
            ownedMomoIds: [],
            ownedPropIds: [],
            ownedEurekaColorIds: []
          }
        }
      )) as IpcResponseLike
      expect(res.success).toBe(true)
      expect(repoMock.replaceWardrobe).toHaveBeenCalledTimes(1)
    })

    it('空批次被 schema 拒绝（零副作用）', async () => {
      const res = (await getHandler('resonance:commitImport')(
        {},
        {
          pulls: [],
          edits: [],
          pearpal: [],
          evo: []
        }
      )) as IpcResponseLike
      expect(res.success).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
      expect(repoMock.importPullsBatch).not.toHaveBeenCalled()
    })

    it('非法行被 schema 拒绝（零副作用）', async () => {
      const res = (await getHandler('resonance:commitImport')(
        {},
        {
          pulls: [{ bannerId: '2', itemId: 'not-numeric', obtainedAt: T }],
          edits: [],
          pearpal: [],
          evo: []
        }
      )) as IpcResponseLike
      expect(res.success).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
      expect(repoMock.importPullsBatch).not.toHaveBeenCalled()
    })
  })

  describe('resonance:export', () => {
    const payload = {
      version: 1,
      app: 'nikkigallery',
      exportedAt: '2025-06-01T00:00:00.000Z',
      pulls: { '2': [[T, '1020000001']] },
      edits: {},
      evo: {},
      pearpal: {},
      wardrobe: {
        version: 1,
        ownedItemIds: [1020000001],
        ownedMakeupIds: [],
        ownedMomoIds: [],
        ownedPropIds: [],
        ownedEurekaColorIds: []
      }
    }

    it('白名单路径写盘成功', async () => {
      fsMock.stat.mockResolvedValue({ isDirectory: () => true })
      fsMock.writeFile.mockResolvedValue(undefined)
      const res = (await getHandler('resonance:export')(
        {},
        { filePath: `${ROOT}\\out.json` },
        payload
      )) as IpcResponseLike
      expect(res.success).toBe(true)
      expect(res.data).toEqual({ path: `${ROOT}\\out.json`, recordCount: 1 })
      expect(fsMock.writeFile).toHaveBeenCalledWith(`${ROOT}\\out.json`, expect.any(String), 'utf8')
    })

    it('非 .json 扩展名被前置拒绝', async () => {
      fsMock.stat.mockResolvedValue({ isDirectory: () => true })
      const res = (await getHandler('resonance:export')(
        {},
        { filePath: `${ROOT}\\out.txt` },
        payload
      )) as IpcResponseLike
      expect(res.success).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
      expect(fsMock.writeFile).not.toHaveBeenCalled()
    })

    it('父目录不存在被前置拒绝', async () => {
      fsMock.stat.mockRejectedValue(new Error('ENOENT'))
      const res = (await getHandler('resonance:export')(
        {},
        { filePath: `${ROOT}\\missing\\out.json` },
        payload
      )) as IpcResponseLike
      expect(res.success).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
      expect(fsMock.writeFile).not.toHaveBeenCalled()
    })

    it('载荷缺字段被 schema 拒绝', async () => {
      const res = (await getHandler('resonance:export')(
        {},
        { filePath: `${ROOT}\\out.json` },
        { version: 1 }
      )) as IpcResponseLike
      expect(res.success).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    })
  })

  describe('resonance:updateWardrobe', () => {
    it('增量更新并返回最新衣橱', async () => {
      const wardrobe = {
        version: 1,
        ownedItemIds: [1020000001],
        ownedMakeupIds: [],
        ownedMomoIds: [],
        ownedPropIds: [],
        ownedEurekaColorIds: [],
        updatedAt: 'x'
      }
      repoMock.updateWardrobe.mockResolvedValue(undefined)
      repoMock.getWardrobe.mockReturnValue(wardrobe)
      const res = (await getHandler('resonance:updateWardrobe')(
        {},
        {
          adds: [{ category: 'item', itemId: 1020000001 }],
          removes: []
        }
      )) as IpcResponseLike
      expect(res.success).toBe(true)
      expect(res.data).toEqual({ wardrobe })
    })

    it('超批量上限被 schema 拒绝', async () => {
      const adds = Array.from({ length: 5001 }, (_, i) => ({ category: 'item', itemId: i + 1 }))
      const res = (await getHandler('resonance:updateWardrobe')(
        {},
        { adds, removes: [] }
      )) as IpcResponseLike
      expect(res.success).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    })
  })
})
