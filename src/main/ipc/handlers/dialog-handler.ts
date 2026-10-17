// @core-change: 图片水印需放行用户在对话框显式选中的单文件，并按目录/文件分集合登记
// （目录形态走 registerUserPickedDir，供 scanner:start / settings:set 的扫描根短路判定）
import { ipcMain, dialog } from 'electron'
import path from 'path'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, pathGuard } from '../validator'
import { requireMainWindow } from './_shared'
import { t } from '../../i18n'

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
      // 选中目录登记白名单（否则 import 链路在路径校验处被拒）并标记 userPicked
      // （用户显式选择即授权：registerUserPickedDir 内部联动 register，避免敏感目录
      // 黑名单误拦用户显式选择的系统目录）。目录形态另记入 userPickedDirs，
      // 供 scanner:start / settings:set 的「扫描根」短路判定使用。
      for (const p of result.filePaths) {
        if (p) pathGuard.registerUserPickedDir(p)
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
        // 显式选择即授权：目录与单文件同语义（doctrine 见 validator.ts addUserPicked 注释）。
        // 此前只在 openDirectory 时登记，导致编辑器图片水印挑中的 logo 未被登记，
        // 经 media:// 展示时四条例外规则均不命中而恒 403、水印静默消失。
        // 放宽的边界由三处兜住：isUserPicked 只做「根自身 / 根+分隔符」前缀匹配，
        // 登记一个文件只放行该文件本身（不外溢到同目录兄弟文件）；展示面另有媒体
        // 扩展名闸门（media-protocol 规则 0），挑中的 .txt/.json 一律不因本登记而放行；
        // 目录与文件分集合登记（registerUserPickedDir / registerUserPicked），
        // scanner:start / settings:set 只认目录集合，挑中的 logo 不能冒充扫描根。
        // multiSelections 下登记全部返回路径（返回值形状不变，仍取 filePaths[0]）。
        const isDirectoryPick = Boolean(options?.properties?.includes('openDirectory'))
        for (const p of result.filePaths) {
          if (!p) continue
          if (isDirectoryPick) pathGuard.registerUserPickedDir(p)
          else pathGuard.registerUserPicked(p)
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
            .min(1, t('main.dialog.validation.messageRequired'))
            .max(8 * 1024),
          buttons: z.array(z.string().max(64)).max(16).optional()
        })
      ]),
      async ([options]) => {
        const result = await dialog.showMessageBox(requireMainWindow(ctx), {
          type: options.type || 'info',
          title: options.title,
          message: options.message,
          buttons: options.buttons || [t('main.dialog.defaultOk')]
        })
        return result.response
      }
    )
  )
}
