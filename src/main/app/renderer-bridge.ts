import type { AppContext } from './app-context'
import { logger } from '../utils/logger'

/**
 * 向渲染进程发消息的安全封装。
 * 主窗口 closed 后 webContents 可能"对象还在但底层已销毁"，直接 send 会抛
 * "Object has been destroyed"，?. 只能防 null 防不住这种情况。
 * 逐级检查窗口/webContents 存活状态，send 外包 try/catch，失败记 warn 不冒泡。
 */
export function sendToRenderer(ctx: AppContext, channel: string, ...args: unknown[]): void {
  const win = ctx.mainWindow
  if (!win) return
  if (win.isDestroyed()) return
  const wc = win.webContents
  if (wc.isDestroyed()) return
  try {
    wc.send(channel, ...args)
  } catch (err) {
    logger.warn('[Renderer] webContents.send 失败:', {
      channel,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}
