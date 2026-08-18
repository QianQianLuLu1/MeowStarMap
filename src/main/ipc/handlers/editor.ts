import { BrowserWindow, ipcMain, dialog } from 'electron'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import sanitizeFilename from 'sanitize-filename'
import type { HandlerContext } from '../handler-context'
import {
  wrapHandler,
  wrapHandlerNoArgs,
  schemas,
  assertFileReadPath,
  assertFileWritePath
} from '../validator'
import { AppError } from '../../../shared/errors/app-error'
// P1-M：编辑器服务（sharp pipeline 与备份/写入逻辑）
import { editorService, buildEditorMetadata } from '../../services/editor-service'
import type { EditorMetadata, EditorMetadataFilter } from '../../../shared/types/editor-metadata'
import { t } from '../../i18n'

/**
 * 复刻 index.ts 中 this.getMainWindow() 的行为：
 * 优先取主窗口，回退到当前焦点窗口，均无则抛错。
 */
function requireMainWindow(ctx: HandlerContext): BrowserWindow {
  const win = ctx.getMainWindow() ?? BrowserWindow.getFocusedWindow()
  if (!win) throw AppError.preconditionFailed(t('main.error.mainWindowNotInit'))
  return win
}

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

// 滤镜预设 schema：name + category + params（params 为字符串或对象）
const filterPresetSchema = z.object({
  name: z
    .string()
    .min(1, t('main.editor.validation.nameRequired'))
    .max(128, t('main.editor.validation.nameMaxLength')),
  category: z
    .string()
    .min(1, t('main.editor.validation.categoryRequired'))
    .max(64, t('main.editor.validation.categoryMaxLength')),
  params: z.union([z.string().max(64 * 1024), z.record(z.string(), z.unknown())])
})

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

  ipcMain.handle(
    'editor:exportPreset',
    wrapHandler(ctx, z.tuple([filterPresetSchema]), async ([preset]) => {
      const db = ctx.dbManager.getDatabase()
      if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
      const result = db
        .prepare(
          'INSERT INTO filter_presets (name, category, params, is_builtin, created_at) VALUES (?, ?, ?, 0, datetime("now"))'
        )
        .run(
          preset.name,
          preset.category,
          typeof preset.params === 'string' ? preset.params : JSON.stringify(preset.params)
        )
      return { id: Number(result.lastInsertRowid) }
    })
  )

  // P1-N：validateFilterPreset 已迁移到 utils/ipc-validate.ts（统一校验工具位置）

  // 滤镜预设 JSON 文件导出/导入
  ipcMain.handle(
    'editor:exportPresetToFile',
    wrapHandler(ctx, z.tuple([filterPresetSchema]), async ([preset]) => {
      const result = await dialog.showSaveDialog(requireMainWindow(ctx), {
        defaultPath: `${preset.name || 'filter-preset'}.json`,
        filters: [{ name: t('main.editor.dialog.filterPresetName'), extensions: ['json'] }]
      })
      if (result.canceled || !result.filePath) {
        throw AppError.canceled(t('main.editor.error.userCanceledSave'))
      }
      const data = JSON.stringify(preset, null, 2)
      await fs.promises.writeFile(result.filePath, data, 'utf-8')
      return { filePath: result.filePath }
    })
  )

  ipcMain.handle(
    'editor:importPresetFromFile',
    wrapHandlerNoArgs(ctx, async () => {
      const result = await dialog.showOpenDialog(requireMainWindow(ctx), {
        properties: ['openFile'],
        filters: [{ name: t('main.editor.dialog.filterPresetName'), extensions: ['json'] }]
      })
      if (result.canceled || result.filePaths.length === 0) {
        throw AppError.canceled(t('main.editor.error.userCanceledSelect'))
      }
      const content = await fs.promises.readFile(result.filePaths[0], 'utf-8')
      let preset: unknown
      try {
        preset = JSON.parse(content)
      } catch (err) {
        throw AppError.validation(
          t('main.editor.error.jsonParseFailed'),
          err instanceof Error ? { message: err.message } : undefined
        )
      }
      // 复用 schema 校验导入的预设结构
      const parsed = filterPresetSchema.safeParse(preset)
      if (!parsed.success) {
        throw AppError.validation(
          t('main.editor.error.presetFormatInvalid'),
          parsed.error.issues.map((i) => ({ path: i.path, message: i.message }))
        )
      }
      return { preset: parsed.data, filePath: result.filePaths[0] }
    })
  )

  ipcMain.handle(
    'editor:loadPresets',
    wrapHandlerNoArgs(ctx, async () => {
      const db = ctx.dbManager.getDatabase()
      if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
      const rows = db
        .prepare(
          'SELECT id, name, category, params, is_builtin, created_at FROM filter_presets ORDER BY created_at DESC'
        )
        .all() as Array<{
        id: number
        name: string
        category: string
        params: string
        is_builtin: number
        created_at: string
      }>
      return {
        presets: rows.map((r) => ({
          id: String(r.id),
          name: r.name,
          category: r.category,
          params: JSON.parse(r.params),
          isBuiltin: !!r.is_builtin,
          createdAt: r.created_at
        }))
      }
    })
  )

  ipcMain.handle(
    'editor:deletePreset',
    wrapHandler(
      ctx,
      z.tuple([z.union([z.string().min(1).max(64), z.number().int().positive()])]),
      async ([id]) => {
        const db = ctx.dbManager.getDatabase()
        if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
        db.prepare('DELETE FROM filter_presets WHERE id = ? AND is_builtin = 0').run(id)
        return { deleted: true }
      }
    )
  )

  // ============================================================================
  // XMP 元数据写入/读取（导出含参数副本 + 一键恢复编辑参数）
  // ============================================================================

  // 编辑器元数据 schema：FilterParams（对象）+ 滤镜信息 + 滤镜强度 + 水印
  // FilterParams 字段较多且嵌套（hsl/curves），使用 z.record(z.string(), z.unknown()) 兜底校验
  const editorMetadataInputSchema = z.object({
    params: z.record(z.string(), z.unknown()),
    filter: z
      .object({
        name: z.string().max(128),
        category: z.string().max(64),
        params: z.union([z.string().max(64 * 1024), z.record(z.string(), z.unknown())])
      })
      .nullable(),
    filterIntensity: z.number().min(0).max(100),
    watermark: z.record(z.string(), z.unknown()).nullable()
  })

  /**
   * 导出单张含编辑参数 XMP 元数据的副本
   *
   * 行为：
   * - 读取源图 → 注入 XMP wxnn:EditorData → 输出到 targetDir（默认弹出对话框选择）
   * - 绝不修改原图
   */
  ipcMain.handle(
    'editor:exportWithMetadata',
    wrapHandler(
      ctx,
      z.tuple([
        schemas.filePath,
        editorMetadataInputSchema,
        z
          .object({
            targetDir: z.string().max(1024).optional(),
            fileName: z.string().max(255).optional(),
            format: z.enum(['jpg', 'jpeg', 'png', 'webp']).optional(),
            quality: z.number().int().min(1).max(100).optional()
          })
          .optional()
      ]),
      async ([sourcePath, metadataInput, options]) => {
        assertFileReadPath(sourcePath)

        // 解析目标目录：优先使用调用方传入的，未传则弹对话框选择
        let targetDir = options?.targetDir
        if (!targetDir) {
          const win = ctx.getMainWindow() ?? BrowserWindow.getFocusedWindow()
          if (!win) throw AppError.preconditionFailed(t('main.error.mainWindowNotInit'))
          const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
          if (result.canceled || result.filePaths.length === 0) {
            throw AppError.canceled(t('main.editor.error.userCanceledExportDir'))
          }
          targetDir = result.filePaths[0]
        }
        assertFileWritePath(targetDir)

        // 序列化 filter.params 为 JSON 字符串（与 EditorMetadataFilter 类型一致）
        const filter: EditorMetadataFilter | null = metadataInput.filter
          ? {
              name: metadataInput.filter.name,
              category: metadataInput.filter.category,
              params:
                typeof metadataInput.filter.params === 'string'
                  ? metadataInput.filter.params
                  : JSON.stringify(metadataInput.filter.params)
            }
          : null

        const metadata: EditorMetadata = buildEditorMetadata({
          params: metadataInput.params as unknown as EditorMetadata['params'],
          filter,
          filterIntensity: metadataInput.filterIntensity,
          watermark: metadataInput.watermark as unknown as EditorMetadata['watermark']
        })

        return editorService.exportWithMetadata(sourcePath, metadata, {
          targetDir,
          fileName: options?.fileName,
          format: options?.format,
          quality: options?.quality
        })
      }
    )
  )

  /**
   * 批量导出含编辑参数 XMP 元数据的副本
   *
   * 用于"批量应用编辑参数到选中图片"场景。所有图片共用同一份编辑参数。
   * 单张失败不阻断其他文件。
   */
  ipcMain.handle(
    'editor:batchExportWithMetadata',
    wrapHandler(
      ctx,
      z.tuple([
        schemas.filePathArray,
        editorMetadataInputSchema,
        z
          .object({
            targetDir: z.string().max(1024),
            format: z.enum(['jpg', 'jpeg', 'png', 'webp']).optional(),
            quality: z.number().int().min(1).max(100).optional()
          })
          .required({ targetDir: true })
      ]),
      async ([sourcePaths, metadataInput, options]) => {
        for (const p of sourcePaths) assertFileReadPath(p)
        assertFileWritePath(options.targetDir)

        const filter: EditorMetadataFilter | null = metadataInput.filter
          ? {
              name: metadataInput.filter.name,
              category: metadataInput.filter.category,
              params:
                typeof metadataInput.filter.params === 'string'
                  ? metadataInput.filter.params
                  : JSON.stringify(metadataInput.filter.params)
            }
          : null

        const metadata: EditorMetadata = buildEditorMetadata({
          params: metadataInput.params as unknown as EditorMetadata['params'],
          filter,
          filterIntensity: metadataInput.filterIntensity,
          watermark: metadataInput.watermark as unknown as EditorMetadata['watermark']
        })

        return editorService.batchExportWithMetadata(sourcePaths, metadata, {
          targetDir: options.targetDir,
          format: options.format,
          quality: options.quality
        })
      }
    )
  )

  /**
   * 读取图片中已写入的编辑参数 XMP 元数据
   *
   * 用于"一键恢复编辑参数"：从图片 XMP 读取 wxnn:EditorData，反序列化后返回。
   * 无 XMP 或解析失败返回 null（不抛错）。
   */
  ipcMain.handle(
    'editor:readMetadata',
    wrapHandler(
      ctx,
      z.tuple([schemas.filePath]),
      async ([filePath]): Promise<EditorMetadata | null> => {
        assertFileReadPath(filePath)
        return editorService.readMetadata(filePath)
      }
    )
  )
}
