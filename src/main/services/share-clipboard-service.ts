/**
 * T09：剪贴板分享服务
 * 将选中的图片/视频文件以 CF_HDROP 格式写入 Windows 剪贴板
 * 支持微信 / QQ / vivo办公套件 等所有支持文件粘贴的应用
 *
 * CF_HDROP 缓冲区结构：
 *   DROPFILES 头（20 字节：pFiles=20, ptX=0, ptY=0, fNC=0, fWide=1）
 *   + UTF-16LE 文件路径列表（以 \0 分隔，双 \0 结尾）
 *
 * 通用化检测策略（确保任意 Windows 机器都能正确识别已安装软件）：
 *   每个渠道按优先级依次尝试以下 4 类来源，任一命中即视为已安装：
 *     1) 注册表候选位置：[HKCU/HKLM × 64/32 位] 下的 InstallPath / Install / DisplayIcon
 *     2) 卸载项枚举：在 3 个 Uninstall 根下查找 DisplayName 含关键字的项
 *     3) 常见安装目录：C/D/E 盘的 Program Files / 用户目录等候选路径
 *     4) 进程路径反查：若软件正在运行，从 wmic / Get-Process 拿到 ExecutablePath
 *   全部失败才算未安装。
 *
 *   - running: 通过 tasklist 查询进程是否在运行（进程名从 installPath 推导，兼容新老版本）
 *   - installPath: 已安装时的可执行文件完整路径，用于启动
 *
 *   UI 根据 installed / running 三态展示文案：
 *     1) 已安装且运行中 → "请打开聊天窗口粘贴"
 *     2) 已安装未运行   → 显示"打开 XX"按钮，启动后引导粘贴
 *     3) 未安装         → "未检测到 XX，文件已复制到剪贴板"
 */
import { clipboard } from 'electron'
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { logger } from '../utils/logger'
import { t } from '../i18n'

// DROPFILES 结构体大小（20 字节）
const DROPFILES_SIZE = 20

// F4 修复：installPathCache TTL（5 分钟）
// 避免用户安装/卸载应用后缓存长期失效，导致 UI 显示状态不准
const INSTALL_PATH_CACHE_TTL_MS = 5 * 60 * 1000

// 渠道文案配置
export interface ShareChannel {
  id: 'wechat' | 'qq' | 'vivo'
  name: string
  // 已安装且运行中：引导粘贴文案
  guide: string
  // 已安装未运行：提示启动文案
  notRunning: string
  // 未安装：兜底文案
  fallback: string
}

export const SHARE_CHANNELS: Record<string, ShareChannel> = {
  wechat: {
    id: 'wechat',
    name: t('share.guide.channels.wechat'),
    guide: t('share.guide.guides.wechat.running'),
    notRunning: t('share.guide.guides.wechat.notRunning'),
    fallback: t('share.guide.guides.wechat.notInstalled')
  },
  qq: {
    id: 'qq',
    name: t('share.guide.channels.qq'),
    guide: t('share.guide.guides.qq.running'),
    notRunning: t('share.guide.guides.qq.notRunning'),
    fallback: t('share.guide.guides.qq.notInstalled')
  },
  vivo: {
    id: 'vivo',
    name: t('share.guide.channels.vivo'),
    guide: t('share.guide.guides.vivo.running'),
    notRunning: t('share.guide.guides.vivo.notRunning'),
    fallback: t('share.guide.guides.vivo.notInstalled')
  }
}

// ============================================================
// 渠道检测配置：数据驱动，便于扩展
// =============================================================

interface RegQueryItem {
  // 注册表键路径（已包含 HKCU / HKLM / WOW6432Node 前缀）
  key: string
  // 要查询的值名（如 InstallPath / Install / DisplayIcon）
  value: string
  // 解析方式：
  //   'installPath' —— 值是目录，需在目录下找 exeName
  //   'displayIcon' —— 值是 "X:\path\app.exe,0" 格式，去掉 ,N 后缀
  parse: 'installPath' | 'displayIcon'
  // 当 parse='installPath' 时，要查找的可执行文件名列表（按优先级）
  exeNames?: string[]
}

