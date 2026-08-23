// 扫描器命名空间：对应主进程 scanner-handler 注册的 scanner:* 通道
import { call, subscribe } from '../ipc'
import type {
  ScannerComplete,
  ScannerProgress,
  ScannerStartResult
} from '../../../shared/types/electron-api'
// 统一 scanner:status 契约（与 main / 渲染进程共享）
import type { ScannerStatus } from '../../../shared/types/progress'

/** electronAPI.scanner：扫描器控制与事件订阅 */
export const scannerAPI = {
  start: (options?: {
    path?: string
    incremental?: boolean
    customKnownPaths?: string[]
    fullScan?: boolean
  }) => call<ScannerStartResult>('scanner:start', options),
  stop: () => call<unknown>('scanner:stop'),
  status: () => call<ScannerStatus>('scanner:status'),
  onProgress: (callback: (progress: ScannerProgress) => void) =>
    subscribe('scanner:progress', callback),
  onComplete: (callback: (result: ScannerComplete) => void) =>
    subscribe('scanner:complete', callback),
  // R12：扫描半可见性提示——主进程在启动时检测到 interrupted 扫描记录后广播，
  // 渲染进程订阅后显示"上次扫描未完成，部分文件可能未入库"提示
  onInterrupted: (callback: (payload: { count: number }) => void) =>
    subscribe('scanner:interrupted', callback)
}
