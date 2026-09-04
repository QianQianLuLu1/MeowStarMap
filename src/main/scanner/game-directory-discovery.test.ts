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
import {
  findOfficialLauncherGamePaths,
  findSteamGamePaths,
  findEpicGamePaths,
  findGameInstallRootsByPriority,
  getAvailableDrives,
  getUserDataPaths,
  getLastProbeTrail
} from './game-directory-discovery'

// ============ vi.mock：按被测模块实际 import 的模块名整体替换 ============

// 中止标志需在用例间切换：mock scan-abort（被测模块经它读取中止状态，
// 不再从 worker-entry 导入——反向 import 会把看门狗带进主进程 chunk）
const workerState = vi.hoisted(() => ({ aborted: false }))

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

vi.mock('./scan-abort', () => ({
  isScanAborted: () => workerState.aborted,
  abortScan: vi.fn(),
  resetScanAbort: vi.fn()
}))

// ============ 测试脚手架 ============

const mockAccess = vi.mocked(fsp.access)
const mockReadFile = vi.mocked(fsp.readFile)
const mockReaddir = vi.mocked(fsp.readdir)

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
  workerState.aborted = false
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

// ============ findSteamGamePaths ============

describe('findSteamGamePaths（Steam 注册表 + VDF 快速路径）', () => {
  it('注册表成功 + VDF 解析成功 → 校验各库并返回存在 InfinityNikki 的路径', async () => {
    stubExecFile((key) => (key === 'HKCU\\Software\\Valve\\Steam' ? regOutput('C:\\Steam') : null))
    mockReadFile.mockResolvedValue(
      '"0"\n{\n\t"path"\t\t"C:\\\\Steam"\n}\n"1"\n{\n\t"path"\t\t"D:\\\\SteamLibrary"\n}\n'
    )
    // 需求三.2：候选须通过 X6Game 强校验，故桩需放行 ...\InfinityNikki\X6Game
    stubAccess([
      'D:\\SteamLibrary\\steamapps\\common\\InfinityNikki',
      'D:\\SteamLibrary\\steamapps\\common\\InfinityNikki\\X6Game'
    ])

    await expect(findSteamGamePaths()).resolves.toEqual([
      'D:\\SteamLibrary\\steamapps\\common\\InfinityNikki'
    ])
    // 主目录与 VDF 主库路径合并后去重，共校验 2 个库：
    // C:\Steam 目录不存在（1 次） + D: 目录存在 + X6Game 校验（2 次）= 3 次
    expect(mockAccess).toHaveBeenCalledTimes(3)
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
    stubAccess([
      'C:\\Steam\\steamapps\\common\\InfinityNikki',
      'C:\\Steam\\steamapps\\common\\InfinityNikki\\X6Game'
    ])

    await expect(findSteamGamePaths()).resolves.toEqual([
      'C:\\Steam\\steamapps\\common\\InfinityNikki'
    ])
    // 目录存在校验 1 次 + X6Game 强校验 1 次
    expect(mockAccess).toHaveBeenCalledTimes(2)
  })

  it('shouldStop=true → 库校验循环中止，返回空', async () => {
    stubExecFile((key) => (key === 'HKCU\\Software\\Valve\\Steam' ? regOutput('C:\\Steam') : null))
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    workerState.aborted = true

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
    stubAccess(['D:\\AltSteam\\InfinityNikki', 'D:\\AltSteam\\InfinityNikki\\X6Game'])

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
    stubAccess([
      'D:\\SteamLibrary\\steamapps\\common\\InfinityNikki',
      'D:\\SteamLibrary\\steamapps\\common\\InfinityNikki\\X6Game'
    ])

    await expect(findSteamGamePaths()).resolves.toEqual([
      'D:\\SteamLibrary\\steamapps\\common\\InfinityNikki'
    ])
  })

  it('2732520 键缺失/查询失败 → 不抛异常，仅由 libraryfolders 兜底', async () => {
    stubExecFile((key) => (key === 'HKCU\\Software\\Valve\\Steam' ? regOutput('C:\\Steam') : null))
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    stubAccess([
      'C:\\Steam\\steamapps\\common\\InfinityNikki',
      'C:\\Steam\\steamapps\\common\\InfinityNikki\\X6Game'
    ])

    await expect(findSteamGamePaths()).resolves.toEqual([
      'C:\\Steam\\steamapps\\common\\InfinityNikki'
    ])
  })

  it('候选目录存在但缺 X6Game → 强校验拒绝，不返回该目录（需求三.2）', async () => {
    stubExecFile((key) => (key === 'HKCU\\Software\\Valve\\Steam' ? regOutput('C:\\Steam') : null))
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    // 目录存在，但没有 X6Game 子目录
    stubAccess(['C:\\Steam\\steamapps\\common\\InfinityNikki'])

    await expect(findSteamGamePaths()).resolves.toEqual([])
  })
})

