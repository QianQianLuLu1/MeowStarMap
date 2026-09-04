/**
 * 带生命周期管理的文件读流（公共工具）
 *
 * 为什么需要它：
 * 直接 `fs.createReadStream(path).pipe(dest)` 是危险的——`pipe()` 返回后同步代码即结束，
 * 后续异步阶段的错误（文件被移走/被占用、权限变更 EACCES/EPERM、磁盘 IO 错误）外层
 * try/catch 完全覆盖不到。`Readable.pipe()` 只会把源流错误转发给目标 dest：dest 若没有
 * 'error' 监听器，错误会升级为未捕获异常或静默 reset（客户端看到 ECONNRESET、服务端零日志）；
 * 且源流没有显式 destroy 时 fd 不保证归还，长时间运行会逐步耗尽句柄。
 *
 * 统一收口：media:// 协议（src/main/app/media-protocol.ts）与 WiFi 分享服务
 * （src/main/services/share-wifi-service.ts）共用同一实现，避免同类漏用再次出现。
 *
 * 注意：本工具只负责「流级」生命周期（fd 归还 + 取消信号）。把流写进 HTTP 响应时，
 * 调用方仍需在响应对象上挂 error/close 监听（见 share-wifi-service.ts 的 serveFile）。
 */
import fs from 'fs'
import { logger } from './logger'
import { t } from '../i18n'

/** 已收敛的合法字节区间：end 保证 < size 且 >= start */
export interface ByteRange {
  start: number
  end: number
}

export interface ManagedReadStreamOptions {
  /** 请求取消信号：abort 时立即 destroy；流 close 后自动摘除监听 */
  signal?: AbortSignal
  /** 分段区间；省略则读取整个文件 */
  range?: ByteRange
  /**
   * 自定义错误回调：在内部 destroy + logger.warn **之后**调用。
   * 工具管资源与日志，调用方在此处理响应语义（回 500 / 断连）。
   */
  onError?: (error: unknown) => void
}

/**
 * 创建带生命周期管理的文件读流，确保任何终止路径都会释放 fd。
 *
 * Windows 上未关闭的 fd 会锁住文件，表现为"图片快速滚动/视频拖进度条后文件删不掉"。
 * 三条兜底：
 *   1. 请求被取消（快速滚动时渲染进程会大量 abort 未完成请求）→ 立即 destroy
 *   2. 读流自身报错（文件被外部删除/移动）→ destroy，同时避免 'error' 无监听导致进程崩溃
 *   3. 流 close 后摘掉 abort 监听，否则长生命周期 signal 上会累积监听器
 */
export function createManagedReadStream(
  filePath: string,
  options: ManagedReadStreamOptions = {}
): fs.ReadStream {
  const { signal, range, onError } = options
  // range 缺失时必须传 {}（传 { start: undefined } 会让 Node 走 start 分支并抛错）
  const stream = fs.createReadStream(filePath, range ?? {})

  const destroy = (): void => {
    if (!stream.destroyed) stream.destroy()
  }

  // 'error' 后 autoClose 不一定跑完，显式 destroy 才能保证 fd 归还
  stream.on('error', (error) => {
    logger.warn(t('main.readStream.log.streamErrorDestroyed'), filePath, error)
    destroy()
    onError?.(error)
  })

  if (signal) {
    if (signal.aborted) {
      destroy()
    } else {
      signal.addEventListener('abort', destroy, { once: true })
      stream.once('close', () => signal.removeEventListener('abort', destroy))
    }
  }

  return stream
}
