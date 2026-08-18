// Electron 渲染进程 browser stub
//
// 渲染进程在 sandbox:true + nodeIntegration:false 环境运行，
// 不能直接 import 'electron'（浏览器无法解析 bare specifier，导致白屏）。
// 渲染进程应通过 preload 的 contextBridge（window.electronAPI）访问 Electron API。
//
// 此 stub 作为 Vite resolve.alias 的目标，将任何残留的 `import 'electron'`
// （通常来自第三方库的 side-effect import 或通过相对路径间接引入的主进程模块）
// 替换为空对象，让 Rollup tree-shaker 移除无副作用的 import 语句。
//
// 对于 `import { app } from 'electron'` 等具名导入，
// stub 导出所有常用 Electron API 为空对象/函数，避免构建期 "is not exported" 错误。
// 运行时这些值是 undefined/noop，但 renderer 代码不应在顶层使用它们
// （应通过 window.electronAPI IPC 通信）。

const noop = () => {}
const emptyObj = {}

export const app = {
  getPath: () => '',
  getName: () => '',
  getVersion: () => '',
  isReady: () => false,
  whenReady: () => Promise.resolve(),
  quit: noop,
  exit: noop,
  on: noop,
  off: noop
}

export const BrowserWindow = function () {
  return emptyObj
}

export const ipcMain = { on: noop, off: noop, handle: noop, removeHandler: noop }
export const ipcRenderer = { on: noop, off: noop, send: noop, invoke: () => Promise.resolve() }
export const dialog = {
  showMessageBox: () => Promise.resolve(),
  showOpenDialog: () => Promise.resolve(),
  showSaveDialog: () => Promise.resolve()
}
export const Menu = { buildFromTemplate: () => emptyObj, setApplicationMenu: noop }
export const MenuItem = function () {}
export const shell = { openExternal: noop, openPath: noop, showItemInFolder: noop }
export const protocol = {
  registerSchemesAsPrivileged: noop,
  registerFileProtocol: noop,
  registerStreamProtocol: noop
}
export const session = {}
export const webContents = {}
export const nativeImage = { createEmpty: () => emptyObj, createFromPath: () => emptyObj }
export const screen = {}
export const powerMonitor = { on: noop }
export const systemPreferences = {}
export const clipboard = { readText: () => '', writeText: noop }
export const contextBridge = { exposeInMainWorld: noop }
export const appCommand = noop
export const crashReporter = { start: noop }
export const desktopCapturer = { getSources: () => Promise.resolve([]) }
export const globalShortcut = { register: noop, unregister: noop }
export const powerSaveBlocker = { start: noop, stop: noop }
export const net = { request: () => emptyObj }
export const netLog = { startLogging: noop, stopLogging: noop }
export const notification = function () {}
export const screenCapture = {}
export const shareMenu = {}
export const systemMemoryInfo = () => emptyObj
export const traceEvents = { start: noop, stop: noop }
export const webFrame = {}
export const crashpad = {}

export default {
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  dialog,
  Menu,
  MenuItem,
  shell,
  protocol,
  session,
  webContents,
  nativeImage,
  screen,
  powerMonitor,
  systemPreferences,
  clipboard,
  contextBridge,
  crashReporter,
  desktopCapturer,
  globalShortcut,
  powerSaveBlocker,
  net,
  netLog,
  notification
}
