import { ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, schemas, assertFileWritePath } from '../validator'
import { SETTING_KEYS } from '../../utils/dir-manager'
import { t } from '../../i18n'

/**
 * P1-A11：抽取 8 个 setDir/resetDir handler 的工厂函数
 *
 * 原 backup/cache/crash/log 四个 handler 文件各自实现完全同构的 setDir/resetDir，
 * 仅 channel 名与 SETTING_KEYS 不同。这里以工厂模式消除约 100 行重复模板。
 *
 * 改造为 wrapHandler：参数校验 + 路径白名单 + 统一响应结构。
 */

interface DirOpResult {
  success: boolean
  needRestart: boolean
  message: string
}

/** 注册「设置自定义目录」handler：校验可写 → 持久化 → 提示重启 */
export function registerSetDirHandler(
  ctx: HandlerContext,
  channel: string,
  settingKey: keyof typeof SETTING_KEYS
): void {
  ipcMain.handle(
    channel,
    wrapHandler(ctx, z.tuple([schemas.filePath]), async ([dir]): Promise<DirOpResult> => {
      // 路径白名单校验：所有自定义目录必须在用户主目录或已注册根下
      assertFileWritePath(dir)
      try {
        // 校验目录可写：mkdir + 写测试文件 + 删除测试文件
        await fs.promises.mkdir(dir, { recursive: true })
        const testFile = path.join(dir, '.wxnn-write-test')
        await fs.promises.writeFile(testFile, 'test', 'utf-8')
        await fs.promises.unlink(testFile)
        // 持久化到设置表
        ctx.dbManager.setSetting(SETTING_KEYS[settingKey], dir)
        return {
          success: true,
          needRestart: true,
          message: `目录已设置为：${dir}，需要重启应用才能生效。是否立即重启？`
        }
      } catch (err) {
        return {
          success: false,
          needRestart: false,
          message: `目录不可写：${err instanceof Error ? err.message : String(err)}`
        }
      }
    })
  )
}

/** 注册「重置为默认目录」handler：清空设置项 → 提示重启 */
export function registerResetDirHandler(
  ctx: HandlerContext,
  channel: string,
  settingKey: keyof typeof SETTING_KEYS
): void {
  ipcMain.handle(
    channel,
    wrapHandlerNoArgs(ctx, async (): Promise<DirOpResult> => {
      try {
        ctx.dbManager.setSetting(SETTING_KEYS[settingKey], '')
        return {
          success: true,
          needRestart: true,
          message: t('main.setDir.message.resetToDefault')
        }
      } catch (err) {
        return {
          success: false,
          needRestart: false,
          message: t('main.setDir.error.resetFailed', {
            reason: err instanceof Error ? err.message : String(err)
          })
        }
      }
    })
  )
}