interface ChannelDetectionConfig {
  // 1) 注册表候选位置（按优先级依次尝试）
  regQueries: RegQueryItem[]
  // 2) 卸载项关键字（在 DisplayName 中模糊匹配，排除词避免误匹配）
  uninstallKeywords: string[]
  uninstallExcludeKeywords: string[]
  // 卸载项 InstallLocation 目录下查找的候选 exe
  candidateExes: string[]
  // 3) 常见安装目录（绝对路径，可包含 %env% 占位符）
  commonDirs: string[]
  // 4) 运行中进程名候选（用于进程路径反查兜底）
  processNames: string[]
}

// 解析常见安装目录中的环境变量占位符
function resolveEnv(p: string): string {
  return p
    .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || '')
    .replace(/%APPDATA%/gi, process.env.APPDATA || '')
    .replace(/%PROGRAMFILES%/gi, process.env.ProgramFiles || 'C:\\Program Files')
    .replace(
      /%PROGRAMFILES\(X86\)%/gi,
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    )
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE || '')
}

const DETECTION_CONFIGS: Record<string, ChannelDetectionConfig> = {
  wechat: {
    // 微信 4.x 注册表 key 改为 Weixin，主程序 Weixin.exe
    // 微信 3.x 注册表 key 是 WeChat，主程序 WeChat.exe
    regQueries: [
      // 4.x 新版：HKCU\Software\Tencent\Weixin
      {
        key: 'HKCU\\Software\\Tencent\\Weixin',
        value: 'InstallPath',
        parse: 'installPath',
        exeNames: ['Weixin.exe']
      },
      // 4.x HKLM（管理员安装）
      {
        key: 'HKLM\\SOFTWARE\\Tencent\\Weixin',
        value: 'InstallPath',
        parse: 'installPath',
        exeNames: ['Weixin.exe']
      },
      {
        key: 'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\Weixin',
        value: 'InstallPath',
        parse: 'installPath',
        exeNames: ['Weixin.exe']
      },
      // 3.x 老版：HKCU\Software\Tencent\WeChat
      {
        key: 'HKCU\\Software\\Tencent\\WeChat',
        value: 'InstallPath',
        parse: 'installPath',
        exeNames: ['WeChat.exe']
      },
      {
        key: 'HKLM\\SOFTWARE\\Tencent\\WeChat',
        value: 'InstallPath',
        parse: 'installPath',
        exeNames: ['WeChat.exe']
      },
      {
        key: 'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\WeChat',
        value: 'InstallPath',
        parse: 'installPath',
        exeNames: ['WeChat.exe']
      }
    ],
    uninstallKeywords: ['Weixin', '微信', 'WeChat'], // TODO: i18n - registry matching keywords (must remain Chinese for DisplayName matching)
    uninstallExcludeKeywords: ['WeChatMeet', '会议', 'WeMeet', 'QQPCMgr'], // TODO: i18n - registry matching keywords
    candidateExes: ['Weixin.exe', 'WeChat.exe'],
    commonDirs: [
      '%PROGRAMFILES%\\Tencent\\Weixin',
      '%PROGRAMFILES%\\Tencent\\WeChat',
      '%PROGRAMFILES(X86)%\\Tencent\\WeChat',
      '%LOCALAPPDATA%\\Tencent\\WeChat',
      '%LOCALAPPDATA%\\Tencent\\Weixin',
      'C:\\Program Files\\Tencent\\Weixin',
      'C:\\Program Files\\Tencent\\WeChat',
      'C:\\Program Files (x86)\\Tencent\\WeChat',
      'D:\\Tencent\\Weixin',
      'D:\\Tencent\\WeChat',
      'D:\\Program Files\\Tencent\\Weixin',
      'E:\\Tencent\\Weixin'
    ],
    processNames: ['Weixin.exe', 'WeChat.exe']
  },
  qq: {
    // QQ NT：HKCU\Software\Tencent\QQNT 只有 version 无 InstallPath
    // 可靠路径来源是卸载项的 DisplayIcon（含完整 exe 路径）
    regQueries: [
      // QQ NT 卸载项（HKLM 32 位 / 64 位 / HKCU）
      {
        key: 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
        value: 'DisplayIcon',
        parse: 'displayIcon'
      },
      {
        key: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
        value: 'DisplayIcon',
        parse: 'displayIcon'
      },
      {
        key: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
        value: 'DisplayIcon',
        parse: 'displayIcon'
      },
      // QQ NT 直接注册表
      {
        key: 'HKCU\\Software\\Tencent\\QQNT',
        value: 'InstallPath',
        parse: 'installPath',
        exeNames: ['QQ.exe']
      },
      {
        key: 'HKLM\\SOFTWARE\\Tencent\\QQNT',
        value: 'InstallPath',
        parse: 'installPath',
        exeNames: ['QQ.exe']
      },
      // 老 QQ（QQ2009 注册表项）
      {
        key: 'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\QQ2009',
        value: 'Install',
        parse: 'installPath',
        exeNames: ['Bin\\QQ.exe', 'QQ.exe']
      },
      {
        key: 'HKLM\\SOFTWARE\\Tencent\\QQ2009',
        value: 'Install',
        parse: 'installPath',
        exeNames: ['Bin\\QQ.exe', 'QQ.exe']
      }
    ],
    uninstallKeywords: ['QQNT', 'QQ NT', 'QQ9', '腾讯QQ'], // TODO: i18n - registry matching keywords
    uninstallExcludeKeywords: [
      // TODO: i18n - registry matching keywords
      'QQPCMgr',
      '电脑管家',
      'QQBrowser',
      '浏览器',
      'QQMusic',
      '音乐',
      'QQVideo',
      '腾讯视频',
      'Tim'
    ],
    candidateExes: ['QQ.exe', 'Bin\\QQ.exe'],
    commonDirs: [
      '%PROGRAMFILES%\\Tencent\\QQNT',
      '%PROGRAMFILES(X86)%\\Tencent\\QQNT',
      '%PROGRAMFILES(X86)%\\Tencent\\QQ',
      '%LOCALAPPDATA%\\Tencent\\QQNT',
      '%LOCALAPPDATA%\\Programs\\Tencent\\QQNT',
      'C:\\Program Files\\Tencent\\QQNT',
      'C:\\Program Files (x86)\\Tencent\\QQNT',
      'C:\\Program Files (x86)\\Tencent\\QQ',
      'D:\\Tencent\\QQNT',
      'D:\\Program Files\\Tencent\\QQNT',
      'E:\\Tencent\\QQNT'
    ],
    processNames: ['QQ.exe']
  },
  vivo: {
    // vivo 办公套件：无固定注册表路径，依赖卸载项 + 常见目录
    regQueries: [],
    uninstallKeywords: ['vivo办公', 'vivo 办公', 'vivooffice', 'vivo-office', 'VivoClient'], // TODO: i18n - registry matching keywords
    uninstallExcludeKeywords: ['vivo手机助手', 'vivo Assistant', 'vivo Assistant'], // TODO: i18n - registry matching keywords
    candidateExes: ['vivooffice.exe', 'vivo-office.exe', 'VivoClient.exe', 'vivo.exe'],
    commonDirs: [
      '%PROGRAMFILES%\\vivo\\vivooffice',
      '%PROGRAMFILES(X86)%\\vivo\\vivooffice',
      '%PROGRAMFILES%\\vivooffice',
      '%PROGRAMFILES(X86)%\\vivooffice',
      '%LOCALAPPDATA%\\vivo\\vivooffice',
      '%LOCALAPPDATA%\\Programs\\vivo\\vivooffice',
      'C:\\Program Files\\vivo\\vivooffice',
      'C:\\Program Files (x86)\\vivo\\vivooffice',
      'D:\\Program Files\\vivo\\vivooffice',
      'D:\\vivo\\vivooffice'
    ],
    processNames: ['vivooffice.exe', 'vivo-office.exe', 'VivoClient.exe']
  }
}

