/**
 * @layer L2
 * @module src/main/app/desktop-shortcut
 * @coverage ensureDesktopShortcut + 私有 resolveDesktopPath / regQueryDesktopPath
 * @dependencies electron (app/shell)、fs、child_process (execFile)、utils/logger、utils/startup-diagnostic
 *
 * 难点：
 * 1. 私有 resolveDesktopPath / regQueryDesktopPath 通过 ensureDesktopShortcut 间接测试
 * 2. execFile 回调需可控（reg query 成功/失败/超时三分支）
 * 3. fs.existsSync / accessSync 需按路径分支返回不同值
 * 4. process.platform 影响代码分支（非 win32 跳过注册表查询）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 共享 mock
const {
  appIsPackagedMock,
  appGetPathMock,
  readShortcutLinkMock,
  writeShortcutLinkMock,
  existsSyncMock,
  unlinkSyncMock,
  accessSyncMock,
  execFileMock,
  loggerWarnMock,
  loggerInfoMock,
  loggerErrorMock,
  logStartupErrorMock
} = vi.hoisted(() => ({
  appIsPackagedMock: { value: false },
  appGetPathMock: vi.fn(),
  readShortcutLinkMock: vi.fn(),
  writeShortcutLinkMock: vi.fn(),
  existsSyncMock: vi.fn(),
  unlinkSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  execFileMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  logStartupErrorMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return appIsPackagedMock.value
    },
    getPath: appGetPathMock
  },
  shell: {
    readShortcutLink: readShortcutLinkMock,
    writeShortcutLink: writeShortcutLinkMock
  }
}))

vi.mock('fs', () => ({
  default: {
    existsSync: existsSyncMock,
    unlinkSync: unlinkSyncMock,
    accessSync: accessSyncMock,
    constants: { R_OK: 4, W_OK: 2 }
  },
  existsSync: existsSyncMock,
  unlinkSync: unlinkSyncMock,
  accessSync: accessSyncMock,
  constants: { R_OK: 4, W_OK: 2 }
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

vi.mock('../../utils/logger', () => ({
  logger: {
    warn: loggerWarnMock,
    info: loggerInfoMock,
    error: loggerErrorMock
  }
}))

vi.mock('../../utils/startup-diagnostic', () => ({
  logStartupError: logStartupErrorMock
}))

import { ensureDesktopShortcut } from '../desktop-shortcut'

const DEFAULT_DESKTOP = 'C:\\Users\\Test\\Desktop'
const DEFAULT_HOME = 'C:\\Users\\Test'
const DEFAULT_EXE = 'C:\\Program Files\\App\\app.exe'
const SHORTCUT_NAME = '无限暖暖相册管理工具.lnk'

// 工具：构造 execFile 回调控制
function setRegResult(stdout: string | null, err: Error | null = null): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (e: Error | null, stdout: string) => void
    ) => {
      if (err) cb(err, '')
      else cb(null, stdout)
    }
  )
}

// 工具：构造 accessSync 行为
function setAccessSyncThrow(shouldThrow: boolean): void {
  accessSyncMock.mockImplementation(() => {
    if (shouldThrow) throw new Error('EACCES')
  })
}

let originalPlatform: string

beforeEach(() => {
  // 重置所有 mock
  appIsPackagedMock.value = false
  appGetPathMock.mockReset()
  readShortcutLinkMock.mockReset()
  writeShortcutLinkMock.mockReset()
  existsSyncMock.mockReset()
  unlinkSyncMock.mockReset()
  accessSyncMock.mockReset()
  execFileMock.mockReset()
  loggerWarnMock.mockReset()
  loggerInfoMock.mockReset()
  loggerErrorMock.mockReset()
  logStartupErrorMock.mockReset()

  // 默认：app.getPath 返回标准路径
  appGetPathMock.mockImplementation((key: string): string => {
    if (key === 'desktop') return DEFAULT_DESKTOP
    if (key === 'home') return DEFAULT_HOME
    if (key === 'exe') return DEFAULT_EXE
    return ''
  })

  // 默认：accessSync 不抛错（路径可写）
  setAccessSyncThrow(false)

  // 默认：execFile 调用回调返回空 stdout（注册表无自定义路径）
  setRegResult('')

  // 保存平台
  originalPlatform = process.platform
})

afterEach(() => {
  // 恢复平台
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

// 工具：强制设为 Windows 平台
function setWindowsPlatform(): void {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
}

// 工具：强制设为打包环境
function setPackaged(value: boolean): void {
  appIsPackagedMock.value = value
}

describe('ensureDesktopShortcut', () => {
  it('1. 开发环境（app.isPackaged=false）直接返回，不执行后续逻辑', async () => {
    setWindowsPlatform()
    setPackaged(false)

    await ensureDesktopShortcut()

    expect(writeShortcutLinkMock).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('2. 打包环境 + 桌面路径不可写时跳过创建（resolveDesktopPath 返回 null）', async () => {
    setWindowsPlatform()
    setPackaged(true)
    // 注册表无自定义路径 + desktop 不可写
    setRegResult('')
    setAccessSyncThrow(true)

    await ensureDesktopShortcut()

    expect(loggerWarnMock).toHaveBeenCalled()
    expect(writeShortcutLinkMock).not.toHaveBeenCalled()
  })

  it('3. 快捷方式不存在时创建新快捷方式', async () => {
    setWindowsPlatform()
    setPackaged(true)
    // 快捷方式不存在
    existsSyncMock.mockReturnValue(false)
    writeShortcutLinkMock.mockReturnValue(true)

    await ensureDesktopShortcut()

    expect(writeShortcutLinkMock).toHaveBeenCalledTimes(1)
    // target 为 app.getPath('exe')
    const opts = writeShortcutLinkMock.mock.calls[0][2] as { target: string }
    expect(opts.target).toBe(DEFAULT_EXE)
    // shortcutPath 在 desktop 下
    const shortcutPath = writeShortcutLinkMock.mock.calls[0][0] as string
    expect(shortcutPath).toContain(DEFAULT_DESKTOP)
    expect(shortcutPath).toContain(SHORTCUT_NAME)
  })

  it('4. 快捷方式存在且 target 有效时跳过创建', async () => {
    setWindowsPlatform()
    setPackaged(true)
    // 快捷方式存在 + target 也存在
    existsSyncMock.mockReturnValue(true)
    readShortcutLinkMock.mockReturnValue({ target: DEFAULT_EXE })
    writeShortcutLinkMock.mockReturnValue(true)

    await ensureDesktopShortcut()

    expect(writeShortcutLinkMock).not.toHaveBeenCalled()
    expect(unlinkSyncMock).not.toHaveBeenCalled()
  })

  it('5. 快捷方式存在但 target 失效（exe 被删除）时删除旧快捷方式并重建', async () => {
    setWindowsPlatform()
    setPackaged(true)
    // 第一次 existsSync(shortcutPath) 返回 true，第二次 existsSync(link.target) 返回 false
    existsSyncMock.mockImplementation((p: string) => p.includes(SHORTCUT_NAME))
    readShortcutLinkMock.mockReturnValue({ target: 'C:\\Missing\\app.exe' })
    writeShortcutLinkMock.mockReturnValue(true)

    await ensureDesktopShortcut()

    expect(unlinkSyncMock).toHaveBeenCalledTimes(1)
    expect(writeShortcutLinkMock).toHaveBeenCalledTimes(1)
  })

  it('6. readShortcutLink 抛错（快捷方式损坏）时删除并重建', async () => {
    setWindowsPlatform()
    setPackaged(true)
    existsSyncMock.mockReturnValue(true)
    readShortcutLinkMock.mockImplementation(() => {
      throw new Error('shortcut corrupted')
    })
    writeShortcutLinkMock.mockReturnValue(true)

    await ensureDesktopShortcut()

    expect(unlinkSyncMock).toHaveBeenCalledTimes(1)
    expect(writeShortcutLinkMock).toHaveBeenCalledTimes(1)
  })

  it('7. shell.writeShortcutLink 返回 false 时 fallback 到用户主目录', async () => {
    setWindowsPlatform()
    setPackaged(true)
    existsSyncMock.mockReturnValue(false)
    // 第一次（desktop）返回 false，第二次（home）返回 true
    writeShortcutLinkMock.mockReturnValueOnce(false).mockReturnValueOnce(true)

    await ensureDesktopShortcut()

    expect(writeShortcutLinkMock).toHaveBeenCalledTimes(2)
    // 第二次调用路径在 home 下
    const fallbackPath = writeShortcutLinkMock.mock.calls[1][0] as string
    expect(fallbackPath).toContain(DEFAULT_HOME)
    expect(fallbackPath).toContain(SHORTCUT_NAME)
  })

  it('8. fallback 也失败时记录 logger.error', async () => {
    setWindowsPlatform()
    setPackaged(true)
    existsSyncMock.mockReturnValue(false)
    // 两次都返回 false
    writeShortcutLinkMock.mockReturnValue(false)

    await ensureDesktopShortcut()

    expect(writeShortcutLinkMock).toHaveBeenCalledTimes(2)
    expect(loggerErrorMock).toHaveBeenCalledTimes(1)
  })

  it('9. resolveDesktopPath 优先返回注册表自定义路径', async () => {
    setWindowsPlatform()
    setPackaged(true)
    const regDesktop = 'D:\\OneDrive\\Desktop'
    // 注册表返回自定义桌面路径
    setRegResult(`\r\n    Desktop    REG_SZ    ${regDesktop}\r\n`)
    // 所有路径都可写
    setAccessSyncThrow(false)
    existsSyncMock.mockReturnValue(false)
    writeShortcutLinkMock.mockReturnValue(true)

    await ensureDesktopShortcut()

    // writeShortcutLink 调用路径应包含注册表返回的桌面
    const shortcutPath = writeShortcutLinkMock.mock.calls[0][0] as string
    expect(shortcutPath).toContain(regDesktop)
    // 不应包含 electron 默认 desktop
    expect(shortcutPath).not.toContain(DEFAULT_DESKTOP)
  })

  it('10. 注册表查询失败时回退到 app.getPath("desktop")', async () => {
    setWindowsPlatform()
    setPackaged(true)
    // 注册表查询失败
    setRegResult('', new Error('reg query failed'))
    existsSyncMock.mockReturnValue(false)
    writeShortcutLinkMock.mockReturnValue(true)

    await ensureDesktopShortcut()

    expect(writeShortcutLinkMock).toHaveBeenCalledTimes(1)
    const shortcutPath = writeShortcutLinkMock.mock.calls[0][0] as string
    expect(shortcutPath).toContain(DEFAULT_DESKTOP)
  })

  it('11. 两个候选路径都不可写时返回 null（跳过创建）', async () => {
    setWindowsPlatform()
    setPackaged(true)
    const regDesktop = 'D:\\OneDrive\\Desktop'
    setRegResult(`\r\n    Desktop    REG_SZ    ${regDesktop}\r\n`)
    // 所有 accessSync 都抛错
    setAccessSyncThrow(true)

    await ensureDesktopShortcut()

    expect(writeShortcutLinkMock).not.toHaveBeenCalled()
    expect(loggerWarnMock).toHaveBeenCalled()
  })

  it('12. 非 Windows 平台跳过注册表查询（execFile 未被调用）', async () => {
    // 模拟 macOS 平台
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    setPackaged(true)
    existsSyncMock.mockReturnValue(false)
    writeShortcutLinkMock.mockReturnValue(true)

    await ensureDesktopShortcut()

    expect(execFileMock).not.toHaveBeenCalled()
    // 仍尝试用 app.getPath('desktop') 创建快捷方式
    expect(writeShortcutLinkMock).toHaveBeenCalledTimes(1)
    const shortcutPath = writeShortcutLinkMock.mock.calls[0][0] as string
    expect(shortcutPath).toContain(DEFAULT_DESKTOP)
  })
})
