import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, schemas } from '../validator'

/**
 * ui-theme 域 IPC handler：界面主题读取与切换。
 */
export function registerThemeHandlers(ctx: HandlerContext): void {
  // ---- ui-theme 域 ----
  // 界面主题（统一主题接口，原 theme:get/set 系统亮暗接口已删除——暗色模式由界面主题派生）
  ipcMain.handle(
    'ui-theme:get',
    wrapHandlerNoArgs(ctx, async () => ({
      theme: ctx.dbManager.getSetting('uiTheme', 'default')
    }))
  )

  ipcMain.handle(
    'ui-theme:set',
    wrapHandler(ctx, z.tuple([schemas.uiTheme]), async ([theme]) => {
      ctx.applyUITheme(theme)
      return { applied: true }
    })
  )
}
