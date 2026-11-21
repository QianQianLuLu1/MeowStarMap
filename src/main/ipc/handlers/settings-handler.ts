// @core-change: 审查修复轮——settings:set 变更留痕时序修正为「校验通过且写库成功后」发生，失败的变更不再留下未发生的 old→new 时间线
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerRaw, assertFileReadPath, pathGuard } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import {
  RENDERER_PREF_KEYS,
  SECURITY_SENSITIVE_KEYS,
  SETTING_KEY_LAUNCH_AT_LOGIN,
  LAUNCH_AT_LOGIN_DEFAULT
} from '../../../shared/settings-keys'
import { writeHardwareAccelPref, writeGpuDiscretePref } from '../../app/gpu-fallback'
import { syncLoginItemSetting } from '../../app/login-item'
import { assertSafeRemoteUrl } from '../../utils/remote-url-guard'
import { t } from '../../i18n'
import { logger } from '../../utils/logger'

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
 * 镜像/加速入口写入校验（manifest 站点键与图片 CDN 入口键**共用同一套规则**）。
 *
 * 空串（或 trim 后为空）= 未配置，回退官方/原始地址（合法回退值）；否则必须是公网
 * http/https URL（协议 + 环回/私网/保留地址闸，镜像域不设白名单）。
 * 该值决定出站请求目标，写入面即安全面。
 *
 * @param invalidMessage 校验失败时的用户可见文案（两个键各自精确指引，不共用一条）
 * @returns 校验通过后的 trim 结果（落库值）
 */
function assertMirrorBaseUrl(value: unknown, invalidMessage: string): string {
  if (typeof value !== 'string') {
    throw AppError.validation(invalidMessage)
  }
  const trimmed = value.trim()
  if (trimmed.length > 256) {
    throw AppError.validation(invalidMessage)
  }
  if (trimmed.length > 0) {
    try {
      assertSafeRemoteUrl(trimmed)
    } catch {
      throw AppError.validation(invalidMessage)
    }
  }
  return trimmed
}

/**
 * 变更留痕 old→new（fail-open）：读旧值/序列化失败一律不影响写入主流程；
 * 单值 >1KB 截断是纯体积约束（已授权不脱敏，路径/标识全量记录）。
 * 必须在「校验通过且写库成功」之后调用——留痕发生在变更确定生效之后，
 * 校验失败/回滚路径不得留下未发生的 old→new 时间线（2026-11-21 审查修复轮时序修正）。
 */
function auditSettingChange(
  ctx: HandlerContext,
  key: string,
  value: unknown,
  oldValue: unknown
): void {
  try {
    const fmt = (v: unknown): string => {
      let s: string
      try {
        s = JSON.stringify(v) ?? String(v)
      } catch {
        s = String(v)
      }
      return s.length > 1024 ? `${s.slice(0, 1024)}…(截断,总长${s.length})` : s
    }
    logger.info(`[Settings] ${key}: ${fmt(oldValue)} → ${fmt(value)}`)
  } catch {
    // 留痕失败不影响设置写入
  }
}