// ============================================================
// 通用工具函数
// =============================================================

/**
 * 构造 CF_HDROP 格式的 Buffer
 * 仅 Windows 平台使用；非 Windows 返回 null
 */
function buildHdropBuffer(filePaths: string[]): Buffer | null {
  if (process.platform !== 'win32' || filePaths.length === 0) return null

  // 拼接 UTF-16LE 路径列表，每条以 \0 分隔，末尾双 \0
  const pathsStr = filePaths.join('\0') + '\0\0'
  const pathsBuf = Buffer.from(pathsStr, 'utf16le')

  // DROPFILES 头：20 字节
  const header = Buffer.alloc(DROPFILES_SIZE, 0)
  header.writeUInt32LE(DROPFILES_SIZE, 0) // pFiles
  header.writeUInt32LE(0, 4) // pt.x
  header.writeUInt32LE(0, 8) // pt.y
  header.writeUInt32LE(0, 12) // fNC = 0
  header.writeUInt32LE(1, 16) // fWide = 1（UTF-16）

  return Buffer.concat([header, pathsBuf])
}

/**
 * 校验文件路径数组：过滤掉不存在或不可访问的文件
 *
 * Slice 7a (P2-5)：同步 fs.statSync → 异步 fs.promises.stat
 *   - 行为等价：过滤逻辑、返回值结构、错误处理均保持一致
 *   - 避免阻塞主进程事件循环（剪贴板复制可能涉及大量文件）
 *   - 已 export 作为公共测试接缝（seam）
 *
 * @returns { valid: string[], skipped: number }
 *   - valid: 通过校验的文件路径（存在且是文件）
 *   - skipped: 跳过的数量（不存在 / 是目录 / stat 抛错）
 */
