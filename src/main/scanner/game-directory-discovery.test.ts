/**
 * @layer L1
 * @module src/main/scanner/game-directory-discovery
 * @coverage 注册表快速路径成功/失败降级、VDF 解析成功/读取失败降级、签名目录匹配与上下文校验、
 *           多盘符扫描、单盘异常不影响其他盘、shouldStop 中止契约、用户数据快速通道
 * @dependencies fs / fs/promises / child_process.execFile / tinyglobby.glob 整体 vi.mock
 *               （依赖面太大，整模块 mock 在本场景可接受）；
 *               ./worker-entry 仅桩 shouldStop（getter 模拟 ESM live binding）与 workerLog。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import { execFile } from 'child_process'
import { glob } from 'tinyglobby'
import { workerLog } from './worker-entry'
import {
  searchBySignatureShallow,
  searchByMediaFolderSignatureShallow,
  findOfficialLauncherGamePaths,
  findSteamGamePaths,
  findEpicGamePaths,
  findGameInstallRootsByPriority,
  getAvailableDrives,
  getUserDataPaths
} from './game-directory-discovery'

// ============ vi.mock：按被测模块实际 import 的模块名整体替换 ============

// shouldStop 需在用例间切换：用 hoisted 状态 + getter 模拟 ESM live binding
const workerState = vi.hoisted(() => ({ shouldStop: false }))

vi.mock('fs', () => ({
  default: { constants: { F_OK: 0 } }
}))

vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn()
  }
}))

vi.mock('child_process', () => ({
  execFile: vi.fn()
}))

vi.mock('tinyglobby', () => ({
  glob: vi.fn()
}))

vi.mock('./worker-entry', () => ({
  get shouldStop() {
    return workerState.shouldStop
  },
  workerLog: vi.fn()
}))

// ============ 测试脚手架 ============

const mockAccess = vi.mocked(fsp.access)
const mockReadFile = vi.mocked(fsp.readFile)
const mockReaddir = vi.mocked(fsp.readdir)
const mockGlob = vi.mocked(glob)
const mockWorkerLog = vi.mocked(workerLog)

/** process.platform 强制 win32（被测函数非 win32 直接返回空），afterAll 还原 */
let originalPlatform: PropertyDescriptor | undefined

beforeAll(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})

afterAll(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  workerState.shouldStop = false
})

/** access 桩：仅 allowed 集合内的路径通过，其余 ENOENT */
function stubAccess(allowed: ReadonlySet<string> | string[]): void {
  const set = allowed instanceof Set ? allowed : new Set(allowed)
  mockAccess.mockImplementation((p: unknown) =>
    set.has(p as string) ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
  )
}

type RegCallback = (err: Error | null, stdout: string) => void

/**
 * execFile 桩：按 reg query 的 key 路由响应。
 * responder 返回 null → 该 key 查询失败（回调 err）；返回字符串 → 作为 stdout。
 */
function stubExecFile(responder: (key: string) => string | null): void {
  vi.mocked(execFile).mockImplementation(((
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: RegCallback
  ) => {
    const stdout = responder(args[1])
    if (stdout === null) {
      cb(new Error('reg query failed'), '')
    } else {
      cb(null, stdout)
    }
  }) as never)
}

/** 构造 reg query 成功输出（REG_SZ 行） */
function regOutput(value: string): string {
  return `HKEY_X\\SomeKey\n    ValueName    REG_SZ    ${value}\n`
}

// ============ searchBySignatureShallow ============

