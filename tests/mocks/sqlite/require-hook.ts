/**
 * 共享测试工具：better-sqlite3 的 Module._load 拦截钩子（成对 install / uninstall）
 *
 * 背景：worker 代码（如 src/main/database/worker/database-worker.ts 的 getDatabaseImpl）
 * 通过惰性 require('better-sqlite3') 加载原生模块；vite-node 注入的原生 require 不经过
 * vi.mock 注册表，且本机 native 模块为 Electron ABI，在 vitest/Node 下加载即崩溃。
 * 故挂钩 CJS 加载器入口 Module._load 定向替换（与 scan-batch-write-failure.test.ts 同源）。
 *
 * 用法：
 * ```ts
 * beforeAll(() => {
 *   hook = installBetterSqlite3Hook(FakeDatabaseCtor)
 * })
 * afterAll(() => {
 *   uninstallBetterSqlite3Hook()
 * })
 *
 * // 逐用例切换行为：
 * hook.setImpl(AnotherCtor)
 * ```
 *
 * 兼容性：mockImpl 传构造函数时，钩子会为其附加 `default` 自引用，
 * 使 `typeof mod === 'function' ? mod : mod.default` 两种消费形态都能命中
 * （database-worker.ts 的 getDatabaseImpl 即按此双形态兼容）；
 * 传 `{ default: Ctor }` 对象形态则原样返回。
 */
import Module from 'node:module'

/** Module._load 的签名（Node 内部 API，无公开类型） */
export type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown

/** installBetterSqlite3Hook 返回的句柄 */
export interface BetterSqlite3HookHandle {
  /** 安装前的原始 Module._load（还原依据，uninstall 内部已持有，此处供检查） */
  originalLoad: ModuleLoad
  /** 运行期替换 mock 实现（如每个用例注入不同 db 行为），无需重装钩子 */
  setImpl: (next: unknown) => void
}

interface ActiveHook {
  originalLoad: ModuleLoad
  interceptedLoad: ModuleLoad
  impl: unknown
}

let activeHook: ActiveHook | null = null

/** 裸 id 与绝对路径两种请求形态都视为 better-sqlite3 */
function isBetterSqliteRequest(request: string): boolean {
  return (
    request === 'better-sqlite3' ||
    request.replace(/\\/g, '/').endsWith('better-sqlite3/lib/index.js')
  )
}

/**
 * 将构造函数形态的 mock 补齐为"函数 + default 自引用"双形态导出；
 * 对象形态（如 { default: Ctor }）原样返回。
 */
function toModuleExport(impl: unknown): unknown {
  if (typeof impl === 'function' && !('default' in (impl as unknown as Record<string, unknown>))) {
    Object.defineProperty(impl, 'default', {
      value: impl,
      configurable: true,
      enumerable: false,
      writable: true
    })
  }
  return impl
}

/**
 * 安装 Module._load 钩子：better-sqlite3 的 require 请求一律返回 mockImpl，
 * 其余请求走原实现。重复安装（未先 uninstall）会抛错，避免钩子叠加。
 *
 * @returns 还原所需状态句柄（originalLoad + setImpl）
 */
export function installBetterSqlite3Hook(mockImpl: unknown): BetterSqlite3HookHandle {
  if (activeHook) {
    throw new Error('better-sqlite3 钩子已安装，请先调用 uninstallBetterSqlite3Hook()')
  }
  const moduleWithLoad = Module as unknown as { _load: ModuleLoad }
  const originalLoad = moduleWithLoad._load
  const hook: ActiveHook = { originalLoad, interceptedLoad: originalLoad, impl: mockImpl }
  hook.interceptedLoad = function interceptedLoad(request, parent, isMain) {
    if (typeof request === 'string' && isBetterSqliteRequest(request)) {
      return toModuleExport(hook.impl)
    }
    return originalLoad(request, parent, isMain)
  }
  activeHook = hook
  moduleWithLoad._load = hook.interceptedLoad
  return {
    originalLoad,
    setImpl: (next) => {
      hook.impl = next
    }
  }
}

/**
 * 卸载钩子：完整还原原始 Module._load。
 * 未安装时静默返回（afterAll 里可无条件调用）。
 */
export function uninstallBetterSqlite3Hook(): void {
  if (!activeHook) return
  const moduleWithLoad = Module as unknown as { _load: ModuleLoad }
  moduleWithLoad._load = activeHook.originalLoad
  activeHook = null
}
