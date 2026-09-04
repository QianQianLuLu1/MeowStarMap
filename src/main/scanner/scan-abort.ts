/**
 * 扫描中止标志（worker 进程内共享的可变状态，无任何副作用）。
 *
 * 抽出为独立模块的原因（与 scan-logger.ts 同模式）：game-directory-discovery
 * 曾从 worker-entry 反向导入 shouldStop，任何主进程侧模块引用
 * game-directory-discovery 时（如 scanner-handler 的 detectGameRootCandidates），
 * 整份 worker-entry 会被跨块引用进主进程——其模块顶层的 15s 心跳自杀看门狗
 * 在主进程永远收不到 WORKER_PING，启动 15s 后以 process.exit(0) 静默杀死主进程
 * （2026-08-29 打包版"运行不足 1 分钟闪退"根因，
 * 取证见 docs/plans/2026-08-29-packaged-crash-forensics-fix.md）。
 *
 * 依赖声明：零依赖纯状态模块，主进程 / worker 进程均可安全加载。
 * 错误处理：无 I/O、无抛错路径。
 */
let aborted = false

/** 扫描循环调用期读取：是否已请求中止 */
export function isScanAborted(): boolean {
  return aborted
}

/** 请求中止（worker 收到 SCAN_STOP / 心跳超时时调用） */
export function abortScan(): void {
  aborted = true
}

/** 新扫描开始时复位 */
export function resetScanAbort(): void {
  aborted = false
}