describe('searchBySignatureShallow（游戏 exe 签名浅层搜索）', () => {
  it('命中签名 → 返回排序后首个匹配文件所在目录', async () => {
    mockGlob.mockResolvedValue([
      'D:\\Games\\InfinityNikki\\InfinityNikki.exe',
      'C:\\Other\\Launcher.exe'
    ])

    const result = await searchBySignatureShallow('D:\\', 4)

    expect(result).toBe('C:\\Other')
    expect(mockGlob).toHaveBeenCalledTimes(1)
    const [pattern, options] = mockGlob.mock.calls[0]
    expect(pattern).toContain('InfinityNikki.exe')
    expect(pattern).toContain('Launcher.exe')
    expect(options).toMatchObject({
      cwd: 'D:\\',
      absolute: true,
      onlyFiles: true,
      deep: 4,
      caseSensitiveMatch: false,
      followSymbolicLinks: false
    })
  })

  it('无命中 → 返回 null', async () => {
    mockGlob.mockResolvedValue([])

    await expect(searchBySignatureShallow('E:\\', 3)).resolves.toBeNull()
  })

  it('glob 抛错 → 降级返回 null 且记录 warn（单盘异常不中断整体扫描）', async () => {
    mockGlob.mockRejectedValue(new Error('EBUSY'))

    await expect(searchBySignatureShallow('F:\\', 3)).resolves.toBeNull()
    expect(mockWorkerLog).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('游戏 exe 签名 glob 失败'),
      'EBUSY'
    )
  })
})

// ============ searchByMediaFolderSignatureShallow ============

describe('searchByMediaFolderSignatureShallow（媒体文件夹签名浅层搜索）', () => {
  it('返回命中目录的父目录，同父目录去重，ScreenShot 需游戏上下文校验', async () => {
    mockGlob.mockResolvedValue([
      'D:\\Game\\X6Game\\Saved\\GamePlayPhotos\\uid1\\NikkiPhotos_HighQuality',
      'D:\\Game\\X6Game\\Saved\\GamePlayPhotos\\uid1\\NikkiPhotos_LowQuality',
      'D:\\Game\\X6Game\\ScreenShot',
      'D:\\Tools\\WarThunder\\ScreenShot'
    ])

    const result = await searchByMediaFolderSignatureShallow('D:\\', 8)

    // 同父目录两个相册签名去重为 1；X6Game 下 ScreenShot 保留；非游戏上下文 ScreenShot 剔除
    expect(result).toEqual(['D:\\Game\\X6Game\\Saved\\GamePlayPhotos\\uid1', 'D:\\Game\\X6Game'])
    const [pattern, options] = mockGlob.mock.calls[0]
    expect(pattern).toContain('NikkiPhotos_HighQuality')
    expect(options).toMatchObject({ onlyDirectories: true, deep: 8 })
  })

  it('Video 签名命中 X6Game\\Video 且出现在 glob 搜索 pattern 中', async () => {
    mockGlob.mockResolvedValue([
      'D:\\Game\\X6Game\\Video',
      'D:\\Game\\X6Game\\ScreenShot',
      'D:\\Tools\\OtherGame\\Video'
    ])

    const result = await searchByMediaFolderSignatureShallow('D:\\', 8)

    // X6Game 下的 Video/ScreenShot 保留（合并到同一父目录 X6Game），非游戏上下文 Video 剔除
    expect(result).toEqual(['D:\\Game\\X6Game'])
    const [pattern] = mockGlob.mock.calls[0]
    expect(pattern).toContain('Video')
  })

  it('glob 抛错 → 降级返回空数组且记录 warn', async () => {
    mockGlob.mockRejectedValue(new Error('EPERM'))

    await expect(searchByMediaFolderSignatureShallow('G:\\', 5)).resolves.toEqual([])
    expect(mockWorkerLog).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('媒体文件夹签名 glob 失败'),
      'EPERM'
    )
  })
})

// ============ findSteamGamePaths ============

