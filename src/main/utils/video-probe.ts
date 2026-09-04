import ffmpeg from 'fluent-ffmpeg'
// P1-A7：统一从 ffmpeg-paths 导入，消除重复路径解析
import { ffprobePath as ffprobeBinaryPath } from './ffmpeg-paths'
import { trackFfmpegCommand, untrackFfmpegCommand } from './process-registry'

/**
 * 建议改#1：抽取自 scanner.getVideoMetadata 与 VideoService.getMetadata 的共享 ffprobe 实现。
 * 单一职责：读取视频元数据，超时可配置，超时/失败时 kill 子进程避免泄漏。
 */
export interface VideoMetadata {
  width?: number
  height?: number
  duration?: number
  codec?: string
  frameRate?: number
}

// 安全解析 ffprobe 返回的帧率字符串（如 "30000/1001"），替代 eval
function parseFrameRate(rateStr: string): number | undefined {
  const parts = rateStr.split('/')
  if (parts.length === 2) {
    const num = Number(parts[0])
    const den = Number(parts[1])
    if (!isNaN(num) && !isNaN(den) && den !== 0) {
      return num / den
    }
  }
  const single = Number(rateStr)
  return isNaN(single) ? undefined : single
}

/**
 * 读取视频元数据。
 * - 超时时 kill 子进程避免 ffmpeg/ffprobe 累积泄漏
 * - 错误时 reject（调用方需 try-catch）
 */
export function probeVideoMetadata(
  filePath: string,
  timeoutMs: number = 30000
): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(filePath).setFfprobePath(ffprobeBinaryPath)
    trackFfmpegCommand(command)

    const timeout = setTimeout(() => {
      command.kill('SIGKILL')
      untrackFfmpegCommand(command)
      reject(new Error(`读取视频元数据超时 (${timeoutMs}ms): ${filePath}`))
    }, timeoutMs)

    command.ffprobe((err, data) => {
      clearTimeout(timeout)
      untrackFfmpegCommand(command)
      if (err) {
        return reject(new Error(`读取视频元数据失败 ${filePath}: ${err.message}`))
      }
      const videoStream = data.streams.find((s) => s.codec_type === 'video')
      resolve({
        width: videoStream?.width,
        height: videoStream?.height,
        duration: data.format.duration ? Math.round(data.format.duration) : undefined,
        codec: videoStream?.codec_name,
        frameRate: videoStream?.r_frame_rate ? parseFrameRate(videoStream.r_frame_rate) : undefined
      })
    })
  })
}
