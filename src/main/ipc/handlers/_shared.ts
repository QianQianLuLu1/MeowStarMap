import { BrowserWindow } from 'electron'
import type { HandlerContext } from '../handler-context'
import { AppError } from '../../../shared/errors/app-error'
import { t } from '../../i18n'

/**
 * 复刻 index.ts 中 this.getMainWindow() 的行为：
 * 优先取主窗口，回退到当前焦点窗口，均无则抛错。
 * ctx.getMainWindow() 返回 null 时不抛，这里负责补上抛错语义以保留原行为。
 */
export function requireMainWindow(ctx: HandlerContext): BrowserWindow {
  const win = ctx.getMainWindow() ?? BrowserWindow.getFocusedWindow()
  if (!win) throw AppError.preconditionFailed(t('main.error.mainWindowNotInit'))
  return win
}
