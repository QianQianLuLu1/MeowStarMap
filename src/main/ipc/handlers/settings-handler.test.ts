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

const {
  handleMock,
  mockAppGetPath,
  mockSetLoginItemSettings,
  mockGetLoginItemSettings,
  mockDiagLog,
  mockLogStartupError,
  appState,
  loginItemState
} = vi.hoisted(() => {
  // 对齐真实 Windows Run 项语义：主路径写入后，getLoginItemSettings() 立即能回读到同一值。
  // Settings.name 只用于历史残留值名清理，不改变主状态。
  const loginItemState = { openAtLogin: false }
  return {
    handleMock: vi.fn(),
    mockAppGetPath: vi.fn((name: string) => (name === 'userData' ? '' : '')),
    mockSetLoginItemSettings: vi.fn((s: { openAtLogin: boolean; name?: string }) => {
      if (s.name === undefined) loginItemState.openAtLogin = s.openAtLogin
    }),
    mockGetLoginItemSettings: vi.fn(() => ({ openAtLogin: loginItemState.openAtLogin })),
    mockDiagLog: vi.fn(),
    mockLogStartupError: vi.fn(),
    appState: { isPackaged: true },
    loginItemState
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  app: {
    getPath: mockAppGetPath,
    get isPackaged() {
      return appState.isPackaged
    },
    setLoginItemSettings: mockSetLoginItemSettings,
    getLoginItemSettings: mockGetLoginItemSettings
  }
}))

