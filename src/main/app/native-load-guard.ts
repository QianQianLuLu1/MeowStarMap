/**
 * 原生模块加载预检与友好错误提示
 *
 * 目的：打包后在干净 Windows 环境，若 VC++ 运行库缺失 / 原生模块 ABI 不匹配 /
 * 安装路径含特殊字符，原生 require 会抛错。原生模块此前在 Application.initialize()
 * 内部惰性加载，失败时要么被主进程静默等待（worker 无超时）要么走依赖 i18n 的弹窗
 * （i18n 未就绪时 t() 二次抛错 → 无弹窗）。本模块在 app.whenReady 内、加载 Application
 * 之前逐个预检，失败即用不依赖 i18n 的同步 dialog.showErrorBox 给出可操作指引。
 */
/** 关键原生模块：任一无法加载即导致应用不可用，必须在启动早期预检 */
export const CRITICAL_NATIVE_MODULES = ['better-sqlite3', 'koffi', 'sharp'] as const
export type CriticalNativeModule = (typeof CRITICAL_NATIVE_MODULES)[number]

export type NativeLoadErrorKind =
  'abi-mismatch' | 'missing-vc-runtime' | 'bindings-missing' | 'unknown'

const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'

// 安装路径非 ASCII 检测复用 path-safety（避免重复实现；DLL 搜索对特殊字符路径偶发失败）
import { hasNonAsciiPath } from '../utils/path-safety'

/**
 * 按错误关键字归类原生模块加载失败原因，用于给出针对性指引。
 */
export function classifyNativeLoadError(err: unknown): NativeLoadErrorKind {
  const msg = err instanceof Error ? err.message : String(err)
  // 1) ABI 不匹配：原生模块以错误 Node/Electron ABI 编译（better-sqlite3/koffi 真实报错含
  //    NODE_MODULE_VERSION 或 "compiled against a different [version of Node.js/Electron]"）
  if (/NODE_MODULE_VERSION/i.test(msg) || /compiled against a different/i.test(msg)) {
    return 'abi-mismatch'
  }
  // 2) 缺失 VC++ 运行库：LoadLibrary 失败（最常见于干净 Windows）
  if (
    /The specified module could not be found/.test(msg) ||
    /A dynamic link library \(DLL\) initialization routine failed/.test(msg) ||
    /%1 is not a valid Win32 application/.test(msg)
  ) {
    return 'missing-vc-runtime'
  }
  // 3) .node 文件缺失（未正确解包 / 未 rebuild）
  if (/Could not locate the bindings file/.test(msg) || /Cannot find module/.test(msg)) {
    return 'bindings-missing'
  }
  return 'unknown'
}

export interface NativeGuardDeps {
  /** 注入的模块加载器（测试用 mock）。默认走真实 require（CJS 主进程）。 */
  requireImpl?: (id: string) => unknown
  /** 注入的错误框（测试用 mock）。默认走 electron.dialog.showErrorBox。 */
  showErrorBox?: (title: string, content: string) => void
  /** 注入的 exe 路径提供器（测试用 mock）。默认 process.execPath。 */
  getExecPath?: () => string
  /** 注入的环境变量读取（测试用 mock）。默认 process.env。 */
  getEnv?: () => NodeJS.ProcessEnv
  /** 注入的日志器（测试用 mock）。默认落盘 startup-errors.log，失败时退化为 console.error。 */
  log?: (stage: string, err: unknown) => void
}

function defaultRequire(id: string): unknown {
  // 主进程以 CJS 产出（electron-vite main format:'cjs'），全局 require 可用（src/** 已关闭 no-require-imports）
  return require(id)
}

function defaultShowErrorBox(title: string, content: string): void {
  try {
    // electron 仅在打包/运行期可用；测试环境注入 showErrorBox 故不会走到这里（src/** 已关闭 no-require-imports）
    const electron = require('electron') as {
      dialog?: { showErrorBox: (t: string, c: string) => void }
    }
    electron.dialog?.showErrorBox(title, content)
  } catch {
    // 极端兜底：electron 不可用时退化为 stderr（console.error 不在 i18n 护栏拦截范围内）
    console.error(`[native-load-guard] ${title}\n${content}`)
  }
}

function defaultLog(stage: string, err: unknown): void {
  try {
    // 避免顶层导入 electron（测试环境会抛错）；运行时惰性 require，失败则退化（src/** 已关闭 no-require-imports）
    const diag = require('../utils/startup-diagnostic') as {
      logStartupError?: (stage: string, err: unknown) => void
    }
    diag.logStartupError?.(stage, err)
  } catch {
    // console.error 不在 i18n 护栏拦截范围内
    console.error(`[native-load-guard] ${stage}:`, err)
  }
}

function buildVcRuntimeContent(moduleName: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  return [
    '应用依赖的 C/C++ 原生模块无法加载，最可能原因是系统缺少',
    'Microsoft Visual C++ 2015-2022 可再发行组件 (x64)。',
    '',
    '请按以下步骤修复：',
    `1. 下载并安装 VC++ 运行库：${VC_REDIST_URL}`,
    '2. 重新启动应用',
    '',
    `失败模块：${moduleName}`,
    `错误详情：${detail}`,
    '',
    'The application failed to load a native (C/C++) module. The most likely',
    'cause is the missing Microsoft Visual C++ 2015-2022 Redistributable (x64).',
    `Download and install it from: ${VC_REDIST_URL}`,
    `Failed module: ${moduleName}`,
    `Error: ${detail}`
  ].join('\n')
}

