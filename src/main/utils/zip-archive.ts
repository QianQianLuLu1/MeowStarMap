/**
 * 进程内 zip 打包工具（替代外部 tar.exe）。
 *
 * 背景：诊断包导出原实现通过 child_process.spawn 调用系统 `tar.exe`，
 * 现场出现 `spawn EFTYPE`（ERROR_BAD_EXE_FORMAT：目标不是有效的 Win32 可执行文件），
 * 且该 Promise 无超时、无兜底，子进程异常时永不 settle → UI 永久停在「正在导出」。
 * 改为进程内流式打包（archiver：纯 JS，无原生依赖，流式读写不整包入内存），
 * 彻底移除对外部可执行文件的依赖，并保证任何分支都 resolve。
 *
 * 五要素：
 * - 依赖声明：archiver（运行时依赖，纯 JS，无需 asarUnpack）；无新增原生依赖。
 * - 启动说明：由 src/main/services/log-service.ts 的 exportLogsAsZip 调用，无需预初始化。
 * - 错误处理：所有分支都 resolve（永不 reject）；超时走 abort + destroy。
 * - 参数校验：sourceDir 必须存在且为目录；targetPath 必须为绝对路径且父目录存在。
 * - 基础测试：见 zip-archive.test.ts（正常 / 异常 / 边界三类）。
 */
import fs from 'fs'
import path from 'path'
import archiver, { type Archiver } from 'archiver'
import { t } from '../i18n'

/** 默认打包超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 60_000

export interface CreateZipOptions {
  /** 打包超时毫秒；非有限正数时回落 60000 */
  timeoutMs?: number
  /** 测试注入点：默认 () => archiver('zip', { zlib: { level: 6 } }) */
  createArchive?: () => Archiver
}

export interface CreateZipResult {
  success: boolean
  message: string
}

function fail(message: string): CreateZipResult {
  return { success: false, message }
}

/** 创建 archiver 实例；失败时返回 error，避免把 try/catch 混进流式编排 */
function createArchiveSafe(opts: CreateZipOptions): { archive?: Archiver; error?: unknown } {
  try {
    return {
      archive: (opts.createArchive ?? (() => archiver('zip', { zlib: { level: 6 } })))()
    }
  } catch (error) {
    return { error }
  }
}

/**
 * 将整个目录打包为 zip（流式写入，不整包入内存）。
 *
 * @param sourceDir 源目录（必须存在且为目录）
 * @param targetPath 目标 zip 绝对路径（父目录必须存在）
 * @param opts 超时与测试注入
 * @returns 永远 resolve 的结果对象；success=false 时 message 为可直接展示的原因
 */
export function createZipFromDirectory(
  sourceDir: string,
  targetPath: string,
  opts: CreateZipOptions = {}
): Promise<CreateZipResult> {
  // 参数校验：源目录
  if (typeof sourceDir !== 'string' || sourceDir.trim() === '') {
    return Promise.resolve(fail(t('main.zip.error.sourceMissing', { dir: String(sourceDir) })))
  }
  try {
    if (!fs.statSync(sourceDir).isDirectory()) {
      return Promise.resolve(fail(t('main.zip.error.sourceMissing', { dir: sourceDir })))
    }
  } catch {
    return Promise.resolve(fail(t('main.zip.error.sourceMissing', { dir: sourceDir })))
  }

  // 参数校验：目标路径
  if (typeof targetPath !== 'string' || targetPath.trim() === '' || !path.isAbsolute(targetPath)) {
    return Promise.resolve(fail(t('main.zip.error.targetMissing', { path: String(targetPath) })))
  }
  const parentDir = path.dirname(targetPath)
  try {
    if (!fs.existsSync(parentDir)) {
      return Promise.resolve(fail(t('main.zip.error.targetParentMissing', { dir: parentDir })))
    }
  } catch {
    return Promise.resolve(fail(t('main.zip.error.targetParentMissing', { dir: parentDir })))
  }

  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? Math.floor(opts.timeoutMs)
      : DEFAULT_TIMEOUT_MS

  return new Promise<CreateZipResult>((resolve) => {
    const output = fs.createWriteStream(targetPath)
    const created = createArchiveSafe(opts)
    if (!created.archive) {
      output.destroy()
      resolve(
        fail(
          t('main.zip.error.writeFailed', {
            reason: created.error instanceof Error ? created.error.message : String(created.error)
          })
        )
      )
      return
    }
    const archive = created.archive

    let settled = false

    // 超时兜底：模拟卡死场景也必须让调用方拿到结果
    const timer = setTimeout(() => {
      try {
        archive.abort()
      } catch {
        // abort 失败不影响超时返回
      }
      output.destroy()
      done(fail(t('main.zip.error.timeout', { ms: String(timeoutMs) })))
    }, timeoutMs)

    // 唯一出口：任何分支都只 resolve 一次
    const done = (result: CreateZipResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    archive.on('error', (err) => {
      output.destroy()
      done(fail(t('main.zip.error.writeFailed', { reason: err.message })))
    })
    output.on('error', (err) => {
      try {
        archive.abort()
      } catch {
        // 忽略
      }
      done(fail(t('main.zip.error.writeFailed', { reason: err.message })))
    })
    output.on('close', () => {
      try {
        if (fs.statSync(targetPath).size === 0) {
          done(fail(t('main.zip.error.emptyArchive')))
          return
        }
      } catch {
        done(fail(t('main.zip.error.targetNotGenerated')))
        return
      }
      done({ success: true, message: '' })
    })

    archive.pipe(output)
    archive.directory(sourceDir, false)
    void archive.finalize().catch((err: unknown) => {
      output.destroy()
      done(
        fail(
          t('main.zip.error.writeFailed', {
            reason: err instanceof Error ? err.message : String(err)
          })
        )
      )
    })
  })
}