export async function filterValidPaths(
  filePaths: string[]
): Promise<{ valid: string[]; skipped: number }> {
  const valid: string[] = []
  let skipped = 0
  for (const p of filePaths) {
    try {
      const stat = await fs.promises.stat(p)
      if (stat.isFile()) {
        valid.push(p)
      } else {
        skipped++
      }
    } catch {
      // stat 抛错（ENOENT / EACCES / EPERM 等）统一视为跳过，避免阻塞整个批量校验
      skipped++
    }
  }
  return { valid, skipped }
}

/**
 * 将文件列表复制到剪贴板（CF_HDROP 格式）
 *
 * Slice 7a (P2-5)：改为 async，因为 filterValidPaths 已异步化
 *   - 调用方（share.ts 的 share:copyFiles handler）需用 await
 *   - 行为等价：返回值结构、错误处理、日志记录均保持一致
 */
export async function copyFilesToClipboard(
  filePaths: string[]
): Promise<{ success: boolean; count: number; skipped: number; message: string }> {
  if (!filePaths || filePaths.length === 0) {
    return { success: false, count: 0, skipped: 0, message: t('share.message.noFilesSelected') }
  }

  const { valid, skipped } = await filterValidPaths(filePaths)
  if (valid.length === 0) {
    return {
      success: false,
      count: 0,
      skipped,
      message: t('share.message.allInaccessible')
    }
  }

  try {
    const buf = buildHdropBuffer(valid)
    if (!buf) {
      return {
        success: false,
        count: 0,
        skipped,
        message: t('share.message.unsupportedPlatform')
      }
    }
    clipboard.writeBuffer('CF_HDROP', buf)
    logger.info(`[ShareClipboard] 已复制 ${valid.length} 个文件到剪贴板（跳过 ${skipped} 个）`) // TODO: i18n: internal log
    return {
      success: true,
      count: valid.length,
      skipped,
      message:
        skipped > 0
          ? t('share.message.copiedWithSkipped', { count: valid.length, skipped })
          : t('share.message.copiedToClipboard', { count: valid.length })
    }
  } catch (err) {
    logger.error('[ShareClipboard] 复制失败:', err) // TODO: i18n: internal log
    return {
      success: false,
      count: 0,
      skipped,
      message: t('share.message.copyFailed', {
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

/**
 * 执行注册表查询（同步包装 execFile）
 * 仅 Windows 使用 reg.exe，避免 shell 注入风险
 * 返回原始字符串值（未解析），调用方按需解析
 */
function regQuery(key: string, valueName?: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null)
      return
    }
    const args = valueName ? ['query', key, '/v', valueName] : ['query', key]
    execFile('reg', args, { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      // 解析 reg query 输出，提取 REG_SZ / REG_EXPAND_SZ 值
      // 格式示例：
      //   InstallPath    REG_SZ    C:\Program Files\Tencent\WeChat
      const lines = stdout.split(/\r?\n/)
      for (const line of lines) {
        const m = line.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i)
        if (m) {
          resolve(m[1].trim())
          return
        }
      }
      resolve(null)
    })
  })
}

