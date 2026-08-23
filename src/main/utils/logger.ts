import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'
import electronLog from 'electron-log'
import { t } from '../i18n'

// 日志级别
type LogLevel = 'info' | 'warn' | 'error' | 'debug'

// 故障类型
export type FaultType =
  | 'uncaughtException' // 主进程未捕获异常
  | 'unhandledRejection' // 未处理的 Promise 拒绝
  | 'rendererCrash' // 渲染进程崩溃
  | 'rendererError' // 渲染层 console.error
  | 'ipcError' // IPC 处理错误
  | 'manual' // 手动记录
  | 'rendererComponent' // ErrorBoundary 捕获的组件渲染异常
  | 'rendererPromise' // 渲染层未处理 Promise 拒绝
  | 'rendererResource' // 渲染层资源加载失败（window.onerror）
  | 'exitDiagnosis' // 进程退出诊断信息
  | 'workerCrash' // utilityProcess 异常退出
  | 'workerRestart' // utilityProcess 自动重启
  | 'databaseCorruption' // 数据库完整性校验失败
  | 'databaseRestore' // 数据库从备份恢复
  | 'indexingTimeout' // 索引链整体超时（fire-and-forget 兜底）
  | 'renderer-not-ready' // 渲染进程就绪超时（疑似白屏）

// 故障记录（用于 UI 展示）
// P0-1 改进：扩展字段，每条故障都包含完整的环境信息，便于开发者定位问题
export interface FaultRecord {
  id: string
  timestamp: string // ISO 8601
  type: FaultType
  summary: string // 故障原因摘要（≤200字符）
  detail: string // 完整错误信息和堆栈
  context?: Record<string, unknown> // 操作上下文
  file: string // 故障所在文件名
  // 环境信息（logFault 自动填充，调用方无需关心）
  appVersion: string // package.json version
  electronVersion: string // process.versions.electron
  nodeVersion: string // process.versions.node
  platform: string // process.platform
  osVersion: string // os.release()
  pid: number // process.pid
  uptime: number // process.uptime() 秒
}

// 故障类型中文映射（诊断面板展示，走 i18n，复用 faultTypes 命名空间）
// t() 延迟到首次访问时解析（Proxy 懒加载缓存），不在模块顶层调用：
// 使 logger 模块在任意加载时机 / 任意进程都安全，不依赖 i18n 初始化顺序，
// 也避免被 preload 等外部模块误引入时在加载期触发主进程 i18n 顶层求值。
let faultTypeLabelsCache: Record<FaultType, string> | null = null

function buildFaultTypeLabels(): Record<FaultType, string> {
  return {
    uncaughtException: t('faultTypes.uncaughtException'),
    unhandledRejection: t('faultTypes.unhandledRejection'),
    rendererCrash: t('faultTypes.rendererCrash'),
    rendererError: t('faultTypes.rendererError'),
    ipcError: t('faultTypes.ipcError'),
    manual: t('faultTypes.manual'),
    rendererComponent: t('faultTypes.rendererComponent'),
    rendererPromise: t('faultTypes.rendererPromise'),
    rendererResource: t('faultTypes.rendererResource'),
    exitDiagnosis: t('faultTypes.exitDiagnosis'),
    workerCrash: t('faultTypes.workerCrash'),
    workerRestart: t('faultTypes.workerRestart'),
    databaseCorruption: t('faultTypes.databaseCorruption'),
    databaseRestore: t('faultTypes.databaseRestore'),
    indexingTimeout: t('faultTypes.indexingTimeout'),
    'renderer-not-ready': t('faultTypes.renderer-not-ready')
  }
}

export const FAULT_TYPE_LABELS: Record<FaultType, string> = new Proxy(
  {} as Record<FaultType, string>,
  {
    get(_target, prop: string | symbol) {
      if (!faultTypeLabelsCache) faultTypeLabelsCache = buildFaultTypeLabels()
      return (faultTypeLabelsCache as Record<string, string>)[prop as string]
    },
    ownKeys() {
      if (!faultTypeLabelsCache) faultTypeLabelsCache = buildFaultTypeLabels()
      return Reflect.ownKeys(faultTypeLabelsCache)
    },
    getOwnPropertyDescriptor(_target, prop: string | symbol) {
      if (!faultTypeLabelsCache) faultTypeLabelsCache = buildFaultTypeLabels()
      const has = Object.prototype.hasOwnProperty.call(faultTypeLabelsCache, prop)
      return has
        ? {
            enumerable: true,
            configurable: true,
            value: (faultTypeLabelsCache as Record<string, string>)[prop as string]
          }
        : undefined
    },
    has(_target, prop: string | symbol) {
      if (!faultTypeLabelsCache) faultTypeLabelsCache = buildFaultTypeLabels()
      return Object.prototype.hasOwnProperty.call(faultTypeLabelsCache, prop)
    }
  }
)

