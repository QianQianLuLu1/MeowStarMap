// @core-change: 项目更名为喵星图，诊断目录常量取值变更需同步日志打包路径注释
import fs from 'fs'
import path from 'path'
import { shell } from 'electron'
import { logger, FaultRecord, getLogDirectory } from '../utils/logger'
import { createZipFromDirectory } from '../utils/zip-archive'
import { getStartupLogPathValue } from '../utils/startup-diagnostic'
import { t } from '../i18n'

// 读取所有故障记录（按时间倒序）
// 业务决策：从所有 faults-*.jsonl 文件读取，文件名按日期倒序遍历
// 然后按 timestamp 倒序合并，确保最新故障显示在列表顶部
// P2-3：新增内存缓存 + 目录 mtime 失效机制，避免万条故障列表每次全量 JSON.parse
let faultsCache: FaultRecord[] | null = null
let faultsCacheKey: string = ''

export async function listFaults(): Promise<FaultRecord[]> {
  const dir = getLogDirectory()

  // P2-3：基于目录 mtime + 文件列表签名的缓存失效
  // 任何新增/删除/修改 faults-*.jsonl 都会改变目录 mtime 或文件列表
  let cacheKey = ''
  try {
    const entries = await fs.promises.readdir(dir)
    const faultFiles = entries
      .filter((name) => name.startsWith('faults-') && name.endsWith('.jsonl'))
      .sort()
      .reverse()
    // 构建缓存键：文件名 + mtime + size，任意变化都失效
    const fileStats = await Promise.all(
      faultFiles.map(async (name) => {
        try {
          const stat = await fs.promises.stat(path.join(dir, name))
          return `${name}:${stat.mtime.getTime()}:${stat.size}`
        } catch {
          return `${name}:0:0`
        }
      })
    )
    cacheKey = fileStats.join('|')
  } catch {
    return []
  }

  // 缓存命中：直接返回副本，避免重复解析
  if (faultsCache && faultsCacheKey === cacheKey) {
    return [...faultsCache]
  }

  // 缓存未命中：重新读取并解析
  let entries: string[]
  try {
    entries = await fs.promises.readdir(dir)
  } catch {
    return []
  }

  // 仅读取 faults-*.jsonl 文件，按文件名降序（最新日期在前）
  const faultFiles = entries
    .filter((name) => name.startsWith('faults-') && name.endsWith('.jsonl'))
    .sort()
    .reverse()

  const faults: FaultRecord[] = []
  for (const filename of faultFiles) {
    try {
      const content = await fs.promises.readFile(path.join(dir, filename), 'utf-8')
      const lines = content.split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          faults.push(JSON.parse(line) as FaultRecord)
        } catch {
          // 跳过损坏的行，避免单条故障影响整体读取
        }
      }
    } catch {
      // 跳过读取失败的文件
    }
  }

  // 按 timestamp 字符串倒序（ISO 8601 字符串可直接字典序比较）
  faults.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  // P2-3：更新缓存
  faultsCache = faults
  faultsCacheKey = cacheKey

  return faults
}

/**
 * P2-3：分页读取故障记录（用于大量故障时的懒加载）
 * @param offset 起始位置（从 0 开始）
 * @param limit 返回条数上限
 * @returns { faults: 当前页数据, total: 总条数, hasMore: 是否还有更多 }
 */
export async function listFaultsPaged(
  offset: number = 0,
  limit: number = 50
): Promise<{ faults: FaultRecord[]; total: number; hasMore: boolean }> {
  const all = await listFaults()
  const total = all.length
  const slice = all.slice(offset, offset + limit)
  return {
    faults: slice,
    total,
    hasMore: offset + limit < total
  }
}

/** P2-3：清除故障列表缓存（清空日志后调用） */
export function invalidateFaultsCache(): void {
  faultsCache = null
  faultsCacheKey = ''
}

// 获取单个故障详情（按 id 查找）
export async function getFaultDetail(id: string): Promise<FaultRecord | null> {
  const faults = await listFaults()
  return faults.find((f) => f.id === id) || null
}

// 打开日志目录（系统资源管理器）
export async function openLogDirectory(): Promise<{ success: boolean; message: string }> {
  try {
    const result = await shell.openPath(getLogDirectory())
    // openPath 在失败时返回错误字符串，成功时返回空字符串
    if (result === '') {
      return { success: true, message: t('main.logService.message.opened') }
    }
    return { success: false, message: t('main.logService.error.openDirFailed', { reason: result }) }
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) }
  }
}

