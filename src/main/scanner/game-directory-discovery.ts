/**
 * 游戏媒体目录发现（注册表快速路径 + 有限盘符枚举兜底）。
 *
 * 从 worker-entry.ts 抽取为独立模块，目的：
 * - 便于单元测试：测试可用 vi.mock('../game-directory-discovery') 桩替换全部发现函数，避免真实盘符/注册表 IO；
 * - 保持 worker-entry.ts 的 findMediaDirectories 契约不变（返回 string[]），调用方无感。
 *
 * 共享依赖（shouldStop / workerLog）从 worker-entry 导入均为"调用期"使用，
 * 循环依赖在 ESM 下安全（模块求值期不读取这些绑定）。
 *
 * 依赖（五要素）：
 * - 依赖声明：仅复用 fs / fs.promises / path / child_process / '../utils/concurrency' / '../utils/constants' / worker-entry，
 *   不新增任何 npm 包 / IPC 通道 / 数据库表。
 * - 启动说明：无副作用，纯函数集合，导入即就绪。
 * - 错误处理：单盘遍历异常 / vdf 读取失败 / 注册表查询失败均降级返回空，由其他路径/盘符兜底，不中断整体扫描。
 * - 参数校验：querySteamInstallPath / getUserDataPaths 对 process.env 缺失做兜底（空串→空结果）。
 * - 基础测试：见 __tests__/worker-entry.findMediaDirectories.test.ts（桩替换本模块）。
 */
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { execFile } from 'child_process'

import { DRIVE_LETTER_START, DRIVE_LETTER_END } from '../utils/constants'
// 循环依赖：以下绑定仅在函数体内（调用期）读取，模块求值期不访问，ESM 安全
import { shouldStop } from './worker-entry'
import { sendScanLogEntry } from './scan-logger'
import { classifyFsError } from './scan-log-store'

// 游戏快捷方式文件名（中文）
// eslint-disable-next-line no-restricted-syntax
const GAME_SHORTCUT_CN = '\u65e0\u9650\u6696\u6696.lnk'

// ============ 官方启动器检测常量 ============

/**
 * 官方启动器注册表候选键（按优先级排序）
 * 覆盖常见安装位置：用户级/机器级/卸载信息/国际服变体
 */
const OFFICIAL_LAUNCHER_REG_KEYS: Array<{
  key: string
  value: string
  /** 诊断阶段标签，用于全链路时间线节点命名 */
  stage: string
  /** true=强制 64 位注册表视图（KEY_WOW64_64KEY 等效），绕过 WOW64 32 位重定向 */
  use64Bit?: boolean
}> = [
  // 官方启动器：优先读当前用户 HKCU（无 WOW64 重定向问题）
  {
    key: 'HKCU\\Software\\InfinityNikki Launcher',
    value: 'InstallPath',
    stage: 'registry-hkcu'
  },
  // HKLM 64 位视图（KEY_WOW64_64KEY）：官方启动器 64 位安装主路径
  {
    key: 'HKLM\\SOFTWARE\\InfinityNikki Launcher',
    value: 'InstallPath',
    stage: 'registry-hklm64',
    use64Bit: true
  },
  // HKLM 32 位视图兜底（WOW6432Node）：仅当 64 位视图查不到时回退
  {
    key: 'HKLM\\SOFTWARE\\WOW6432Node\\InfinityNikki Launcher',
    value: 'InstallPath',
    stage: 'registry-hklm32'
  },
  // 卸载信息中的安装位置（用户级）
  {
    key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\InfinityNikki',
    value: 'InstallLocation',
    stage: 'registry-uninstall-hkcu'
  },
  // 卸载信息中的安装位置（机器级 64 位视图）
  {
    key: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\InfinityNikki',
    value: 'InstallLocation',
    stage: 'registry-uninstall-hklm64',
    use64Bit: true
  },
  {
    key: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\InfinityNikki',
    value: 'InstallLocation'
  },
  // 国际服变体
  { key: 'HKCU\\Software\\InfinityNikkiGlobal Launcher', value: 'InstallPath' },
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\InfinityNikkiGlobal Launcher', value: 'InstallPath' }
]

