/**
 * 开机自启共享模块（login-item）单元测试：常量、脏值收敛、dev 门控、系统 API 异常兜底。
 * 运行：npx vitest run src/main/app/__tests__/login-item.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  setLoginItemSettings: vi.fn(),
  diagLog: vi.fn(),
  logStartupError: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  appIsPackaged: true
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return m.appIsPackaged
    },
    setLoginItemSettings: m.setLoginItemSettings
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
  syncLoginItemSetting
} from '../login-item'

describe('login-item 开机自启共享模块', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.appIsPackaged = true
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

  it('C2 边界：打包态调用系统 API，dev 态只记日志不写登录项', () => {
    m.appIsPackaged = true
    syncLoginItemSetting(true)
    expect(m.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })

    m.setLoginItemSettings.mockClear()
    m.appIsPackaged = false
    syncLoginItemSetting(false)
    expect(m.setLoginItemSettings).not.toHaveBeenCalled()
    expect(m.diagLog).toHaveBeenCalled()
  })

  it('C3 异常：系统 API 抛错不外抛且留痕', () => {
    m.appIsPackaged = true
    m.setLoginItemSettings.mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    expect(() => syncLoginItemSetting(true)).not.toThrow()
    expect(m.logStartupError).toHaveBeenCalled()
  })
})
