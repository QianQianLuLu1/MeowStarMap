/**
 * @layer L2
 * @module src/main/ipc/ipc-observability
 * @coverage IPC 单点拦截器：失败落 fault / 校验失败 warn / CANCELED 静默 / 慢调用 warn / 抛错留痕后原样重抛
 * @dependencies utils/logger（logger + logFault）、shared/types/ipc-types（错误码常量）、node:perf_hooks
 *
 * 设计：全部 250 处 ipcMain.handle 都经 setupIPC 注册，故在注册入口安装一次
 * 常驻幂等包装即可覆盖所有通道（含晚注册），无需机械迁移 47 个 handler 文件。
 * 契约：不改变 IPC 响应形状；成功且快（≤500ms）的调用零写盘；
 * 观测逻辑全程 fail-open——观测自身异常绝不影响业务响应。
 */
import { performance } from 'node:perf_hooks'
import { logger, logFault } from '../utils/logger'
import { IPC_ERROR_CODES } from '../../shared/types/ipc-types'

/** 慢调用阈值：正常 handler <50ms，500ms 覆盖慢盘/锁等待且误报低 */
export const IPC_SLOW_THRESHOLD_MS = 500

export type IpcListener = (event: unknown, ...args: unknown[]) => unknown

interface IpcFailureShape {
  success?: boolean
  error?: { code?: string; message?: string; details?: unknown }
}

/** 包装单个 listener：计时 + 响应观测，返回值与异常原样透传 */
export function observeIpcListener(channel: string, listener: IpcListener): IpcListener {
  return async (event, ...args) => {
    const start = performance.now()
    let result: unknown
    try {
      result = await listener(event, ...args)
    } catch (err) {
      // wrap* 家族之外的异常（注册层/基础设施抛错）：留痕后原样重抛，不吞契约
      try {
        logFault('ipcError', err, { channel, phase: 'listener-throw' }).catch(() => {})
      } catch {
        // fail-open
      }
      throw err
    }
    try {
      const elapsed = performance.now() - start
      const r = result as IpcFailureShape | null
      if (r && typeof r === 'object' && r.success === false && r.error) {
        const code = r.error.code ?? ''
        if (code === IPC_ERROR_CODES.CANCELED) {
          // 用户取消对话框属正常交互，不是故障，静默
        } else if (code === IPC_ERROR_CODES.VALIDATION_ERROR) {
          logger.warn(`[IPC] validation failed: ${channel}`, {
            code,
            message: r.error.message,
            details: r.error.details
          })
        } else {
          logFault('ipcError', new Error(r.error.message ?? 'IPC handler failed'), {
            channel,
            code,
            details: r.error.details
          }).catch(() => {})
        }
      }
      if (elapsed > IPC_SLOW_THRESHOLD_MS) {
        logger.warn(`[IPC] slow: ${channel} elapsed=${Math.round(elapsed)}ms`)
      }
    } catch {
      // 观测失败不影响业务响应
    }
    return result
  }
}

const patched = new WeakSet<object>()

/**
 * 在 ipcMain 形状对象上安装常驻幂等包装（重复调用不双重包装）。
 * 注入形状而非直接 import electron，便于单测用 fake ipcMain 验证。
 */
export function installIpcObservability(ipcMainLike: {
  handle: (channel: string, listener: IpcListener) => unknown
}): void {
  if (patched.has(ipcMainLike)) return
  patched.add(ipcMainLike)
  const original = ipcMainLike.handle.bind(ipcMainLike)
  ipcMainLike.handle = (channel, listener) =>
    original(channel, observeIpcListener(channel, listener))
}