/**
 * 从 DisplayIcon 字符串提取 exe 路径
 * 格式可能为：X:\path\app.exe 或 "X:\path\app.exe",0 或 X:\path\app.exe,0
 */
function parseDisplayIcon(s: string): string | null {
  if (!s) return null
  // 去掉末尾 ",数字" 和首尾引号
  const cleaned = s
    .replace(/,\s*\d+$/, '')
    .replace(/^"|"$/g, '')
    .trim()
  if (!cleaned.toLowerCase().endsWith('.exe')) return null
  return cleaned
}

/**
 * 在指定目录下查找候选 exe，返回第一个存在的完整路径
 *
 * Slice 7a (P2-5)：同步 fs.existsSync + fs.statSync → 异步 fs.promises.stat + fs.promises.access
 *   - existsSync 替换为 stat（捕获错误判断存在性），与原 existsSync 行为等价
 *   - access 用于 exe 文件存在性检查（不读 metadata，更轻量）
 *   - 行为等价：空目录 / 目录不存在 / 是文件非目录 / 候选 exe 顺序均一致
 *   - 已 export 作为公共测试接缝（seam）
 *
 * @returns 第一个存在的 exe 完整路径，都不存在返回 null
 */
export async function findExeInDir(dir: string, exeNames: string[]): Promise<string | null> {
  if (!dir) return null
  // 检查目录是否存在且是目录
  let dirStat: fs.Stats
  try {
    dirStat = await fs.promises.stat(dir)
  } catch {
    // stat 抛错（ENOENT / EACCES 等）→ 目录不存在或不可访问
    return null
  }
  if (!dirStat.isDirectory()) return null

  // 依次检查候选 exe 是否存在
  for (const exe of exeNames) {
    const full = path.join(dir, exe)
    try {
      await fs.promises.access(full)
      return full
    } catch {
      // access 抛错 → 文件不存在，继续下一个候选
    }
  }
  return null
}

/**
 * 异步检查路径是否存在（替代同步 fs.existsSync）
 *
 * Slice 7a (P2-5)：统一封装 existsSync → promises.access 的转换
 *   - existsSync 返回 boolean，access 通过抛错表示不存在
 *   - 此辅助函数捕获错误返回 boolean，保持与 existsSync 等价的调用风格
 *
 * @returns 路径存在返回 true，不存在或不可访问返回 false
 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p)
    return true
  } catch {
    return false
  }
}

interface UninstallEntry {
  displayName: string
  installLocation: string | null
  displayIcon: string | null
}

/**
 * 枚举注册表卸载项，查找 DisplayName 包含任一关键字（且不含排除词）的项
 * 返回所有匹配项（结构化数据），调用方决定如何使用
 */
