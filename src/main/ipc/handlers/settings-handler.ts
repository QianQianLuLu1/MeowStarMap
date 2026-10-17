// @core-change: customScanPaths 短路判据由 isUserPicked 改为 isUserPickedDir，与 scanner:start
// 同口径——挑中的单个文件不得作为「用户显式授权的扫描根」被持久化
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerRaw, assertFileReadPath, pathGuard } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { RENDERER_PREF_KEYS, SECURITY_SENSITIVE_KEYS } from '../../../shared/settings-keys'
import { writeHardwareAccelPref } from '../../app/gpu-fallback'
import { t } from '../../i18n'

// 与设置页 MAX_CUSTOM_PATHS / scanner:start schema 保持一致
const MAX_CUSTOM_SCAN_PATHS = 64

/**
 * customScanPaths 写入校验。
 *
 * 该设置项会被 refreshPathGuardRoots 注册为 pathGuard 白名单根，等价于"写设置即扩权"。
 * 合法来源只有 dialog:selectDirectory（用户选中时即已登记白名单），
 * 故写入时逐条读校验，阻止渲染进程直接注入任意路径绕过 scanner:start 的校验。
 */
function assertCustomScanPaths(value: unknown): void {
  if (!Array.isArray(value)) throw AppError.validation(t('main.settings.error.customPathsNotArray'))
  if (value.length > MAX_CUSTOM_SCAN_PATHS) {
    throw AppError.validation(
      t('main.settings.error.customPathsMax', { max: MAX_CUSTOM_SCAN_PATHS })
    )
  }
  for (const p of value) {
    if (typeof p !== 'string' || p.length === 0) {
      throw AppError.validation(t('main.settings.error.customPathsEmptyItem'))
    }
    // userPickedDir（对话框显式选择的目录）短路：ScanFallbackSection/ScanPathsSection
    // 选系统目录后经此持久化是唯一合法写入来源，用户显式授权不受敏感目录黑名单误拦；
    // 伪造路径（未命中标记）仍走完整校验。判据用目录集合而非 userPicked——
    // customScanPaths 存的是扫描根，dialog:openFile 挑中的单个文件不能冒充它。
    if (!pathGuard.isUserPickedDir(p)) assertFileReadPath(p)
  }
}

/**
 * settings 域 IPC handler：应用设置读写。
 */
export function registerSettingsHandlers(ctx: HandlerContext): void {
  // ---- settings 域 ----
  // 应用设置
  // settings:get 保留原"返回 defaultValue"语义：当 key 不存在时直接返回 defaultValue
  // 用 wrapHandlerRaw 自行校验参数，handler 返回原始值由 wrapHandlerRaw 包装为 IpcResponse<T>
  ipcMain.handle(
    'settings:get',
    wrapHandlerRaw<unknown>(ctx, async (args, ctx) => {
      const parsed = z
        .tuple([
          z
            .string()
            .min(1, t('main.settings.validation.keyRequired'))
            .max(128, t('main.settings.validation.keyMaxLength')),
          z.unknown().optional()
        ])
        .safeParse(args)
      if (!parsed.success) {
        throw AppError.validation(
          t('main.settings.error.validationFailed', {
            reason: parsed.error.issues.map((i) => i.message).join('; ')
          })
        )
      }
      const [key, defaultValue] = parsed.data
      return ctx.dbManager.getSetting(key, defaultValue)
    })
  )

  ipcMain.handle(
    'settings:set',
    wrapHandler(
      ctx,
      z.tuple([
        z
          .string()
          .min(1, t('main.settings.validation.keyRequired'))
          .max(128, t('main.settings.validation.keyMaxLength')),
        z.unknown()
      ]),
      async ([key, value]) => {
        // P1-D：校验 value 大小，防止恶意/异常调用写入超大 JSON
        try {
          const valueStr = JSON.stringify(value)
          if (valueStr.length > 1024 * 1024) {
            throw AppError.validation(t('main.settings.error.valueTooLarge'))
          }
        } catch (err) {
          if (err instanceof AppError) throw err
          throw AppError.validation(t('main.settings.error.valueNotSerializable'))
        }
        // customScanPaths 走内联校验放行（方案 A：维持现状，不迁专用通道）
        if (key === 'customScanPaths') {
          assertCustomScanPaths(value)
          ctx.dbManager.setSetting(key, value)
          return { saved: true }
        }
        // hardwareAcceleration 走内联布尔校验，并双写启动期可同步读取的偏好镜像
        if (key === 'hardwareAcceleration') {
          if (typeof value !== 'boolean') {
            throw AppError.validation(t('main.settings.error.hwAccelNotBoolean'))
          }
          ctx.dbManager.setSetting(key, value)
          writeHardwareAccelPref(value)
          return { saved: true }
        }
        // 其余 key 必须在普通偏好白名单内；命中敏感 key 时给出专用通道指引
        if (!(RENDERER_PREF_KEYS as readonly string[]).includes(key)) {
          const channel = (SECURITY_SENSITIVE_KEYS as Record<string, string>)[key]
          if (channel) {
            throw AppError.validation(
              t('main.settings.error.securitySensitiveKey', { key, channel })
            )
          }
          throw AppError.validation(t('main.settings.error.unknownKey', { key }))
        }
        ctx.dbManager.setSetting(key, value)
        return { saved: true }
      }
    )
  )
}
