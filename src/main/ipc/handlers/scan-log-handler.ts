/**
 * 扫描诊断日志域 IPC handler。
 *
 * 暴露只读查询与导出通道，供诊断工具页回放/导出全链路扫描日志：
 * - scan:getScanLog：返回本次（或全部）扫描的结构化诊断条目
 * - scan:clearScanLog：清空内存缓冲区（不影响当前正在进行的扫描）
 * - scan:exportScanLog：将轨迹导出为用户选择的 .json / .log 文件（需求五.1 一键导出）
 *
 * 五要素：
 * - 依赖声明：复用 scanLogStore（主进程单例）+ electron dialog + fs/promises，无新增依赖。
 * - 启动说明：由 setupIPC 调用 registerScanLogHandlers 注册，无副作用。
 * - 错误处理：查询/清空为只读，异常由 wrapHandler* 统一兜底；导出失败抛 AppError.internal，
 *   用户取消保存抛 AppError.canceled（渲染端据此不提示错误）。
 * - 参数校验：查询/清空无入参（wrapHandlerNoArgs）；导出用 zod 校验 format 枚举。
 *   写入路径经 pathGuard.register + assertFileWritePath，遵循既有写校验约定。
 * - 基础测试：随 scan-log-store.test.ts 覆盖仓库逻辑；本 handler 仅做转发。
 */
import { ipcMain, dialog } from 'electron'
import { z } from 'zod'
import fsp from 'fs/promises'
import path from 'path'
import type { HandlerContext } from '../handler-context'
import { wrapHandlerNoArgs, wrapHandler, pathGuard, assertFileWritePath } from '../validator'
import { scanLogStore, toExportText } from '../../scanner/scan-log-store'
import { AppError } from '../../../shared/errors/app-error'
import { requireMainWindow } from './_shared'
import { t } from '../../i18n'

/** 导出格式：json（结构化，便于工单附件）/ log（可读文本，含错误码列） */
const exportSchema = z.tuple([
  z
    .object({
      format: z.enum(['json', 'log']).optional()
    })
    .optional()
])

export function registerScanLogHandlers(ctx: HandlerContext): void {
  ipcMain.handle(
    'scan:getScanLog',
    wrapHandlerNoArgs(ctx, () => scanLogStore.getEntries())
  )
  ipcMain.handle(
    'scan:clearScanLog',
    wrapHandlerNoArgs(ctx, () => {
      scanLogStore.clear()
      return { ok: true }
    })
  )

  // 需求五.1：扫描诊断一键导出（保存为 .json / .log）
  ipcMain.handle(
    'scan:exportScanLog',
    wrapHandler(ctx, exportSchema, async ([options]) => {
      const format = options?.format ?? 'json'
      const defaultName = `nikki-scan-diagnostic-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${format}`
      const result = await dialog.showSaveDialog(requireMainWindow(ctx), {
        defaultPath: defaultName,
        filters: [
          format === 'json'
            ? { name: 'JSON', extensions: ['json'] }
            : { name: 'Log', extensions: ['log', 'txt'] }
        ]
      })
      if (result.canceled || !result.filePath) {
        throw AppError.canceled(t('main.scanLog.error.exportCanceled'))
      }
      const filePath = result.filePath
      // 仅登记父目录，避免后续写入校验被拒
      pathGuard.register(path.dirname(filePath))
      assertFileWritePath(filePath)

      try {
        const entries = scanLogStore.getEntries()
        const content = format === 'json' ? JSON.stringify(entries, null, 2) : toExportText(entries)
        await fsp.writeFile(filePath, content, 'utf-8')
        return { ok: true, path: filePath, count: entries.length }
      } catch (error) {
        throw AppError.internal(
          t('main.scanLog.error.exportFailed', {
            reason: error instanceof Error ? error.message : String(error)
          })
        )
      }
    })
  )
}