/**
 * 启动器配置文件候选路径（环境变量展开）
 * 注册表检测失败时的辅助路径
 */
function getLauncherConfigCandidates(): string[] {
  const candidates: string[] = []
  const localAppData = process.env.LOCALAPPDATA || ''
  const appData = process.env.APPDATA || ''

  if (localAppData) {
    candidates.push(path.join(localAppData, 'InfinityNikki Launcher', 'config.ini'))
    candidates.push(path.join(localAppData, 'InfinityNikki Launcher', 'settings.json'))
  }
  if (appData) {
    candidates.push(path.join(appData, 'InfinityNikki Launcher', 'config.ini'))
    candidates.push(path.join(appData, 'InfinityNikki Launcher', 'settings.json'))
  }
  return candidates
}

/**
 * 桌面快捷方式候选路径（环境变量展开）
 * 配置文件解析失败时的兜底路径
 */
function getShortcutCandidates(): string[] {
  const candidates: string[] = []
  const userProfile = process.env.USERPROFILE || ''
  const publicDir = process.env.PUBLIC || ''

  if (userProfile) {
    candidates.push(path.join(userProfile, 'Desktop', GAME_SHORTCUT_CN))
    candidates.push(path.join(userProfile, 'Desktop', 'InfinityNikki.lnk'))
  }
  if (publicDir) {
    candidates.push(path.join(publicDir, 'Desktop', GAME_SHORTCUT_CN))
    candidates.push(path.join(publicDir, 'Desktop', 'InfinityNikki.lnk'))
  }
  return candidates
}

/**
 * 官方启动器常见安装路径枚举（自定义盘符变体）
 *
 * 覆盖用户明确要求枚举的「常见安装路径」：
 * `C:\Program Files\InfinityNikki Launcher\InfinityNikki\` 及自定义盘符变体
 * （D:–Z: 由 DRIVE_LETTER_START/END 约束），以及 `Program Files (x86)` 变体。
 * 仅枚举本机实际可达的盘符（getAvailableDrives）以限制 IO，避免对不存在盘符做无谓 access。
 * 返回未经 validateGameRoot 校验的候选根目录；调用方须对每个候选做校验后入库。
 */
async function getCommonLauncherInstallCandidates(): Promise<string[]> {
  const candidates: string[] = []
  const drives = await getAvailableDrives()
  const programFilesRoots = ['Program Files', 'Program Files (x86)']
  for (const drive of drives) {
    for (const pf of programFilesRoots) {
      candidates.push(path.join(drive, pf, 'InfinityNikki Launcher', 'InfinityNikki'))
    }
    // spec 第 3 变体：自定义盘符根直接安装（无 Program Files 前缀），如 D:\InfinityNikki Launcher\InfinityNikki\
    candidates.push(path.join(drive, 'InfinityNikki Launcher', 'InfinityNikki'))
  }
  return candidates
}

// ============ 官方启动器检测函数 ============

/**
 * 通过官方启动器注册表查找游戏安装路径（P0，最高优先级）
 *
 * 三重检测策略（按优先级）：
 * 1. 注册表检测：枚举 8 个候选键，按优先级顺序尝试
 * 2. 配置文件解析：INI/JSON 格式，支持 InstallPath 字段
 * 3. 快捷方式反向定位：PowerShell 解析 .lnk 目标路径
 *
 * 所有候选路径必须经过 validateGameRoot 验证后才返回。
 * 非 Windows 平台直接返回空数组。
 *
 * @returns 游戏根目录路径数组（通常 0 或 1 个）
 */
