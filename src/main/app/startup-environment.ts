/**
 * 启动期环境检测：安装路径特殊字符 + userData 可写性。
 *
 * 目的：干净 Windows 上两类高发启动失败——
 * 1) 系统目录权限不足：userData 被杀软锁定 / 只读 / 磁盘满，写入静默失败；
 * 2) 安装路径含特殊字符：原生模块与子进程偶发加载失败。
 * 本模块在 app.whenReady 内、加载 Application 之前检测，复用 native-load-guard
 * 的不依赖 i18n 的同步弹窗 + 诊断落盘模式，把「静默失败」转化为可操作双语引导。
 *
 * 不引入任何新依赖，仅用 Node 内置与既有模块（path-safety / startup-diagnostic）。
 */
import { hasNonAsciiPath, ensureWritableDir } from '../utils/path-safety'
import { logStartupError } from '../utils/startup-diagnostic'

export interface StartupEnvDeps {
  /** 注入的错误框（测试用 mock）。默认走 electron.dialog.showErrorBox。 */
  showErrorBox?: (title: string, content: string) => void
  /** 注入的 exe 路径提供器（测试用 mock）。默认 process.execPath。 */
  getExecPath?: () => string
  /** 注入的 userData 路径提供器（测试用 mock）。默认 app.getPath('userData')。 */
  getUserDataPath?: () => string
  /** 注入的环境变量读取（测试用 mock）。默认 process.env。 */
  getEnv?: () => NodeJS.ProcessEnv
  /** 注入的日志器（测试用 mock）。默认落盘 startup-errors.log。 */
  log?: (stage: string, err: unknown) => void
}

function defaultShowErrorBox(title: string, content: string): void {
  try {
    // 运行时惰性 require，避免顶层 import electron 在测试环境抛错（src/** 已关闭 no-require-imports）
    const electron = require('electron') as {
      dialog?: { showErrorBox: (t: string, c: string) => void }
    }
    electron.dialog?.showErrorBox(title, content)
  } catch {
    console.error(`[startup-environment] ${title}\n${content}`)
  }
}

function defaultLog(stage: string, err: unknown): void {
  try {
    logStartupError(stage, err)
  } catch {
    console.error(`[startup-environment] ${stage}:`, err)
  }
}

/**
 * 安装路径含特殊字符：仅提示，不阻塞（与 native-load-guard 一致）。
 * 现代 Windows 多可加载，仅作风险预警。
 */
function checkInstallPathNonAscii(
  execPath: string,
  showErrorBox: (t: string, c: string) => void,
  log: (stage: string, err: unknown) => void
): void {
  if (!hasNonAsciiPath(execPath)) return
  showErrorBox(
    '安装路径含特殊字符 / Non-ASCII Install Path',
    [
      '检测到应用安装路径包含非英文字符，部分功能（如视频转码）可能无法正常工作。',
      '建议将应用安装到纯英文路径后重试。',
      '',
      `当前路径：${execPath}`,
      '',
      'The install path contains non-ASCII characters, which may prevent',
      'some features (e.g. video transcoding) from working.',
      `Path: ${execPath}`
    ].join('\n')
  )
  log('startup-environment', `install path contains non-ASCII: ${execPath}`)
}

/**
 * userData 可写性：阻塞检测。不可写时弹双语引导并返回 false。
 */
function checkUserDataWritable(
  userData: string,
  showErrorBox: (t: string, c: string) => void,
  log: (stage: string, err: unknown) => void
): boolean {
  if (ensureWritableDir(userData)) return true
  log('startup-environment', `userData not writable: ${userData}`)
  showErrorBox(
    '无法写入数据目录 / Cannot Write Data Directory',
    [
      '应用无法在以下数据目录写入文件，可能是权限不足或杀毒软件拦截所致：',
      '',
      `数据目录：${userData}`,
      '',
      '请尝试以下操作：',
      '1. 检查杀毒软件（如 Windows Defender）是否拦截了本程序，将其加入白名单；',
      '2. 以管理员身份运行本程序（右键 → 以管理员身份运行）；',
      '3. 在设置中将数据目录修改到你有写入权限的位置。',
      '',
      'The application cannot write to its data directory, possibly due to',
      'insufficient permissions or antivirus blocking.',
      `Directory: ${userData}`,
      '',
      'Suggested fixes:',
      '1. Allow the app in your antivirus (e.g. Windows Defender) real-time protection;',
      '2. Run as administrator (right-click → Run as administrator);',
      '3. Change the data directory in Settings to a writable location.'
    ].join('\n')
  )
  return false
}

/**
 * 启动期环境检测主入口。
 * 返回 true 表示环境可用可继续；false 表示已弹窗并应终止启动。
 */
export function verifyStartupEnvironment(deps: StartupEnvDeps = {}): boolean {
  const showErrorBox = deps.showErrorBox ?? defaultShowErrorBox
  const getExecPath = deps.getExecPath ?? (() => process.execPath)
  const getUserDataPath =
    deps.getUserDataPath ?? (() => require('electron').app.getPath('userData'))
  const getEnv = deps.getEnv ?? (() => process.env)
  const log = deps.log ?? defaultLog

  // 开发 / CI 跳过开关：仅严格等于 '1' 才跳过（防误触与大小写/空白）
  if (getEnv().NIKKI_SKIP_ENV_GUARD === '1') {
    log('startup-environment', 'skipped via NIKKI_SKIP_ENV_GUARD=1')
    return true
  }

  const execPath = getExecPath()
  // 安装路径非 ASCII：仅警告，不阻塞
  checkInstallPathNonAscii(execPath, showErrorBox, log)

  const userData = getUserDataPath()
  // userData 不可写：阻塞
  if (!checkUserDataWritable(userData, showErrorBox, log)) {
    return false
  }
  return true
}
