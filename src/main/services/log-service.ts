// @core-change: 诊断包暂存目录名加进程内递增序号，修同毫秒并发导出互删暂存
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app, shell } from 'electron'
import { logger, FaultRecord, getLogDirectory } from '../utils/logger'
import { createZipFromDirectory } from '../utils/zip-archive'
import { getStartupLogPathValue } from '../utils/startup-diagnostic'
import { CHROMIUM_LOG_BASENAME } from '../utils/user-diag-path'
import {
  getForensicsRoot,
  getForensicsFilePath,
  getForensicsRootSource,
  FORENSICS_ROOT_FILE_NAMES
} from '../utils/forensics-dir'
import { DIAGNOSTIC_FILE_NAMES } from '../app/shell/diagnostic-files'
import { t } from '../i18n'

/**
 * 原生日志进包的上限：只保留尾部这么多字节。
 * Chromium 的 FATAL 写在最后，滚动后的 chromium-debug.log 头部全是历史噪音；
 * 2MB 足够覆盖「GPU process exited unexpectedly: exit_code=…」与其后的 FATAL。
 */
export const DIAG_LOG_TAIL_BYTES = 2 * 1024 * 1024

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

/**
 * R-a2：暂存目录名的进程内递增序号。仅用 Date.now() 时同毫秒并发导出会共用
 * 同一暂存目录，先完成者的 cleanupTmpDir 把后完成者正在打包的暂存整个删掉。
 */
let diagnosticTmpSeq = 0

