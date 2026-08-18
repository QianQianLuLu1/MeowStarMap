import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerRaw, assertFileReadPath } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { RENDERER_PREF_KEYS, SECURITY_SENSITIVE_KEYS } from '../../../shared/settings-keys'

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
  if (!Array.isArray(value)) throw AppError.validation('customScanPaths 必须是字符串数组')
  if (value.length > MAX_CUSTOM_SCAN_PATHS) {
    throw AppError.validation(`自定义扫描路径数量上限 ${MAX_CUSTOM_SCAN_PATHS}`)
  }
  for (const p of value) {
    if (typeof p !== 'string' || p.length === 0) {
      throw AppError.validation('customScanPaths 存在空或非字符串项')
    }
    assertFileReadPath(p)
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
          z.string().min(1, 'key 不能为空').max(128, 'key 长度上限 128'),
          z.unknown().optional()
        ])
        .safeParse(args)
      if (!parsed.success) {
        throw AppError.validation(
          `参数校验失败: ${parsed.error.issues.map((i) => i.message).join('; ')}`
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
      z.tuple([z.string().min(1, 'key 不能为空').max(128, 'key 长度上限 128'), z.unknown()]),
      async ([key, value]) => {
        // P1-D：校验 value 大小，防止恶意/异常调用写入超大 JSON
        try {
          const valueStr = JSON.stringify(value)
          if (valueStr.length > 1024 * 1024) {
            throw AppError.validation('设置值过大（上限 1MB）')
          }
        } catch (err) {
          if (err instanceof AppError) throw err
          throw AppError.validation('设置值无法序列化')
        }
        // customScanPaths 走内联校验放行（方案 A：维持现状，不迁专用通道）
        if (key === 'customScanPaths') {
          assertCustomScanPaths(value)
          ctx.dbManager.setSetting(key, value)
          return { saved: true }
        }
        // 其余 key 必须在普通偏好白名单内；命中敏感 key 时给出专用通道指引
        if (!(RENDERER_PREF_KEYS as readonly string[]).includes(key)) {
          const channel = (SECURITY_SENSITIVE_KEYS as Record<string, string>)[key]
          if (channel) {
            throw AppError.validation(`key "${key}" 为安全敏感项，请改用通道：${channel}`)
          }
          throw AppError.validation(`未知的设置项 key：${key}`)
        }
        ctx.dbManager.setSetting(key, value)
        return { saved: true }
      }
    )
  )
}