export async function findOfficialLauncherGamePaths(): Promise<string[]> {
  if (process.platform !== 'win32') return []

  const validatedPaths: string[] = []
  const seenPaths = new Set<string>()

  // 0. 常见安装路径枚举（最高优先级补充源）：C:\Program Files\InfinityNikki Launcher\InfinityNikki\
  //    及自定义盘符变体 + Program Files (x86) 变体；每个候选经 validateGameRoot 校验后入库。
  if (!shouldStop) {
    for (const candidate of await getCommonLauncherInstallCandidates()) {
      if (shouldStop) break
      const validated = await validateGameRoot(candidate)
      if (validated && !seenPaths.has(validated.toLowerCase())) {
        seenPaths.add(validated.toLowerCase())
        validatedPaths.push(validated)
        // 枚举命中即返回（官方启动器最高优先级，不继续尝试注册表/配置/快捷方式）
        return validatedPaths
      }
    }
  }

  // 1. 注册表检测（主路径）
  // 规范一.1：注册表 InstallPath 视为"启动器目录"，游戏根 = 启动器目录 + InfinityNikki，
  // 或启动器目录下 config.json / game_settings.ini 的 game_install_path（优先）。
  for (const { key, value, stage, use64Bit } of OFFICIAL_LAUNCHER_REG_KEYS) {
    if (shouldStop) break
    // 全链路诊断：[注册表] 节点——区分路径不存在 / 权限 / 其他
    sendScanLogEntry({
      stage,
      level: 'info',
      message: `读取注册表：${key} / ${value}${use64Bit ? ' (force 64-bit view)' : ''}`
    })
    const launcherPath = await queryRegistryValue(key, value, { use64BitView: use64Bit })
    if (!launcherPath) {
      sendScanLogEntry({
        stage,
        level: 'warn',
        kind: 'path-missing',
        message: `注册表项不存在或无 InstallPath：${key}`
      })
      continue
    }
    sendScanLogEntry({
      stage,
      level: 'info',
      kind: 'ok',
      message: `注册表读取成功，启动器目录：${launcherPath}`,
      detail: { key, launcherPath }
    })

    // 候选 A：启动器目录下配置文件直读 game_install_path（config.json / game_settings.ini / settings.json / config.ini）
    const configCandidates = [
      path.join(launcherPath, 'config.json'),
      path.join(launcherPath, 'game_settings.ini'),
      path.join(launcherPath, 'settings.json'),
      path.join(launcherPath, 'config.ini')
    ]
    let resolvedFromConfig = false
    for (const cfg of configCandidates) {
      // 全链路诊断：[配置文件] 节点
      sendScanLogEntry({ stage: 'config', level: 'info', message: `解析配置文件：${cfg}` })
      const cfgRoot = await parseLauncherConfig(cfg)
      if (cfgRoot) {
        sendScanLogEntry({
          stage: 'config',
          level: 'info',
          kind: 'ok',
          message: `配置文件读取游戏路径：${cfgRoot}`,
          detail: { cfg, cfgRoot }
        })
        const validated = await validateGameRoot(cfgRoot)
        if (validated && !seenPaths.has(validated.toLowerCase())) {
          seenPaths.add(validated.toLowerCase())
          validatedPaths.push(validated)
          resolvedFromConfig = true
          break
        }
      } else {
        sendScanLogEntry({
          stage: 'config',
          level: 'warn',
          kind: 'path-missing',
          message: `配置文件无有效 game_install_path：${cfg}`
        })
      }
    }
    if (resolvedFromConfig) return validatedPaths

    // 候选 B：启动器目录 + InfinityNikki（规范一.1.3 兜底）
    // 全链路诊断：[路径拼接] 节点——必须拼接一层 \InfinityNikki 才是游戏根
    const inferredRoot = path.join(launcherPath, 'InfinityNikki')
    sendScanLogEntry({
      stage: 'path-join',
      level: 'info',
      message: `拼接游戏根目录（启动器目录 + \\InfinityNikki）：${inferredRoot}`
    })
    const validatedInferred = await validateGameRoot(inferredRoot)
    if (validatedInferred && !seenPaths.has(validatedInferred.toLowerCase())) {
      seenPaths.add(validatedInferred.toLowerCase())
      validatedPaths.push(validatedInferred)
      return validatedPaths
    }
  }

  // 2. 配置文件解析（辅助路径）
  for (const configPath of getLauncherConfigCandidates()) {
    if (shouldStop) break
    const configInstallPath = await parseLauncherConfig(configPath)
    if (configInstallPath) {
      const validated = await validateGameRoot(configInstallPath)
      if (validated && !seenPaths.has(validated.toLowerCase())) {
        seenPaths.add(validated.toLowerCase())
        validatedPaths.push(validated)
        return validatedPaths
      }
    }
  }

  // 3. 快捷方式反向定位（兜底）
  for (const shortcutPath of getShortcutCandidates()) {
    if (shouldStop) break
    const targetPath = await resolveShortcutTarget(shortcutPath)
    if (targetPath) {
      // 快捷方式指向的是 exe，取其父目录作为候选根
      const candidateRoot = path.dirname(targetPath)
      const validated = await validateGameRoot(candidateRoot)
      if (validated && !seenPaths.has(validated.toLowerCase())) {
        seenPaths.add(validated.toLowerCase())
        validatedPaths.push(validated)
        return validatedPaths
      }
    }
  }

  return validatedPaths
}