// ============ findEpicGamePaths ============

describe('findEpicGamePaths（Epic 注册表快速路径）', () => {
  it('注册表成功 → 校验安装路径并返回存在的 InfinityNikki 目录', async () => {
    stubExecFile((key) =>
      key === 'HKCU\\Software\\Epic Games\\EOS' ? regOutput('D:\\EpicGames') : null
    )
    // 需求三.2：X6Game 强校验
    stubAccess(['D:\\EpicGames\\InfinityNikki', 'D:\\EpicGames\\InfinityNikki\\X6Game'])

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
    workerState.aborted = true

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
    stubAccess(['E:\\EpicGames\\InfinityNikki', 'E:\\EpicGames\\InfinityNikki\\X6Game'])

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

  it('注册表首个键命中（InstallPath=启动器目录）→ 拼接 InfinityNikki 返回游戏根', async () => {
    stubExecFile((key) =>
      key === 'HKCU\\Software\\InfinityNikki Launcher'
        ? regOutput('D:\\Games\\InfinityNikki Launcher')
        : null
    )
    stubAccess(['D:\\Games\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos'])

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual([
      'D:\\Games\\InfinityNikki Launcher\\InfinityNikki'
    ])
    expect(mockAccess).toHaveBeenCalled()
  })

  it('注册表 InstallPath=启动器目录 + 启动器目录 config.game_install_path 直读优先于拼接 InfinityNikki', async () => {
    stubExecFile((key) =>
      key === 'HKCU\\Software\\InfinityNikki Launcher'
        ? regOutput('D:\\Games\\InfinityNikki Launcher')
        : null
    )
    // 启动器目录下的 config.json 直读 game_install_path 指向独立根
    mockReadFile.mockImplementation((p: unknown) => {
      const filePath = String(p)
      if (filePath === 'D:\\Games\\InfinityNikki Launcher\\config.json') {
        return Promise.resolve('{"game_install_path": "E:\\\\CustomGame"}')
      }
      return Promise.reject(new Error('ENOENT'))
    })
    stubAccess([
      'E:\\CustomGame\\X6Game\\Saved\\GamePlayPhotos',
      'D:\\Games\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos'
    ])

    // config 直读优先：返回 E:\CustomGame，而非拼接的 D:\Games\InfinityNikki Launcher\InfinityNikki
    await expect(findOfficialLauncherGamePaths()).resolves.toEqual(['E:\\CustomGame'])
  })

  it('注册表首个键失败 → 尝试下一个键（按优先级顺序）', async () => {
    stubExecFile((key) =>
      key === 'HKLM\\SOFTWARE\\WOW6432Node\\InfinityNikki Launcher'
        ? regOutput('E:\\InfinityNikki')
        : null
    )
    stubAccess(['E:\\InfinityNikki\\InfinityNikki\\X6Game'])

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual([
      'E:\\InfinityNikki\\InfinityNikki'
    ])
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
        return Promise.resolve('{"game": {"installPath": "G:\\\\InfinityNikki"}}')
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

  it('路径验证失败（启动器目录拼接后仍无 X6Game）→ 继续尝试其他候选', async () => {
    stubExecFile((key) =>
      key === 'HKCU\\Software\\InfinityNikki Launcher'
        ? regOutput('X:\\InvalidPath')
        : key === 'HKLM\\SOFTWARE\\WOW6432Node\\InfinityNikki Launcher'
          ? regOutput('Y:\\ValidPath')
          : null
    )
    stubAccess(['Y:\\ValidPath\\InfinityNikki\\X6Game'])

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual(['Y:\\ValidPath\\InfinityNikki'])
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
    workerState.aborted = true

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

  it('启动器命中（注册表 InstallPath=启动器目录）→ 不查询 Steam/Epic 注册表键', async () => {
    // 盘符不可达 → 枚举不命中；启动器注册表首个键命中（InstallPath 视为启动器目录）
    stubExecFile((key) =>
      key === 'HKCU\\Software\\InfinityNikki Launcher'
        ? regOutput('D:\\Games\\InfinityNikki Launcher')
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
    stubAccess([
      'D:\\SteamLibrary\\steamapps\\common\\InfinityNikki',
      'D:\\SteamLibrary\\steamapps\\common\\InfinityNikki\\X6Game'
    ])

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

// ============ 需求三.1 新增定位渠道 ============

describe('需求三.1 新增：盘符模板 / 开始菜单快捷方式 / 探测轨迹', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    savedEnv.LOCALAPPDATA = process.env.LOCALAPPDATA
    savedEnv.APPDATA = process.env.APPDATA
    savedEnv.USERPROFILE = process.env.USERPROFILE
    savedEnv.PUBLIC = process.env.PUBLIC
    savedEnv.ProgramData = process.env.ProgramData
    process.env.LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local'
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
    process.env.USERPROFILE = 'C:\\Users\\tester'
    process.env.PUBLIC = 'C:\\Users\\Public'
    process.env.ProgramData = 'C:\\ProgramData'
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  function stubAllFail(): void {
    stubExecFile(() => null)
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
  }

  it('盘符模板 [盘符]:\\InfinityNikki\\ 命中', async () => {
    stubAllFail()
    mockReaddir.mockRejectedValue(new Error('ENOENT'))
    stubAccess(['D:\\', 'D:\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos'])

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual(['D:\\InfinityNikki'])
  })

  it('盘符模板 [盘符]:\\Games\\InfinityNikki\\ 命中', async () => {
    stubAllFail()
    mockReaddir.mockRejectedValue(new Error('ENOENT'))
    stubAccess(['E:\\', 'E:\\Games\\InfinityNikki\\X6Game'])

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual(['E:\\Games\\InfinityNikki'])
  })

  it('开始菜单快捷方式反向定位命中（中文快捷方式名）', async () => {
    stubAllFail()
    // 开始菜单目录 readdir 返回中文快捷方式；非 .lnk / 非游戏名条目应被过滤
    mockReaddir.mockResolvedValue([
      { name: '无限暖暖.lnk', isDirectory: () => false },
      { name: 'OtherGame.lnk', isDirectory: () => false },
      { name: 'readme.txt', isDirectory: () => false }
    ])
    vi.mocked(execFile).mockImplementation(((
      cmd: string,
      _args: string[],
      _opts: unknown,
      cb: RegCallback
    ) => {
      if (cmd === 'powershell' || cmd === 'pwsh') {
        cb(null, 'H:\\StartMenuGame\\InfinityNikki.exe')
      } else {
        cb(new Error('fail'), '')
      }
    }) as never)
    stubAccess(['H:\\StartMenuGame\\X6Game\\Saved\\GamePlayPhotos'])

    await expect(findOfficialLauncherGamePaths()).resolves.toEqual(['H:\\StartMenuGame'])
  })

  it('getLastProbeTrail：全渠道落空时输出已探测的注册表项与结果（E001 详情）', async () => {
    stubAllFail()
    mockReaddir.mockRejectedValue(new Error('ENOENT'))
    stubAccess([])

    await expect(findGameInstallRootsByPriority()).resolves.toEqual([])
    const trail = getLastProbeTrail()
    expect(trail.length).toBeGreaterThan(0)
    // 官方启动器注册表键被探测且结果为 missing
    const registryProbes = trail.filter((t) => t.source === 'registry')
    expect(registryProbes.some((t) => t.target.includes('InfinityNikki Launcher'))).toBe(true)
    expect(registryProbes.every((t) => t.result === 'missing')).toBe(true)
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
    workerState.aborted = true

    await expect(getUserDataPaths()).resolves.toEqual([])
    expect(mockAccess).not.toHaveBeenCalled()
  })
})
