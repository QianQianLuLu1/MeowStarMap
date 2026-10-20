/**
 * IPC 参数校验工具
 * 解决 A-S9：原全部 IPC 处理器直接信任渲染进程参数，无任何校验
 * 提供：
 * - 路径白名单校验（仅允许已索引媒体或用户选择目录）
 * - 数值范围校验
 * - 数组长度上限校验
 * - 字符串长度/字符校验
 * P1-A5：新增路径遍历校验（.. 段检测）和系统敏感目录黑名单
 */
import path from 'path'
import fs from 'fs'
import os from 'os'
import { t } from '../i18n'
// P2-A3：引用 constants 常量替代硬编码数字
import {
  MAX_PATH_ARRAY_SIZE,
  MAX_MEDIA_ID_ARRAY_SIZE,
  MAX_TAG_NAME_LENGTH,
  MAX_FILE_PATH_LENGTH
} from './constants'

/**
 * P1-A5：系统敏感目录黑名单
 * 从 index.ts 迁移过来，统一在 ipc-validate.ts 维护
 * 用于 shell:openPath 和所有写操作 IPC 的安全校验
 */
export const SYSTEM_SENSITIVE_DIRS: readonly string[] = [
  'C:\\Windows\\System32',
  'C:\\Windows\\SysWOW64',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData'
]

// FIX(组5-2): 敏感目录判定扩展——原先仅 5 条硬编码 C: 盘路径，未覆盖其他盘符的
// Windows/Program Files/ProgramData、UNC 管理共享（\\server\c$\Windows）与用户主目录下
// 的凭据目录（.ssh/.aws 等），且未解析符号链接（软链可把敏感目录映射到普通路径绕过）。
// 任意盘符的系统目录：盘符后第一段是 windows / program files / program files (x86) / programdata，
// 目录名边界必须是分隔符或路径末尾（沿用 P1-A8 精确边界语义，'Program Filesabc' 不误拦）
const DRIVE_SYSTEM_DIR_RE =
  /^[a-z]:[\\/](?:windows|program files(?: \(x86\))?|programdata)(?:[\\/].*)?$/
// UNC 管理共享：\\server\c$\... —— 管理共享即整盘访问，根与全部子路径一律视为敏感
const UNC_ADMIN_SHARE_RE = /^\\\\[^\\/]+[\\/][a-z]\$(?:[\\/].*)?$/
// 用户主目录下的凭据/密钥目录（主目录后第一段命中即拒绝）
const USER_CREDENTIAL_DIR_NAMES = new Set(['.ssh', '.aws', '.gnupg', '.kube'])

/**
 * FIX(组5-2): 路径是否落在系统敏感目录内（纯字符串模式判定，无 IO）。
 * 覆盖任意盘符的系统目录、UNC 管理共享与用户主目录凭据目录。
 * validateNonSensitivePath 在此基础上追加符号链接解析复检。
 */
export function isSensitivePath(filePath: string): boolean {
  // 固化 win32 语义（产品仅发布 Windows，测试可跨平台执行）
  let normalized: string
  try {
    normalized = path.win32.resolve(filePath).toLowerCase()
  } catch {
    return false
  }
  if (DRIVE_SYSTEM_DIR_RE.test(normalized)) return true
  if (UNC_ADMIN_SHARE_RE.test(normalized)) return true
  let home = ''
  try {
    home = path.win32.resolve(os.homedir()).toLowerCase()
  } catch {
    // 测试环境 homedir 可能抛错，跳过用户目录检查
  }
  if (home && normalized.startsWith(home + path.win32.sep)) {
    const firstSeg = normalized.slice(home.length + 1).split(/[\\/]/)[0]
    if (USER_CREDENTIAL_DIR_NAMES.has(firstSeg)) return true
  }
  return false
}

/**
 * 校验文件路径数组：每个元素必须是绝对路径且长度合理
 * 防止注入异常路径或超大数组导致主进程卡死
 *
 * P1-A7：移除 hasPathTraversal 检查——path.resolve 会展开所有 .. 段，
 * 该函数对绝大多数输入恒返回 false，仅提供虚假安全感。
 * 写操作的路径安全由 validateNonSensitivePath 黑名单兜底。
 */