export async function exportLogsAsZip(
  targetPath: string
): Promise<{ success: boolean; message: string }> {
  const logDir = getLogDirectory()

  // 安全校验：目标路径必须是 .zip 扩展名
  if (!targetPath.toLowerCase().endsWith('.zip')) {
    return { success: false, message: t('main.logService.error.zipRequired') }
  }

  // P1-4：构建临时诊断目录，整合 logs + crashes + startup-errors.log + system-info.json
  // 暂存目录固定落取证根（不随 logDir 漂移）：异常退出残留也只在统一目录内
  const tmpDir = path.join(getForensicsRoot(), `diagnostic-tmp-${Date.now()}-${++diagnosticTmpSeq}`)
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

    // 3.5 复制取证根里的 Chromium 原生日志
    //     原生 FATAL（如 "GPU process isn't usable. Goodbye."）不经过 Node，
    //     startup-errors.log 里永远没有它；exit_code 只存在于 chromium-debug.log。
    //     读取侧必须与写入侧（index.ts --log-file）同源走取证根——此前读 Documents
    //     回退目录，打包态（取证根=安装目录）导出包系统性缺这份原生 FATAL 证据。
    //     逐文件容错：chromium-debug.log 被占用（防护软件抓刚落地的日志是常态）
    //     不得连后面的 diag.log 一起丢掉。
    try {
      for (const name of [CHROMIUM_LOG_BASENAME, `${CHROMIUM_LOG_BASENAME}.old`, 'diag.log']) {
        try {
          const src = getForensicsFilePath(name)
          if (fs.existsSync(src)) {
            await copyBounded(src, path.join(tmpDir, name), DIAG_LOG_TAIL_BYTES)
          }
        } catch (err) {
          logger.warn(`diagnostic bundle: skipped ${name}`, err)
        }
      }
    } catch (err) {
      logger.warn('diagnostic bundle: forensics root unavailable', err)
    }

    // 3.6 GPU 兼容阶梯状态：判断设备卡在哪一级、失败计数多少，只看这一个文件
    try {
      const gpuStatePath = getForensicsFilePath('gpu-fallback.json')
      if (fs.existsSync(gpuStatePath)) {
        await fs.promises.copyFile(gpuStatePath, path.join(tmpDir, 'gpu-fallback.json'))
      }
    } catch {}

    // 3.7 硬件加速偏好镜像：用户是否手动关过硬件加速（花屏取证的另一半事实）
    try {
      const gpuPrefPath = getForensicsFilePath('gpu-pref.json')
      if (fs.existsSync(gpuPrefPath)) {
        await fs.promises.copyFile(gpuPrefPath, path.join(tmpDir, 'gpu-pref.json'))
      }
    } catch {}

    // 3.8 其余根级取证文件（退出取证/单实例握手/启动成功标记），逐文件 fail-open
    const handledRootFiles = new Set<string>([
      CHROMIUM_LOG_BASENAME,
      `${CHROMIUM_LOG_BASENAME}.old`,
      'diag.log',
      'startup-errors.log',
      'gpu-fallback.json',
      'gpu-pref.json'
    ])
    for (const name of FORENSICS_ROOT_FILE_NAMES) {
      if (handledRootFiles.has(name)) continue
      try {
        const src = getForensicsFilePath(name)
        if (fs.existsSync(src)) {
          await fs.promises.copyFile(src, path.join(tmpDir, name))
        }
      } catch (err) {
        logger.warn(`diagnostic bundle: skipped ${name}`, err)
      }
    }

    // 3.9 NikkiSync 聚合诊断（5 文件白名单，取证根\nikkisync）；缺席不建目录，
    //     manifest.missing 如实登记 'nikkisync/'
    try {
      const nikkiSrcDir = path.join(getForensicsRoot(), 'nikkisync')
      const nikkiDstDir = path.join(tmpDir, 'nikkisync')
      for (const name of DIAGNOSTIC_FILE_NAMES) {
        try {
          const src = path.join(nikkiSrcDir, name)
          if (fs.existsSync(src)) {
            await fs.promises.mkdir(nikkiDstDir, { recursive: true })
            await fs.promises.copyFile(src, path.join(nikkiDstDir, name))
          }
        } catch (err) {
          logger.warn(`diagnostic bundle: skipped nikkisync/${name}`, err)
        }
      }
    } catch {}

    // 4. 生成 system-info.json
    const systemInfo = await collectSystemInfo()
    await fs.promises.writeFile(
      path.join(tmpDir, 'system-info.json'),
      JSON.stringify(systemInfo, null, 2),
      'utf-8'
    )

    // 5. 生成 manifest.json（如实化：contents 按实际入包条目登记，期望但缺席的进 missing。
    //    旧版 contents 是静态期望清单——chromium-debug.log 缺席时仍声称包含，取证方被误导）
    const appInfo = (systemInfo.app || {}) as { version?: string }
    const expectedOptional: string[] = [...FORENSICS_ROOT_FILE_NAMES, 'nikkisync/']
    let contents: string[] = ['logs/', 'crashes/', ...expectedOptional, 'system-info.json']
    let missing: string[] = []
    try {
      const entries = await fs.promises.readdir(tmpDir, { withFileTypes: true })
      const names = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      contents = [...names.sort(), 'manifest.json']
      missing = expectedOptional.filter((name) => !names.includes(name))
    } catch {
      // 目录读取失败时保留静态期望清单（兜底，不阻断导出）
    }
    const manifest = {
      generatedAt: new Date().toISOString(),
      appVersion: appInfo.version || 'unknown',
      diagnosticVersion: '1.2',
      contents,
      missing
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

/**
 * 有界复制：不超过 maxBytes 就整份 copyFile；超限只把尾部读出来写入。
 * 用于 Chromium 原生日志（可滚动到 10MB），FATAL 总在文件末尾，保留尾部即可。
 */
async function copyBounded(src: string, dst: string, maxBytes: number): Promise<void> {
  const size = (await fs.promises.stat(src)).size
  if (size <= maxBytes) {
    await fs.promises.copyFile(src, dst)
    return
  }
  const handle = await fs.promises.open(src, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    await handle.read(buf, 0, maxBytes, size - maxBytes)
    await fs.promises.writeFile(dst, buf)
  } finally {
    await handle.close().catch(() => {})
  }
}

/** 清理临时诊断目录（递归：含 logs/ crashes/ nikkisync/ 子目录，不留残留） */
async function cleanupTmpDir(tmpDir: string): Promise<void> {
  try {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
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
  // os / app 走模块顶部的静态 import：此前这里写的是裸 require('os') / require('electron')，
  // 而 CI 用 npm ci --ignore-scripts 装依赖（electron 的 postinstall 不跑 ⇒ 无 path.txt），
  // node_modules/electron/index.js 在被 require 时直接抛「Electron failed to install correctly」，
  // 这两行又不在任何 try 内 ⇒ collectSystemInfo 抛出 ⇒ exportLogsAsZip 的外层 catch 接管，
  // system-info.json 与 manifest.json 双双缺席（CI run #31 的 shard 10 与 Coverage Gate 同一条红）。
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

  // GPU 状态（花屏取证：显卡型号/驱动/活动显卡 + 兼容档位）。动态引入避免 services→app
  // 静态耦合；探针自带三级 fail-open，这里再兜一层：任何失败 ⇒ gpu=null，不拖垮诊断包。
  try {
    const { collectGpuStatus } = await import('../app/gpu-status')
    info.gpu = await collectGpuStatus()
  } catch {
    info.gpu = null
  }

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

  // 取证根与候选来源：取证方据此判断 install（安装目录）/ fallback（Documents 链）
  try {
    info.forensics = {
      root: getForensicsRoot(),
      source: getForensicsRootSource()
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