/**
 * 查询 Windows 注册表键值
 * @param key 注册表键路径（如 HKCU\Software\...）
 * @param value 值名称（如 InstallPath）
 * @param opts.use64BitView 为 true 时显式调用 64 位 reg.exe（C:\Windows\System32\reg.exe），
 *   等价 KEY_WOW64_64KEY，强制访问 64 位注册表视图，绕过 WOW64 32 位重定向。
 * @returns 注册表值字符串，失败时返回 null
 */
async function queryRegistryValue(
  key: string,
  value: string,
  opts?: { use64BitView?: boolean }
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    try {
      // 默认用 PATH 中的 reg；强制 64 位视图时直接用 System32 下的 64 位 reg.exe
      const regCmd = opts?.use64BitView ? 'C:\\Windows\\System32\\reg.exe' : 'reg'
      execFile(
        regCmd,
        ['query', key, '/v', value],
        { timeout: 3000, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve(null)
            return
          }
          const lines = stdout.split(/\r?\n/)
          for (const line of lines) {
            const m = line.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i)
            if (m) {
              // 展开环境变量（如 %ProgramFiles%）
              const rawValue = m[1].trim()
              const expanded = rawValue.replace(
                /%([^%]+)%/g,
                (_, varName) => process.env[varName] || ''
              )
              resolve(expanded)
              return
            }
          }
          resolve(null)
        }
      )
    } catch {
      resolve(null)
    }
  })
}

/**
 * 解析启动器配置文件（支持 INI 和 JSON 格式）
 * @param configPath 配置文件完整路径
 * @returns InstallPath 值，解析失败时返回 null
 */
async function parseLauncherConfig(configPath: string): Promise<string | null> {
  try {
    const content = await fsp.readFile(configPath, 'utf-8')
    const ext = path.extname(configPath).toLowerCase()

    if (ext === '.json') {
      // JSON 格式解析
      try {
        const json = JSON.parse(content)
        // 支持多种可能的字段路径
        const installPath =
          json?.game_install_path || json?.game?.installPath || json?.installPath || json?.gamePath
        return installPath || null
      } catch {
        return null
      }
    } else {
      // INI 格式解析（简化版，不引入新依赖）
      const lines = content.split(/\r?\n/)
      let inGameSection = false
      for (const line of lines) {
        const trimmed = line.trim()
        // 检测 [Game] 段
        if (trimmed.toLowerCase() === '[game]') {
          inGameSection = true
          continue
        }
        // 遇到新段则退出
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          inGameSection = false
          continue
        }
        // 在 [Game] 段中查找 InstallPath / game_install_path
        if (inGameSection) {
          const match = trimmed.match(/^(installpath|game_install_path)\s*=\s*(.+)$/i)
          if (match) {
            return match[2].trim()
          }
        }
      }
      // 未找到 [Game] 段时，全局搜索 InstallPath / game_install_path
      for (const line of lines) {
        const match = line.trim().match(/^(installpath|game_install_path)\s*=\s*(.+)$/i)
        if (match) {
          return match[1].trim()
        }
      }
      return null
    }
  } catch {
    // 文件不存在或读取失败
    return null
  }
}