describe('findSteamGamePaths（Steam 注册表 + VDF 快速路径）', () => {
  it('注册表成功 + VDF 解析成功 → 校验各库并返回存在 InfinityNikki 的路径', async () => {
    stubExecFile((key) => (key === 'HKCU\\Software\\Valve\\Steam' ? regOutput('C:\\Steam') : null))
    mockReadFile.mockResolvedValue(
      '"0"\n{\n\t"path"\t\t"C:\\\\Steam"\n}\n"1"\n{\n\t"path"\t\t"D:\\\\SteamLibrary"\n}\n'
    )
    stubAccess(['D:\\SteamLibrary\\steamapps\\common\\InfinityNikki'])

    await expect(findSteamGamePaths()).resolves.toEqual([
      'D:\\SteamLibrary\\steamapps\\common\\InfinityNikki'
    ])
    // 主目录与 VDF 主库路径合并后去重，共校验 2 个库
    expect(mockAccess).toHaveBeenCalledTimes(2)
  })

  it('注册表全部失败 → 返回空数组（不读 VDF、不校验库）', async () => {
    stubExecFile(() => null)

    await expect(findSteamGamePaths()).resolves.toEqual([])
    expect(mockReadFile).not.toHaveBeenCalled()
    expect(mockAccess).not.toHaveBeenCalled()
  })

  it('VDF 读取失败 → 降级仅用 Steam 主目录兜底', async () => {
    stubExecFile((key) =>
      key === 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam' ? regOutput('C:\\Steam') : null
    )
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    stubAccess(['C:\\Steam\\steamapps\\common\\InfinityNikki'])

    await expect(findSteamGamePaths()).resolves.toEqual([
      'C:\\Steam\\steamapps\\common\\InfinityNikki'
    ])
    expect(mockAccess).toHaveBeenCalledTimes(1)
  })

  it('shouldStop=true → 库校验循环中止，返回空', async () => {
    stubExecFile((key) => (key === 'HKCU\\Software\\Valve\\Steam' ? regOutput('C:\\Steam') : null))
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    workerState.shouldStop = true

    await expect(findSteamGamePaths()).resolves.toEqual([])
    expect(mockAccess).not.toHaveBeenCalled()
  })

  it('Steam App 2732520 卸载键 InstallLocation 命中（libraryfolders 无结果时仍返回）', async () => {
    stubExecFile((key) =>
      key === 'HKCU\\Software\\Valve\\Steam'
        ? regOutput('C:\\Steam')
        : key === 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 2732520'
          ? regOutput('D:\\AltSteam\\InfinityNikki')
          : null
    )
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    stubAccess(['D:\\AltSteam\\InfinityNikki'])

    await expect(findSteamGamePaths()).resolves.toEqual(['D:\\AltSteam\\InfinityNikki'])
  })

  it('libraryfolders 与 2732520 键指向同一路径 → 去重为 1 条', async () => {
    stubExecFile((key) =>
      key === 'HKCU\\Software\\Valve\\Steam'
        ? regOutput('C:\\Steam')
        : key === 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 2732520'
          ? regOutput('D:\\SteamLibrary\\steamapps\\common\\InfinityNikki')
          : null
    )
    mockReadFile.mockResolvedValue('"0"\n{\n\t"path"\t\t"D:\\\\SteamLibrary"\n}\n')
    stubAccess(['D:\\SteamLibrary\\steamapps\\common\\InfinityNikki'])

    await expect(findSteamGamePaths()).resolves.toEqual([
      'D:\\SteamLibrary\\steamapps\\common\\InfinityNikki'
    ])
  })

  it('2732520 键缺失/查询失败 → 不抛异常，仅由 libraryfolders 兜底', async () => {
    stubExecFile((key) => (key === 'HKCU\\Software\\Valve\\Steam' ? regOutput('C:\\Steam') : null))
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    stubAccess(['C:\\Steam\\steamapps\\common\\InfinityNikki'])

    await expect(findSteamGamePaths()).resolves.toEqual([
      'C:\\Steam\\steamapps\\common\\InfinityNikki'
    ])
  })
})

// ============ findEpicGamePaths ============

