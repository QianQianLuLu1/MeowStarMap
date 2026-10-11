// @core-change: sync-integration 阶段 4 新增 sync 域 IPC handler：同步服务器状态/启停/配对二维码内容
import { ipcMain } from 'electron'
import type { HandlerContext } from '../handler-context'
import { wrapHandlerNoArgs } from '../validator'
import { AppError } from '../../../shared/errors/app-error'

/**
 * NikkiSync 同步服务域 IPC handler（sync-integration 阶段 4）。
 *
 * - sync:getStatus：服务器运行状态 + 服务身份/TLS 指纹（available=false 表示未组装）
 * - sync:startServer / sync:stopServer：手动启停（自启开关为 sync.serverEnabled 设置）
 * - sync:createPairingQr：生成一次性配对二维码内容（NS1 七段串；SVG 渲染属阶段 5 UI 层）
 *
 * 错误消息为英文：i18n key 与设置 UI 一并归入阶段 5（当前无渲染端消费方）。
 */
export function registerSyncHandlers(ctx: HandlerContext): void {
  ipcMain.handle(
    'sync:getStatus',
    wrapHandlerNoArgs(ctx, async () => {
      if (!ctx.syncServer) return { available: false as const }
      return await ctx.syncServer.getStatus()
    })
  )

  ipcMain.handle(
    'sync:startServer',
    wrapHandlerNoArgs(ctx, async () => {
      if (!ctx.syncServer) {
        throw AppError.preconditionFailed('sync server is not assembled yet')
      }
      await ctx.syncServer.start()
      return await ctx.syncServer.getStatus()
    })
  )

  ipcMain.handle(
    'sync:stopServer',
    wrapHandlerNoArgs(ctx, async () => {
      if (!ctx.syncServer) {
        throw AppError.preconditionFailed('sync server is not assembled yet')
      }
      await ctx.syncServer.stop()
      return await ctx.syncServer.getStatus()
    })
  )

  ipcMain.handle(
    'sync:createPairingQr',
    wrapHandlerNoArgs(ctx, async () => {
      if (!ctx.syncServer) {
        throw AppError.preconditionFailed('sync server is not assembled yet')
      }
      return await ctx.syncServer.createPairingQr()
    })
  )
}
