import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import path from 'path'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, schemas } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { validateNonSensitivePath } from '../../utils/ipc-validate'

/**
 * shell 操作（打开目录 / 打开文件所在位置）仅让操作系统定位文件，不经由应用读取文件内容，
 * 因此不应受 pathGuard 读取白名单约束（否则图库内已索引但目录未登记为白名单根的游戏截图
 * 会被误拦截，弹出“路径不在白名单内，禁止读取操作”）。
 * 仅做：绝对路径校验 + 系统敏感目录黑名单拦截（兜底安全）。
 */
function assertShellPathSafe(p: string): void {
  // 兼容 Windows 盘符路径（D:\...）、UNC（\\...）与 POSIX 根路径（/...）；真正的相对路径（foo、./x、../x）才拦截
  if (!path.isAbsolute(p) && !p.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(p)) {
    throw AppError.forbidden('路径必须为绝对路径', { path: p })
  }
  const result = validateNonSensitivePath(p)
  if (!result.valid) {
    throw AppError.forbidden(result.message ?? '出于安全考虑，不允许操作系统敏感目录', {
      path: p
    })
  }
}

// FIX(组5-1): Windows 下 shell.openPath 等效双击，可执行/脚本文件会被直接启动进程，
// 渲染进程被入侵后可借该通道执行任意非黑名单路径下的程序，故 openPath 增加可执行扩展名拦截。
// showItemInFolder 仅在资源管理器定位选中、不执行文件，不在拦截范围内。
const EXECUTABLE_PATH_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.scr',
  '.com',
  '.msi',
  '.msp',
  '.ps1',
  '.psm1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.ws',
  '.wsf',
  '.wsh',
  '.hta',
  '.pif',
  '.cpl',
  '.msc',
  '.jar',
  '.reg',
  '.lnk',
  '.sh',
  '.app'
])

/**
 * FIX(组5-1): 拦截可执行/脚本文件路径，防止 shell:openPath 成为任意程序执行通道。
 */
function assertNotExecutablePath(p: string): void {
  const ext = path.extname(p).toLowerCase()
  if (EXECUTABLE_PATH_EXTENSIONS.has(ext)) {
    throw AppError.forbidden('出于安全考虑，不允许通过 shell:openPath 打开可执行或脚本文件', {
      path: p
    })
  }
}

/**
 * shell 域 IPC handler：外部链接 / 资源管理器打开。
 */
export function registerShellHandlers(ctx: HandlerContext): void {
  // ---- shell 域 ----
  // 外部链接
  ipcMain.handle(
    'shell:openExternal',
    wrapHandler(ctx, z.tuple([schemas.httpUrl]), async ([url]) => {
      try {
        await shell.openExternal(url)
        return { opened: true }
      } catch (error) {
        throw AppError.internal(
          `打开外部链接失败: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )

  // T01：在资源管理器中打开目录
  ipcMain.handle(
    'shell:openPath',
    wrapHandler(ctx, z.tuple([schemas.filePath]), async ([dirPath]) => {
      // shell 操作为系统级定位，仅需绝对路径 + 系统敏感目录黑名单校验
      assertShellPathSafe(dirPath)
      // FIX(组5-1): openPath 等效双击，可执行/脚本文件必须拦截
      assertNotExecutablePath(dirPath)
      try {
        await shell.openPath(dirPath)
        return { opened: true }
      } catch (error) {
        throw AppError.internal(
          `打开目录失败: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )

  // 在资源管理器中打开文件所在位置并选中该文件
  // shell.showItemInFolder 是 Electron 内置 API，仅 Windows/macOS 支持
  ipcMain.handle(
    'shell:showItemInFolder',
    wrapHandler(ctx, z.tuple([schemas.filePath]), async ([filePath]) => {
      assertShellPathSafe(filePath)
      try {
        shell.showItemInFolder(filePath)
        return { opened: true }
      } catch (error) {
        throw AppError.internal(
          `打开文件所在位置失败: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )
}