/** 校验通过后的统一落库+留痕：旧值须在写库前读取（写库成功后即留痕），读旧值失败不留痕不阻断。 */
function writeSettingAndAudit(
  ctx: HandlerContext,
  key: string,
  value: unknown,
  finalValue?: unknown
): void {
  let oldValue: unknown
  let oldReadOk = true
  try {
    oldValue = ctx.dbManager.getSetting<unknown>(key, undefined)
  } catch {
    oldReadOk = false
  }
  ctx.dbManager.setSetting(key, finalValue ?? value)
  if (!oldReadOk) return
  auditSettingChange(ctx, key, value, oldValue)
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
        // 变更留痕在各分支「校验通过且写库成功」后统一发生（见 writeSettingAndAudit /
        // auditSettingChange）：此前留痕先于校验，失败的变更会被记录成已发生。
        // customScanPaths 走内联校验放行（方案 A：维持现状，不迁专用通道）
        if (key === 'customScanPaths') {
          assertCustomScanPaths(value)
          writeSettingAndAudit(ctx, key, value)
          return { saved: true }
        }
        // hardwareAcceleration 走内联布尔校验，并双写启动期可同步读取的偏好镜像
        if (key === 'hardwareAcceleration') {
          if (typeof value !== 'boolean') {
            throw AppError.validation(t('main.settings.error.hwAccelNotBoolean'))
          }
          writeSettingAndAudit(ctx, key, value)
          writeHardwareAccelPref(value)
          return { saved: true }
        }
        // gpu.discretePreference 走内联值域校验（'auto' | 'high-performance'），
        // 同样双写启动期镜像（index.ts 在 whenReady 前读镜像应用独显优先注册表）
        if (key === 'gpu.discretePreference') {
          if (value !== 'auto' && value !== 'high-performance') {
            throw AppError.validation(t('main.settings.error.gpuPreferenceInvalid'))
          }
          writeSettingAndAudit(ctx, key, value)
          writeGpuDiscretePref(value)
          return { saved: true }
        }
        // launchAtLogin：布尔校验 → 落库 → 同步 OS 登录项 → 按真实结果返回。
        // 同步失败必须回滚 DB，否则「UI 已回滚但 DB 是失败后的新值」会在下次启动被重新写回 OS。
        if (key === SETTING_KEY_LAUNCH_AT_LOGIN) {
          if (typeof value !== 'boolean') {
            throw AppError.validation(t('main.settings.error.launchAtLoginNotBoolean'))
          }
          const previous = ctx.dbManager.getSetting<unknown>(key, LAUNCH_AT_LOGIN_DEFAULT)
          ctx.dbManager.setSetting(key, value)
          try {
            const sync = syncLoginItemSetting(value)
            // 留痕在 OS 同步结果确定后发生：回滚路径（同步失败）不得留下未发生的变更
            if (sync.synced) {
              auditSettingChange(ctx, key, value, previous)
              return { saved: true, synced: true }
            }
            auditSettingChange(ctx, key, value, previous)
            return { saved: true, synced: false, skipped: sync.skipped }
          } catch (err) {
            // 回滚失败只留痕：绝不能让它覆盖原始同步失败，否则用户会看到无关的 DB 错误串。
            try {
              ctx.dbManager.setSetting(key, previous)
            } catch (rollbackErr) {
              logger.warn(`[settings] login item rollback failed: ${String(rollbackErr)}`)
            }
            if (err instanceof AppError) throw err
            throw AppError.internal(
              `[settings] login item sync failed: ${String(err)}`,
              undefined,
              {
                userMessage: t('main.settings.error.launchAtLoginSyncFailed')
              }
            )
          }
        }
        // referenceData.manifestBaseUrl 走内联 URL/SSRF 校验（空串 = 官方站点）
        if (key === 'referenceData.manifestBaseUrl') {
          // assertMirrorBaseUrl 作为实参先求值：校验抛错时不会落库、不留痕
          writeSettingAndAudit(
            ctx,
            key,
            value,
            assertMirrorBaseUrl(value, t('main.settings.error.manifestBaseUrlInvalid'))
          )
          return { saved: true }
        }
        // referenceData.imageMirrorBaseUrl（阶段 5）：同款校验、不同语义——只替换已授权
        // 图片资源的取图 host，与 manifest 站点键各自独立，不得串用
        if (key === 'referenceData.imageMirrorBaseUrl') {
          writeSettingAndAudit(
            ctx,
            key,
            value,
            assertMirrorBaseUrl(value, t('main.settings.error.imageMirrorBaseUrlInvalid'))
          )
          return { saved: true }
        }
        // 两个布尔开关（外部图片总开关 / 开机自动检查）：非 boolean 一律拒绝，
        // 不把不可信值（字符串 "false" 等）落库后让消费侧按真值性误判为开启。
        if (key === 'referenceData.remoteImagesEnabled' || key === 'referenceData.autoUpdate') {
          if (typeof value !== 'boolean') {
            throw AppError.validation(t('main.settings.error.referenceDataSwitchNotBoolean'))
          }
          writeSettingAndAudit(ctx, key, value)
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
        writeSettingAndAudit(ctx, key, value)
        return { saved: true }
      }
    )
  )
}
