/**
 * P1-A7：统一 ffmpeg/ffprobe 二进制路径解析
 *
 * 原实现：video-service.ts、livephoto-service.ts、generator.ts 各自重复定义 ffmpegBinaryPath，
 * video-probe.ts 单独定义 ffprobeBinaryPath。路径解析逻辑分散，修改需同步多处。
 *
 * 现统一从此模块导出，调用方只需 import { ffmpegPath, ffprobePath } 即可。
 *
 * P2-A1：将 native-path.ts 的 resolveAsarUnpackedPath 合并到此模块，
 * 消除单函数文件的碎片化（native-path.ts 仅此一个函数且仅此处调用）。
 */
import fs from 'fs'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { hasValidPeStructure } from './path-safety'
import { diagLog } from './startup-diagnostic'

/**
 * asar 打包后，require('ffmpeg-static') 返回 asar 内部路径，
 * 但 child_process.spawn 无法执行 asar 内的文件，需替换为 asar.unpacked 路径。
 *
 * P1-A7：改用正则确保只替换 'app.asar' 后面是路径分隔符或字符串结尾的情况，
 * 避免误替换 'app.asar.backup' 等包含 'app.asar' 子串的路径。
 */
export function resolveAsarUnpackedPath(p: string): string {
  return p.replace(/app\.asar(?=[\\/]|$)/g, 'app.asar.unpacked')
}

/**
 * 在 npm postinstall 未执行（CI/离线/缓存损坏）时，ffmpeg-static / ffprobe-static
 * 仍会返回一个指向不存在文件的路径。仅判 truthy 无法识别这种情况，
 * 必须用 fs.existsSync 验证二进制真实落盘，否则回退到系统 PATH 上的可执行文件。
 */
function resolveBinaryPath(candidate: string | undefined | null, fallback: string): string {
  if (!candidate) return fallback
  const resolved = resolveAsarUnpackedPath(candidate)
  if (fs.existsSync(resolved)) {
    // PE 结构预检：existsSync 无法识别“文件被杀软截断/替换但 MZ 头仍完好”的场景，
    // 旧的 2 字节 MZ 预检也无法检测节表超出文件大小的截断二进制。
    // hasValidPeStructure 通过解析完整 PE 头+节表结构判断是否截断。
    // 仅 win32 生效，避免 Linux/macOS 的 ELF 二进制被误判。
    if (process.platform === 'win32' && !hasValidPeStructure(resolved)) {
      diagLog(
        'FFMPEG',
        `bundled binary has invalid/truncated PE structure (possibly corrupted by antivirus or incomplete install), fall back to system PATH: ${resolved}`
      )
      return fallback
    }
    return resolved
  }
  return fallback
}

export const ffmpegPath: string = resolveBinaryPath(ffmpegStatic, 'ffmpeg')

export const ffprobePath: string = resolveBinaryPath(ffprobeStatic?.path, 'ffprobe')