describe('findEpicGamePaths（Epic 注册表快速路径）', () => {
  it('注册表成功 → 校验安装路径并返回存在的 InfinityNikki 目录', async () => {
    stubExecFile((key) =>
      key === 'HKCU\\Software\\Epic Games\\EOS' ? regOutput('D:\\EpicGames') : null
    )
    stubAccess(['D:\\EpicGames\\InfinityNikki'])

    await expect(findEpicGamePaths()).resolves.toEqual(['D:\\EpicGames\\InfinityNikki'])
  })

  it('注册表全部失败 → 返回空数组', async () => {
    stubExecFile(() => null)

    await expect(findEpicGamePaths()).resolves.toEqual([])
    expect(mockAccess).not.toHaveBeenCalled()
  })

  it('shouldStop=true → 路径校验循环中止，返回空', async () => {
    stubExecFile((key) =>
      key === 'HKCU\\Software\\Epic Games\\EOS' ? regOutput('D:\\EpicGames') : null
    )
    workerState.shouldStop = true

    await expect(findEpicGamePaths()).resolves.toEqual([])
    expect(mockAccess).not.toHaveBeenCalled()
  })

  it('Epic 清单文件 InstallLocation 命中（注册表失败时仍返回）', async () => {
    stubExecFile(() => null)
    mockReaddir.mockResolvedValue(['InfinityNikki.item'])
    mockReadFile.mockImplementation((p: unknown) =>
      String(p).includes('InfinityNikki.item')
        ? Promise.resolve(JSON.stringify({ InstallLocation: 'E:\\EpicGames\\InfinityNikki' }))
        : Promise.reject(new Error('ENOENT'))
    )
    stubAccess(['E:\\EpicGames\\InfinityNikki'])

    await expect(findEpicGamePaths()).resolves.toEqual(['E:\\EpicGames\\InfinityNikki'])
  })

  it('清单 InstallLocation 非 InfinityNikki → 忽略', async () => {
    stubExecFile(() => null)
    mockReaddir.mockResolvedValue(['OtherGame.item'])
    mockReadFile.mockImplementation((p: unknown) =>
      String(p).includes('OtherGame.item')
        ? Promise.resolve(JSON.stringify({ InstallLocation: 'C:\\Games\\OtherGame' }))
        : Promise.reject(new Error('ENOENT'))
    )
    stubAccess([])

    await expect(findEpicGamePaths()).resolves.toEqual([])
  })

  it('清单目录不存在（readdir 失败）→ 降级返回空，不抛异常', async () => {
    stubExecFile(() => null)
    mockReaddir.mockRejectedValue(new Error('ENOENT'))
    stubAccess([])

    await expect(findEpicGamePaths()).resolves.toEqual([])
  })
})

// ============ findOfficialLauncherGamePaths ============

