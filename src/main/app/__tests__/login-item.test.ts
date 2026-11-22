/**
 * 开机自启共享模块（login-item）单元测试：常量、脏值收敛、dev 门控、系统 API 异常兜底。
 * 运行：npx vitest run src/main/app/__tests__/login-item.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { AppError } from '../../../shared/errors/app-error'

const m = vi.hoisted(() => {
  // 对齐真实 Windows Run 项语义：主路径写入后，getLoginItemSettings() 立即能回读到同一值。
  // Settings.name 只用于历史残留值名清理，不改变主状态。
  const loginItemState = { openAtLogin: false }
  return {
    setLoginItemSettings: vi.fn((s: { openAtLogin: boolean; name?: string }) => {
      if (s.name === undefined) loginItemState.openAtLogin = s.openAtLogin
    }),
    // 返回 unknown：各用例可用 mockReturnValueOnce 模拟非布尔 / 带 launchItems 的真实 OS 读数
    getLoginItemSettings: vi.fn((): unknown => ({
      openAtLogin: loginItemState.openAtLogin,
      launchItems: []
    })),
    diagLog: vi.fn(),
    logStartupError: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    appIsPackaged: true,
    loginItemState
  }
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return m.appIsPackaged
    },
    setLoginItemSettings: m.setLoginItemSettings,
    getLoginItemSettings: m.getLoginItemSettings
  }
}))

vi.mock('../../utils/startup-diagnostic', () => ({
  diagLog: m.diagLog,
  logStartupError: m.logStartupError
}))

vi.mock('../../utils/logger', () => ({ logger: m.logger }))

import {
  SETTING_LAUNCH_AT_LOGIN,
  LAUNCH_AT_LOGIN_DEFAULT,
  normalizeLaunchAtLogin,
  syncLoginItemSetting,
  cleanupLegacyLoginItemNames,
  detectLegacyLoginItemNames,
  LEGACY_LOGIN_ITEM_NAMES
} from '../login-item'
import * as loginItemModule from '../login-item'

describe('login-item 开机自启共享模块', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.appIsPackaged = true
    m.loginItemState.openAtLogin = false
    // 每个用例都从干净的 OS 读数起步，避免 mockImplementationOnce 队列跨用例残留
    m.getLoginItemSettings.mockImplementation(() => ({
      openAtLogin: m.loginItemState.openAtLogin,
      launchItems: []
    }))
  })

  it('C1 正常/边界：常量正确，脏值一律回落默认 true', () => {
    expect(SETTING_LAUNCH_AT_LOGIN).toBe('launchAtLogin')
    expect(LAUNCH_AT_LOGIN_DEFAULT).toBe(true)
    expect(normalizeLaunchAtLogin(true)).toBe(true)
    expect(normalizeLaunchAtLogin(false)).toBe(false)
    for (const dirty of ['false', null, 1, {}, [], undefined]) {
      expect(normalizeLaunchAtLogin(dirty)).toBe(true)
    }
  })

  it('C2 边界：打包态调用系统 API，dev 态返回可区分的 skipped 态且零回读零清理', () => {
    m.appIsPackaged = true
    expect(syncLoginItemSetting(true)).toEqual({ synced: true })
    expect(m.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })

    m.setLoginItemSettings.mockClear()
    m.getLoginItemSettings.mockClear()
    m.appIsPackaged = false
    expect(syncLoginItemSetting(false)).toEqual({ synced: false, skipped: 'dev' })
    expect(m.setLoginItemSettings).not.toHaveBeenCalled()
    expect(m.getLoginItemSettings).not.toHaveBeenCalled()
    expect(m.diagLog).toHaveBeenCalled()
  })

  it('C3′ 异常：系统 API 抛错必须抛 AppError（不得静默吞掉）且留痕', () => {
    m.appIsPackaged = true
    m.setLoginItemSettings.mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    // 原 C3 断言 not.toThrow()，把「吞异常」固化成期望；此处纠正为可感知失败
    expect(() => syncLoginItemSetting(true)).toThrow(AppError)
    expect(m.logStartupError).toHaveBeenCalled()
    expect(m.diagLog).toHaveBeenCalled()
  })

  it('C4 边界：历史残留 Run 值名按 Settings.name 逐项清理，非法名跳过并留痕', () => {
    cleanupLegacyLoginItemNames(['old-name'])
    expect(m.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false, name: 'old-name' })

    m.setLoginItemSettings.mockClear()
    cleanupLegacyLoginItemNames(['', 'a\\b', 'x'.repeat(300)])
    expect(m.setLoginItemSettings).not.toHaveBeenCalled()
    expect(m.diagLog).toHaveBeenCalled()
  })

  it('C4a 异常：单项清理抛错不影响其余项，且逐项留痕', () => {
    m.setLoginItemSettings.mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    cleanupLegacyLoginItemNames(['bad-name', 'good-name'])
    expect(m.setLoginItemSettings).toHaveBeenNthCalledWith(1, {
      openAtLogin: false,
      name: 'bad-name'
    })
    expect(m.setLoginItemSettings).toHaveBeenNthCalledWith(2, {
      openAtLogin: false,
      name: 'good-name'
    })
    expect(m.diagLog).toHaveBeenCalledWith(
      'LOGIN',
      expect.stringContaining('legacy cleanup failed')
    )
  })

  it('C4b 边界：dev 态清理必须零调用系统 API', () => {
    m.appIsPackaged = false
    cleanupLegacyLoginItemNames(['old-name'])
    expect(m.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('C4c 边界：生产路径的清理名单恒等于取证常量（取证前为空数组 ⇒ 零清理）', () => {
    expect(Array.isArray(LEGACY_LOGIN_ITEM_NAMES)).toBe(true)
    expect(syncLoginItemSetting(true)).toEqual({ synced: true })
    const cleanedNames = m.setLoginItemSettings.mock.calls
      .map(([settings]) => (settings as { name?: string }).name)
      .filter((name) => name !== undefined)
    expect(cleanedNames).toEqual([...LEGACY_LOGIN_ITEM_NAMES])
  })

  it('C5 异常：写入后回读不一致必须抛 AppError，不得谎报成功', () => {
    m.appIsPackaged = true
    m.getLoginItemSettings.mockReturnValueOnce({ openAtLogin: false })
    expect(() => syncLoginItemSetting(true)).toThrow(AppError)
  })

  it('C6 异常（红测）：回读不可用须单独留痕 read-back unavailable，且仍可感知失败', () => {
    m.appIsPackaged = true
    m.getLoginItemSettings.mockReturnValueOnce({
      openAtLogin: 'not-boolean'
    } as unknown as { openAtLogin: boolean })
    expect(() => syncLoginItemSetting(true)).toThrow(AppError)
    expect(m.diagLog).toHaveBeenCalledWith(
      'LOGIN',
      expect.stringContaining('read-back unavailable')
    )
    expect(m.logStartupError).toHaveBeenCalled()
  })

  it('C7 异常：回读布尔值明确不一致时仍抛 AppError，带用户可读文案并留痕', () => {
    m.appIsPackaged = true
    m.getLoginItemSettings.mockReturnValueOnce({ openAtLogin: false })
    let caught: unknown
    try {
      syncLoginItemSetting(true)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).userMessage).toBeTruthy()
    expect(m.diagLog).toHaveBeenCalledWith('LOGIN', expect.stringContaining('read-back mismatch'))
  })

  it('C8 边界：OS 恒回读 false 时每次开启都必须可感知失败（不放宽断言）', () => {
    m.appIsPackaged = true
    for (let i = 0; i < 3; i++) {
      m.getLoginItemSettings.mockReturnValueOnce({ openAtLogin: false })
      expect(() => syncLoginItemSetting(true)).toThrow(AppError)
    }
  })

  // ===== 历史 Run 值名残留（Electron launchItems 动态发现）=====
  // 根因：setLoginItemSettings 不传 name 时，Run 值名取 AppUserModelId()；
  // 该 AUMID 是 c7c7c92 才引入的，晚于引入自启功能的 69343e3，故中间分发的构建
  // 写入过旧默认名。不再靠人工猜名单，改由 OS 读数按 exe 路径精确识别。

  const launchItem = (name: string, exePath = process.execPath, scope = 'user') => ({
    name,
    path: exePath,
    args: [],
    scope,
    enabled: true
  })

  const cleanedNames = () =>
    m.setLoginItemSettings.mock.calls
      .map(([settings]) => (settings as { name?: string }).name)
      .filter((name) => name !== undefined)

  it('D1 正常（红测）：OS 报出指向本应用 exe 的历史值名时必须清理', () => {
    m.getLoginItemSettings.mockImplementation(() => ({
      openAtLogin: true,
      launchItems: [launchItem('legacy-aumid')]
    }))
    expect(syncLoginItemSetting(true)).toEqual({ synced: true })
    expect(m.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      name: 'legacy-aumid'
    })
  })

  it('D2 边界（红测）：当前受管名 / 其它应用 / machine 作用域一律不得清理', () => {
    m.getLoginItemSettings.mockImplementation(() => ({
      openAtLogin: true,
      launchItems: [
        launchItem('legacy-aumid'),
        launchItem('com.qianlu.meow-star-map'),
        launchItem('legacy-machine', process.execPath, 'machine'),
        launchItem('other-app', 'C:\\Other\\app.exe')
      ]
    }))
    expect(syncLoginItemSetting(true)).toEqual({ synced: true })
    expect(cleanedNames()).toEqual(['legacy-aumid'])
  })

  it('D3 边界（红测）：注册表路径带引号与大小写差异时仍能识别本应用 exe', () => {
    const quotedUpper = `"${process.execPath.toUpperCase()}"`
    m.getLoginItemSettings.mockImplementation(() => ({
      openAtLogin: true,
      launchItems: [launchItem('legacy-quoted', quotedUpper)]
    }))
    expect(syncLoginItemSetting(true)).toEqual({ synced: true })
    expect(m.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      name: 'legacy-quoted'
    })
  })

  it('D4 异常（红测）：枚举启动项抛错只留痕，不得阻断主设置同步', () => {
    let calls = 0
    m.getLoginItemSettings.mockImplementation(() => {
      calls += 1
      if (calls === 2) throw new Error('enum failed')
      return { openAtLogin: true, launchItems: [] }
    })
    expect(syncLoginItemSetting(true)).toEqual({ synced: true })
    expect(m.diagLog).toHaveBeenCalledWith(
      'LOGIN',
      expect.stringContaining('legacy detection failed')
    )
  })

  it('D5 边界（红测）：当前受管名必须与 build.appId 同源，防止漂移', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      build: { appId: string }
    }
    expect(loginItemModule.CURRENT_LOGIN_ITEM_NAME).toBe(pkg.build.appId)
  })

  it('D6 边界（红测）：安装目录变更（同 exe 基名、不同路径）的历史值名也能识别', () => {
    // 2026-11-22 取证：升级换安装目录后旧项 path 不再等于 process.execPath，
    // 全路径精确匹配漏检，残留项继续开机拉起应用；按 exe 基名兜底识别
    const movedPath = `D:\\old-install-dir\\${basename(process.execPath)}`
    m.getLoginItemSettings.mockImplementation(() => ({
      openAtLogin: true,
      launchItems: [launchItem('legacy-moved', movedPath)]
    }))
    expect(detectLegacyLoginItemNames()).toEqual(['legacy-moved'])
  })

  it('D7 安全护栏：异基名与 machine 作用域一律不得识别（绝不误删第三方启动项）', () => {
    const ownBase = basename(process.execPath)
    m.getLoginItemSettings.mockImplementation(() => ({
      openAtLogin: true,
      launchItems: [
        launchItem('other-tool', 'C:\\other-tool\\tool.exe'),
        launchItem('same-base-machine', `E:\\elsewhere\\${ownBase}`, 'machine')
      ]
    }))
    expect(detectLegacyLoginItemNames()).toEqual([])
  })
})
