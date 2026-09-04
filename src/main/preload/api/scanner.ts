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
  /** 失败节点错误码（E001–E005），成功节点无此字段 */
  code?: 'E001' | 'E002' | 'E003' | 'E004' | 'E005'
}

/** electronAPI.scanner：扫描器控制与事件订阅 */
/** 游戏根目录候选（需求三.3：列出全部探测结果供用户选择） */
export interface GameRootCandidate {
  path: string
  mtimeMs: number
  hasGamePlayPhotos: boolean
  source: 'custom' | 'official' | 'steam' | 'epic'
}

export const scannerAPI = {
  start: (options?: {
    path?: string
    incremental?: boolean
    customKnownPaths?: string[]
    excludedPaths?: string[]
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
  // 全链路诊断：读取扫描结构化日志轨迹 / 清空 / 导出到文件
  getScanLog: () => call<ScanLogEntry[]>('scan:getScanLog'),
  clearScanLog: () => call<{ ok: boolean }>('scan:clearScanLog'),
  exportScanLog: (format?: 'json' | 'log') =>
    call<{ ok: boolean; path?: string; count?: number }>('scan:exportScanLog', { format }),
  // 需求三.3：枚举全部游戏目录候选
  detectGameRoots: (options?: { customPaths?: string[] }) =>
    call<GameRootCandidate[]>('scanner:detectGameRoots', options)
}
