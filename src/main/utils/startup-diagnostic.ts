/**
 * 启动诊断工具：在 logger 系统就绪前，提供独立的错误记录能力
 *
 * 关键作用：解决"启动早期失败无日志"的诊断盲区
 * - dbManager.initialize() 失败时，logger.ts 的 initLogger() 尚未执行
 * - process.on('uncaughtException') 也尚未注册
 * - 错误只能到 stderr，打包后用户不可见
 *
 * 本工具直接写文件到 userData/startup-errors.log，不依赖任何其他模块
 * 即便 dbManager / logger 都未初始化，也能记录失败原因
 */
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

let startupLogPath: string | null = null

function getStartupLogPath(): string {
  if (startupLogPath) return startupLogPath
  try {
    const userData = app.getPath('userData')
    startupLogPath = path.join(userData, 'startup-errors.log')
  } catch {
    // 极端情况：app.getPath 失败，回退到 os.tmpdir
    startupLogPath = path.join(require('os').tmpdir(), 'wxnn-startup-errors.log')
  }
  return startupLogPath
}

let diagLogPath: string | null = null

/**
 * 获取诊断日志路径
 *
 * 关键修复：原 _diag 函数用 process.cwd()，打包后双击 exe 启动时
 * cwd = C:\Windows\System32，无写入权限，导致 try/catch 静默吞掉日志
 *
 * 路径选择优先级（确保 app.whenReady() 之前也能写入）：
 * 1. app.getPath('userData')/diag.log — whenReady 之后可用
 * 2. process.env.APPDATA/wxnn-photo-manager/diag.log — whenReady 之前可用的 Windows fallback
 * 3. os.tmpdir()/wxnn-diag.log — 最后兜底
 *
 * 注意：app.getPath('userData') 在 app.whenReady() 之前调用会抛错
 * "Cannot create app data folder before app.whenReady()"
 * 所以 index.ts 中在 whenReady 之前调用 diagLog 时，会走 fallback 2
 */
function getDiagLogPath(): string {
  if (diagLogPath) return diagLogPath
  // 优先尝试 app.getPath('userData')（whenReady 之后可用）
  try {
    const userData = app.getPath('userData')
    try {
      if (!fs.existsSync(userData)) {
        fs.mkdirSync(userData, { recursive: true })
      }
    } catch {}
    diagLogPath = path.join(userData, 'diag.log')
    return diagLogPath
  } catch {
    // app.whenReady() 之前调用 app.getPath('userData') 会抛错。
    // 注意：此处 fallback 不缓存（diagLogPath 保持 null），否则首次调用（whenReady 前）
    // 会永久缓存 APPDATA，导致 app 运行期间 diag.log 永远落在 %APPDATA%，与
    // --user-data-dir 临时目录 / e2e 采集假设不符。一旦 whenReady 后 userData 可用，
    // 下一次调用立即切回 userData\diag.log。
    // fallback 1：用 process.env.APPDATA（Windows 上一定存在）
    try {
      const appData = process.env.APPDATA
      if (appData) {
        const dir = path.join(appData, 'wxnn-photo-manager')
        try {
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
          }
        } catch {}
        return path.join(dir, 'diag.log')
      }
    } catch {}
    // fallback 2：os.tmpdir()
    try {
      return path.join(require('os').tmpdir(), 'wxnn-diag.log')
    } catch {
      // 最终兜底：用当前目录（虽然打包后可能无权限，但至少不会抛错）
      return 'diag.log'
    }
  }
}

/**
 * 通用诊断日志：用于启动早期追踪流程，写入 userData/diag.log
 * 替代各文件中分散的 _diag 函数（原函数用 process.cwd() 在打包后无法写入）
 *
 * @param tag 模块标签（如 'BOOT'、'DB'、'WIN'）
 * @param msg 消息内容
 */
export function diagLog(tag: string, msg: string): void {
  try {
    const logPath = getDiagLogPath()
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] [${tag}] ${msg}\n`
    fs.appendFileSync(logPath, line)
  } catch {
    // 静默失败：诊断日志本身失败不应影响启动流程
  }
}

/**
 * 记录启动错误到独立文件（不依赖 logger 系统）
 * 即使 dbManager 未初始化、logger 未初始化，也能记录
 */
export function logStartupError(stage: string, error: unknown): void {
  try {
    const logPath = getStartupLogPath()
    const timestamp = new Date().toISOString()
    const errStr = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error)
    const line = `[${timestamp}] [STAGE: ${stage}] ${errStr}\n`
    // 追加写入，最多保留 100KB
    try {
      const stat = fs.statSync(logPath)
      if (stat.size > 100 * 1024) {
        // 超过 100KB，重置文件
        fs.writeFileSync(logPath, line, 'utf8')
      } else {
        fs.appendFileSync(logPath, line, 'utf8')
      }
    } catch (err) {
      // P1-C9：区分错误码，仅 ENOENT（文件不存在）才 writeFileSync 创建新文件；
      // 其他错误（EACCES 权限不足等，文件已存在但不可访问）改用 appendFileSync，
      // 避免 writeFileSync 覆盖已有日志丢失历史
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        fs.writeFileSync(logPath, line, 'utf8')
      } else {
        fs.appendFileSync(logPath, line, 'utf8')
      }
    }
  } catch {
    // 最后兜底：写入失败只能放弃，避免日志模块本身导致崩溃
  }
}

/**
 * 读取启动错误日志（供设置页诊断功能调用）
 */
export function readStartupErrors(): string {
  try {
    const logPath = getStartupLogPath()
    return fs.readFileSync(logPath, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 清除启动错误日志
 */
export function clearStartupErrors(): void {
  try {
    const logPath = getStartupLogPath()
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath)
    }
  } catch {
    // 静默处理
  }
}

/**
 * 获取启动错误日志路径
 */
export function getStartupLogPathValue(): string {
  return getStartupLogPath()
}