// 业务决策：日志总占用上限 2GB（P2-4 从 5GB 调整为 2GB，桌面应用足够）
// C-G11：project_memory 硬约束为"日志存储必须不超过 5GB"，2GB 上限满足该约束且更保守
// 超限时按 mtime 升序删除最旧日志文件，直至低于阈值
const MAX_TOTAL_LOG_SIZE = 2 * 1024 * 1024 * 1024
// P2-4：日志时间维度过期（90 天），超过自动清理
const MAX_LOG_AGE_MS = 90 * 24 * 60 * 60 * 1000
const MAX_SUMMARY_LENGTH = 200

// P1-3：最近日志环形缓冲区，故障发生时附带最近 N 条主日志作为上下文
const RECENT_LOG_BUFFER_SIZE = 50
const recentLogs: Array<{ timestamp: string; level: string; message: string }> = []

let logDir = ''

// P2-4 写放大优化：时间窗口节流 + 内存累加估算，避免每条故障写入都全量扫描日志目录
// 时间窗口：距上次真实扫描不足 ENFORCE_INTERVAL_MS 时跳过，仅登记待执行，窗口结束后补跑一次
// 内存估算：累计写入字节超过阈值（≈200MB）时立即扫描，绕过时间窗口，确保 2GB 上限不被高频大日志击穿
const ENFORCE_INTERVAL_MS = 8000
const ENFORCE_SIZE_THRESHOLD = 200 * 1024 * 1024
let lastEnforceAt = 0
let totalApproxBytes = 0
let pendingEnforce = false
let enforcing = false
let enforceTimer: ReturnType<typeof setTimeout> | null = null

// 初始化日志目录（必须在 app.whenReady 之后调用）
export function initLogger(): void {
  if (logDir) return
  logDir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(logDir, { recursive: true })
}

export function getLogDirectory(): string {
  if (!logDir) initLogger()
  return logDir
}

/**
 * 自定义目录支持：设置日志目录路径
 * 必须在 initLogger() 之前调用（由 applyCustomDirectories 触发）
 * 设置后 initLogger() 的幂等守卫会跳过默认路径初始化
 */
export function setLogDirectory(dir: string): void {
  logDir = dir
}

// 获取当前日期字符串（UTC，保证跨时区一致）
function getDateStr(): string {
  return new Date().toISOString().slice(0, 10)
}

// 常规日志文件（按日期滚动）
function getMainLogPath(): string {
  return path.join(logDir, `main-${getDateStr()}.log`)
}

// 故障日志文件（按日期滚动，JSONL 格式）
function getFaultLogPath(): string {
  return path.join(logDir, `faults-${getDateStr()}.jsonl`)
}

// 计算 electron-log 兜底文件路径
// 目的：app.whenReady() 之前 app.getPath('userData') 会抛错，此时 logDir 尚未初始化，
// 用 APPDATA / tmp 兜底，确保 electron-log 早期也能落盘，不抛错也不吞日志。
function getFallbackElectronLogPath(): string {
  try {
    const userData = app.getPath('userData')
    return path.join(userData, 'logs', 'main.log')
  } catch {
    // app.whenReady() 之前触发：回退到 APPDATA（Windows 一定存在）
    const appData = process.env.APPDATA
    if (appData) return path.join(appData, 'wxnn-photo-manager', 'logs', 'main.log')
    return path.join(os.tmpdir(), 'wxnn-photo-manager-logs', 'main.log')
  }
}