// 开机自启模块会写诊断日志：测试内隔离，避免落真实磁盘（按解析后的模块 ID 命中）
vi.mock('../../utils/startup-diagnostic', () => ({
  diagLog: mockDiagLog,
  logStartupError: mockLogStartupError
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

let tmpUserDir: string

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerSettingsHandlers } from './settings-handler'
import { assertFileReadPath, pathGuard } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { setForensicsEnvProvider } from '../../utils/forensics-dir'

const assertFileReadPathMock = vi.mocked(assertFileReadPath)

describe('registerSettingsHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
  })

  beforeAll(() => {
    tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-pref-'))
    mockAppGetPath.mockImplementation((name: string) => (name === 'userData' ? tmpUserDir : ''))
    // gpu-pref 镜像写入侧已统一走取证根（install 态 = tmpUserDir\Diagnostics），
    // 注入 provider 使读写同源；不注入会回落真实 Documents 目录
    setForensicsEnvProvider(() => ({
      isPackaged: true,
      defaultApp: false,
      exePath: path.join(tmpUserDir, 'app.exe')
    }))
  })

  afterAll(() => {
    setForensicsEnvProvider(null)
    fs.rmSync(tmpUserDir, { recursive: true, force: true })
  })

  afterEach(() => {
    // 隔离：清理硬件加速偏好镜像，避免跨用例残留导致断言误判
    const pref = path.join(tmpUserDir, 'Diagnostics', 'gpu-pref.json')
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
      ['export.namingPattern', 'export:setNamingPattern'],
      ['nikkisync.gameRoot', 'nikkisync:set-game-root']
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

  it('settings:set hardwareAcceleration=false 双写到取证根/gpu-pref.json', async () => {
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
    const pref = JSON.parse(
      fs.readFileSync(path.join(tmpUserDir, 'Diagnostics', 'gpu-pref.json'), 'utf8')
    ) as {
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
    expect(fs.existsSync(path.join(tmpUserDir, 'Diagnostics', 'gpu-pref.json'))).toBe(false)
  })
})

// ===== 本次需求：开机自启动设置（launchAtLogin，默认开启）=====
describe('settings:set launchAtLogin 开机自启动', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appState.isPackaged = true
    loginItemState.openAtLogin = false
  })

  it('B1 回归：布尔 true 持久化并同步 OS 登录项（打包态）', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(handleMock, 'settings:set')(['launchAtLogin', true])) as {
      success: boolean
      data?: { saved: boolean; synced?: boolean }
      error?: { message: string }
    }
    expect(result.success, result.error?.message).toBe(true)
    expect(result.data?.saved).toBe(true)
    expect(result.data?.synced).toBe(true)
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('launchAtLogin', true)
    expect(mockSetLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
  })

  it('B2 回归：非布尔值被拒且走专用校验文案，不写库不调系统 API', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    for (const dirty of ['true', 1, null, {}, []]) {
      const result = (await getHandler(handleMock, 'settings:set')(['launchAtLogin', dirty])) as {
        success: boolean
        error?: { message: string }
      }
      expect(result.success).toBe(false)
      expect(result.error?.message).toContain('launchAtLogin 必须是布尔值')
      expect(result.error?.message).not.toContain('未知的设置项 key')
    }
    expect(ctx.dbManager.setSetting).not.toHaveBeenCalled()
    expect(mockSetLoginItemSettings).not.toHaveBeenCalled()
    // undefined 在通用序列化校验处即被拒，同样不得写库
    const undef = (await getHandler(handleMock, 'settings:set')(['launchAtLogin', undefined])) as {
      success: boolean
    }
    expect(undef.success).toBe(false)
    expect(ctx.dbManager.setSetting).not.toHaveBeenCalled()
  })

  it('B3 边界：false 同步移除登录项', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(handleMock, 'settings:set')(['launchAtLogin', false])) as {
      success: boolean
      data?: { saved: boolean; synced?: boolean }
      error?: { message: string }
    }
    expect(result.success, result.error?.message).toBe(true)
    expect(result.data?.saved).toBe(true)
    expect(result.data?.synced).toBe(true)
    expect(mockSetLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false })
  })

  it('B4′ 边界：dev 态不写 OS，且必须回传可区分的 skipped 态（不得谎报已生效）', async () => {
    appState.isPackaged = false
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(handleMock, 'settings:set')(['launchAtLogin', true])) as {
      success: boolean
      data?: { saved: boolean; synced?: boolean; skipped?: string }
      error?: { message: string }
    }
    expect(result.success, result.error?.message).toBe(true)
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('launchAtLogin', true)
    expect(mockSetLoginItemSettings).not.toHaveBeenCalled()
    expect(mockDiagLog).toHaveBeenCalled()
    expect(result.data?.synced).toBe(false)
    expect(result.data?.skipped).toBe('dev')
  })

  it('B5′ 异常（主红测）：系统 API 抛错必须可感知地失败、回滚 DB 且留痕', async () => {
    mockSetLoginItemSettings.mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    const ctx = makeCtx({})
    ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockReturnValue(true)
    registerSettingsHandlers(ctx)
    const result = (await getHandler(handleMock, 'settings:set')(['launchAtLogin', false])) as {
      success: boolean
      error?: { code: string; message: string; userMessage?: string }
    }
    // 原 B5 断言 success===true，把「静默失败」固化成期望；此处纠正为可感知失败
    expect(result.success, result.error?.message).toBe(false)
    expect(result.error?.code).toBe('IPC_INTERNAL_ERROR')
    expect(result.error?.userMessage).toBeTruthy()
    // 同步失败后 DB 必须回滚到旧值 true，避免下次启动把失败意图重新写回 OS
    expect(ctx.dbManager.setSetting).toHaveBeenLastCalledWith('launchAtLogin', true)
    expect(mockLogStartupError).toHaveBeenCalled()
  })

  it('B6 异常：写入后回读与期望不一致时必须失败（不得谎报成功）', async () => {
    // 模拟系统 API 调用成功但 Run 项并未真正改变
    mockGetLoginItemSettings.mockReturnValueOnce({ openAtLogin: false })
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(handleMock, 'settings:set')(['launchAtLogin', true])) as {
      success: boolean
      error?: { code: string; message: string; userMessage?: string }
    }
    expect(result.success, result.error?.message).toBe(false)
    expect(result.error?.code).toBe('IPC_INTERNAL_ERROR')
    expect(result.error?.userMessage).toContain('开机自启动状态同步失败')
  })

  it('B7 异常：OS 状态回读抛错时必须失败（不得静默当作成功）', async () => {
    mockGetLoginItemSettings.mockImplementationOnce(() => {
      throw new Error('read failed')
    })
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(handleMock, 'settings:set')(['launchAtLogin', true])) as {
      success: boolean
      error?: { code: string; message: string; userMessage?: string }
    }
    expect(result.success, result.error?.message).toBe(false)
    expect(result.error?.code).toBe('IPC_INTERNAL_ERROR')
    expect(result.error?.userMessage).toContain('开机自启动状态同步失败')
  })

  it('B8 异常（红测）：DB 回滚自身抛错时不得覆盖原始同步失败与用户文案', async () => {
    mockSetLoginItemSettings.mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    const ctx = makeCtx({})
    ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockReturnValue(true)
    let setCall = 0
    ;(ctx.dbManager.setSetting as ReturnType<typeof vi.fn>).mockImplementation(() => {
      setCall += 1
      // 第一次是写入新值，第二次是失败后的 DB 回滚
      if (setCall === 2) throw new Error('rollback disk full')
    })
    registerSettingsHandlers(ctx)
    const result = (await getHandler(handleMock, 'settings:set')(['launchAtLogin', false])) as {
      success: boolean
      error?: { code: string; message: string; userMessage?: string }
    }
    expect(result.success, result.error?.message).toBe(false)
    expect(result.error?.code).toBe('IPC_INTERNAL_ERROR')
    expect(result.error?.userMessage ?? '').toContain('开机自启动状态同步失败')
    expect(result.error?.message).not.toContain('rollback disk full')
  })

  it('B9 边界：键原本未设置时回滚写入默认值，语义与默认开启等价', async () => {
    mockSetLoginItemSettings.mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    const ctx = makeCtx({})
    // 对齐真实 getSetting(key, defaultValue)：键未设置时返回调用方给的默认值
    ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
      (_key: string, dflt: unknown) => dflt
    )
    registerSettingsHandlers(ctx)
    const result = (await getHandler(handleMock, 'settings:set')(['launchAtLogin', false])) as {
      success: boolean
      error?: { message: string }
    }
    expect(result.success, result.error?.message).toBe(false)
    expect(ctx.dbManager.setSetting).toHaveBeenLastCalledWith('launchAtLogin', true)
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
    setForensicsEnvProvider(() => ({
      isPackaged: true,
      defaultApp: false,
      exePath: path.join(tmpUserDir, 'app.exe')
    }))
  })

  afterAll(() => {
    setForensicsEnvProvider(null)
    fs.rmSync(tmpUserDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    handleMock.mockClear()
    const pref = path.join(tmpUserDir, 'Diagnostics', 'gpu-pref.json')
    if (fs.existsSync(pref)) fs.rmSync(pref, { force: true })
  })

  it('d1: 合法值 high-performance 持久化并双写到 gpu-pref.json（保留 hardwareAcceleration）', async () => {
    fs.mkdirSync(path.join(tmpUserDir, 'Diagnostics'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpUserDir, 'Diagnostics', 'gpu-pref.json'),
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
    const pref = JSON.parse(
      fs.readFileSync(path.join(tmpUserDir, 'Diagnostics', 'gpu-pref.json'), 'utf8')
    ) as {
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
    const pref = JSON.parse(
      fs.readFileSync(path.join(tmpUserDir, 'Diagnostics', 'gpu-pref.json'), 'utf8')
    ) as {
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
    expect(fs.existsSync(path.join(tmpUserDir, 'Diagnostics', 'gpu-pref.json'))).toBe(false)
  })
})

// ===== 外部参考数据镜像站点（referenceData.manifestBaseUrl，总计划阶段 1）=====
describe('settings:set referenceData.manifestBaseUrl 镜像站点', () => {
  // 本块在文件顶层：外层 describe 的 beforeEach（handleMock.mockClear）不覆盖这里，
  // 不清的话 getHandler 会命中此前用例注册的旧 handler（旧 ctx），setSetting 断言落空
  beforeEach(() => {
    handleMock.mockClear()
  })

  it('公网 https 地址放行并持久化', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(
      handleMock,
      'settings:set'
    )(['referenceData.manifestBaseUrl', 'https://mirror.example.test/'])) as {
      data?: { saved?: boolean }
    }
    expect(result.data?.saved).toBe(true)
    // 存储值已去尾斜杠由消费方拼接；这里断言原样透传（trim 语义在 handler 内）
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith(
      'referenceData.manifestBaseUrl',
      'https://mirror.example.test/'
    )
  })

  it('空串放行（= 回退上游官方站点）', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = (await getHandler(
      handleMock,
      'settings:set'
    )(['referenceData.manifestBaseUrl', ''])) as { data?: { saved?: boolean } }
    expect(result.data?.saved).toBe(true)
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('referenceData.manifestBaseUrl', '')
  })

  it('非字符串（数字/对象）被拒', async () => {
    registerSettingsHandlers(makeCtx({}))
    for (const value of [123, { evil: true }, null]) {
      const result = (await getHandler(
        handleMock,
        'settings:set'
      )(['referenceData.manifestBaseUrl', value])) as { error?: { code?: string } }
      expect(result.error?.code).toBe('IPC_VALIDATION_ERROR')
    }
  })

  it('环回 / 私网 / 非 http(s) 地址被拒（SSRF 闸），不落库', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    for (const value of [
      'http://127.0.0.1:9',
      'http://localhost',
      'http://192.168.1.1',
      'http://10.0.0.5',
      'ftp://mirror.example.test',
      'not-a-url'
    ]) {
      const result = (await getHandler(
        handleMock,
        'settings:set'
      )(['referenceData.manifestBaseUrl', value])) as { error?: { code?: string } }
      expect(result.error?.code, value).toBe('IPC_VALIDATION_ERROR')
    }
    expect(ctx.dbManager.setSetting).not.toHaveBeenCalled()
  })
})

