import { ipcMain, app } from 'electron'
import type { HandlerContext } from '../handler-context'
import { wrapHandlerNoArgs } from '../validator'
// 自动更新：handler 直接委托给 auto-update 模块的已初始化实例
import { checkForUpdates, downloadUpdate, quitAndInstall } from '../../app/auto-update'

/**
 * app 域 IPC handler：应用重启 / 版本号查询。
 */
export function registerAppHandlers(_ctx: HandlerContext): void {
  // ---- app 域 ----
  // 重启应用（自定义目录切换后调用）
  // 修复：用 app.quit 触发 before-quit 清理流程，确保数据库 checkpoint 和子进程 kill
  ipcMain.handle(
    'app:relaunch',
    wrapHandlerNoArgs(_ctx, async () => {
      app.relaunch()
      app.quit()
      return { relaunching: true }
    })
  )

  // U1：获取应用版本号，避免渲染层硬编码 v2.5.0
  ipcMain.handle(
    'app:getVersion',
    wrapHandlerNoArgs(_ctx, async () => app.getVersion())
  )

  // 自动更新：渲染端主动触发检查（仅生产环境有效，dev 下 checkForUpdates no-op）
  ipcMain.handle(
    'app:update:check',
    wrapHandlerNoArgs(_ctx, async () => {
      await checkForUpdates()
      return { checking: true }
    })
  )

  // 自动更新：用户确认后开始下载（autoDownload=false 时显式触发）
  ipcMain.handle(
    'app:update:download',
    wrapHandlerNoArgs(_ctx, async () => {
      await downloadUpdate()
      return { downloading: true }
    })
  )

  // 自动更新：用户确认「安装并重启」
  ipcMain.handle(
    'app:update:install',
    wrapHandlerNoArgs(_ctx, async () => {
      quitAndInstall()
      return { installing: true }
    })
  )
}
