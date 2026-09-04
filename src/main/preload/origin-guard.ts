/**
 * preload 文档源自检（preload 侧第二层防线）
 *
 * 背景：preload 是 webContents 级别的 webPreferences，对窗口加载的**任何**文档
 * （含被导航到的 file:///…/evil.html、本机任意端口的 localhost 服务）都会执行，
 * 与页面来源无关。只要执行了 contextBridge.exposeInMainWorld，那个文档就拿到完整 IPC 桥。
 * preload 不受页面 CSP 约束，因此 CSP 不构成这道防线。
 *
 * 主进程侧第一层防线是 app/navigation-guard.ts（isAppDocumentUrl，拦 URL）。
 * 本模块是第二层：直接看自己所在文档的 origin，非授信源一个全局都不暴露。
 * 两层放行集合必须逐字镜像，改一处要同步改另一处。
 *
 * 约束：本文件位于 preload 目录内且零依赖（仅 console），以满足 preload.test.ts 的
 * 依赖白名单守卫——preload 模块不得引入主进程 heavy 模块，也不得引入 shared 的运行时值。
 */

// 编译期常量，由 electron.vite.config.ts 的 preload.define 注入。
// 不能用运行时 process.env：preload 运行于 sandbox 环境，且 electron-vite 的 lib 模式
// 不做 process.env.NODE_ENV 静态替换（实测 dist 产物保留字面量）。
// 未注入时（如 vitest 直接跑源码）按 false 处理，走"仅授信 app:// 与 media://"的安全缺省。
declare const __NIKKI_PRELOAD_DEV__: boolean

/** dev server 源（electron.vite.config.ts renderer.server.port = 5173） */
const DEV_SERVER_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://127.0.0.1:5173']

/** 当前是否为 dev 构建（编译期常量缺失时安全缺省为 false） */
export function isPreloadDev(): boolean {
  return typeof __NIKKI_PRELOAD_DEV__ !== 'undefined' && __NIKKI_PRELOAD_DEV__ === true
}

/**
 * 读取当前文档的 origin。
 *
 * node / 单测环境没有 location 全局，返回 null（由调用方按非授信处理）。
 */
export function readDocumentOrigin(): string | null {
  try {
    if (typeof location === 'undefined') return null
    return typeof location.origin === 'string' ? location.origin : null
  } catch {
    // 极端情况下读取 location 抛错（跨源访问限制等）：按非授信处理，宁可拒绝授予
    return null
  }
}

/**
 * 判断文档 origin 是否可授予 IPC 桥。
 *
 * 拒绝空 / 'null' / about: 族：opaque origin 同样会被 evil 父页通过
 * document.write 写进自建的 about:blank iframe 后访问其 contentWindow，
 * 放行等于把第一层防线开的洞重新打开。
 */
export function isTrustedDocumentOrigin(
  origin: string | null | undefined,
  isDev: boolean
): boolean {
  if (!origin || origin === 'null') return false
  if (origin.startsWith('about:')) return false
  if (origin.startsWith('app://') || origin.startsWith('media://')) return true
  if (!isDev) return false
  return DEV_SERVER_ORIGINS.includes(origin)
}