/**
 * 解析 Windows 快捷方式 (.lnk) 目标路径
 * 使用 PowerShell + WScript.Shell COM 对象
 * @param shortcutPath 快捷方式完整路径
 * @returns 目标路径字符串，失败时返回 null
 */
async function resolveShortcutTarget(shortcutPath: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    try {
      const psCommand = `$shell = New-Object -ComObject WScript.Shell; $shortcut = $shell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}'); $shortcut.TargetPath`
      execFile(
        'powershell',
        ['-NoProfile', '-Command', psCommand],
        { timeout: 3000, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve(null)
            return
          }
          const targetPath = stdout.trim()
          if (targetPath) {
            resolve(targetPath)
          } else {
            resolve(null)
          }
        }
      )
    } catch {
      resolve(null)
    }
  })
}

/**
 * 验证候选游戏根目录是否有效
 * 验证逻辑：检查 GamePlayPhotos 子目录或 X6Game 目录是否存在
 * @param candidatePath 候选游戏根目录路径
 * @returns 验证通过返回原路径，失败返回 null
 */
async function validateGameRoot(candidatePath: string): Promise<string | null> {
  if (!candidatePath || typeof candidatePath !== 'string') return null

  // 全链路诊断：[目标路径] 节点——最终目标相册路径必须严格等于
  // [游戏根]\X6Game\Saved\GamePlayPhotos
  const gamePlayPhotosPath = path.join(candidatePath, 'X6Game', 'Saved', 'GamePlayPhotos')
  sendScanLogEntry({
    stage: 'target-path',
    level: 'info',
    message: `拼接目标相册路径：${gamePlayPhotosPath}`
  })
  try {
    await fsp.access(gamePlayPhotosPath, fs.constants.F_OK)
    sendScanLogEntry({
      stage: 'path-existence',
      level: 'info',
      kind: 'ok',
      message: `目标路径存在：${gamePlayPhotosPath}`
    })
    return candidatePath
  } catch (err) {
    // 备选：验证 X6Game 目录存在（路径错误时继续下一个定位方式，不打断整体扫描）
    const x6gamePath = path.join(candidatePath, 'X6Game')
    try {
      await fsp.access(x6gamePath, fs.constants.F_OK)
      sendScanLogEntry({
        stage: 'path-existence',
        level: 'warn',
        kind: 'empty',
        message: `GamePlayPhotos 不存在但 X6Game 存在（路径可能错误，已降级）：${x6gamePath}`
      })
      return candidatePath
    } catch (err2) {
      const kind2 = classifyFsError(err2)
      sendScanLogEntry({
        stage: 'path-existence',
        level: 'warn',
        kind: kind2,
        message:
          kind2 === 'permission'
            ? `访问被拒绝（权限不足）：${gamePlayPhotosPath}`
            : `路径不存在：${gamePlayPhotosPath}`,
        detail: String(err)
      })
      return null
    }
  }
}

/**
 * 通过 Steam 注册表和 libraryfolders.vdf 查找所有无限暖暖游戏路径（复数）
 * 流程：
 *   1) 注册表查询 Steam 安装路径（HKCU/HKLM）
 *   2) 解析 steamapps/libraryfolders.vdf 获取所有 Steam 库
 *   3) 在每个库的 steamapps/common/InfinityNikki 下验证特征文件
 * 返回所有匹配路径（可能为空数组）
 */