export function validateFilePathArray(
  filePaths: unknown,
  maxCount = MAX_PATH_ARRAY_SIZE
): { valid: boolean; message?: string } {
  if (!Array.isArray(filePaths)) {
    return { valid: false, message: t('main.validator.arrayStringRequired') }
  }
  if (filePaths.length === 0) {
    return { valid: false, message: t('main.validator.pathArrayRequired') }
  }
  if (filePaths.length > maxCount) {
    return {
      valid: false,
      message: t('main.validator.ipcPathArrayMaxLength', { max: String(maxCount) })
    }
  }
  for (const p of filePaths) {
    if (typeof p !== 'string' || p.length === 0 || p.length > MAX_FILE_PATH_LENGTH) {
      return {
        valid: false,
        message: t('main.validator.pathStringLength', { max: String(MAX_FILE_PATH_LENGTH) })
      }
    }
    // 固化 win32 语义（产品仅发布 Windows，测试可跨平台执行）
    if (!path.win32.isAbsolute(p)) {
      return { valid: false, message: t('main.validator.pathMustAbsolute', { path: p }) }
    }
  }
  return { valid: true }
}

/**
 * 校验单个文件路径
 */
export function validateFilePath(filePath: unknown): { valid: boolean; message?: string } {
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    filePath.length > MAX_FILE_PATH_LENGTH
  ) {
    return {
      valid: false,
      message: t('main.validator.pathStringLength', { max: String(MAX_FILE_PATH_LENGTH) })
    }
  }
  // 固化 win32 语义（产品仅发布 Windows，测试可跨平台执行）
  if (!path.win32.isAbsolute(filePath)) {
    return { valid: false, message: t('main.validator.pathMustAbsolute', { path: filePath }) }
  }
  return { valid: true }
}

/**
 * P1-A5：校验路径不在系统敏感目录内
 * 用于 shell:openPath 和所有写操作 IPC（file:copy/file:move/file:export 等）
 * 与 validateFilePath 配合使用：先校验路径合法，再校验非敏感
 */
export function validateNonSensitivePath(filePath: string): { valid: boolean; message?: string } {
  // FIX(组5-2): 归一化路径先按模式匹配（任意盘符/UNC/用户凭据目录），
  // 再对真实路径（解析符号链接后）复检——软链把敏感目录映射到普通路径时，
  // realpath 结果仍落在敏感目录内，阻断该绕过通道（路径不存在时 realpath 抛错跳过复检）
  if (isSensitivePath(filePath)) {
    return { valid: false, message: t('main.shell.error.sensitiveDirForbidden') }
  }
  try {
    const real = fs.realpathSync.native(filePath)
    if (isSensitivePath(real)) {
      return { valid: false, message: t('main.shell.error.sensitiveDirForbidden') }
    }
  } catch {
    // 路径不存在或无法解析：保持模式匹配结果（放行）
  }
  return { valid: true }
}

/**
 * 路径归属判断原语：判断 filePath 是否位于 dir 内（含 dir 自身）
 * Windows 文件系统大小写不敏感，须统一 toLowerCase 再比较，
 * 否则 DB 存 D:\Photos、请求 d:\photos\a.jpg 会被前缀比较误判为不在白名单内（裂图）
 *
 * 本函数是**纯比较**（结果不交给 fs），故与同文件其余判定一样固化 win32：
 * 早先它按 `process.platform` 开关决定是否折叠大小写、并用宿主 `path.sep` 拼前缀，
 * 于是 Linux CI 上两侧归一与产品语义分叉——这正是 `resource-allowlist` 里那处同类漏项的
 * 模板。折叠无条件化只合并「同一文件的不同写法」，不放宽目录级授权。
 */
export function isPathUnderDir(filePath: string, dir: string): boolean {
  const f = path.win32.resolve(filePath).toLowerCase()
  const d = path.win32.resolve(dir).toLowerCase()
  return f === d || f.startsWith(d + path.win32.sep)
}

/**
 * 校验数值范围
 */
export function validateNumberRange(
  value: unknown,
  min: number,
  max: number,
  name = 'value'
): { valid: boolean; message?: string } {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { valid: false, message: t('main.validator.numberFinite', { name }) }
  }
  if (value < min || value > max) {
    return {
      valid: false,
      message: t('main.validator.numberRange', { name, min: String(min), max: String(max) })
    }
  }
  return { valid: true }
}