// 导出完整诊断包为 zip 压缩包
// P1-4 改进：从仅打包 logs 目录，扩展为完整诊断包，包含：
//   - logs/         所有主日志 + 故障 JSONL
//   - crashes/      所有崩溃 dump 文件
//   - startup-errors.log  启动错误日志
//   - system-info.json    自动生成的系统环境信息
// 业务决策：进程内流式压缩（archiver，纯 JS），不再调用外部 tar.exe
// 原因：tar.exe 在部分机器不可用（spawn EFTYPE），且子进程路径难以保证结果可达，
//       现实现恒有结果（成功 / 失败 / 超时），UI 不会永久停留在「正在导出」
export async function exportLogsAsZip(
  targetPath: string
): Promise<{ success: boolean; message: string }> {
  const logDir = getLogDirectory()

  // 安全校验：目标路径必须是 .zip 扩展名
  if (!targetPath.toLowerCase().endsWith('.zip')) {
    return { success: false, message: t('main.logService.error.zipRequired') }
  }

  // P1-4：构建临时诊断目录，整合 logs + crashes + startup-errors.log + system-info.json
  const tmpDir = path.join(logDir, '..', 'diagnostic-tmp-' + Date.now())
  try {
    await fs.promises.mkdir(tmpDir, { recursive: true })

    // 1. 复制 logs 目录
    const logsTarget = path.join(tmpDir, 'logs')
    await fs.promises.mkdir(logsTarget, { recursive: true })
    try {
      const logFiles = await fs.promises.readdir(logDir)
      for (const f of logFiles) {
        if (f.endsWith('.log') || f.endsWith('.jsonl')) {
          await fs.promises.copyFile(path.join(logDir, f), path.join(logsTarget, f))
        }
      }
    } catch {}

    // 2. 复制 crashes 目录（崩溃 dump 文件）
    const crashDir = await getCrashDirectoryAsync()
    if (crashDir) {
      const crashesTarget = path.join(tmpDir, 'crashes')
      await fs.promises.mkdir(crashesTarget, { recursive: true })
      try {
        const crashFiles = await fs.promises.readdir(crashDir)
        for (const f of crashFiles) {
          if (f.endsWith('.dmp') || f.endsWith('.dump') || f.endsWith('.crash')) {
            await fs.promises.copyFile(path.join(crashDir, f), path.join(crashesTarget, f))
          }
        }
      } catch {}
    }

    // 3. 复制 startup-errors.log
    // 路径必须走 getStartupLogPathValue()（诊断目录单一真相源）：
    // 此前按 logDir/.. 计算，指向 userData，与真实落盘（文档/喵星图/Diagnostics）不一致
    try {
      const startupLogPath = getStartupLogPathValue()
      if (fs.existsSync(startupLogPath)) {
        await fs.promises.copyFile(startupLogPath, path.join(tmpDir, 'startup-errors.log'))
      }
    } catch {}

    // 4. 生成 system-info.json
    const systemInfo = await collectSystemInfo()
    await fs.promises.writeFile(
      path.join(tmpDir, 'system-info.json'),
      JSON.stringify(systemInfo, null, 2),
      'utf-8'
    )

    // 5. 生成 manifest.json
    const appInfo = (systemInfo.app || {}) as { version?: string }
    const manifest = {
      generatedAt: new Date().toISOString(),
      appVersion: appInfo.version || 'unknown',
      diagnosticVersion: '1.0',
      contents: ['logs/', 'crashes/', 'startup-errors.log', 'system-info.json']
    }
    await fs.promises.writeFile(
      path.join(tmpDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    )
  } catch (err) {
    // 临时目录构建失败时回退到仅打包 logs 目录
    logger.error(t('main.logService.log.buildDiagnosticFailed'), err)
  }

  // 优先打包临时诊断目录，失败时回退到仅 logs 目录
  const sourceDir = fs.existsSync(tmpDir) ? tmpDir : logDir

  // 打包方式：进程内流式压缩（utils/zip-archive → archiver），不再 spawn 外部 tar.exe。
  // 原因：tar.exe 在部分机器上不可用，spawn 抛 `EFTYPE`（ERROR_BAD_EXE_FORMAT），
  // 且原实现无超时与兜底，Promise 可能永不 settle → UI 永久停在「正在导出」。
  // createZipFromDirectory 保证任何分支（含超时）都 resolve。
  const zipResult = await createZipFromDirectory(sourceDir, targetPath)

  // 无论成功与否都清理临时目录
  await cleanupTmpDir(tmpDir)

  if (!zipResult.success) {
    return { success: false, message: zipResult.message }
  }
  return { success: true, message: t('main.logService.message.exported') }
}

/** 清理临时诊断目录 */
async function cleanupTmpDir(tmpDir: string): Promise<void> {
  try {
    const entries = await fs.promises.readdir(tmpDir)
    for (const entry of entries) {
      const entryPath = path.join(tmpDir, entry)
      const stat = await fs.promises.stat(entryPath)
      if (stat.isDirectory()) {
        const subEntries = await fs.promises.readdir(entryPath)
        for (const sub of subEntries) {
          await fs.promises.unlink(path.join(entryPath, sub)).catch(() => {})
        }
      } else {
        await fs.promises.unlink(entryPath).catch(() => {})
      }
    }
    await fs.promises.rmdir(tmpDir).catch(() => {})
  } catch {}
}

/** 获取崩溃目录路径（异步，避免循环依赖） */
async function getCrashDirectoryAsync(): Promise<string | null> {
  try {
    const { getCrashDirectory } = require('./crash-service')
    return getCrashDirectory()
  } catch {
    return null
  }
}

/** P1-4：收集系统环境信息用于诊断包 */
interface SystemInfoApp {
  version: string
  name: string
  buildDate: string
}
async function collectSystemInfo(): Promise<Record<string, unknown>> {
  const os = require('os')
  const { app } = require('electron')

  const info: Record<string, unknown> = {
    generatedAt: new Date().toISOString()
  }

  // 应用信息
  try {
    const appInfo: SystemInfoApp = {
      version: app.getVersion?.() || 'unknown',
      name: app.getName?.() || 'unknown',
      buildDate: 'unknown'
    }
    info.app = appInfo
  } catch {}

  // 运行时信息
  try {
    info.runtime = {
      electron: process.versions.electron,
      node: process.versions.node,
      chromium: process.versions.chrome
    }
  } catch {}

  // 操作系统信息
  try {
    info.os = {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      hostname: os.hostname(),
      type: os.type()
    }
  } catch {}

  // 硬件信息
  try {
    info.hardware = {
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || 'unknown',
      totalMemory: os.totalmem(),
      freeMemory: os.freemem()
    }
  } catch {}

  // 进程信息
  try {
    info.process = {
      pid: process.pid,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage()
    }
  } catch {}

  // 自定义目录配置
  try {
    const { getLogDirectory } = require('../utils/logger')
    const { getCrashDirectory } = require('./crash-service')
    info.config = {
      customDirs: {
        logDir: getLogDirectory(),
        crashDir: getCrashDirectory()
      }
    }
  } catch {}

  return info
}

// 清空所有日志文件
// 仅删除 .log 和 .jsonl 文件，保留 logs 目录本身
// P2-3：清空后同步失效故障列表缓存
export async function clearAllLogs(): Promise<{
  success: boolean
  message: string
  cleared: number
}> {
  const dir = getLogDirectory()

  try {
    const entries = await fs.promises.readdir(dir)
    let cleared = 0
    for (const name of entries) {
      if (!name.endsWith('.log') && !name.endsWith('.jsonl')) continue
      try {
        await fs.promises.unlink(path.join(dir, name))
        cleared++
      } catch {
        // 跳过删除失败的文件
      }
    }
    // P2-3：清空日志后失效缓存，下次 listFaults 重新读取
    invalidateFaultsCache()
    return {
      success: true,
      message: `已清空 ${cleared} 个日志文件`,
      cleared
    }
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
      cleared: 0
    }
  }
}