export async function findSteamGamePaths(): Promise<string[]> {
  if (process.platform !== 'win32') return []

  const steamInstallPath = await querySteamInstallPath()
  if (!steamInstallPath) return []

  // 收集所有 Steam 库路径（Steam 主目录 + libraryfolders.vdf 中的额外库）
  const libraryPaths = new Set<string>()
  libraryPaths.add(steamInstallPath)

  const vdfPath = path.join(steamInstallPath, 'steamapps', 'libraryfolders.vdf')
  try {
    const vdfContent = await fsp.readFile(vdfPath, 'utf-8')
    // 简化 VDF 解析：正则提取 "path" 字段，不引入 VDF 解析依赖
    const matches = vdfContent.matchAll(/"path"\s+"([^"]+)"/g)
    for (const match of matches) {
      // VDF 中路径用双反斜杠转义，需还原为单反斜杠
      const libPath = match[1].replace(/\\\\/g, '\\')
      libraryPaths.add(libPath)
    }
  } catch {
    // VDF 文件不存在或读取失败，仅用 Steam 主目录
  }

  const found = new Set<string>()
  // 在每个 Steam 库的 steamapps/common/InfinityNikki 下查找特征文件
  for (const libPath of libraryPaths) {
    if (shouldStop) break
    const gamePath = path.join(libPath, 'steamapps', 'common', 'InfinityNikki')
    try {
      await fsp.access(gamePath, fs.constants.F_OK)
      found.add(gamePath)
    } catch {
      // 该库下无 InfinityNikki
    }
  }

  // 补充源：Steam 卸载信息键 "Steam App 2732520" 的 InstallLocation（spec 指定来源）。
  // 与 libraryfolders.vdf 解析「两者并存」去重合并，覆盖 VDF 缺失/布局异常场景；
  // 注册表查询失败或键缺失返回 null（不抛异常），由下方 access 校验兜底。
  const uninstallPath = await querySteamApp2732520InstallLocation()
  if (uninstallPath) {
    try {
      await fsp.access(uninstallPath, fs.constants.F_OK)
      found.add(uninstallPath)
    } catch {
      // 该路径不存在
    }
  }

  return Array.from(found)
}

/**
 * 读取 Steam 卸载信息键 "Steam App 2732520" 的 InstallLocation（spec 指定来源）。
 * 与 querySteamInstallPath + libraryfolders.vdf 解析「两者并存」：本函数直接给出游戏安装根目录，
 * 作为 libraryfolders 的兜底/补充来源，覆盖 VDF 缺失或布局异常场景。
 * 复用 queryRegistryValue（已处理 REG_EXPAND_SZ 的 %VAR% 展开）；查询失败/键缺失返回 null，不抛异常。
 */
async function querySteamApp2732520InstallLocation(): Promise<string | null> {
  return queryRegistryValue(
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 2732520',
    'InstallLocation'
  )
}

/**
 * 通过 Epic Games Launcher 注册表查找无限暖暖游戏路径
 * @returns 匹配路径列表（可能为空数组）
 */