/**
 * 校验整数范围
 */
export function validateIntRange(
  value: unknown,
  min: number,
  max: number,
  name = 'value'
): { valid: boolean; message?: string } {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { valid: false, message: t('main.validator.intRequired', { name }) }
  }
  if (value < min || value > max) {
    return {
      valid: false,
      message: t('main.validator.numberRange', { name, min: String(min), max: String(max) })
    }
  }
  return { valid: true }
}

/**
 * 校验字符串长度
 */
export function validateStringLength(
  value: unknown,
  max = MAX_FILE_PATH_LENGTH,
  name = 'string'
): { valid: boolean; message?: string } {
  if (typeof value !== 'string') {
    return { valid: false, message: t('main.validator.stringTypeRequired', { name }) }
  }
  if (value.length === 0 || value.length > max) {
    return {
      valid: false,
      message: t('main.validator.stringLengthRange', { name, max: String(max) })
    }
  }
  return { valid: true }
}

/**
 * 校验 mediaId（正整数）
 */
export function validateMediaId(mediaId: unknown): { valid: boolean; message?: string } {
  return validateIntRange(mediaId, 1, Number.MAX_SAFE_INTEGER, 'mediaId')
}

/**
 * 校验 mediaId 数组
 */
export function validateMediaIdArray(
  mediaIds: unknown,
  maxCount = MAX_MEDIA_ID_ARRAY_SIZE
): { valid: boolean; message?: string } {
  if (!Array.isArray(mediaIds)) {
    return { valid: false, message: t('main.validator.mediaIdsArrayRequired') }
  }
  if (mediaIds.length === 0) {
    return { valid: false, message: t('main.validator.mediaIdsNotEmpty') }
  }
  if (mediaIds.length > maxCount) {
    return {
      valid: false,
      message: t('main.validator.mediaIdsMaxLength', { max: String(maxCount) })
    }
  }
  for (const id of mediaIds) {
    const r = validateMediaId(id)
    if (!r.valid) return r
  }
  return { valid: true }
}

/**
 * 校验标签名：禁止控制字符、过长字符串
 */
export function validateTagName(tagName: unknown): { valid: boolean; message?: string } {
  if (typeof tagName !== 'string') {
    return { valid: false, message: t('main.validator.tagNameStringRequired') }
  }
  if (tagName.length === 0 || tagName.length > MAX_TAG_NAME_LENGTH) {
    return {
      valid: false,
      message: t('main.validator.tagNameLength', { max: String(MAX_TAG_NAME_LENGTH) })
    }
  }
  // 禁止控制字符
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(tagName)) {
    return { valid: false, message: t('main.validator.tagNameControlChars') }
  }
  return { valid: true }
}

/**
 * 校验 URL：仅允许 http/https
 */
export function validateHttpUrl(url: unknown): { valid: boolean; message?: string } {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) {
    return { valid: false, message: t('main.validator.urlLength') }
  }
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        valid: false,
        message: t('main.validator.protocolNotAllowed', { protocol: parsed.protocol })
      }
    }
    return { valid: true }
  } catch {
    return { valid: false, message: t('main.validator.urlInvalidLiteral') }
  }
}

/**
 * P1-N：从 index.ts 迁移过来的滤镜预设结构校验
 * 校验导入的 JSON 是否符合 FilterPreset 结构
 */
export function validateFilterPreset(preset: unknown): { valid: boolean; message?: string } {
  if (typeof preset !== 'object' || preset === null) {
    return { valid: false, message: t('main.validator.presetObjectRequired') }
  }
  const p = preset as Record<string, unknown>
  if (typeof p.name !== 'string' || p.name.trim() === '') {
    return { valid: false, message: t('main.validator.presetNameRequired') }
  }
  if (typeof p.category !== 'string' || p.category.trim() === '') {
    return { valid: false, message: t('main.validator.presetCategoryRequired') }
  }
  if (typeof p.params !== 'object' || p.params === null) {
    return { valid: false, message: t('main.validator.presetParamsRequired') }
  }
  return { valid: true }
}
