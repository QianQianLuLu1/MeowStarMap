// 缓存命名空间：对应主进程 handlers/cache.ts 注册的 cache:* 通道
import { call } from '../ipc'
import type {
  CacheCleanResult,
  CacheEnforceResult,
  CacheSetLimitResult,
  CacheStats,
  DirOpResult
} from '../../../shared/types/electron-api'

/** electronAPI.cache：T10 缩略图缓存管理 */
export const cacheAPI = {
  getStats: () => call<CacheStats>('cache:getStats'),
  clean: () => call<CacheCleanResult>('cache:clean'),
  setLimit: (limitBytes: number) => call<CacheSetLimitResult>('cache:setLimit', limitBytes),
  enforceLimit: () => call<CacheEnforceResult>('cache:enforceLimit'),
  // 自定义目录支持
  setDir: (dir: string) => call<DirOpResult>('cache:setDir', dir),
  resetDir: () => call<DirOpResult>('cache:resetDir'),
  getDir: () => call<string>('cache:getDir')
}