function findUninstallEntries(
  keywords: string[],
  excludeKeywords: string[]
): Promise<UninstallEntry[]> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve([])
      return
    }
    // 枚举 HKLM 64位 + 32位 + HKCU 的卸载项
    const roots = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    ]
    let pending = roots.length
    const results: UninstallEntry[] = []

    const check = () => {
      pending--
      if (pending === 0) resolve(results)
    }

    const lowerKeywords = keywords.map((k) => k.toLowerCase())
    const lowerExcludes = excludeKeywords.map((k) => k.toLowerCase())

    for (const root of roots) {
      // /s 递归查询所有子键
      execFile(
        'reg',
        ['query', root, '/s'],
        { timeout: 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) {
            check()
            return
          }
          // 解析输出：每个 HKEY_ 开头的子键下含若干 REG_SZ 值
          const lines = stdout.split(/\r?\n/)
          let currentDisplayName = ''
          let currentInstallLoc = ''
          let currentDisplayIcon = ''

          const flush = () => {
            if (!currentDisplayName) return
            const lowerName = currentDisplayName.toLowerCase()
            // 必须包含任一关键字
            const matched = lowerKeywords.some((k) => lowerName.includes(k))
            // 必须不含任何排除词
            const excluded = lowerExcludes.some((k) => lowerName.includes(k))
            if (matched && !excluded) {
              results.push({
                displayName: currentDisplayName,
                installLocation: currentInstallLoc || null,
                displayIcon: currentDisplayIcon || null
              })
            }
            currentDisplayName = ''
            currentInstallLoc = ''
            currentDisplayIcon = ''
          }

          for (const line of lines) {
            if (line.startsWith('HKEY_')) {
              // 新子键开始，处理上一个
              flush()
            } else {
              const dm = line.match(/DisplayName\s+REG_SZ\s+(.+)/i)
              if (dm) currentDisplayName = dm[1].trim()
              const il = line.match(/InstallLocation\s+REG_SZ\s+(.+)/i)
              if (il) currentInstallLoc = il[1].trim()
              const di = line.match(/DisplayIcon\s+REG_SZ\s+(.+)/i)
              if (di) currentDisplayIcon = di[1].trim()
            }
          }
          flush()
          check()
        }
      )
    }
  })
}

/**
 * 通过 wmic / PowerShell 查询运行中进程的可执行文件路径
 * 兜底场景：注册表和卸载项都没找到，但软件在运行
 * 优先 wmic（启动快），失败回退 PowerShell（兼容 Win11 24H2+）
 */
function getProcessExecutablePath(processName: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null)
      return
    }
    // 1) wmic：传统方案，启动较快
    execFile(
      'wmic',
      ['process', 'where', `name='${processName}'`, 'get', 'ExecutablePath', '/format:list'],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        if (!err && stdout) {
          const m = stdout.match(/ExecutablePath=(.+)/)
          if (m) {
            const p = m[1].trim()
            if (p) {
              // Slice 7a：fs.existsSync → pathExists（异步）
              // Slice 7c-fix：补 .catch() 兜底，pathExists 内部已 try/catch 不会 reject，
              // 此处为防御性兜底，避免未来实现变更时产生 unhandled rejection
              pathExists(p)
                .then((exists) => {
                  if (exists) {
                    resolve(p)
                    return
                  }
                  // 文件不存在，回退到 PowerShell
                  runPowerShellFallback()
                })
                .catch(() => runPowerShellFallback())
              return
            }
          }
        }
        // 2) PowerShell 兜底（wmic 在 Win11 24H2 已移除）
        runPowerShellFallback()
      }
    )

    // PowerShell 兜底逻辑抽为闭包，避免 wmic 路径校验失败时重复代码
    function runPowerShellFallback(): void {
      const psCmd = `(Get-Process -Name '${processName.replace(/\.exe$/i, '')}' -ErrorAction SilentlyContinue | Select-Object -First 1).Path`
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', psCmd],
        { timeout: 4000, windowsHide: true },
        (err2, stdout2) => {
          if (err2 || !stdout2) {
            resolve(null)
            return
          }
          const p = stdout2.trim()
          if (p && p.toLowerCase().endsWith('.exe')) {
            // Slice 7a：fs.existsSync → pathExists（异步）
            // Slice 7c-fix：补 .catch() 兜底，失败时视为路径不存在
            pathExists(p)
              .then((exists) => {
                resolve(exists ? p : null)
              })
              .catch(() => resolve(null))
          } else {
            resolve(null)
          }
        }
      )
    }
  })
}