// electron-log 统一错误落盘：把主进程日志同步导向 electron-log 的 file transport
// 保留现有 logger 的 writeLog / logFault / 控制台 / diagLog 行为，此为额外增强
const electronLogger = electronLog.create({ logId: 'main' })
electronLogger.transports.file.level = 'info'
electronLogger.transports.file.resolvePathFn = () =>
  logDir ? path.join(logDir, 'main.log') : getFallbackElectronLogPath()

// 供 index.ts 等外部模块在 unhandledRejection 等处直接写入 electron-log
export { electronLogger }

// P1-3：推入最近日志缓冲区（环形，超限自动淘汰最旧）
function pushToRecentBuffer(level: string, message: string): void {
  recentLogs.push({ timestamp: new Date().toISOString(), level, message })
  if (recentLogs.length > RECENT_LOG_BUFFER_SIZE) {
    recentLogs.shift()
  }
}

/** 获取最近日志缓冲区副本（用于故障上下文） */
export function getRecentLogs(): Array<{ timestamp: string; level: string; message: string }> {
  return [...recentLogs]
}

// 写入常规日志（异步、低开销，不阻塞主线程）
function writeLog(level: LogLevel, message: string, ...args: unknown[]): void {
  if (!logDir) initLogger()
  const timestamp = new Date().toISOString()
  const argsStr =
    args.length > 0
      ? ' ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
      : ''
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${argsStr}\n`
  // P1-3：同步推入环形缓冲区（内存操作，零开销）
  pushToRecentBuffer(level, message + argsStr)
  // 异步写入，失败时至少在控制台暴露问题，便于排查磁盘满/权限问题
  fs.promises.appendFile(getMainLogPath(), line, 'utf-8').catch((err) => {
    // 中文保留（有意）：logger 是 i18n 不可用时的最后兜底输出渠道，且初始化早于 i18n
    console.error('[Logger] 写入失败:', err)
  })
  // 同步输出到控制台（开发调试）
  const consoleFn = level === 'debug' ? console.log : console[level]
  consoleFn(message, ...args)
  // electron-log 统一落盘（与自定义格式并存，增强外部可诊断性）
  electronLogger[level].call(electronLogger, message, ...args)
}

// P0-1：收集环境信息（logFault 调用时自动填充到 FaultRecord）
// 使用懒加载避免启动早期 app.getVersion() 不可用
let envInfoCache: {
  appVersion: string
  electronVersion: string
  nodeVersion: string
  platform: string
  osVersion: string
} | null = null

function collectEnvInfo(): {
  appVersion: string
  electronVersion: string
  nodeVersion: string
  platform: string
  osVersion: string
} {
  if (envInfoCache) return envInfoCache
  try {
    envInfoCache = {
      appVersion: app.getVersion?.() || 'unknown',
      electronVersion: process.versions.electron || 'unknown',
      nodeVersion: process.versions.node || 'unknown',
      platform: process.platform,
      osVersion: os.release()
    }
  } catch {
    // 启动早期 app.getVersion 可能不可用，回退到 unknown
    envInfoCache = {
      appVersion: 'unknown',
      electronVersion: process.versions.electron || 'unknown',
      nodeVersion: process.versions.node || 'unknown',
      platform: process.platform,
      osVersion: os.release()
    }
  }
  return envInfoCache
}

// 构建故障记录（logFault / logFaultSync 共用，保证两条路径记录结构一致）
// P0-1：自动填充环境信息字段；P1-3：自动附带 recentLogs 上下文
function buildFaultRecord(
  type: FaultType,
  error: unknown,
  context?: Record<string, unknown>
): FaultRecord {
  const id = crypto.randomUUID()
  const timestamp = new Date().toISOString()
  const errObj = error instanceof Error ? error : new Error(String(error))
  const summary = (errObj.message || String(error)).slice(0, MAX_SUMMARY_LENGTH)

  // P1-3：将最近日志缓冲区附加到 context（仅对关键故障类型，避免日志膨胀）
  const finalContext: Record<string, unknown> = { ...(context || {}) }
  if (
    type === 'uncaughtException' ||
    type === 'unhandledRejection' ||
    type === 'rendererCrash' ||
    type === 'rendererComponent' ||
    type === 'exitDiagnosis' ||
    type === 'workerCrash' ||
    type === 'workerRestart' ||
    type === 'databaseCorruption' ||
    type === 'databaseRestore'
  ) {
    finalContext.recentLogs = getRecentLogs()
  }

  // 构造完整详情（包含堆栈和上下文）
  const detailParts: string[] = [`Message: ${errObj.message}`, `Stack: ${errObj.stack || 'N/A'}`]
  if (finalContext && Object.keys(finalContext).length > 0) {
    detailParts.push(`Context: ${JSON.stringify(finalContext, null, 2)}`)
  }
  const detail = detailParts.join('\n')

  // P0-1：自动填充环境信息
  const env = collectEnvInfo()

  return {
    id,
    timestamp,
    type,
    summary,
    detail,
    context: finalContext,
    file: `faults-${getDateStr()}.jsonl`,
    appVersion: env.appVersion,
    electronVersion: env.electronVersion,
    nodeVersion: env.nodeVersion,
    platform: env.platform,
    osVersion: env.osVersion,
    pid: process.pid,
    uptime: process.uptime()
  }
}

// 故障记录的公共尾部副作用：2GB 节流 + 主日志摘要 + electron-log 落盘
// 同步路径（logFaultSync）下这些是次要副作用，失败不能影响故障记录主流程
function writeFaultSideEffects(type: FaultType, record: FaultRecord): void {
  try {
    // 节流触发 2GB 大小检查（避免每次写入都扫描目录）
    scheduleSizeEnforcement()
    // 同步记录到主日志（便于运维排查时一站式查看）
    writeLog('error', `[Fault:${type}] ${record.summary}`)
    // electron-log 统一落盘故障记录，便于外部工具解析
    electronLogger.error(`[Fault:${type}] ${record.summary}`, { record })
  } catch {
    // 副作用失败仅忽略，不影响故障记录写入
  }
}

// 记录故障（异步、轻量）
// 性能策略：仅追加写入一行 JSON，O(1) 复杂度；2GB 检查通过节流异步触发
export async function logFault(
  type: FaultType,
  error: unknown,
  context?: Record<string, unknown>
): Promise<string> {
  if (!logDir) initLogger()
  const record = buildFaultRecord(type, error, context)

  // 异步追加 JSONL（每行一个故障，O(1) 写入）；同时累加估算写入字节，供写放大节流判断
  try {
    const line = JSON.stringify(record) + '\n'
    await fs.promises.appendFile(getFaultLogPath(), line, 'utf-8')
    totalApproxBytes += Buffer.byteLength(line, 'utf-8')
  } catch (err) {
    // 写入失败时仅控制台告警，避免日志系统本身导致崩溃扩散
    // 中文保留（有意）：logger 是 i18n 不可用时的最后兜底输出渠道，且初始化早于 i18n
    console.error('[Logger] 故障日志写入失败:', err)
  }

  writeFaultSideEffects(type, record)
  return record.id
}

/**
 * 同步写盘通道：崩溃退出竞态专用。
 * 供 uncaughtException 等在 app.exit() 前调用——异步 fs.promises.appendFile
 * 尚未完成时进程可能已被终止，最关键的崩溃记录反而最容易丢；
 * 此处用 fs.appendFileSync 追加单行 JSON，确保退出前记录已落盘。
 */
export function logFaultSync(
  type: FaultType,
  error: unknown,
  context?: Record<string, unknown>
): string {
  if (!logDir) initLogger()
  const record = buildFaultRecord(type, error, context)

  // 同步追加 JSONL（阻塞写盘，保证崩溃记录不因退出竞态丢失）
  try {
    const line = JSON.stringify(record) + '\n'
    fs.appendFileSync(getFaultLogPath(), line, 'utf-8')
    totalApproxBytes += Buffer.byteLength(line, 'utf-8')
  } catch (err) {
    // 写入失败时仅控制台告警，避免日志系统本身导致崩溃扩散
    // 中文保留（有意）：logger 是 i18n 不可用时的最后兜底输出渠道，且初始化早于 i18n
    console.error('[Logger] 故障日志写入失败:', err)
  }

  writeFaultSideEffects(type, record)
  return record.id
}

// 写放大节流：时间窗口 + 内存累加估算双策略
// 1) 内存估算触发：累计写入超阈值时立即扫描，绕过时间窗口（防止 2GB 上限被高频大日志击穿）
// 2) 时间窗口：距上次真实扫描 ≥ ENFORCE_INTERVAL_MS 才扫描；窗口内仅登记，窗口结束补跑一次
function scheduleSizeEnforcement(): void {
  const now = Date.now()

  // 内存估算触发：累计写入超阈值，立即扫描，绕过时间窗口
  if (totalApproxBytes >= ENFORCE_SIZE_THRESHOLD) {
    runEnforcement(now)
    return
  }

  // 时间窗口已过期：立即扫描
  if (now - lastEnforceAt >= ENFORCE_INTERVAL_MS) {
    runEnforcement(now)
    return
  }

  // 窗口内：仅登记待执行，窗口结束后补跑一次（合并窗口内所有积压调用）
  if (!pendingEnforce) {
    pendingEnforce = true
    const delayMs = ENFORCE_INTERVAL_MS - (now - lastEnforceAt)
    enforceTimer = setTimeout(() => {
      enforceTimer = null
      runEnforcement(Date.now())
    }, delayMs)
  }
}

// 执行一次真实大小检查并重置节流状态；enforcing 守卫避免并发扫描重叠
function runEnforcement(now: number): void {
  if (enforcing) return
  enforcing = true
  lastEnforceAt = now
  pendingEnforce = false
  totalApproxBytes = 0 // 真实扫描后以磁盘实际占用为准，重新开始累加
  if (enforceTimer) {
    clearTimeout(enforceTimer)
    enforceTimer = null
  }
  enforceMaxSize()
    .catch(() => {})
    .finally(() => {
      enforcing = false
    })
}

// P2-4：2GB 上限检查 + 90 天时间维度过期清理
// 扫描整个日志目录，先按时间维度删除超过 90 天的日志，再按大小维度删除最旧文件
async function enforceMaxSize(): Promise<void> {
  try {
    const entries = await fs.promises.readdir(logDir)
    const stats = await Promise.all(
      entries
        .filter((name) => name.endsWith('.log') || name.endsWith('.jsonl'))
        .map(async (name) => {
          const filepath = path.join(logDir, name)
          const stat = await fs.promises.stat(filepath)
          return { name, filepath, size: stat.size, mtime: stat.mtime.getTime() }
        })
    )

    // P2-4：阶段 1 - 时间维度过期：删除超过 90 天的日志
    const now = Date.now()
    const expired = stats.filter((s) => now - s.mtime > MAX_LOG_AGE_MS)
    for (const file of expired) {
      try {
        await fs.promises.unlink(file.filepath)
        console.log(`[Logger] 90 天过期触发，删除日志: ${file.name}`) // 中文保留（有意）：logger 兜底输出
      } catch {
        // 删除失败时跳过
      }
    }

    // P2-4：阶段 2 - 大小维度：剩余文件总大小超 2GB 时按 mtime 升序删除最旧
    const remaining = stats.filter((s) => !expired.includes(s))
    const totalSize = remaining.reduce((sum, s) => sum + s.size, 0)
    if (totalSize <= MAX_TOTAL_LOG_SIZE) return

    // 按 mtime 升序排序，依次删除最旧文件直至低于阈值
    const sorted = remaining.sort((a, b) => a.mtime - b.mtime)
    let currentSize = totalSize
    for (const file of sorted) {
      if (currentSize <= MAX_TOTAL_LOG_SIZE) break
      try {
        await fs.promises.unlink(file.filepath)
        currentSize -= file.size
        console.log(`[Logger] 2GB 上限触发，删除最旧日志: ${file.name}`) // 中文保留（有意）：logger 兜底输出
      } catch {
        // 删除失败时跳过，避免阻塞清理流程
      }
    }
  } catch (err) {
    // 中文保留（有意）：logger 是 i18n 不可用时的最后兜底输出渠道，且初始化早于 i18n
    console.error('[Logger] 大小检查失败:', err)
  }
}

// 兼容原有 logger API，新增 fault 方法
export const logger = {
  info: (message: string, ...args: unknown[]) => writeLog('info', message, ...args),
  warn: (message: string, ...args: unknown[]) => writeLog('warn', message, ...args),
  error: (message: string, ...args: unknown[]) => writeLog('error', message, ...args),
  debug: (message: string, ...args: unknown[]) => writeLog('debug', message, ...args),
  fault: logFault
}