describe('findOfficialLauncherGamePaths（官方启动器三重检测）', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    savedEnv.LOCALAPPDATA = process.env.LOCALAPPDATA
    savedEnv.APPDATA = process.env.APPDATA
    savedEnv.USERPROFILE = process.env.USERPROFILE
    savedEnv.PUBLIC = process.env.PUBLIC
    process.env.LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local'
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
    process.env.USERPROFILE = 'C:\\Users\\tester'
    process.env.PUBLIC = 'C:\\Users\\Public'
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('注册表首个键命中 + 路径验证通过 → 返回验证后的路径', async () => {
    stubExecFile((key) =>
      key === 'HKCU\\Software\\InfinityNikki Launcher'
        ? regOutput('D:\\Games\\InfinityNikki Launcher\\InfinityNikki')
        : null
    )
    stubAccess(['D:\\Games\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos'])

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual([
      'D:\\Games\\InfinityNikki Launcher\\InfinityNikki'
    ])
    // 首个键命中后不应继续查询后续键（枚举阶段会先探测盘符，故仅断言确实发生过校验）
    expect(mockAccess).toHaveBeenCalled()
  })

  it('注册表首个键失败 → 尝试下一个键（按优先级顺序）', async () => {
    stubExecFile((key) =>
      key === 'HKLM\\SOFTWARE\\WOW6432Node\\InfinityNikki Launcher'
        ? regOutput('E:\\InfinityNikki')
        : null
    )
    stubAccess(['E:\\InfinityNikki\\X6Game'])

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual(['E:\\InfinityNikki'])
  })

  it('注册表全部失败 → 降级到配置文件解析（INI 格式）', async () => {
    stubExecFile(() => null)
    mockReadFile.mockImplementation((p: unknown) => {
      if (p === 'C:\\Users\\tester\\AppData\\Local\\InfinityNikki Launcher\\config.ini') {
        return Promise.resolve('[Game]\nInstallPath=F:\\Games\\InfinityNikki\n')
      }
      return Promise.reject(new Error('ENOENT'))
    })
    stubAccess(['F:\\Games\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos'])

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual(['F:\\Games\\InfinityNikki'])
  })

  it('注册表全部失败 → 降级到配置文件解析（JSON 格式）', async () => {
    stubExecFile(() => null)
    mockReadFile.mockImplementation((p: unknown) => {
      const filePath = String(p)
      if (filePath.includes('settings.json')) {
        return Promise.resolve('{"game": {"installPath": "G:\\InfinityNikki"}}')
      }
      return Promise.reject(new Error('ENOENT'))
    })
    stubAccess(['G:\\InfinityNikki\\X6Game'])

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual(['G:\\InfinityNikki'])
  })

  it('注册表+配置文件均失败 → 降级到快捷方式解析', async () => {
    stubExecFile(() => null)
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    // PowerShell 解析快捷方式：第一个参数是命令名，第二个是 args 数组
    vi.mocked(execFile).mockImplementation(((
      cmd: string,
      _args: string[],
      _opts: unknown,
      cb: RegCallback
    ) => {
      // 模拟 powershell 输出快捷方式目标路径
      if (cmd === 'powershell' || cmd === 'pwsh') {
        cb(null, 'H:\\InfinityNikki\\InfinityNikki.exe')
      } else {
        cb(new Error('reg query failed'), '')
      }
    }) as never)
    stubAccess(['H:\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos'])

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual(['H:\\InfinityNikki'])
  })

  it('路径验证失败（GamePlayPhotos 和 X6Game 都不存在）→ 继续尝试其他候选', async () => {
    stubExecFile((key) =>
      key === 'HKCU\\Software\\InfinityNikki Launcher'
        ? regOutput('X:\\InvalidPath')
        : key === 'HKLM\\SOFTWARE\\WOW6432Node\\InfinityNikki Launcher'
          ? regOutput('Y:\\ValidPath')
          : null
    )
    stubAccess(['Y:\\ValidPath\\X6Game'])

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual(['Y:\\ValidPath'])
  })

  it('所有检测方式均失败 → 返回空数组', async () => {
    stubExecFile(() => null)
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    // PowerShell 也失败
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: RegCallback
    ) => {
      cb(new Error('File not found'), '')
    }) as never)

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual([])
  })

  it('shouldStop=true → 检测中止，返回空数组', async () => {
    workerState.shouldStop = true

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual([])
    expect(mockAccess).not.toHaveBeenCalled()
  })

  it('非 Windows 平台 → 直接返回空数组', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual([])
    expect(mockAccess).not.toHaveBeenCalled()

    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })
})

// ============ 常见安装路径枚举（Subtask A 增补） ============

