/**
 * 游戏媒体目录发现（注册表快速路径 + 全盘签名深度搜索）。
 *
 * 从 worker-entry.ts 抽取为独立模块，目的：
 * - 便于单元测试：测试可用 vi.mock('../game-directory-discovery') 桩替换全部发现函数，避免真实盘符/注册表 IO；
 * - 保持 worker-entry.ts 的 findMediaDirectories 契约不变（返回 string[]），调用方无感。
 *
 * 共享依赖（shouldStop / workerLog / 签名常量）从 worker-entry 导入均为"调用期"使用，
 * 循环依赖在 ESM 下安全（模块求值期不读取这些绑定）。
 *
 * 依赖（五要素）：
 * - 依赖声明：仅复用 fs / fs.promises / path / child_process / tinyglobby / '../utils/concurrency' / '../utils/constants' / worker-entry，
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
// 全盘签名扫描：用 tinyglobby（Vite 同款，基于 fdir + picomatch，零依赖）替换手写 fs.readdir 递归
import { glob } from 'tinyglobby'
import { DRIVE_LETTER_START, DRIVE_LETTER_END } from '../utils/constants'
// 循环依赖：以下绑定仅在函数体内（调用期）读取，模块求值期不访问，ESM 安全
import { shouldStop, workerLog } from './worker-entry'

// 游戏 exe 特征签名（用于全盘签名搜索定位游戏安装根目录）
const GAME_SIGNATURES = [
  'InfinityNikki.exe',
  'NikkiLauncher.exe',
  'GameConfig.ini',
  'InfinityNikkiLauncher.exe',
  'Launcher.exe'
]

// 安装树结构锚点（用于全盘扫描识别非标准安装树，不依赖游戏 exe 或媒体子目录名）
// 覆盖场景：官网/WeGame 启动器安装路径 `InfinityNikki Launcher\InfinityNikki\X6Game\...`
// - X6Game：虚幻引擎游戏资源根目录，所有游戏内媒体（ScreenShot / Saved\GamePlayPhotos 等）均在其下；
//   命中后返回其父目录（即 `...\InfinityNikki`），使 scanDirectory 从安装树根递归即可覆盖全部媒体。
// - InfinityNikki Launcher：官网/国际服启动器目录本身，命中后返回其父目录（安装树更上一级），
//   同样可作为扫描根，递归进入其下的 InfinityNikki\X6Game。
// 注意：X6Game / Launcher 均为通用名，必须经下方上下文校验（父链含 infinitynikki）才能入库，
// 避免误匹配其他虚幻游戏或无关软件的安装目录。
const INSTALL_TREE_SIGNATURES = ['X6Game', 'InfinityNikki Launcher']

// 媒体特征文件夹（用于全盘扫描识别游戏媒体目录，不依赖游戏 exe）
// 只保留无限暖暖专属签名，这些签名在非游戏目录中不会出现
const MEDIA_FOLDER_SIGNATURES = [
  // 游戏内主要相册（位于 X6Game\Saved\GamePlayPhotos\$uid$\ 下）
  // 这些是无限暖暖专属命名，不会误匹配
  'NikkiPhotos_HighQuality',
  'NikkiPhotos_LowQuality',
  'MagazinePhotos',
  'ClockInPhoto',
  'CloudPhotos',
  'CloudPhotos_LowQuality',
  // 拼图相册父目录（GamePlayPhotos\$uid$\Collage\）
  'Collage',
  // 其他游戏内相册（位于 X6Game\Saved\ 下，均为无限暖暖专属命名）
  'CustomAvatar',
  'CustomCard',
  'CustomHomeBoardPhoto',
  'HomeTemplate',
  'PlantDyeing',
  'DIY',
  'XSdkQrCode',
  'MallPic',
  // 游戏截图（位于 X6Game\ScreenShot，ScreenShot 较通用但配合游戏目录上下文可接受）
  'ScreenShot',
  // 游戏内视频（位于 X6Game\Video，与 ScreenShot 同级，均为无限暖暖标准安装树下的图库内容）
  'Video'
]

// 游戏快捷方式文件名（中文）
// eslint-disable-next-line no-restricted-syntax
const GAME_SHORTCUT_CN = '\u65e0\u9650\u6696\u6696.lnk'

/**
 * 浅层签名搜索（限制深度，快速定位常见安装路径）
 *
 * 为何用 tinyglobby 替换手写递归：原 searchBySignature 逐目录调用 fs.readdir 递归遍历，
 * 每个目录一次系统调用，全盘扫描时 IO 往返极多。tinyglobby（Vite 同款，基于 fdir + picomatch，零依赖）
 * 在 C 层一次性完成目录遍历与模式匹配，并用 brace 一次性匹配全部游戏 exe 签名，显著降低系统调用次数。
 * 遍历中单目录读取失败由 fdir 内部静默处理（tinyglobby 无 suppressErrors 选项），不会中断整体扫描。
 *
 * @param rootPath 搜索根目录（通常是盘符根）
 * @param maxDepth 最大搜索深度
 */
