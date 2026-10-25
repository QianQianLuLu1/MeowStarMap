/**
 * @layer L3
 * @module src/main/ipc/handlers/settings-handler
 * @coverage settings 域 IPC handler（settings:get / set）
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, getHandler } from './_test-helpers'

const { handleMock, mockAppGetPath } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  mockAppGetPath: vi.fn((name: string) => (name === 'userData' ? '' : ''))
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  app: { getPath: mockAppGetPath }
}))

let tmpUserDir: string

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerSettingsHandlers } from './settings-handler'
import { assertFileReadPath, pathGuard } from '../validator'
import { AppError } from '../../../shared/errors/app-error'

const assertFileReadPathMock = vi.mocked(assertFileReadPath)

describe('registerSettingsHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
  })

  beforeAll(() => {
    tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-pref-'))
    mockAppGetPath.mockImplementation((name: string) => (name === 'userData' ? tmpUserDir : ''))
  })

  afterAll(() => {
    fs.rmSync(tmpUserDir, { recursive: true, force: true })
  })

  afterEach(() => {
    // 隔离：清理硬件加速偏好镜像，避免跨用例残留导致断言误判
    const pref = path.join(tmpUserDir, 'gpu-pref.json')
    if (fs.existsSync(pref)) fs.rmSync(pref, { force: true })
  })

  it('应注册 settings:get / settings:set channel', () => {
    registerSettingsHandlers(makeCtx({}))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('settings:get')
    expect(channels).toContain('settings:set')
  })

  it('settings:get 校验失败时抛 validation', async () => {
    registerSettingsHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'settings:get')(['', 'default'])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
  })

  it('settings:get 成功时返回 settings 值', async () => {
    const ctx = makeCtx({})
    ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockReturnValue('value')
    registerSettingsHandlers(ctx)
    const result = (await getHandler(handleMock, 'settings:get')(['key', 'default'])) as {
      success: true
      data: string
    }
    expect(ctx.dbManager.getSetting).toHaveBeenCalledWith('key', 'default')
    expect(result.data).toBe('value')
  })

  it('settings:set 白名单内 key 成功持久化并返回 saved', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(handleMock, 'settings:set')(['uiTheme', 'default'])) as {
      success: true
      data: { saved: boolean }
    }
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('uiTheme', 'default')
    expect(result.data.saved).toBe(true)
  })

  it('settings:set K8 整理队列开关（nikkisync.organizerEnabled）白名单内可写', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(
      handleMock,
      'settings:set'
    )(['nikkisync.organizerEnabled', true])) as { success: true; data: { saved: boolean } }
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('nikkisync.organizerEnabled', true)
    expect(result.data.saved).toBe(true)
  })

  it('settings:set customScanPaths 经内联校验放行', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(
      handleMock,
      'settings:set'
    )(['customScanPaths', ['C:\\Users\\test\\photos']])) as {
      success: true
      data: { saved: boolean }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('C:\\Users\\test\\photos')
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('customScanPaths', [
      'C:\\Users\\test\\photos'
    ])
    expect(result.data.saved).toBe(true)
  })

  it('settings:set 安全敏感 key 被拒且错误信息含专用通道名', async () => {
    registerSettingsHandlers(makeCtx({}))
    const cases: Array<[string, string]> = [
      ['backupDir', 'backup:setDir'],
      ['thumbnailCacheDir', 'cache:setDir'],
      ['logDir', 'log:setDir'],
      ['crashDir', 'crash:setDir'],
      ['export.defaultDir', 'export:setDefaultDir'],
      ['export.namingPattern', 'export:setNamingPattern']
    ]
    for (const [key, channel] of cases) {
      const result = (await getHandler(handleMock, 'settings:set')([key, 'x'])) as {
        success: false
        error: { code: string; message: string }
      }
      expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
      expect(result.error.message).toContain(channel)
    }
  })

  it('settings:set 未知 key 被拒', async () => {
    registerSettingsHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'settings:set')(['unknownKey', 'x'])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
    expect(result.error.message).toContain('未知')
  })

  it('settings:set 值超过 1MB 时抛 validation', async () => {
    registerSettingsHandlers(makeCtx({}))
    const big = 'x'.repeat(1024 * 1024 + 1)
    const result = (await getHandler(handleMock, 'settings:set')(['key', big])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
    expect(result.error.message).toContain('过大')
  })

  it('settings:set hardwareAcceleration=false 双写到 userData/gpu-pref.json', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(
      handleMock,
      'settings:set'
    )(['hardwareAcceleration', false])) as {
      success: true
      data: { saved: boolean }
    }
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('hardwareAcceleration', false)
    expect(result.data.saved).toBe(true)
    const pref = JSON.parse(fs.readFileSync(path.join(tmpUserDir, 'gpu-pref.json'), 'utf8')) as {
      hardwareAcceleration: boolean
    }
    expect(pref.hardwareAcceleration).toBe(false)
  })

  it('settings:set hardwareAcceleration 非布尔值 → 被拒且不写镜像', async () => {
    registerSettingsHandlers(makeCtx({}))
    const result = (await getHandler(
      handleMock,
      'settings:set'
    )(['hardwareAcceleration', 'on'])) as {
      success: false
      error: { code: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
    expect(fs.existsSync(path.join(tmpUserDir, 'gpu-pref.json'))).toBe(false)
  })
})

// ============================================================================
// customScanPaths — userPicked（对话框显式选择即授权）短路
// ScanFallbackSection 选系统目录后经 settings:set 持久化的连带入口。
// ============================================================================

describe('settings:set customScanPaths — userPicked 短路', () => {
  const SYS_PICKED = 'D:\\Program Files\\Game'

  beforeEach(() => {
    handleMock.mockClear()
    assertFileReadPathMock.mockReset()
    vi.mocked(pathGuard.isUserPicked).mockReset()
    vi.mocked(pathGuard.isUserPicked).mockImplementation(() => false)
    vi.mocked(pathGuard.isUserPickedDir).mockReset()
    vi.mocked(pathGuard.isUserPickedDir).mockImplementation(() => false)
  })

  it('C1: 显式选择的目录（isUserPickedDir 命中）跳过 assertFileReadPath 并正常持久化', async () => {
    vi.mocked(pathGuard.isUserPickedDir).mockImplementation((p) => p === SYS_PICKED)
    assertFileReadPathMock.mockImplementation(() => {
      throw AppError.forbidden('路径不在白名单内，禁止读取操作')
    })
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(
      handleMock,
      'settings:set'
    )(['customScanPaths', [SYS_PICKED]])) as { success: boolean; data: { saved: boolean } }
    expect(result.success).toBe(true)
    expect(result.data.saved).toBe(true)
    expect(assertFileReadPathMock).not.toHaveBeenCalled()
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('customScanPaths', [SYS_PICKED])
  })

  it('C2(守卫): 非userPicked 路径仍被 assertFileReadPath 校验拦截', async () => {
    assertFileReadPathMock.mockImplementation(() => {
      throw AppError.forbidden('路径不在白名单内，禁止读取操作')
    })
    registerSettingsHandlers(makeCtx({}))
    const result = (await getHandler(
      handleMock,
      'settings:set'
    )(['customScanPaths', ['C:\\Users\\test\\photos']])) as { success: boolean }
    expect(result.success).toBe(false)
    expect(assertFileReadPathMock).toHaveBeenCalledWith('C:\\Users\\test\\photos')
  })

  it('C3(边界): 仅登记为文件的显式选择不得短路 customScanPaths 校验', async () => {
    // 图片水印修复后 `dialog:openFile` 也会登记 userPicked；customScanPaths 存的是扫描根，
    // 单个文件（如挑中的 logo）不能因此被当成合法目录持久化
    const PICKED_FILE = 'D:\\Downloads\\logo.png'
    vi.mocked(pathGuard.isUserPicked).mockImplementation((p) => p === PICKED_FILE)
    assertFileReadPathMock.mockImplementation(() => {
      throw AppError.forbidden('路径不在白名单内，禁止读取操作')
    })
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(
      handleMock,
      'settings:set'
    )(['customScanPaths', [PICKED_FILE]])) as { success: boolean }
    expect(result.success).toBe(false)
    expect(assertFileReadPathMock).toHaveBeenCalledWith(PICKED_FILE)
    expect(ctx.dbManager.setSetting).not.toHaveBeenCalled()
  })
})

// ============================================================================
// gpu.discretePreference — 独显优先偏好（gpu-pref.json 镜像双写）
// ============================================================================

describe('settings:set gpu.discretePreference — 值域校验与镜像双写', () => {
  // 上一 describe 的 afterAll 已删除其临时目录，这里自建独立目录
  beforeAll(() => {
    tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-pref2-'))
    mockAppGetPath.mockImplementation((name: string) => (name === 'userData' ? tmpUserDir : ''))
  })

  afterAll(() => {
    fs.rmSync(tmpUserDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    handleMock.mockClear()
    const pref = path.join(tmpUserDir, 'gpu-pref.json')
    if (fs.existsSync(pref)) fs.rmSync(pref, { force: true })
  })

  it('d1: 合法值 high-performance 持久化并双写到 gpu-pref.json（保留 hardwareAcceleration）', async () => {
    fs.writeFileSync(
      path.join(tmpUserDir, 'gpu-pref.json'),
      JSON.stringify({ hardwareAcceleration: true })
    )
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(
      handleMock,
      'settings:set'
    )(['gpu.discretePreference', 'high-performance'])) as {
      success: true
      data: { saved: boolean }
    }
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith(
      'gpu.discretePreference',
      'high-performance'
    )
    expect(result.data.saved).toBe(true)
    const pref = JSON.parse(fs.readFileSync(path.join(tmpUserDir, 'gpu-pref.json'), 'utf8')) as {
      hardwareAcceleration: boolean
      discretePreference: string
    }
    expect(pref.discretePreference).toBe('high-performance')
    expect(pref.hardwareAcceleration).toBe(true) // 不互相覆盖
  })

  it('d2: 合法值 auto 同样放行', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(
      handleMock,
      'settings:set'
    )(['gpu.discretePreference', 'auto'])) as { success: boolean }
    expect(result.success).toBe(true)
    const pref = JSON.parse(fs.readFileSync(path.join(tmpUserDir, 'gpu-pref.json'), 'utf8')) as {
      discretePreference: string
    }
    expect(pref.discretePreference).toBe('auto')
  })

  it('d3: 非法值（foo / 数组 / undefined）→ 被拒且不写镜像', async () => {
    registerSettingsHandlers(makeCtx({}))
    for (const bad of ['foo', ['high-performance'], undefined, 2]) {
      const result = (await getHandler(
        handleMock,
        'settings:set'
      )(['gpu.discretePreference', bad])) as { success: boolean; error?: { code: string } }
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('IPC_VALIDATION_ERROR')
    }
    expect(fs.existsSync(path.join(tmpUserDir, 'gpu-pref.json'))).toBe(false)
  })
})