describe('findOfficialLauncherGamePaths - 常见安装路径枚举（C: 及自定义盘符变体）', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    savedEnv.LOCALAPPDATA = process.env.LOCALAPPDATA
    savedEnv.APPDATA = process.env.APPDATA
    savedEnv.USERPROFILE = process.env.USERPROFILE
    savedEnv.PUBLIC = process.env.PUBLIC
    process.env.LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local'
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
    process.env.USERPROFILE = 'C:\\Users\\tester'
    process.env.PUBLIC = 'C:\\Users\\Public'
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  function stubPowershellFail(): void {
    vi.mocked(execFile).mockImplementation(((
      _c: string,
      _a: string[],
      _o: unknown,
      cb: RegCallback
    ) => cb(new Error('fail'), '')) as never)
  }

  it('枚举命中 C:\\Program Files\\InfinityNikki Launcher\\InfinityNikki（注册表/配置/快捷方式均失败）', async () => {
    // 仅允许 C: 盘符 + 候选根下的 GamePlayPhotos，使 getAvailableDrives 返回 ['C:\\'] 且枚举命中
    stubAccess([
      'C:\\',
      'C:\\Program Files\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos'
    ])
    stubExecFile(() => null)
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    stubPowershellFail()

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual([
      'C:\\Program Files\\InfinityNikki Launcher\\InfinityNikki'
    ])
  })

  it('自定义盘符变体 D:\\Program Files\\InfinityNikki Launcher\\InfinityNikki 命中', async () => {
    stubAccess(['D:\\', 'D:\\Program Files\\InfinityNikki Launcher\\InfinityNikki\\X6Game'])
    stubExecFile(() => null)
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    stubPowershellFail()

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual([
      'D:\\Program Files\\InfinityNikki Launcher\\InfinityNikki'
    ])
  })

  it('盘符下无游戏根（validateGameRoot 拒绝）→ 枚举不命中，注册表也失败 → 返回空', async () => {
    // 允许 C: 盘符可达，但候选根下无 X6Game/GamePlayPhotos → 枚举落空
    stubAccess(['C:\\'])
    stubExecFile(() => null)
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    stubPowershellFail()

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual([])
  })

  it('自定义盘符根直接安装 D:\\InfinityNikki Launcher\\InfinityNikki（无 Program Files 前缀）命中', async () => {
    // 仅允许 D: 盘符 + 盘符根变体候选下的 X6Game，使枚举命中 spec 一.1 第 3 变体
    stubAccess(['D:\\', 'D:\\InfinityNikki Launcher\\InfinityNikki\\X6Game'])
    stubExecFile(() => null)
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    stubPowershellFail()

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual([
      'D:\\InfinityNikki Launcher\\InfinityNikki'
    ])
  })
})

// ============ findGameInstallRootsByPriority（Subtask B 优先级解析） ============

describe('findGameInstallRootsByPriority（启动器 > Steam > Epic，命中即止）', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    savedEnv.LOCALAPPDATA = process.env.LOCALAPPDATA
    savedEnv.APPDATA = process.env.APPDATA
    savedEnv.USERPROFILE = process.env.USERPROFILE
    savedEnv.PUBLIC = process.env.PUBLIC
    process.env.LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local'
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
    process.env.USERPROFILE = 'C:\\Users\\tester'
    process.env.PUBLIC = 'C:\\Users\\Public'
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('启动器命中（注册表）→ 不查询 Steam/Epic 注册表键', async () => {
    // 盘符不可达 → 枚举不命中；启动器注册表首个键命中
    stubExecFile((key) =>
      key === 'HKCU\\Software\\InfinityNikki Launcher'
        ? regOutput('D:\\Games\\InfinityNikki Launcher\\InfinityNikki')
        : null
    )
    stubAccess(['D:\\Games\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos'])

    const result = await findGameInstallRootsByPriority()
    expect(result).toEqual(['D:\\Games\\InfinityNikki Launcher\\InfinityNikki'])
    const calledKeys = vi.mocked(execFile).mock.calls.map((c) => c[1][1])
    expect(calledKeys.some((k) => k.includes('Valve\\Steam'))).toBe(false)
    expect(calledKeys.some((k) => k.includes('Epic'))).toBe(false)
  })

  it('启动器失败 → 降级 Steam 命中（不查询 Epic）', async () => {
    stubExecFile((key) => {
      if (key === 'HKCU\\Software\\Valve\\Steam') return regOutput('C:\\Steam')
      return null
    })
    mockReadFile.mockResolvedValue(
      '"0"\n{\n\t"path"\t\t"C:\\\\Steam"\n}\n"1"\n{\n\t"path"\t\t"D:\\\\SteamLibrary"\n}\n'
    )
    stubAccess(['D:\\SteamLibrary\\steamapps\\common\\InfinityNikki'])

    const result = await findGameInstallRootsByPriority()
    expect(result).toEqual(['D:\\SteamLibrary\\steamapps\\common\\InfinityNikki'])
    const calledKeys = vi.mocked(execFile).mock.calls.map((c) => c[1][1])
    expect(calledKeys.some((k) => k.includes('Epic'))).toBe(false)
  })

  it('三渠道全失败 → 返回空数组，且 Steam/Epic 注册表键均被查询（证明降级发生）', async () => {
    stubExecFile(() => null)
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    stubAccess([])

    const result = await findGameInstallRootsByPriority()
    expect(result).toEqual([])
    const calledKeys = vi.mocked(execFile).mock.calls.map((c) => c[1][1])
    expect(calledKeys.some((k) => k.includes('Valve\\Steam'))).toBe(true)
    expect(calledKeys.some((k) => k.includes('Epic'))).toBe(true)
  })
})

