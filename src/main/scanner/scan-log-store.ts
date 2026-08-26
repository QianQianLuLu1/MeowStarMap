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

export interface ScanLogEntry {
  id: number
  ts: number
  stage: string
  level: ScanLogLevel
  kind: ScanLogKind
  message: string
  detail?: unknown
}

export interface ScanLogInput {
  stage: string
  level?: ScanLogLevel
  kind?: ScanLogKind
  message: string
  detail?: unknown
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
      detail: input.detail
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
      fsp.appendFile(this.logFilePath as string, line).catch(() => undefined)
    )
  }
}

export const scanLogStore = new ScanLogStore()

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
