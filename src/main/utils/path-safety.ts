/**
 * 路径安全工具：集中处理「特殊字符路径」与「目录可写性」两类环境兼容问题。
 *
 * 背景：干净 Windows 上，安装路径 / 二进制路径含中文或特殊字符时，
 * 原生模块加载与子进程 spawn 可能失败；userData 被杀软锁定 / 只读时写入会静默失败。
 * 本模块抽取自 native-load-guard 的非 ASCII 判定逻辑，并复用 dir-manager 的
 * ensureDir / isValidDir，避免在多处重复实现。
 *
 * 不引入任何新依赖，仅用 Node 内置 path/fs 与既有模块。
 */
import fs from 'fs'
import path from 'path'
import { ensureDir, isValidDir } from './dir-manager'

/**
 * 判断路径是否包含非 ASCII 字符（码点 > 127）。
 * 安装路径 / 二进制路径含中文或特殊字符时，原生模块加载与子进程 spawn 可能失败。
 * 不用正则避免 no-control-regex（[\x00] 触发），改用码点扫描。
 */
export function hasNonAsciiPath(p: string): boolean {
  if (!p) return false
  for (let i = 0; i < p.length; i++) {
    if (p.charCodeAt(i) > 127) return true
  }
  return false
}

/**
 * 确保目录存在且当前进程可写。
 *
 * 参数校验：入参须为绝对路径；空串 / 相对路径直接返回 false（不可靠场景不臆测）。
 * 复用 dir-manager.ensureDir 建目录 + isValidDir 校验 W_OK。
 *
 * @param dir 目标目录（建议绝对路径）
 * @returns 目录存在且可写返回 true，否则 false
 */
export function ensureWritableDir(dir: string): boolean {
  if (!dir || !path.isAbsolute(dir)) return false
  try {
    ensureDir(dir)
  } catch {
    return false
  }
  return isValidDir(dir)
}

/**
 * 解析可用的二进制路径：
 * - 本地候选存在且路径不含非 ASCII 字符 → 采用本地候选（随包二进制最稳定）
 * - 否则降级到 fallback（通常为系统 PATH 中的同名可执行文件）
 *
 * 用于 ffmpeg/ffprobe 等：安装到中文路径时本地二进制路径含特殊字符，
 * spawn 易失败，此时降级到系统 PATH 中的同名命令往往可正常工作。
 *
 * @param candidate 本地候选二进制绝对路径
 * @param fallback 降级路径（如 'ffmpeg' / 'ffprobe'）
 */
export function resolveSafeBinaryPath(candidate: string, fallback: string): string {
  try {
    if (candidate && fs.existsSync(candidate) && !hasNonAsciiPath(candidate)) {
      return candidate
    }
  } catch {
    // existsSync 异常视为不可用，走降级
  }
  return fallback
}

/**
 * 校验文件是否为 Windows PE 可执行文件（前 2 字节 "MZ" 魔数）。
 *
 * 背景：现场 `spawn EFTYPE` = CreateProcess 错误 193（ERROR_BAD_EXE_FORMAT），
 * 常见诱因是杀软隔离/替换二进制后留下 0 字节或文本占位文件——fs.existsSync 仍为 true，
 * spawn 时才失败。故对随包二进制在 spawn 前做魔数预检。
 *
 * 任何异常（不存在 / 目录 / 权限 / 读取失败 / size < 2）一律返回 false，由调用方走降级。
 * 注意：仅识别 Windows PE（本项目目标平台 win32）；Linux/macOS ELF 不在识别范围。
 */
export function hasWindowsExecutableHeader(filePath: string): boolean {
  if (!filePath) return false
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size < 2) return false
    const fd = fs.openSync(filePath, 'r')
    try {
      const header = Buffer.alloc(2)
      const bytesRead = fs.readSync(fd, header, 0, 2, 0)
      return bytesRead === 2 && header[0] === 0x4d && header[1] === 0x5a
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}