// ============ getAvailableDrives ============

describe('getAvailableDrives（盘符枚举）', () => {
  it('多盘符扫描：仅返回 access 通过的盘符，单盘异常不影响其他盘', async () => {
    // D: access 直接抛异常（模拟设备错误），C:/E: 正常，其余盘不存在
    mockAccess.mockImplementation((p: unknown) => {
      if (p === 'D:\\') return Promise.reject(new Error('EIO'))
      if (p === 'C:\\' || p === 'E:\\') return Promise.resolve()
      return Promise.reject(new Error('ENOENT'))
    })

    await expect(getAvailableDrives()).resolves.toEqual(['C:\\', 'E:\\'])
    // C-Z 全量探测 24 次
    expect(mockAccess).toHaveBeenCalledTimes(24)
  })
})

// ============ getUserDataPaths ============

describe('getUserDataPaths（用户数据快速通道）', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    savedEnv.LOCALAPPDATA = process.env.LOCALAPPDATA
    savedEnv.USERPROFILE = process.env.USERPROFILE
    savedEnv.HOME = process.env.HOME
    delete process.env.HOME
    process.env.LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local'
    process.env.USERPROFILE = 'C:\\Users\\tester'
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('存在且非空的目录入选；不存在或空目录被剔除', async () => {
    const localAppData = 'C:\\Users\\tester\\AppData\\Local'
    const gameData = `${localAppData}\\InfinityNikki`
    const launcherCache = `${localAppData}\\InfinityNikki Launcher\\cache\\images`
    const globalCache = `${localAppData}\\InfinityNikkiGlobal Launcher\\cache\\images`
    const docs = 'C:\\Users\\tester\\Documents\\InfinityNikki'

    stubAccess([gameData, launcherCache, globalCache, docs])
    mockReaddir.mockImplementation((p: unknown) =>
      p === launcherCache ? Promise.resolve([]) : Promise.resolve(['a.png'])
    )

    // launcherCache 存在但为空目录 → 剔除；其余存在且非空 → 入选
    await expect(getUserDataPaths()).resolves.toEqual([gameData, globalCache, docs])
    expect(mockAccess).toHaveBeenCalledTimes(4)
  })

  it('LOCALAPPDATA/USERPROFILE/HOME 均缺失 → 无候选，返回空数组', async () => {
    delete process.env.LOCALAPPDATA
    delete process.env.USERPROFILE
    delete process.env.HOME

    await expect(getUserDataPaths()).resolves.toEqual([])
    expect(mockAccess).not.toHaveBeenCalled()
  })

  it('shouldStop=true → 候选校验循环中止，返回空', async () => {
    workerState.shouldStop = true

    await expect(getUserDataPaths()).resolves.toEqual([])
    expect(mockAccess).not.toHaveBeenCalled()
  })
})
