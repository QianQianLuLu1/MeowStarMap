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
import os from 'os'
import path from 'path'
import { getUserFacingDiagDir } from './user-diag-path'

let startupLogPath: string | null = null

/**
 * 诊断目录单一真相源：启动日志与 diag.log 一律走 getUserFacingDiagDir()。
 *
 * documents 候选由主进程入口通过 setDocumentsPathProvider(() => app.getPath('documents'))
 * 注册，使「写盘路径」与「弹窗展示路径」严格同源。
 * 修复前本模块未注入 documents，真实落盘回落到 <homedir>/NikkiGallery/Diagnostics，
 * 而弹窗仍展示 文档/NikkiGallery/Diagnostics → 用户在弹窗路径下找不到日志。
 */
function resolveDiagDir(): string {
  return getUserFacingDiagDir()
}

function getStartupLogPath(): string {
  if (startupLogPath) return startupLogPath
  try {
    // 用户友好目录：文档/NikkiGallery/Diagnostics（非隐藏，普通用户易查找）
    startupLogPath = path.join(resolveDiagDir(), 'startup-errors.log')
  } catch {
    // 极端情况：getUserFacingDiagDir 失败，回退到 os.tmpdir
    startupLogPath = path.join(os.tmpdir(), 'NikkiGallery-startup-errors.log')
  }
  return startupLogPath
}

let diagLogPath: string | null = null

/**
 * 获取诊断日志路径。
 *
 * 统一输出到用户友好目录（getUserFacingDiagDir）：
 *   文档/NikkiGallery/Diagnostics/diag.log
 * 而非隐藏的 AppData，确保普通用户在启动失败时也能轻松找到日志。
 */
function getDiagLogPath(): string {
  if (diagLogPath) return diagLogPath
  try {
    diagLogPath = path.join(resolveDiagDir(), 'diag.log')
  } catch {
    diagLogPath = path.join(os.tmpdir(), 'NikkiGallery-diag.log')
  }
  return diagLogPath
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
 * 提取 errno 摘要（code / errno / syscall / path / spawnargs）。
 *
 * 目的：子进程启动失败（现场问题 `spawn EFTYPE`）的 message 不含目标可执行文件，
 * 仅凭 message + stack 无法判断是哪个二进制失败，故单独追加一行可检索摘要。
 */
function summarizeErrno(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const e = error as NodeJS.ErrnoException & { spawnargs?: unknown }
  const parts: string[] = []
  if (e.code) parts.push(`code=${e.code}`)
  if (e.errno !== undefined && e.errno !== null) parts.push(`errno=${String(e.errno)}`)
  if (e.syscall) parts.push(`syscall=${e.syscall}`)
  if (e.path) parts.push(`path=${e.path}`)
  if (Array.isArray(e.spawnargs)) parts.push(`spawnargs=${JSON.stringify(e.spawnargs)}`)
  return parts.length > 0 ? `[errno] ${parts.join(' ')}` : ''
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
    const errnoLine = summarizeErrno(error)
    const line = `[${timestamp}] [STAGE: ${stage}] ${errStr}${errnoLine ? `\n${errnoLine}` : ''}\n`
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
