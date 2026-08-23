// 崩溃报告命名空间：对应主进程 handlers/crash.ts 注册的 crash:* 通道
import { call } from '../ipc'
import type {
  CrashClearResult,
  CrashListResult,
  CrashStats,
  DirOpResult
} from '../../../shared/types/electron-api'

/** electronAPI.crash：T13 崩溃报告管理（crashReporter dump 文件） */
export const crashAPI = {
  list: () => call<CrashListResult>('crash:list'),
  getStats: () => call<CrashStats>('crash:getStats'),
  openDirectory: () => call<{ opened: boolean }>('crash:openDirectory'),
  clear: () => call<CrashClearResult>('crash:clear'),
  // 自定义目录支持
  setDir: (dir: string) => call<DirOpResult>('crash:setDir', dir),
  resetDir: () => call<DirOpResult>('crash:resetDir'),
  getDir: () => call<string>('crash:getDir')
}