export async function searchBySignatureShallow(
  rootPath: string,
  maxDepth: number
): Promise<string | null> {
  const pattern = `**/{${GAME_SIGNATURES.join(',')}}`
  let matches: string[] = []
  try {
    // onlyFiles 默认 true；全小写签名 + caseSensitiveMatch:false 抵消 Windows 大小写差异
    matches = await glob(pattern, {
      cwd: rootPath,
      absolute: true,
      onlyFiles: true,
      deep: maxDepth,
      caseSensitiveMatch: false,
      followSymbolicLinks: false
    })
  } catch (err) {
    // 单盘遍历异常不应中断全盘扫描；记录后降级返回空，由其他盘符/快速路径兜底
    workerLog(
      'warn',
      `[Scanner] 游戏 exe 签名 glob 失败: ${rootPath}`,
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
  if (matches.length === 0) return null
  // 原始逻辑命中 exe 时返回"所在目录"（path.dirname）且首匹配即停止（stop:true）。
  // glob 返回所有命中 exe 的完整路径，取排序后首个的父目录，等价于原首匹配语义。
  matches.sort()
  return path.dirname(matches[0].replace(/[\\/]+$/, ''))
}

/**
 * 浅层媒体文件夹签名搜索（限制深度，快速定位常见媒体目录）
 *
 * 与 searchBySignatureShallow 同理，用 tinyglobby 一次性匹配全部媒体特征文件夹签名，
 * 取代逐层 fs.readdir 递归。命中目录继续做"游戏媒体特征签名校验"：ScreenShot 为通用名，
 * 仍需路径上下文验证（仅当父目录含 InfinityNikki 或 X6Game 才视为游戏截图目录）。
 *
 * @param rootPath 搜索根目录（通常是盘符根）
 * @param maxDepth 最大搜索深度
 */
export async function searchByMediaFolderSignatureShallow(
  rootPath: string,
  maxDepth: number
): Promise<string[]> {
  const pattern = `**/{${MEDIA_FOLDER_SIGNATURES.join(',')}}`
  let matches: string[] = []
  try {
    matches = await glob(pattern, {
      cwd: rootPath,
      absolute: true,
      onlyDirectories: true,
      deep: maxDepth,
      caseSensitiveMatch: false,
      followSymbolicLinks: false
    })
  } catch (err) {
    workerLog(
      'warn',
      `[Scanner] 媒体文件夹签名 glob 失败: ${rootPath}`,
      err instanceof Error ? err.message : String(err)
    )
    return []
  }

  const dirs: string[] = []
  for (const raw of matches) {
    // glob 目录结果可能带尾斜杠，统一去除后处理（path.basename/dirname 对尾斜杠不敏感，但保持返回一致）
    const match = raw.replace(/[\\/]+$/, '')
    const baseName = path.basename(match).toLowerCase()
    // 原始逻辑返回命中文件夹的"父目录"（包含相册集合的目录），故取 dirname
    const dir = path.dirname(match)
    // ScreenShot / Video 为通用名（War Thunder、Trae skills/screenshot、各类游戏 Video 等均可能误匹配），
    // 需路径上下文验证：仅当父目录含 infinitynikki 或 x6game 才视为无限暖暖游戏媒体目录。
    if (baseName === 'screenshot' || baseName === 'video') {
      const normalizedDir = dir.replace(/\//g, '\\').toLowerCase()
      if (!normalizedDir.includes('infinitynikki') && !normalizedDir.includes('x6game')) {
        continue
      }
    }
    dirs.push(dir)
  }
  // 去重：同一父目录下可能有多个匹配子目录（如 NikkiPhotos_HighQuality + NikkiPhotos_LowQuality）
  return Array.from(new Set(dirs))
}

/**
 * 浅层安装树锚点签名搜索（限制深度，定位非标准安装树根）
 *
 * 与媒体文件夹签名搜索同理，用 tinyglobby 一次性匹配安装树结构目录（X6Game / InfinityNikki Launcher）。
 * 这些锚点不依赖游戏 exe，也不依赖深层媒体子目录名，专门覆盖官网/WeGame 启动器安装路径
 * `InfinityNikki Launcher\InfinityNikki\X6Game\...`：该路径既非 Steam/Epic 标准路径（注册表命中不了），
 * 又可能缺失 exe 签名（游戏以 X6Game 形态存在），纯媒体子目录签名常因 depth 边界而错过。
 *
 * 命中后返回"锚点目录的父目录"作为扫描根，使 scanDirectory 从该根递归即能覆盖
 * X6Game\ScreenShot、X6Game\Saved\GamePlayPhotos 等全部媒体，比只认深层媒体目录更稳。
 *
 * 上下文校验（防误匹配）：X6Game / InfinityNikki Launcher 均为通用名，必须经父链校验——
 * 要求命中目录的完整路径（含所有祖先）含 `infinitynikki` 关键字，才视为无限暖暖安装树。
 * 用户的 `InfinityNikki Launcher\InfinityNikki\X6Game`：命中 X6Game 时，其完整路径已含
 * `infinitynikki`（上级 `InfinityNikki Launcher` 与 `InfinityNikki` 均匹配），可通过校验。
 *
 * @param rootPath 搜索根目录（通常是盘符根）
 * @param maxDepth 最大搜索深度
 */
export async function searchByInstallTreeSignatureShallow(
  rootPath: string,
  maxDepth: number
): Promise<string[]> {
  const pattern = `**/{${INSTALL_TREE_SIGNATURES.join(',')}}`
  let matches: string[] = []
  try {
    matches = await glob(pattern, {
      cwd: rootPath,
      absolute: true,
      onlyDirectories: true,
      deep: maxDepth,
      caseSensitiveMatch: false,
      followSymbolicLinks: false
    })
  } catch (err) {
    workerLog(
      'warn',
      `[Scanner] 安装树锚点签名 glob 失败: ${rootPath}`,
      err instanceof Error ? err.message : String(err)
    )
    return []
  }

  const roots: string[] = []
  for (const raw of matches) {
    const match = raw.replace(/[\\/]+$/, '')
    // 仅当完整路径（含祖先）含 infinitynikki 才视为无限暖暖安装树，避免误匹配其他软件/游戏
    const normalized = match.replace(/\//g, '\\').toLowerCase()
    if (!normalized.includes('infinitynikki')) continue
    // 返回锚点目录的父目录作为扫描根（如 `...\InfinityNikki`），递归即可覆盖其下全部媒体
    roots.push(path.dirname(match))
  }
  // 去重：同一安装树下可能命中 X6Game 与 InfinityNikki Launcher 两个锚点，父目录可能相同
  return Array.from(new Set(roots))
}

// ============ 官方启动器检测常量 ============

/**
 * 官方启动器注册表候选键（按优先级排序）
 * 覆盖常见安装位置：用户级/机器级/卸载信息/国际服变体
 */
const OFFICIAL_LAUNCHER_REG_KEYS: Array<{ key: string; value: string }> = [
  // 官方启动器安装路径（最常见）
  { key: 'HKCU\\Software\\InfinityNikki Launcher', value: 'InstallPath' },
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\InfinityNikki Launcher', value: 'InstallPath' },
  { key: 'HKLM\\SOFTWARE\\InfinityNikki Launcher', value: 'InstallPath' },
  // 卸载信息中的安装位置
  {
    key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\InfinityNikki',
    value: 'InstallLocation'
  },
  {
    key: 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\InfinityNikki',
    value: 'InstallLocation'
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

  // 1. 注册表检测（主路径）
  for (const { key, value } of OFFICIAL_LAUNCHER_REG_KEYS) {
    if (shouldStop) break
    const regPath = await queryRegistryValue(key, value)
    if (regPath) {
      const validated = await validateGameRoot(regPath)
      if (validated && !seenPaths.has(validated.toLowerCase())) {
        seenPaths.add(validated.toLowerCase())
        validatedPaths.push(validated)
        // 注册表命中即返回（最高优先级，不继续尝试其他键）
        return validatedPaths
      }
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
 * @returns 注册表值字符串，失败时返回 null
 */
async function queryRegistryValue(key: string, value: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    try {
      execFile(
        'reg',
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
        const installPath = json?.game?.installPath || json?.installPath || json?.gamePath
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
        // 在 [Game] 段中查找 InstallPath
        if (inGameSection) {
          const match = trimmed.match(/^installpath\s*=\s*(.+)$/i)
          if (match) {
            return match[1].trim()
          }
        }
      }
      // 未找到 [Game] 段时，全局搜索 InstallPath
      for (const line of lines) {
        const match = line.trim().match(/^installpath\s*=\s*(.+)$/i)
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

  // 验证 GamePlayPhotos 子目录存在
  const gamePlayPhotosPath = path.join(candidatePath, 'X6Game', 'Saved', 'GamePlayPhotos')
  try {
    await fsp.access(gamePlayPhotosPath, fs.constants.F_OK)
    return candidatePath
  } catch {
    // 备选：验证 X6Game 目录存在
    const x6gamePath = path.join(candidatePath, 'X6Game')
    try {
      await fsp.access(x6gamePath, fs.constants.F_OK)
      return candidatePath
    } catch {
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

  const found: string[] = []
  // 在每个 Steam 库的 steamapps/common/InfinityNikki 下查找特征文件
  for (const libPath of libraryPaths) {
    if (shouldStop) break
    const gamePath = path.join(libPath, 'steamapps', 'common', 'InfinityNikki')
    try {
      await fsp.access(gamePath, fs.constants.F_OK)
      found.push(gamePath)
    } catch {
      // 该库下无 InfinityNikki
    }
  }

  return found
}

/**
 * 通过 Epic Games Launcher 注册表查找无限暖暖游戏路径
 * @returns 匹配路径列表（可能为空数组）
 */
export async function findEpicGamePaths(): Promise<string[]> {
  if (process.platform !== 'win32') return []

  const found: string[] = []
  const regKeys = [
    { key: 'HKCU\\Software\\Epic Games\\EOS', value: 'InstallPath' },
    { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\EOS', value: 'InstallPath' }
  ]

  const epicPaths = new Set<string>()
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
      if (result) epicPaths.add(result)
    } catch {
      // 该注册表键查询失败
    }
  }

  // 在每个 Epic 安装路径下查找 InfinityNikki
  for (const epicPath of epicPaths) {
    if (shouldStop) break
    const gamePath = path.join(epicPath, 'InfinityNikki')
    try {
      await fsp.access(gamePath, fs.constants.F_OK)
      found.push(gamePath)
    } catch {
      // 该路径下无 InfinityNikki
    }
  }

  return found
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
