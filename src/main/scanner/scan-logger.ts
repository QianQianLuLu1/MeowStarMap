/**
 * 扫描进程内诊断日志发送器。
 *
 * worker 与主进程通过 UtilityProcess 通信，日志经 parentPort 以 SCAN_LOG 事件发出。
 * 抽出本模块是为了避免 game-directory-discovery（被 worker-entry 引用）反向 import worker-entry
 * 造成循环依赖——两者都从这里取 sendScanLogEntry / sendScanLogInfo。
 *
 * 五要素：
 * - 依赖声明：仅 process.parentPort（Node 内置），无第三方依赖。
 * - 启动说明：worker 内 process.parentPort 就绪后调用即生效；父进程不可用时静默丢弃。
 * - 错误处理：postMessage 抛错被 try/catch 吞掉，保证日志永不中断扫描主流程。
 * - 参数校验：level 限定三值，缺省 info；kind 缺省 other（scan-log-store 会再校验）。
 * - 基础测试：发送动作副作用在 worker 集成测试中覆盖，无需单测本模块。
 */
import type { ScanLogKind } from './scan-log-store'

export function sendScanLogInfo(message: string): void {
  try {
    process.parentPort?.postMessage({ type: 'SCAN_LOG', payload: { level: 'info', message } })
  } catch {
    /* parentPort 不可用时丢弃 */
  }
}

/**
 * 发送结构化扫描诊断条目，携带 stage / kind / detail，
 * 供诊断工具页按阶段渲染时间线并区分三类错误。
 */
export function sendScanLogEntry(params: {
  stage: string
  level?: 'info' | 'warn' | 'error'
  kind?: ScanLogKind
  message: string
  detail?: unknown
}): void {
  try {
    process.parentPort?.postMessage({
      type: 'SCAN_LOG',
      payload: {
        level: params.level ?? 'info',
        message: params.message,
        stage: params.stage,
        kind: params.kind ?? 'other',
        detail: params.detail
      }
    })
  } catch {
    /* parentPort 不可用时丢弃 */
  }
}