export async function findEpicGamePaths(): Promise<string[]> {
  if (process.platform !== 'win32') return []

  const epicRoots = new Set<string>()
  const regKeys = [
    { key: 'HKCU\\Software\\Epic Games\\EOS', value: 'InstallPath' },
    { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\EOS', value: 'InstallPath' }
  ]

  for (const { key, value } of regKeys) {
    try {
      const result = await queryRegistryValue(key, value)
      if (result) epicRoots.add(result)
    } catch {
      // 该注册表键查询失败
    }
  }

  // 在每个 Epic 安装路径下查找 InfinityNikki
  const found = new Set<string>()
  for (const epicPath of epicRoots) {
    if (shouldStop) break
    const gamePath = path.join(epicPath, 'InfinityNikki')
    try {
      await fsp.access(gamePath, fs.constants.F_OK)
      found.add(gamePath)
    } catch {
      // 该路径下无 InfinityNikki
    }
  }

  // 补充源：Epic 清单文件（spec 指定的"清单文件"定位方式），与 EOS 注册表「两者并存」去重合并
  for (const manifestPath of await parseEpicManifests()) {
    found.add(manifestPath)
  }

  return Array.from(found)
}

/**
 * 解析 Epic 清单文件定位无限暖暖安装目录（spec 指定的"清单文件"方式）。
 * 清单位于 C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests\*.item|*.json（JSON 格式，
 * 含 InstallLocation / AppName / DisplayName 字段）。仅采纳 InstallLocation 指向实际存在目录
 * 且确属 InfinityNikki 的清单。清单目录不存在 / 读取失败 / 解析异常均降级返回空，不抛异常、不中断整体。
 */
export async function parseEpicManifests(): Promise<string[]> {
  const programData = process.env.ProgramData || 'C:\\ProgramData'
  const manifestsDir = path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')

  let files: string[]
  try {
    const entries = await fsp.readdir(manifestsDir)
    files = Array.isArray(entries) ? entries : []
  } catch {
    return []
  }

  const results: string[] = []
  for (const file of files) {
    if (shouldStop) break
    if (!file.toLowerCase().endsWith('.item') && !file.toLowerCase().endsWith('.json')) {
      continue
    }
    const filePath = path.join(manifestsDir, file)
    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      const json = JSON.parse(content) as {
        InstallLocation?: string
        AppName?: string
        DisplayName?: string
      }
      const installLocation = json?.InstallLocation
      if (
        installLocation &&
        (installLocation.toLowerCase().includes('infinitynikki') ||
          (json.AppName || '').toLowerCase().includes('infinitynikki'))
      ) {
        const resolved = path.resolve(installLocation)
        try {
          await fsp.access(resolved, fs.constants.F_OK)
          results.push(resolved)
        } catch {
          // 清单声明的安装目录不存在
        }
      }
    } catch {
      // 单文件解析失败，跳过
    }
  }
  return results
}

/**
 * 三渠道根目录定位解析器（启动器 > Steam > Epic，命中即止）
 *
 * 按用户强制要求的优先级顺序解析游戏根目录：
 *   1. 官方启动器版（最高优先级）：常见路径枚举 + 注册表 + 配置 + 桌面快捷方式；
 *   2. Steam 版：注册表 Uninstall 键 + libraryfolders.vdf；
 *   3. Epic 版：Launcher 注册表/清单。
 * 任一渠道返回非空即采用其全部结果并立即返回，不再降级查询后续渠道
 * （"优先匹配到此渠道后不再降级"）。三渠道全空返回 `[]`，不抛异常。
 *
 * 返回的均为「游戏安装根目录」数组（如 `...\InfinityNikki`），由上层 findMediaDirectories
 * 统一拼接 `X6Game\Saved\GamePlayPhotos` 子路径。非 Windows 平台直接返回空数组。
 *
 * @returns 来自首个非空渠道的游戏根目录数组（0 或多个）
 */
export async function findGameInstallRootsByPriority(): Promise<string[]> {
  if (process.platform !== 'win32') return []

  // 1. 官方启动器版（最高优先级）
  const launcherPaths = await findOfficialLauncherGamePaths()
  if (launcherPaths.length > 0) return launcherPaths

  // 2. Steam 版（启动器未命中才降级）
  const steamPaths = await findSteamGamePaths()
  if (steamPaths.length > 0) return steamPaths

  // 3. Epic 版（最低优先级）
  return await findEpicGamePaths()
}

/**
 * 查询 Steam 安装路径（Windows 注册表）
 * 候选键（按优先级）：
 *   HKCU\Software\Valve\Steam SteamPath（用户级，最常见）
 *   HKLM\SOFTWARE\WOW6432Node\Valve\Steam InstallPath（32位兼容层）
 *   HKLM\SOFTWARE\Valve\Steam InstallPath（64位）
 */
