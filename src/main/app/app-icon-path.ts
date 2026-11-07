/**
 * 应用图标路径解析（纯函数，不 import electron，便于单测注入）。
 *
 * 打包态：build.asarUnpack 把 icon.ico 移出 asar，真实文件位于
 * <resourcesPath>/app.asar.unpacked/resources/icons/icon.ico，原生层按文件路径读取必须指向这里。
 * dev 态：__dirname 可能是产物布局 dist/main/main/app（回退 4 层）或源码布局 src/main/app（回退 3 层）。
 * 候选 + existsSync 的写法复用 src/main/decryption-worker/dll-path.ts 的既有范式。
 */
import path from 'node:path'
import { existsSync } from 'node:fs'

export interface AppIconContext {
  isPackaged: boolean
  resourcesPath?: string
  appDir: string
}

const ICON_REL = path.join('resources', 'icons', 'icon.ico')

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function firstExisting(candidates: string[], exists: (p: string) => boolean): string | null {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * 返回可用的图标绝对路径；找不到时返回 null（由调用方记 warn 并省略 BrowserWindow 的 icon 选项）。
 * @param input 运行环境上下文；isPackaged 为 true 时 resourcesPath 必填
 * @param exists 可注入的存在性判断，默认 fs.existsSync
 */
export function resolveAppIconPath(
  input: AppIconContext,
  exists: (p: string) => boolean = existsSync
): string | null {
  if (!input || typeof input !== 'object') return null
  if (!isNonBlankString(input.appDir)) return null

  if (input.isPackaged === true) {
    if (!isNonBlankString(input.resourcesPath)) return null
    return firstExisting([path.join(input.resourcesPath, 'app.asar.unpacked', ICON_REL)], exists)
  }

  return firstExisting(
    [
      path.resolve(input.appDir, '../../../../', ICON_REL),
      path.resolve(input.appDir, '../../../', ICON_REL)
    ],
    exists
  )
}
