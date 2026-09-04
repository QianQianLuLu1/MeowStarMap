/**
 * preload 专用轻量日志
 *
 * 刻意不引用主进程 logger（../utils/logger）：后者顶层 import { app } from 'electron'，
 * 并在模块加载期对 FAULT_TYPE_LABELS 调用 i18n 的 t()。一旦 preload 引入它，
 * 会让 preload 在加载阶段耦合主进程 electron app / i18n 初始化，
 * 任一顶层求值抛错都会使整段 preload 失败、window.electronAPI 永不暴露 → 隐性白屏。
 *
 * 这里只用 console，零依赖、零顶层副作用，保证 preload 加载即安全。
 */
const PRELOAD_LOG_PREFIX = '[preload]'

export const preloadLogger = {
  info: (message: string, ...args: unknown[]): void => {
    // console.warn 而非 console.log：eslint 护栏禁用调试 console 调用，warn 属放行级别
    console.warn(PRELOAD_LOG_PREFIX, message, ...args)
  },
  error: (message: string, ...args: unknown[]): void => {
    console.error(PRELOAD_LOG_PREFIX, message, ...args)
  }
}
