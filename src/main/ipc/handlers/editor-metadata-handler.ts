/**
 * 编辑器域 IPC handler：XMP 元数据
 *
 * 覆盖「导出含参数副本 + 一键恢复编辑参数」：
 * editor:exportWithMetadata / editor:batchExportWithMetadata / editor:readMetadata
 *
 * 保存类通道见 `editor.ts`，滤镜预设通道见 `editor-preset-handler.ts`。
 */
import { BrowserWindow, ipcMain, dialog } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, schemas, assertFileReadPath, assertFileWritePath } from '../validator'
import { assertMediaReadPath } from '../media-read-guard'
import { AppError } from '../../../shared/errors/app-error'
// P1-M：编辑器服务（sharp pipeline 与备份/写入逻辑）
import { editorService, buildEditorMetadata } from '../../services/editor-service'
import type { EditorMetadata, EditorMetadataFilter } from '../../../shared/types/editor-metadata'
import { t } from '../../i18n'

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

export function registerEditorMetadataHandlers(ctx: HandlerContext): void {
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
        schemas.filePathArrayBulk,
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
        // 双层校验：已索引媒体白名单优先，PathGuard 兜底（纯只读元数据通道，
        // 与 file:getExif / video:metadata 同根因同方案）
        assertMediaReadPath(ctx, filePath)
        return editorService.readMetadata(filePath)
      }
    )
  )
}
