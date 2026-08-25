/**
 * 编辑器域 IPC handler：滤镜预设
 *
 * 覆盖滤镜预设的入库 / JSON 文件导出导入 / 列表 / 删除。
 * 保存类通道见 `editor.ts`，XMP 元数据通道见 `editor-metadata-handler.ts`。
 */
import { ipcMain, dialog } from 'electron'
import { z } from 'zod'
import fs from 'fs'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { requireMainWindow } from './_shared'
import { t } from '../../i18n'

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

export function registerEditorPresetHandlers(ctx: HandlerContext): void {
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
}