// ===== 参考图片加速/镜像入口（referenceData.imageMirrorBaseUrl，阶段 5）=====
describe('settings:set referenceData.imageMirrorBaseUrl 图片加速入口', () => {
  /**
   * 与 manifest 镜像键**同款校验、不同语义**：manifest 键覆盖热更站点，本键只替换
   * 已授权图片资源的取图 host。两键必须各自独立可写，且不得互相串用。
   * 应用不内置、不代建加速节点——本键是用户自配入口的唯一落点。
   */
  const KEY = 'referenceData.imageMirrorBaseUrl'

  beforeEach(() => {
    handleMock.mockClear()
  })

  async function set(value: unknown): Promise<{
    data?: { saved?: boolean }
    error?: { code?: string }
  }> {
    return (await getHandler(handleMock, 'settings:set')([KEY, value])) as {
      data?: { saved?: boolean }
      error?: { code?: string }
    }
  }

  it('公网 https 地址放行并持久化', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const result = await set('https://image-mirror.example.test')
    expect(result.data?.saved).toBe(true)
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith(KEY, 'https://image-mirror.example.test')
  })

  it('带路径前缀的反代形态放行（子路径部署）', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    expect((await set('https://image-mirror.example.test/nikki-cdn/')).data?.saved).toBe(true)
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith(
      KEY,
      'https://image-mirror.example.test/nikki-cdn/'
    )
  })

  it('空串放行（= 未配置，走原始地址）', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    expect((await set('')).data?.saved).toBe(true)
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith(KEY, '')
  })

  it('边界：首尾空白被 trim 后落库', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    expect((await set('  https://image-mirror.example.test  ')).data?.saved).toBe(true)
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith(KEY, 'https://image-mirror.example.test')
  })

  it('边界：仅空白串等同未配置（trim 后为空）', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    expect((await set('   ')).data?.saved).toBe(true)
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith(KEY, '')
  })

  it('异常：非字符串（数字/对象/null/布尔）被拒', async () => {
    registerSettingsHandlers(makeCtx({}))
    for (const value of [123, { evil: true }, null, true, ['https://a.example']]) {
      expect((await set(value)).error?.code, String(value)).toBe('IPC_VALIDATION_ERROR')
    }
  })

  it('异常：环回 / 私网 / 保留段 / 非 http(s) / 不可解析地址被拒（SSRF 闸），不落库', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    for (const value of [
      'http://127.0.0.1:9',
      'http://localhost',
      'http://192.168.1.1',
      'http://10.0.0.5',
      'http://169.254.169.254/latest/meta-data',
      'https://[fe80::1]',
      'ftp://image-mirror.example.test',
      'file:///etc/passwd',
      'not-a-url'
    ]) {
      expect((await set(value)).error?.code, value).toBe('IPC_VALIDATION_ERROR')
    }
    expect(ctx.dbManager.setSetting).not.toHaveBeenCalled()
  })

  it('异常：超长地址（>256）被拒', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    const long = `https://image-mirror.example.test/${'a'.repeat(300)}`
    expect((await set(long)).error?.code).toBe('IPC_VALIDATION_ERROR')
    expect(ctx.dbManager.setSetting).not.toHaveBeenCalled()
  })

  it('两个镜像键互不串用：写图片入口不影响 manifest 键的落库值', async () => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    await set('https://image-mirror.example.test')
    const manifestResult = (await getHandler(
      handleMock,
      'settings:set'
    )(['referenceData.manifestBaseUrl', 'https://manifest-mirror.example.test'])) as {
      data?: { saved?: boolean }
    }

    expect(manifestResult.data?.saved).toBe(true)
    expect(ctx.dbManager.setSetting).toHaveBeenNthCalledWith(
      1,
      KEY,
      'https://image-mirror.example.test'
    )
    expect(ctx.dbManager.setSetting).toHaveBeenNthCalledWith(
      2,
      'referenceData.manifestBaseUrl',
      'https://manifest-mirror.example.test'
    )
  })
})