function buildAbiMismatchContent(moduleName: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  return [
    '应用的原生模块与当前 Electron 运行时不兼容（ABI 版本不匹配）。',
    '请勿混用不同版本的安装包，请重新下载并安装官方最新版本。',
    '',
    `失败模块：${moduleName}`,
    `错误详情：${detail}`,
    '',
    'A native module is incompatible with the current Electron runtime',
    '(ABI version mismatch). Please reinstall the latest official build.',
    `Failed module: ${moduleName}`,
    `Error: ${detail}`
  ].join('\n')
}

function buildBindingsMissingContent(moduleName: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  return [
    '应用的原生模块文件缺失（未正确打包或解包失败）。',
    '请重新安装应用，或联系支持并附上本日志。',
    '',
    `失败模块：${moduleName}`,
    `错误详情：${detail}`
  ].join('\n')
}

function buildUnknownContent(moduleName: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  return [
    '应用启动失败：原生模块加载出错。',
    '请将以下错误信息与启动日志一并提交，便于排查。',
    '',
    `失败模块：${moduleName}`,
    `错误详情：${detail}`,
    '',
    'Application failed to start due to a native module load error.',
    `Failed module: ${moduleName}`,
    `Error: ${detail}`
  ].join('\n')
}

/** 由模块名 + 错误类别生成不依赖 i18n 的双语错误框文案 */
export function nativeLoadErrorBox(
  moduleName: string,
  kind: NativeLoadErrorKind,
  err: unknown
): { title: string; content: string } {
  switch (kind) {
    case 'abi-mismatch':
      return {
        title: '原生模块版本不兼容 / Native Module Incompatible',
        content: buildAbiMismatchContent(moduleName, err)
      }
    case 'missing-vc-runtime':
      return {
        title: '无法启动：缺少 Visual C++ 运行库 / Missing VC++ Runtime',
        content: buildVcRuntimeContent(moduleName, err)
      }
    case 'bindings-missing':
      return {
        title: '原生模块文件缺失 / Native Module Missing',
        content: buildBindingsMissingContent(moduleName, err)
      }
    default:
      return { title: '启动失败 / Startup Failed', content: buildUnknownContent(moduleName, err) }
  }
}

/**
 * 预检关键原生模块能否在当前环境加载。
 * 返回 true 表示全部可加载；false 表示已弹窗并应终止启动。
 */
export function verifyCriticalNativeModules(deps: NativeGuardDeps = {}): boolean {
  const requireImpl = deps.requireImpl ?? defaultRequire
  const showErrorBox = deps.showErrorBox ?? defaultShowErrorBox
  const getExecPath = deps.getExecPath ?? (() => process.execPath)
  const getEnv = deps.getEnv ?? (() => process.env)
  const log = deps.log ?? defaultLog

  // 开发 / CI 跳过开关：仅严格等于 '1' 才跳过（防误触与大小写/空白）
  if (getEnv().NIKKI_SKIP_NATIVE_GUARD === '1') {
    log('native-load-guard', 'skipped via NIKKI_SKIP_NATIVE_GUARD=1')
    return true
  }

  // 安装路径含特殊字符：仅提示，不阻塞（现代 Windows 多可加载）
  const execPath = getExecPath()
  if (hasNonAsciiPath(execPath)) {
    showErrorBox(
      '安装路径含特殊字符 / Non-ASCII Install Path',
      [
        '检测到应用安装路径包含非英文字符，部分原生模块可能无法加载。',
        '建议将应用安装到纯英文路径后重试。',
        '',
        `当前路径：${execPath}`,
        '',
        'The install path contains non-ASCII characters, which may prevent',
        'native modules from loading. Consider installing to an ASCII path.',
        `Path: ${execPath}`
      ].join('\n')
    )
    log('native-load-guard', `install path contains non-ASCII: ${execPath}`)
  }

  for (const mod of CRITICAL_NATIVE_MODULES) {
    try {
      requireImpl(mod)
    } catch (err) {
      const kind = classifyNativeLoadError(err)
      log(`native-load-guard: ${mod} failed (${kind})`, err)
      const { title, content } = nativeLoadErrorBox(mod, kind, err)
      showErrorBox(title, content)
      return false
    }
  }
  return true
}

/**
 * FATAL 兜底弹窗：不依赖 i18n，任何启动期异常都保证弹出（修复原 t() 二次抛错导致的无弹窗）。
 */
export function showFatalStartupErrorBox(err: unknown, logPath?: string): void {
  const msg = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error ? (err.stack ?? '') : ''
  const lines = ['应用启动失败。请将以下信息与启动日志一并反馈，便于排查。', '', `错误信息：${msg}`]
  if (logPath) lines.push(`日志路径：${logPath}`)
  lines.push('', '---', stack)
  lines.push(
    '',
    'The application failed to start. Please report the message above',
    logPath ? `and the log at: ${logPath}` : 'for diagnosis.'
  )
  defaultShowErrorBox('启动失败 / Startup Failed', lines.join('\n'))
  // 高亮日志文件，便于用户直接在资源管理器定位（不依赖 i18n / 渲染进程）
  if (logPath) {
    try {
      const electron = require('electron') as { shell?: { showItemInFolder: (p: string) => void } }
      electron.shell?.showItemInFolder?.(logPath)
    } catch {
      /* 忽略：shell 不可用时不影响弹窗 */
    }
  }
}
