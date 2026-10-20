/**
 * 单测专用的惰性 electron 替身（`vitest.config.ts` 的 resolve.alias 目标）。
 *
 * 为什么要有它：CI 用 `npm ci --ignore-scripts` + `ELECTRON_SKIP_BINARY_DOWNLOAD=1`
 * 装依赖（`.github/workflows/build.yml:132-136`），electron 包的 `path.txt` 由 postinstall
 * 生成，因此**不存在**；`node_modules/electron/index.js` 的 `getElectronPath()` 当场抛
 * 「Electron failed to install correctly」。开发机上 `path.txt` 在，`require('electron')`
 * 只是返回 exe 路径字符串，于是主进程模块图里那些「import 了 electron 但没 mock」的测试
 * 本机绿、CI 红——实测一次隐藏 `path.txt` 的全量运行里，40 个测试文件倒在同一个原因上。
 *
 * 单元不该依赖 Electron 二进制是否下载成功，所以把 `electron` 统一别名到本文件：
 * - 具名导出全部 `undefined`，与开发机上「加载了 stub、`app` 实际是 undefined」的现状逐字等价，
 *   因此不改变任何既有断言；
 * - 需要 electron API 的用例仍必须自己 `vi.mock('electron', ...)`（仓内既有约定，
 *   `vi.mock` 优先级高于别名），这样被测代码拿到的形状由用例显式声明，而不是由安装状态决定。
 */
export const app: unknown = undefined
export const BrowserWindow: unknown = undefined
export const Menu: unknown = undefined
export const Tray: unknown = undefined
export const dialog: unknown = undefined
export const ipcMain: unknown = undefined
export const ipcRenderer: unknown = undefined
export const nativeImage: unknown = undefined
export const powerMonitor: unknown = undefined
export const safeStorage: unknown = undefined
export const screen: unknown = undefined
export const session: unknown = undefined
export const shell: unknown = undefined
export const utilityProcess: unknown = undefined
export const net: unknown = undefined
export const protocol: unknown = undefined

const inertElectron: Record<string, unknown> = {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  ipcRenderer,
  nativeImage,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  utilityProcess,
  net,
  protocol
}

export default inertElectron