// ===== T4：外部图片总开关 / 开机自动检查开关的布尔校验 =====
describe('settings:set 外部参考数据布尔开关', () => {
  const keys = ['referenceData.remoteImagesEnabled', 'referenceData.autoUpdate']

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(keys)('%s：true / false 均正确落库', async (key) => {
    for (const value of [true, false]) {
      // getHandler 返回首个注册的 handler，每轮清空注册记录以绑定本轮 ctx
      handleMock.mockClear()
      const ctx = makeCtx({})
      registerSettingsHandlers(ctx)
      const result = (await getHandler(handleMock, 'settings:set')([key, value])) as {
        success: boolean
        error?: { message: string }
      }
      expect(result.success, result.error?.message).toBe(true)
      expect(ctx.dbManager.setSetting).toHaveBeenCalledWith(key, value)
    }
  })

  it.each(keys)('%s：非布尔值被拒，不写库且给出明确错误', async (key) => {
    const ctx = makeCtx({})
    registerSettingsHandlers(ctx)
    for (const dirty of ['true', 1, null, {}, []]) {
      const result = (await getHandler(handleMock, 'settings:set')([key, dirty])) as {
        success: boolean
        error?: { message: string }
      }
      expect(result.success).toBe(false)
      expect(result.error?.message).toContain('布尔值')
    }
    expect(ctx.dbManager.setSetting).not.toHaveBeenCalled()
  })
})

