// @core-change: sync-integration 阶段4/5：sync 域 IPC handler（阶段4 状态/启停/配对二维码内容；
//               阶段5 新增设备列表 sync:listDevices 与撤销 sync:revokeDevice）
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandlerNoArgs, wrapHandlerRaw } from '../validator'
import { AppError } from '../../../shared/errors/app-error'

/**
 * NikkiSync 同步服务域 IPC handler（sync-integration 阶段 4/5）。
 *
 * - sync:getStatus：服务器运行状态 + 服务身份/TLS 指纹（available=false 表示未组装）
 * - sync:startServer / sync:stopServer：手动启停（自启开关为 sync.serverEnabled 设置）
 * - sync:createPairingQr：生成一次性配对二维码内容（NS1 七段串；SVG 渲染属阶段 5 UI 层）
 * - sync:listDevices：已配对设备列表（仅活跃设备，阶段 5）
 * - sync:revokeDevice：撤销设备（软删 revoked_at；不踢已建立 WS 连接，阶段 5）
 *
 * 错误消息为英文（项目规则：主进程字符串字面量禁中文）；本地化由渲染层 i18n 完成。
 */

// sync:revokeDevice deviceId 校验（与设备表 device_id 长度同量级；trim 防空白误绑）
const revokeDeviceSchema = z.string().trim().min(1).max(128)

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

  // ---- 阶段 5：设备管理 ----
  ipcMain.handle(
    'sync:listDevices',
    wrapHandlerNoArgs(ctx, async () => {
      if (!ctx.syncServer) {
        throw AppError.preconditionFailed('sync server is not assembled yet')
      }
      return await ctx.syncServer.listDevices()
    })
  )

  // revokeDevice 走 wrapHandlerRaw + 内联 zod（scanner:start 同款：校验真实生效且可测）
  ipcMain.handle(
    'sync:revokeDevice',
    wrapHandlerRaw(ctx, async (args) => {
      const parsed = revokeDeviceSchema.safeParse(args[0])
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((i) => `[${i.path.join('.')}] ${i.message}`)
          .join('; ')
        throw AppError.validation(`invalid deviceId: ${message}`)
      }
      if (!ctx.syncServer) {
        throw AppError.preconditionFailed('sync server is not assembled yet')
      }
      const revoked = await ctx.syncServer.revokeDevice(parsed.data)
      if (!revoked) {
        throw AppError.notFound(`sync device not found: ${parsed.data}`)
      }
      return await ctx.syncServer.listDevices()
    })
  )
}
