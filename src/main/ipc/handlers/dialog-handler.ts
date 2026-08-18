import { ipcMain, dialog } from 'electron'
import path from 'path'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, pathGuard } from '../validator'
import { requireMainWindow } from './_shared'

// 对话框 filters 公共 schema
const dialogFiltersSchema = z
  .array(
    z.object({
      name: z.string().max(64),
      extensions: z.array(z.string().max(16)).max(32)
    })
  )
  .max(16)
  .optional()

/**
 * dialog 域 IPC handler：目录选择 / 文件打开 / 文件保存 / 消息框。
 */
export function registerDialogHandlers(ctx: HandlerContext): void {
  // ---- dialog 域 ----
  // dialog:* 系列保留原"取消时返回 null"语义：handler 返回 string|null，由 wrapHandler 包装为 IpcResponse<string|null>
  ipcMain.handle(
    'dialog:selectDirectory',
    wrapHandlerNoArgs<string | null>(ctx, async () => {
      const result = await dialog.showOpenDialog(requireMainWindow(ctx), {
        properties: ['openDirectory']
      })
      if (result.canceled) return null
      // 选中的目录必须登记白名单，否则 import 链路在路径校验处被拒绝
      for (const p of result.filePaths) {
        if (p) pathGuard.register(p)
      }
      return result.filePaths[0] ?? null
    })
  )

  // 增强对话框
  ipcMain.handle(
    'dialog:openFile',
    wrapHandler(
      ctx,
      z.tuple([
        z
          .object({
            properties: z
              .array(
                z.enum([
                  'openFile',
                  'openDirectory',
                  'multiSelections',
                  'showHiddenFiles',
                  'createDirectory',
                  'promptToCreate',
                  'noResolveAliases',
                  'treatPackageAsDirectory',
                  'dontAddToRecent'
                ])
              )
              .optional(),
            filters: dialogFiltersSchema
          })
          .optional()
      ]),
      async ([options]) => {
        const result = await dialog.showOpenDialog(requireMainWindow(ctx), {
          properties: options?.properties || ['openFile'],
          filters: options?.filters
        })
        if (result.canceled) return null
        // openDirectory 模式下选中的是目录，须登记白名单以便后续文件操作放行
        if (options?.properties?.includes('openDirectory')) {
          pathGuard.register(result.filePaths[0])
        }
        return result.filePaths[0] ?? null
      }
    )
  )

  ipcMain.handle(
    'dialog:saveFile',
    wrapHandler(
      ctx,
      z.tuple([
        z
          .object({
            defaultPath: z.string().max(1024).optional(),
            filters: dialogFiltersSchema
          })
          .optional()
      ]),
      async ([options]) => {
        const result = await dialog.showSaveDialog(requireMainWindow(ctx), {
          defaultPath: options?.defaultPath,
          filters: options?.filters
        })
        if (result.canceled) return null
        // 仅登记父目录，避免后续写入校验被拒
        if (result.filePath) pathGuard.register(path.dirname(result.filePath))
        return result.filePath ?? null
      }
    )
  )

  ipcMain.handle(
    'dialog:showMessageBox',
    wrapHandler(
      ctx,
      z.tuple([
        z.object({
          type: z.enum(['none', 'info', 'error', 'question', 'warning']).optional(),
          title: z.string().max(256).optional(),
          message: z
            .string()
            .min(1, 'message 不能为空')
            .max(8 * 1024),
          buttons: z.array(z.string().max(64)).max(16).optional()
        })
      ]),
      async ([options]) => {
        const result = await dialog.showMessageBox(requireMainWindow(ctx), {
          type: options.type || 'info',
          title: options.title,
          message: options.message,
          buttons: options.buttons || ['确定']
        })
        return result.response
      }
    )
  )
}
