import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, assertFileWritePath } from '../validator'
import { MAX_FILE_PATH_LENGTH } from '../../utils/constants'

/**
 * export 域专用 handler：导出默认目录与命名规则的安全写入通道。
 *
 * export.defaultDir 会被拼为导出目标路径，export.namingPattern 会参与构造导出文件名，
 * 二者均属安全敏感项，不得经通用 settings:set 写入（settings:set 会拒绝这两个 key）。
 * 此处复用 assertFileWritePath 做路径白名单校验；命名规则校验拦路径分隔符与 ".." 防子目录注入。
 */

// 空串单独允许（清空场景），非空时长度上限与 schemas.filePath 一致
const defaultDirSchema = z.string().max(MAX_FILE_PATH_LENGTH)

// 命名规则：禁止路径分隔符与 ".."（防子目录穿越）；允许空串等同于清空
const namingPatternSchema = z
  .string()
  .max(256, '命名规则长度上限 256')
  .refine((s) => !/[\\/]/.test(s), '命名规则不得包含路径分隔符')
  .refine((s) => !s.includes('..'), '命名规则不得包含 ".."')

export function registerExportPrefHandlers(ctx: HandlerContext): void {
  // 设置默认导出目录：空串=清空回退到即时选择；非空经 assertFileWritePath 白名单校验
  ipcMain.handle(
    'export:setDefaultDir',
    wrapHandler(ctx, z.tuple([defaultDirSchema]), async ([dir]) => {
      if (dir.length > 0) {
        assertFileWritePath(dir)
      }
      ctx.dbManager.setSetting('export.defaultDir', dir)
      return { saved: true }
    })
  )

  // 设置导出命名规则：zod 已校验无路径分隔符/..，直接落库
  ipcMain.handle(
    'export:setNamingPattern',
    wrapHandler(ctx, z.tuple([namingPatternSchema]), async ([pattern]) => {
      ctx.dbManager.setSetting('export.namingPattern', pattern)
      return { saved: true }
    })
  )
}
