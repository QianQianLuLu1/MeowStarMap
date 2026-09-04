/**
 * 扫描全链路诊断日志仓库（主进程）。
 *
 * 设计目标：把 worker 在各关键节点（扫描启动 / 注册表读取 / 配置解析 / 路径拼接 /
 * 路径存在性 / 目录遍历 / 文件扫描）发出的结构化日志持久化为内存 ring buffer，
 * 并可选落盘到 userData/scan-log.jsonl，供诊断工具页时间线回放定位失效节点。
 *
 * 五要素：
 * - 依赖声明：仅 fs / fs.promises / path；不 import 'electron'（避免单测环境无 electron 崩溃），
 *   落盘路径由 `setLogFilePath` 在 app ready 后注入。
 * - 启动说明：单例 `scanLogStore`，`startRun()` 在每次扫描开始时清空，平时累积。
 * - 错误处理：落盘失败静默忽略（诊断日志不得影响主扫描）；JSON.stringify 异常由调用方保证 detail 可序列化。
 * - 参数校验：`append` 的 stage/level/kind 由调用方保证合法；非法 level 默认 'info'，非法 kind 默认 'other'。
 * - 基础测试：见 __tests__/scan-log-store.test.ts（startRun/append/getEntriesSince/classifyFsError）。
 */
import fsp from 'fs/promises'

export type ScanLogKind = 'path-missing' | 'permission' | 'empty' | 'ok' | 'other'
export type ScanLogLevel = 'info' | 'warn' | 'error'

/**
 * 全链路诊断错误码（需求五.1）：
 * - E001 路径定位：未找到任何游戏安装目录
 * - E002 路径定位：找到游戏根目录，但目标子目录不存在
 * - E003 目录访问：目录访问被拒绝（权限不足）
 * - E004 目录遍历：未找到 UID 文件夹
 * - E005 文件读取：图片/元数据读取失败
 */
export type ScanErrorCode = 'E001' | 'E002' | 'E003' | 'E004' | 'E005'

export const SCAN_ERROR_CODES: ScanErrorCode[] = ['E001', 'E002', 'E003', 'E004', 'E005']

export interface ScanLogEntry {
  id: number
  ts: number
  stage: string
  level: ScanLogLevel
  kind: ScanLogKind
  message: string
  detail?: unknown
  /** 失败节点的结构化错误码（可选，向后兼容：成功节点无 code） */
  code?: ScanErrorCode
}

export interface ScanLogInput {
  stage: string
  level?: ScanLogLevel
  kind?: ScanLogKind
  message: string
  detail?: unknown
  code?: ScanErrorCode
}

const MAX_ENTRIES = 2000
const VALID_LEVELS: ScanLogLevel[] = ['info', 'warn', 'error']
const VALID_KINDS: ScanLogKind[] = ['path-missing', 'permission', 'empty', 'ok', 'other']

class ScanLogStore {
  private entries: ScanLogEntry[] = []
  private nextId = 1
  private logFilePath: string | null = null
  private writeChain: Promise<void> = Promise.resolve()

  /** 由 app ready 后在 setupIPC 注入用户数据目录下的落盘路径；传 null 关闭落盘 */
  setLogFilePath(fp: string | null): void {
    this.logFilePath = fp
  }

  /** 每次扫描启动清空历史，开始新一次诊断轨迹 */
  startRun(): void {
    this.entries = []
    this.nextId = 1
  }

  append(input: ScanLogInput): void {
    const level: ScanLogLevel = VALID_LEVELS.includes(input.level as ScanLogLevel)
      ? (input.level as ScanLogLevel)
      : 'info'
    const kind: ScanLogKind = VALID_KINDS.includes(input.kind as ScanLogKind)
      ? (input.kind as ScanLogKind)
      : 'other'
    const entry: ScanLogEntry = {
      id: this.nextId++,
      ts: Date.now(),
      stage: input.stage,
      level,
      kind,
      message: input.message,
      detail: input.detail,
      ...(input.code ? { code: input.code } : {})
    }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    }
    this.persist(entry)
  }

  getEntries(): ScanLogEntry[] {
    return this.entries
  }

  /** 增量拉取：返回 id 大于 since 的新条目，供诊断页轮询 */
  getEntriesSince(since: number): ScanLogEntry[] {
    return this.entries.filter((e) => e.id > since)
  }

  clear(): void {
    this.entries = []
    this.nextId = 1
  }

  private persist(entry: ScanLogEntry): void {
    if (!this.logFilePath) return
    const line = JSON.stringify(entry) + '\n'
    this.writeChain = this.writeChain.then(() =>
      // 显式 utf8：诊断日志含中文路径/错误栈，不依赖系统默认编码
      fsp.appendFile(this.logFilePath as string, line, 'utf8').catch(() => undefined)
    )
  }
}

export const scanLogStore = new ScanLogStore()

/** 导出时间线的可读文本（含错误码列），供「一键导出诊断日志」落盘 */
export function toExportText(entries: ScanLogEntry[] = scanLogStore.getEntries()): string {
  return entries
    .map((e) => {
      const time = new Date(e.ts).toISOString()
      const code = e.code ? ` ${e.code}` : ''
      const detail =
        e.detail === undefined
          ? ''
          : ` | detail=${typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)}`
      return `[${time}] [${e.stage}] ${e.level.toUpperCase()} (${e.kind})${code} ${e.message}${detail}`
    })
    .join('\n')
}

/**
 * 将 fs 错误归一化为诊断分类。
 * ENOENT → 路径不存在（path-missing）；EACCES/EPERM → 权限不足（permission）；其余 → other。
 * 调用方对「目录存在但为空」需自行判定为 empty。
 */
export function classifyFsError(err: unknown): ScanLogKind {
  const code = (err as { code?: string } | null)?.code
  if (code === 'ENOENT') return 'path-missing'
  if (code === 'EACCES' || code === 'EPERM') return 'permission'
  return 'other'
}

/** 仅用于测试：重置单例状态，避免用例间串扰 */
export function __resetScanLogStore(): void {
  scanLogStore.startRun()
  scanLogStore.setLogFilePath(null)
}