async function querySteamInstallPath(): Promise<string | null> {
  const regKeys = [
    { key: 'HKCU\\Software\\Valve\\Steam', value: 'SteamPath' },
    { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', value: 'InstallPath' },
    { key: 'HKLM\\SOFTWARE\\Valve\\Steam', value: 'InstallPath' }
  ]

  for (const { key, value } of regKeys) {
    try {
      const result = await new Promise<string | null>((resolve) => {
        execFile(
          'reg',
          ['query', key, '/v', value],
          { timeout: 3000, windowsHide: true },
          (err, stdout) => {
            if (err) {
              resolve(null)
              return
            }
            // 解析 reg query 输出，提取 REG_SZ / REG_EXPAND_SZ 值
            const lines = stdout.split(/\r?\n/)
            for (const line of lines) {
              const m = line.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i)
              if (m) {
                resolve(m[1].trim())
                return
              }
            }
            resolve(null)
          }
        )
      })
      if (result) return result
    } catch {
      // 该注册表键查询失败，尝试下一个
    }
  }

  return null
}

/**
 * 列出所有可用盘符（C-Z），用于全盘签名搜索
 * 平台限定：Windows 下返回 C:-Z:，非 Windows 返回空（无盘符概念）
 * @returns 可用盘符根路径列表，如 ['C:\\', 'D:\\']
 */
export async function getAvailableDrives(): Promise<string[]> {
  const drives: string[] = []
  // C-G3：驱动器字母范围 C-Z 用命名常量
  for (let i = DRIVE_LETTER_START; i <= DRIVE_LETTER_END; i++) {
    const drive = `${String.fromCharCode(i)}:\\`
    try {
      await fsp.access(drive, fs.constants.F_OK)
      drives.push(drive)
    } catch {
      // 驱动器不存在
    }
  }
  return drives
}

/**
 * 恢复用户数据路径快速通道（P0-01 重构时误移除，违反 project_memory 约束）
 *
 * 检查以下不依赖游戏 exe 的媒体目录：
 * 1. %LOCALAPPDATA%\InfinityNikki\（游戏用户数据）
 * 2. %USERPROFILE%\Documents\InfinityNikki\（游戏用户数据）
 * 3. %LOCALAPPDATA%\InfinityNikki Launcher\cache\images\（启动器缓存图片）
 * 4. %LOCALAPPDATA%\InfinityNikkiGlobal Launcher\cache\images\（国际服启动器缓存）
 *
 * 这些目录位于 AppData 下，而 SYSTEM_DIRS_TO_SKIP 跳过 appdata，
 * 全盘签名搜索无法进入，必须通过快速通道显式检查。
 *
 * @returns 存在的用户数据路径列表（仅返回实际存在的目录）
 */
export async function getUserDataPaths(): Promise<string[]> {
  const found: string[] = []
  const userProfile = process.env.USERPROFILE || process.env.HOME || ''
  const localAppData =
    process.env.LOCALAPPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Local') : '')

  const candidates: string[] = []
  if (localAppData) {
    // 游戏用户数据（可能含媒体文件）
    candidates.push(path.join(localAppData, 'InfinityNikki'))
    // 启动器缓存图片（LauncherCacheImages 资源相册）
    candidates.push(path.join(localAppData, 'InfinityNikki Launcher', 'cache', 'images'))
    // 国际服启动器缓存图片
    candidates.push(path.join(localAppData, 'InfinityNikkiGlobal Launcher', 'cache', 'images'))
  }
  if (userProfile) {
    // Documents 下的游戏数据
    candidates.push(path.join(userProfile, 'Documents', 'InfinityNikki'))
  }

  for (const candidate of candidates) {
    if (shouldStop) break
    try {
      await fsp.access(candidate, fs.constants.F_OK)
      // 校验目录非空（避免误识别空目录）
      const entries = await fsp.readdir(candidate)
      if (entries.length > 0) {
        found.push(candidate)
      }
    } catch {
      // 目录不存在
    }
  }

  return found
}
