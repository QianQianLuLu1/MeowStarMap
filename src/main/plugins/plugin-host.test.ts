/**
 * PluginHost 单元测试（P6：单个插件加载/激活成功与失败留痕）。
 *
 * 依赖声明：electron / pluggable-electron/main / fs / logger / startup-diagnostic / i18n
 *   全部 vi.mock 替身；被测模块为单例，每个用例经 vi.resetModules + 动态 import 取新实例。
 * 启动说明：npx vitest run src/main/plugins/plugin-host.test.ts
 * 错误处理：日志断言之外，同时验证失败路径仍按原语义抛错/记录（日志不得改变行为）。
 * 参数校验：toggleActive/installPlugins 的既有校验语义不在本套件范围（见 handler 层测试）。
 * 基础测试：init 逐插件加载留痕、安装成功/失败留痕、激活成功/失败留痕、
 *   recordPluginError 加载失败留痕（均含 [Plugin] 前缀与插件名/路径/错误）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { peInitMock, loggerMock, managerDouble, logStartupErrorMock } = vi.hoisted(() => {
  const managerDouble = {
    getAllPlugins: vi.fn(() => [] as unknown[]),
    getActivePlugins: vi.fn(() => [] as unknown[]),
    getPlugin: vi.fn(() => null as unknown),
    installPlugins: vi.fn(async () => [] as unknown[])
  }
  return {
    managerDouble,
    peInitMock: vi.fn(() => managerDouble),
    loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    logStartupErrorMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/userdata') },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { removeHandler: vi.fn() }
}))
vi.mock('pluggable-electron/main', () => ({
  init: (...args: unknown[]) => peInitMock(...args)
}))
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => '{}')
  }
}))
vi.mock('../utils/logger', () => ({ logger: loggerMock }))
vi.mock('../utils/startup-diagnostic', () => ({ logStartupError: logStartupErrorMock }))
vi.mock('../i18n', () => ({ t: (key: string) => key }))

/** 每个用例取全新单例（initialized/pluginErrors 等模块级状态不跨用例泄漏） */
async function loadFresh() {
  vi.resetModules()
  return await import('./plugin-host')
}

function makePlugin(overrides: Record<string, unknown> = {}) {
  return {
    name: 'demo-plugin',
    version: '1.0.0',
    active: false,
    setActive: vi.fn(),
    uninstall: vi.fn(async () => undefined),
    isUpdateAvailable: vi.fn(async () => false),
    update: vi.fn(() => true),
    ...overrides
  }
}

beforeEach(() => {
  loggerMock.info.mockClear()
  loggerMock.warn.mockClear()
  loggerMock.error.mockClear()
  logStartupErrorMock.mockClear()
  managerDouble.getAllPlugins.mockReset().mockReturnValue([])
  managerDouble.getPlugin.mockReset().mockReturnValue(null)
  managerDouble.installPlugins.mockReset().mockResolvedValue([])
})

describe('P6：插件加载/激活结果留痕（[Plugin]）', () => {
  it('init：逐个已加载插件留 info 痕（含插件名与安装路径）', async () => {
    managerDouble.getAllPlugins.mockReturnValue([makePlugin({ active: true })])
    const { pluginHost } = await loadFresh()
    await expect(pluginHost.init()).resolves.toBe(true)
    const line = loggerMock.info.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('[Plugin]') && m.includes('demo-plugin') && m.includes('loaded'))
    expect(line).toBeDefined()
    expect(line).toContain('plugins')
    expect(line).toContain('active=true')
  })

  it('installPlugins 成功：逐个新装插件留 info 痕（含插件名与路径）', async () => {
    managerDouble.installPlugins.mockResolvedValue([makePlugin()])
    const { pluginHost } = await loadFresh()
    await pluginHost.init()
    loggerMock.info.mockClear()
    await pluginHost.installPlugins(['demo-plugin'])
    const line = loggerMock.info.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('[Plugin]') && m.includes('demo-plugin') && m.includes('installed'))
    expect(line).toBeDefined()
    expect(line).toContain('plugins')
  })

  it('installPlugins 失败：留 error 痕（含 specifier 与错误信息），且仍向外抛错', async () => {
    managerDouble.installPlugins.mockRejectedValue(new Error('npm postinstall blew up'))
    const { pluginHost } = await loadFresh()
    await pluginHost.init()
    await expect(pluginHost.installPlugins(['evil-pkg'])).rejects.toThrow('npm postinstall blew up')
    const line = loggerMock.error.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('[Plugin]') && m.includes('evil-pkg'))
    expect(line).toBeDefined()
    expect(line).toContain('npm postinstall blew up')
  })

  it('toggleActive 成功：留 info 痕（含插件名与目标状态）', async () => {
    const plugin = makePlugin()
    managerDouble.getPlugin.mockReturnValue(plugin)
    const { pluginHost } = await loadFresh()
    await pluginHost.init()
    loggerMock.info.mockClear()
    await pluginHost.toggleActive('demo-plugin', true)
    expect(plugin.setActive).toHaveBeenCalledWith(true)
    const line = loggerMock.info.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('[Plugin]') && m.includes('demo-plugin') && m.includes('active=true'))
    expect(line).toBeDefined()
  })

  it('toggleActive 失败：留 error 痕（含插件名与错误信息），且仍向外抛错', async () => {
    const plugin = makePlugin({
      setActive: vi.fn(() => {
        throw new Error('activation exploded')
      })
    })
    managerDouble.getPlugin.mockReturnValue(plugin)
    const { pluginHost } = await loadFresh()
    await pluginHost.init()
    await expect(pluginHost.toggleActive('demo-plugin', true)).rejects.toThrow(
      'activation exploded'
    )
    const line = loggerMock.error.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('[Plugin]') && m.includes('demo-plugin'))
    expect(line).toBeDefined()
    expect(line).toContain('activation exploded')
  })

  it('recordPluginError：插件加载失败留 error 痕（含插件名与错误信息）', async () => {
    const { pluginHost } = await loadFresh()
    pluginHost.recordPluginError('broken-plugin', new Error('init threw'))
    const line = loggerMock.error.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('[Plugin]') && m.includes('broken-plugin'))
    expect(line).toBeDefined()
    expect(line).toContain('init threw')
  })
})
