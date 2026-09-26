/**
 * 运行期 spawn 类错误诊断记录
 *
 * 背景：现场 `spawn EFTYPE`（ERROR_BAD_EXE_FORMAT）类错误若被调用点局部捕获
 * （如 fluent-ffmpeg 的 error 事件 → reject → 上层 try/catch 降级），不会进入
 * uncaughtException，startup-errors.log 里查不到任何痕迹，远程无法定位。
 *
 * 本工具供各 spawn 调用点的 error 路径调用：命中 spawn 类错误时把【原始错误对象】
 * 交给 logStartupError（复用其 [errno] code/syscall/path/spawnargs 摘要行）落盘
 * startup-errors.log，stage 形如 `runtime-spawn-error:ffmpeg-runner`。
 *
 * 约束：
 * - 普通 Error（无 code/syscall）不记录，避免业务失败噪音淹没诊断信号；
 * - 非 Error 值（如字符串 reject）按异常信号原样记录（String 化由 logStartupError 处理）；
 * - 全程 try/catch，绝不向业务冒泡；startup-diagnostic 无 electron 依赖，
 *   utilityProcess worker（scanner/media 等）内可安全调用。
 */
import { logStartupError } from './startup-diagnostic'

/** 视为 spawn 链路失败的错误码（EFTYPE=非 PE；ENOENT=二进制缺失，如 Win11 24H2 移除 wmic；EACCES=权限） */
const SPAWN_ERROR_CODES = new Set(['EFTYPE', 'ENOENT', 'EACCES'])

/**
 * 判断错误是否为子进程 spawn 类错误。
 * 在 early-crash-guard 的 isChildProcessSpawnError（仅 EFTYPE，不导出）基础上
 * 扩展 ENOENT/EACCES：syscall 以 spawn 开头，或 code 命中 SPAWN_ERROR_CODES。
 */
export function isChildProcessSpawnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as NodeJS.ErrnoException
  if (typeof e.syscall === 'string' && /^spawn/i.test(e.syscall)) return true
  return typeof e.code === 'string' && SPAWN_ERROR_CODES.has(e.code)
}

/**
 * 记录 spawn 类错误到 startup-errors.log（非 spawn 类错误静默跳过）。
 * @param source 调用点短标签（如 'ffmpeg-runner' / 'video-probe' / 'thumbnail-generator'）
 * @param err   error 事件/回调的原始错误对象（保留 code/path/spawnargs 供摘要行输出）
 */
export function maybeLogSpawnError(source: string, err: unknown): void {
  try {
    const isPlainValue = err !== null && err !== undefined && typeof err !== 'object'
    if (!isPlainValue && !isChildProcessSpawnError(err)) return
    logStartupError(`runtime-spawn-error:${source}`, err)
  } catch {
    // 诊断写盘失败绝不影响业务
  }
}