describe('P5: settings:set 变更留痕', () => {
  beforeEach(() => {
    handleMock.mockClear()
  })

  it('hardwareAcceleration 写入记录 [Settings] old→new（旧值 false 新值 true 均可见）', async () => {
    const { logger } = await import('../../utils/logger')
    const infoMock = vi.mocked(logger.info)
    infoMock.mockClear()
    const ctx = makeCtx({})
    vi.mocked(ctx.dbManager.getSetting).mockReturnValue(false)
    registerSettingsHandlers(ctx)
    const result = (await getHandler(
      handleMock,
      'settings:set'
    )(['hardwareAcceleration', true])) as { success: boolean; error?: { message: string } }
    expect(result.success, result.error?.message).toBe(true)
    const lines = infoMock.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('[Settings]'))
    expect(lines.length).toBeGreaterThan(0)
    const joined = lines.join('\n')
    expect(joined).toContain('hardwareAcceleration')
    expect(joined).toContain('false')
    expect(joined).toContain('true')
  })

  it('审查修复轮：校验失败的写入不得留下 [Settings] old→new 留痕（留痕时序修正）', async () => {
    const { logger } = await import('../../utils/logger')
    const infoMock = vi.mocked(logger.info)
    infoMock.mockClear()
    const ctx = makeCtx({})
    vi.mocked(ctx.dbManager.getSetting).mockReturnValue(false)
    registerSettingsHandlers(ctx)
    // hardwareAcceleration 传非布尔值：走内联校验分支抛 ValidationError
    const result = (await getHandler(
      handleMock,
      'settings:set'
    )(['hardwareAcceleration', 'yes-not-boolean'])) as { success: boolean }
    expect(result.success).toBe(false)
    // 留痕必须在「校验通过且写库成功」之后发生：失败的变更记录成已发生会污染诊断时间线
    const lines = infoMock.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('[Settings]'))
    expect(lines).toEqual([])
  })
})