// 已安装应用的可执行文件路径缓存（避免每次查询注册表）
// F4 修复：增加 TTL，避免用户安装/卸载应用后缓存长期失效
const installPathCache: Record<string, { path: string | null; expireAt: number }> = {}

/**
 * 通用化检测：依次尝试 4 类来源，任一命中即返回
 * 1) 注册表候选位置 → 2) 卸载项枚举 → 3) 常见安装目录 → 4) 进程路径反查
 */
async function detectInstalled(
  channelId: string
): Promise<{ installed: boolean; installPath: string | null }> {
  if (process.platform !== 'win32') {
    return { installed: false, installPath: null }
  }

  // 缓存命中：仅在 TTL 内才复用，过期则重新走 4 层检测
  const cached = installPathCache[channelId]
  if (cached && cached.expireAt > Date.now()) {
    return { installed: !!cached.path, installPath: cached.path }
  }

  const config = DETECTION_CONFIGS[channelId]
  if (!config) {
    return { installed: false, installPath: null }
  }

  let installPath: string | null = null

  try {
    // 1) 注册表候选位置
    for (const item of config.regQueries) {
      const value = await regQuery(item.key, item.value)
      if (!value) continue

      if (item.parse === 'displayIcon') {
        const exe = parseDisplayIcon(value)
        // Slice 7a：fs.existsSync → await pathExists
        if (exe && (await pathExists(exe))) {
          installPath = exe
          break
        }
      } else if (item.parse === 'installPath') {
        // value 是安装目录，在目录下查找候选 exe
        // Slice 7a：findExeInDir 已 async，需 await
        const exe = await findExeInDir(value, item.exeNames || [])
        if (exe) {
          installPath = exe
          break
        }
      }
    }

    // 2) 卸载项枚举
    if (!installPath) {
      const entries = await findUninstallEntries(
        config.uninstallKeywords,
        config.uninstallExcludeKeywords
      )
      for (const entry of entries) {
        // 优先用 DisplayIcon（含完整 exe 路径）
        if (entry.displayIcon) {
          const exe = parseDisplayIcon(entry.displayIcon)
          // Slice 7a：fs.existsSync → await pathExists
          if (exe && (await pathExists(exe))) {
            installPath = exe
            break
          }
        }
        // 其次用 InstallLocation + 候选 exe 名
        if (!installPath && entry.installLocation) {
          // Slice 7a：findExeInDir 已 async，需 await
          const exe = await findExeInDir(entry.installLocation, config.candidateExes)
          if (exe) {
            installPath = exe
            break
          }
        }
      }
    }

    // 3) 常见安装目录扫描
    if (!installPath) {
      for (const dir of config.commonDirs) {
        const resolved = resolveEnv(dir)
        if (!resolved) continue
        // Slice 7a：findExeInDir 已 async，需 await
        const exe = await findExeInDir(resolved, config.candidateExes)
        if (exe) {
          installPath = exe
          break
        }
      }
    }

    // 4) 进程路径反查（运行中才能查到）
    if (!installPath) {
      for (const procName of config.processNames) {
        const exe = await getProcessExecutablePath(procName)
        if (exe) {
          installPath = exe
          break
        }
      }
    }
  } catch (err) {
    logger.warn(`[ShareClipboard] 检测 ${channelId} 安装路径失败:`, err) // TODO: i18n: internal log
  }

  installPathCache[channelId] = {
    path: installPath,
    expireAt: Date.now() + INSTALL_PATH_CACHE_TTL_MS
  }
  return { installed: !!installPath, installPath }
}

