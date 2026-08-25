/**
 * 编辑器域 IPC handler：保存
 *
 * 覆盖 editor:save / editor:saveAs。
 * 滤镜预设通道见 `editor-preset-handler.ts`，XMP 元数据通道见 `editor-metadata-handler.ts`。
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import path from 'path'
import sanitizeFilename from 'sanitize-filename'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, schemas, assertFileWritePath } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
// P1-M：编辑器服务（sharp pipeline 与备份/写入逻辑）
import { editorService } from '../../services/editor-service'
import { t } from '../../i18n'

// dataUrl 200MB 上限（base64 编码后的字符串长度）
const MAX_DATA_URL_LENGTH = 200 * 1024 * 1024

// 另存为允许的输出格式：白名单而非任意字符串，避免渲染进程写出 .bat/.exe 等可执行扩展名
const SAVE_AS_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'avif'] as const

/**
 * 消毒「另存为」文件名。
 *
 * basename 先剥掉任何路径成分（fileName 里塞 ..\..\ 时只保留最后一段），
 * 再交给 sanitize-filename 处理 Windows 保留设备名（CON/PRN/NUL…）与非法字符。
 */
function sanitizeSaveAsFileName(raw: string): string {
  const sanitized = sanitizeFilename(path.basename(raw)).trim()
  if (!sanitized) throw AppError.validation(t('main.editor.validation.fileNameInvalid'))
  return sanitized
}

export function registerEditorHandlers(ctx: HandlerContext): void {
  ipcMain.handle(
    'editor:save',
    wrapHandler(
      ctx,
      z.tuple([
        schemas.filePath,
        z
          .string()
          .min(1, t('main.editor.validation.dataUrlRequired'))
          .max(MAX_DATA_URL_LENGTH, t('main.editor.validation.dataUrlMaxLength')),
        z
          .object({
            format: z.string().max(32).optional(),
            quality: z.number().int().min(1).max(100).optional(),
            params: z
              .string()
              .max(64 * 1024)
              .optional()
          })
          .optional()
      ]),
      async ([filePath, dataUrl, options]) => {
        // P1-M：sharp pipeline 已抽取到 editorService.save()
        // 职责分离：handler 仅做参数校验，业务逻辑（备份/写入/恢复/历史记录）由 service 处理
        return editorService.save(filePath, dataUrl, options)
      }
    )
  )

  ipcMain.handle(
    'editor:saveAs',
    wrapHandler(
      ctx,
      z.tuple([
        z
          .string()
          .min(1, t('main.editor.validation.dataUrlRequired'))
          .max(MAX_DATA_URL_LENGTH, t('main.editor.validation.dataUrlMaxLength')),
        z
          .object({
            directory: z.string().max(1024).optional(),
            fileName: z.string().max(255).optional(),
            format: z.enum(SAVE_AS_FORMATS).optional(),
            quality: z.number().int().min(1).max(100).optional()
          })
          .optional()
      ]),
      async ([dataUrl, options]) => {
        if (!options) return ctx.fileService.saveDataUrl(dataUrl, {})

        // 目录：渲染进程给的落盘目录必须在 pathGuard 白名单内
        if (options.directory) assertFileWritePath(options.directory)

        return ctx.fileService.saveDataUrl(dataUrl, {
          ...options,
          ...(options.fileName !== undefined
            ? { fileName: sanitizeSaveAsFileName(options.fileName) }
            : {})
        })
      }
    )
  )
}
