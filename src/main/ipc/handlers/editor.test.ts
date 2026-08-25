/**
 * @layer L3
 * @module src/main/ipc/handlers/editor
 * @coverage 编辑器域 IPC handler 注册与执行
 * @dependencies electron / editor-service / better-sqlite3 (via dbManager)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'
import { AppError } from '../../../shared/errors/app-error'

const {
  handleMock,
  dialogShowSaveDialogMock,
  dialogShowOpenDialogMock,
  getFocusedWindowMock,
  writeFileMock,
  readFileMock,
  editorSaveMock
} = vi.hoisted(() => {
  return {
    handleMock: vi.fn(),
    dialogShowSaveDialogMock: vi.fn(),
    dialogShowOpenDialogMock: vi.fn(),
    getFocusedWindowMock: vi.fn(),
    writeFileMock: vi.fn(),
    readFileMock: vi.fn(),
    editorSaveMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => getFocusedWindowMock() },
  dialog: {
    showSaveDialog: dialogShowSaveDialogMock,
    showOpenDialog: dialogShowOpenDialogMock
  }
}))

vi.mock('fs', () => ({
  default: {
    promises: {
      writeFile: writeFileMock,
      readFile: readFileMock
    }
  }
}))

vi.mock('../../services/editor-service', () => ({
  editorService: { save: editorSaveMock }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerEditorHandlers as registerEditorSaveHandlers } from './editor'
import { registerEditorPresetHandlers } from './editor-preset-handler'
import { registerEditorMetadataHandlers } from './editor-metadata-handler'
import { assertFileWritePath } from '../validator'

// 拆分后保留兼容包装：等价于原 registerEditorHandlers(ctx) 的全量注册。
// 调用顺序与原通道注册顺序一致（save/saveAs → 滤镜预设 → XMP 元数据），
// 保证「应注册 10 个 editor channel」的顺序断言继续通过。
function registerEditorHandlers(ctx: HandlerContext): void {
  registerEditorSaveHandlers(ctx)
  registerEditorPresetHandlers(ctx)
  registerEditorMetadataHandlers(ctx)
}

interface DbStub {
  prepare: ReturnType<typeof vi.fn>
}

function makeCtx(db?: DbStub): HandlerContext {
  return {
    dbManager: {
      getDatabase: vi.fn(() => db ?? null)
    },
    fileService: { saveDataUrl: vi.fn() },
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

describe('registerEditorHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    editorSaveMock.mockReset()
    writeFileMock.mockReset()
    readFileMock.mockReset()
    dialogShowSaveDialogMock.mockReset()
    dialogShowOpenDialogMock.mockReset()
    getFocusedWindowMock.mockReturnValue(null)
  })

  it('应注册 10 个 editor channel', () => {
    registerEditorHandlers(makeCtx())
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toEqual([
      'editor:save',
      'editor:saveAs',
      'editor:exportPreset',
      'editor:exportPresetToFile',
      'editor:importPresetFromFile',
      'editor:loadPresets',
      'editor:deletePreset',
      'editor:exportWithMetadata',
      'editor:batchExportWithMetadata',
      'editor:readMetadata'
    ])
  })

  it('editor:save 成功时返回 service 结果', async () => {
    editorSaveMock.mockResolvedValue({ saved: true })
    registerEditorHandlers(makeCtx())
    const result = (await getHandler('editor:save')([
      '/path/file.png',
      'data:image/png;base64,xxx'
    ])) as {
      success: true
      data: { saved: boolean }
    }
    expect(editorSaveMock).toHaveBeenCalledWith(
      '/path/file.png',
      'data:image/png;base64,xxx',
      undefined
    )
    expect(result.data.saved).toBe(true)
  })

  it('editor:save 传 options 时透传给 service', async () => {
    editorSaveMock.mockResolvedValue({ saved: true })
    registerEditorHandlers(makeCtx())
    const opts = { format: 'jpeg', quality: 90 }
    await getHandler('editor:save')(['/p', 'dataUrl', opts])
    expect(editorSaveMock).toHaveBeenCalledWith('/p', 'dataUrl', opts)
  })

  it('editor:saveAs 调用 fileService.saveDataUrl 并返回结果', async () => {
    const ctx = makeCtx()
    ;(ctx.fileService.saveDataUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: '/out.png'
    })
    registerEditorHandlers(ctx)
    const result = (await getHandler('editor:saveAs')(['data:image/png;base64,xxx'])) as {
      success: true
      data: { path: string }
    }
    expect(ctx.fileService.saveDataUrl).toHaveBeenCalledWith('data:image/png;base64,xxx', {})
    expect(result.data.path).toBe('/out.png')
  })

  it('editor:saveAs 传 options 时透传', async () => {
    const ctx = makeCtx()
    ;(ctx.fileService.saveDataUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: '/out.png'
    })
    const opts = { directory: '/dir', fileName: 'f.png', format: 'png', quality: 80 }
    registerEditorHandlers(ctx)
    await getHandler('editor:saveAs')(['dataUrl', opts])
    expect(ctx.fileService.saveDataUrl).toHaveBeenCalledWith('dataUrl', opts)
  })

  it('editor:saveAs 传入越界目录时被拒绝且不落盘', async () => {
    const ctx = makeCtx()
    vi.mocked(assertFileWritePath).mockImplementationOnce(() => {
      throw AppError.forbidden('不允许写入该路径')
    })
    registerEditorHandlers(ctx)
    const result = (await getHandler('editor:saveAs')([
      'dataUrl',
      { directory: 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Startup' }
    ])) as { success: false; error: { code: string; message: string } }

    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_PATH_FORBIDDEN')
    expect(ctx.fileService.saveDataUrl).not.toHaveBeenCalled()
  })

  it('editor:saveAs 的 fileName 被剥离路径成分后再落盘', async () => {
    const ctx = makeCtx()
    ;(ctx.fileService.saveDataUrl as ReturnType<typeof vi.fn>).mockResolvedValue({ path: '/o.jpg' })
    registerEditorHandlers(ctx)
    await getHandler('editor:saveAs')([
      'dataUrl',
      { directory: '/dir', fileName: '../../Startup/evil' }
    ])
    expect(ctx.fileService.saveDataUrl).toHaveBeenCalledWith('dataUrl', {
      directory: '/dir',
      fileName: 'evil'
    })
  })

  it('editor:saveAs 的 fileName 消毒后为空时抛校验错误', async () => {
    const ctx = makeCtx()
    registerEditorHandlers(ctx)
    const result = (await getHandler('editor:saveAs')(['dataUrl', { fileName: '..' }])) as {
      success: false
      error: { code: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
    expect(ctx.fileService.saveDataUrl).not.toHaveBeenCalled()
  })

  it('editor:exportPreset 成功时返回自增 id', async () => {
    const runMock = vi.fn(() => ({ lastInsertRowid: 42n }))
    const db = { prepare: vi.fn(() => ({ run: runMock })) }
    registerEditorHandlers(makeCtx(db))
    const result = (await getHandler('editor:exportPreset')([
      { name: '滤镜1', category: 'cat1', params: { a: 1 } }
    ])) as { success: true; data: { id: number } }
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO filter_presets'))
    expect(runMock).toHaveBeenCalledWith('滤镜1', 'cat1', JSON.stringify({ a: 1 }))
    expect(result.data.id).toBe(42)
  })

  it('editor:exportPreset 当 params 为字符串时直接传入', async () => {
    const runMock = vi.fn(() => ({ lastInsertRowid: 1n }))
    const db = { prepare: vi.fn(() => ({ run: runMock })) }
    registerEditorHandlers(makeCtx(db))
    await getHandler('editor:exportPreset')([{ name: 'n', category: 'c', params: '{"a":1}' }])
    expect(runMock).toHaveBeenCalledWith('n', 'c', '{"a":1}')
  })

  it('editor:exportPreset 数据库未初始化时抛 preconditionFailed', async () => {
    registerEditorHandlers(makeCtx(null))
    const result = (await getHandler('editor:exportPreset')([
      { name: 'n', category: 'c', params: '{}' }
    ])) as {
      success: false
      error: { code: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
  })

  it('editor:exportPresetToFile 取消保存时抛 canceled', async () => {
    dialogShowSaveDialogMock.mockResolvedValue({ canceled: true, filePath: '' })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerEditorHandlers(makeCtx())
    const result = (await getHandler('editor:exportPresetToFile')([
      { name: 'n', category: 'c', params: '{}' }
    ])) as {
      success: false
      error: { code: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_CANCELED')
  })

  it('editor:exportPresetToFile 成功时写入文件并返回路径', async () => {
    dialogShowSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/out/n.json' })
    writeFileMock.mockResolvedValue(undefined)
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerEditorHandlers(makeCtx())
    const result = (await getHandler('editor:exportPresetToFile')([
      { name: 'n', category: 'c', params: '{}' }
    ])) as {
      success: true
      data: { filePath: string }
    }
    expect(writeFileMock).toHaveBeenCalledWith('/out/n.json', expect.any(String), 'utf-8')
    expect(result.data.filePath).toBe('/out/n.json')
  })

  it('editor:exportPresetToFile 主窗口不存在时抛 preconditionFailed', async () => {
    dialogShowSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/out.json' })
    registerEditorHandlers(makeCtx())
    const result = (await getHandler('editor:exportPresetToFile')([
      { name: 'n', category: 'c', params: '{}' }
    ])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
  })

  it('editor:importPresetFromFile 取消选择时抛 canceled', async () => {
    dialogShowOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerEditorHandlers(makeCtx())
    const result = (await getHandler('editor:importPresetFromFile')()) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_CANCELED')
  })

  it('editor:importPresetFromFile 成功时返回解析后的 preset', async () => {
    dialogShowOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/in.json'] })
    readFileMock.mockResolvedValue('{"name":"n","category":"c","params":{}}')
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerEditorHandlers(makeCtx())
    const result = (await getHandler('editor:importPresetFromFile')()) as {
      success: true
      data: { preset: { name: string }; filePath: string }
    }
    expect(result.data.preset.name).toBe('n')
    expect(result.data.filePath).toBe('/in.json')
  })

  it('editor:importPresetFromFile JSON 解析失败时抛 validation', async () => {
    dialogShowOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/in.json'] })
    readFileMock.mockResolvedValue('not-json')
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerEditorHandlers(makeCtx())
    const result = (await getHandler('editor:importPresetFromFile')()) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
  })

  it('editor:loadPresets 成功时返回 presets 数组并解析 params', async () => {
    const allMock = vi.fn(() => [
      {
        id: 1,
        name: 'n1',
        category: 'c',
        params: '{"k":1}',
        is_builtin: 0,
        created_at: '2026-01-01'
      }
    ])
    const db = { prepare: vi.fn(() => ({ all: allMock })) }
    registerEditorHandlers(makeCtx(db))
    const result = (await getHandler('editor:loadPresets')()) as {
      success: true
      data: { presets: Array<{ id: string; params: unknown; isBuiltin: boolean }> }
    }
    expect(result.data.presets).toHaveLength(1)
    expect(result.data.presets[0].id).toBe('1')
    expect(result.data.presets[0].params).toEqual({ k: 1 })
    expect(result.data.presets[0].isBuiltin).toBe(false)
  })

  it('editor:loadPresets 数据库未初始化时抛 preconditionFailed', async () => {
    registerEditorHandlers(makeCtx(null))
    const result = (await getHandler('editor:loadPresets')()) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
  })

  it('editor:deletePreset 成功时返回 { deleted: true }', async () => {
    const runMock = vi.fn()
    const db = { prepare: vi.fn(() => ({ run: runMock })) }
    registerEditorHandlers(makeCtx(db))
    const result = (await getHandler('editor:deletePreset')([5])) as {
      success: true
      data: { deleted: boolean }
    }
    expect(db.prepare).toHaveBeenCalledWith(
      'DELETE FROM filter_presets WHERE id = ? AND is_builtin = 0'
    )
    expect(runMock).toHaveBeenCalledWith(5)
    expect(result.data.deleted).toBe(true)
  })

  it('editor:deletePreset 字符串 id 也可用', async () => {
    const runMock = vi.fn()
    const db = { prepare: vi.fn(() => ({ run: runMock })) }
    registerEditorHandlers(makeCtx(db))
    await getHandler('editor:deletePreset')(['abc'])
    expect(runMock).toHaveBeenCalledWith('abc')
  })

  it('editor:deletePreset 数据库未初始化时抛 preconditionFailed', async () => {
    registerEditorHandlers(makeCtx(null))
    const result = (await getHandler('editor:deletePreset')([1])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
  })
})