/**
 * 检测应用进程是否正在运行
 * 仅 Windows 使用 tasklist（无通配符，进程名必须完整）
 */
function detectRunning(processName: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(false)
      return
    }
    // tasklist /FI "IMAGENAME eq XXX.exe" /NH /FO CSV
    // /FO CSV 输出 CSV 格式便于解析，避免依赖中文输出文本
    execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${processName}`, '/NH', '/FO', 'CSV'],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          // tasklist 在"无匹配"时也可能返回非零退出码
          // 通过 stdout 判断
          if (stdout && !stdout.includes('No tasks') && !stdout.includes('没有运行')) {
            // TODO: i18n - tasklist output matching
            // 输出非空且非"无任务"提示，按 CSV 解析
          } else {
            resolve(false)
            return
          }
        }
        // CSV 输出首列即映像名，例如 "WeChat.exe","1234","Console","1","100,000 K"
        const firstLine = stdout.split(/\r?\n/)[0] || ''
        const match = firstLine.match(/^"([^"]+)"/)
        const imgName = match ? match[1].toLowerCase() : ''
        resolve(imgName === processName.toLowerCase())
      }
    )
  })
}

export interface AppStatus {
  installed: boolean
  running: boolean
  installPath: string | null
}

/**
 * 综合检测应用状态：已安装 + 正在运行
 * 进程名从 installPath 推导（path.basename），兼容新版 Weixin.exe / 老版 WeChat.exe
 */
export async function getAppStatus(channelId: string): Promise<AppStatus> {
  const channel = SHARE_CHANNELS[channelId]
  if (!channel) {
    return { installed: false, running: false, installPath: null }
  }
  const { installed, installPath } = await detectInstalled(channelId)
  let running = false
  if (installed && installPath) {
    // 优先用 installPath 的实际文件名作为进程名（兼容新老版本）
    const processName = path.basename(installPath)
    running = await detectRunning(processName)
  }
  return { installed, running, installPath }
}

/**
 * 启动目标应用
 * @returns 成功启动返回 true；未安装或启动失败返回 false
 */
export async function launchApp(channelId: string): Promise<{ success: boolean; message: string }> {
  const { installed, installPath } = await detectInstalled(channelId)
  if (!installed || !installPath) {
    return { success: false, message: t('share.message.notInstalled') }
  }
  // Slice 7a：fs.existsSync → await pathExists
  if (!(await pathExists(installPath))) {
    return { success: false, message: t('share.message.exeNotExist') }
  }
  return new Promise((resolve) => {
    // F-S2 修复：原实现用 exec(`start "" "${installPath}"`) 通过 shell 解析，存在命令注入风险。
    // 改用 execFile('cmd', ['/c', 'start', '', installPath]) 绕过 shell，参数数组直接传递。
    execFile(
      'cmd',
      ['/c', 'start', '', installPath],
      { timeout: 3000, windowsHide: true },
      (err) => {
        if (err) {
          logger.error(`[ShareClipboard] 启动 ${channelId} 失败:`, err) // TODO: i18n: internal log
          resolve({
            success: false,
            message: t('share.message.launchFailed', { reason: err.message })
          })
        } else {
          logger.info(`[ShareClipboard] 已启动 ${channelId}: ${installPath}`) // TODO: i18n: internal log
          resolve({ success: true, message: t('share.message.launched') })
        }
      }
    )
  })
}
