// 扫描器命名空间：对应主进程 scanner-handler 注册的 scanner:* 通道
import { call, subscribe } from '../ipc'
import type {
  ScannerComplete,
  ScannerProgress,
  ScannerStartResult
} from '../../../shared/types/electron-api'
import type { ScannerStatus } from '../../../shared/types/progress'

// 全链路扫描诊断日志条目（与 scan-log-store.ts / 渲染端 vite-env.d.ts 保持一致）
export interface ScanLogEntry {
  id: number
  ts: number
  stage: string
  level: 'info' | 'warn' | 'error'
  kind: 'path-missing' | 'permission' | 'empty' | 'ok' | 'other'
  message: string
  detail?: unknown
}

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
    subscribe('scanner:interrupted', callback),
  // 全链路诊断：读取扫描结构化日志轨迹 / 清空
  getScanLog: () => call<ScanLogEntry[]>('scan:getScanLog'),
  clearScanLog: () => call<{ ok: boolean }>('scan:clearScanLog')
}