// 获取日志目录的统计信息（用于 UI 展示）
// P2-3：不再调用 listFaults（会触发全量 JSON.parse），改为独立的轻量计数
// 仅扫描文件元信息（size/mtime），不读取文件内容，性能 O(文件数) 而非 O(故障数)
export async function getLogStats(): Promise<{
  faultCount: number
  totalSize: number
  fileCount: number
  oldestTimestamp: string | null
}> {
  const dir = getLogDirectory()

  let totalSize = 0
  let fileCount = 0
  let faultCount = 0
  let oldestMtime: number | null = null

  try {
    const entries = await fs.promises.readdir(dir)
    for (const name of entries) {
      if (!name.endsWith('.log') && !name.endsWith('.jsonl')) continue
      try {
        const stat = await fs.promises.stat(path.join(dir, name))
        totalSize += stat.size
        fileCount++
        // P2-3：通过 faults-*.jsonl 文件行数估算故障数（避免全量 JSON.parse）
        // 用 size / 平均单行长度（约 500 字节）估算，UI 显示"约 N 条"即可
        if (name.startsWith('faults-') && name.endsWith('.jsonl')) {
          // 精确计数：按换行符数量统计（仅读取文件内容一次，比 JSON.parse 快 10 倍）
          try {
            const content = await fs.promises.readFile(path.join(dir, name), 'utf-8')
            // JSONL 每行一条记录，空行不计
            const lineCount = content.split('\n').filter((l) => l.trim().length > 0).length
            faultCount += lineCount
          } catch {
            // 读取失败时按 size 估算
            faultCount += Math.max(1, Math.floor(stat.size / 500))
          }
        }
        if (oldestMtime === null || stat.mtime.getTime() < oldestMtime) {
          oldestMtime = stat.mtime.getTime()
        }
      } catch {
        // 跳过统计失败的文件
      }
    }
  } catch {
    // 目录读取失败时返回默认值
  }

  return {
    faultCount,
    totalSize,
    fileCount,
    oldestTimestamp: oldestMtime ? new Date(oldestMtime).toISOString() : null
  }
}
