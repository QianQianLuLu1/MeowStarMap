/**
 * A6：ffmpeg 命令执行工具
 * 抽取自 livephoto-service.ts，统一处理：
 *   - trackFfmpegCommand 注册/反注册
 *   - 超时定时器 + clearTimeout
 *   - end/error 事件 → resolve/reject
 *
 * P2-4：video-service 4 处 ffmpeg 调用已全部复用本工具；
 *      仅覆盖无进度的简单命令，带 progress 回调的场景仍需原生写法
 */
import ffmpeg from 'fluent-ffmpeg'
import { ffmpegPath as ffmpegBinaryPath } from './ffmpeg-paths'
import { trackFfmpegCommand, untrackFfmpegCommand } from './process-registry'

/**
 * 执行 ffmpeg 命令并返回 Promise。
 * @param inputPath 输入文件路径
 * @param configure 在 ffmpeg(input) 链上追加 outputOptions/output/format 等
 * @param timeoutMs 超时毫秒，超时后 SIGKILL 并 reject
 * @param operationName 操作名称（用于超时错误消息，默认 'ffmpeg'）
 * @param onStarted FIX(组16-2): 命令启动前的句柄回调——调用方持有命令句柄后可在
 *   用户取消时主动 kill（原先仅超时路径有 kill，取消时 ffmpeg 会完整跑完当前编码）
 */
export function runFfmpegCommand(
  inputPath: string,
  configure: (cmd: ffmpeg.FfmpegCommand) => ffmpeg.FfmpegCommand,
  timeoutMs: number,
  operationName?: string,
  onStarted?: (command: ffmpeg.FfmpegCommand) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const command = configure(ffmpeg(inputPath).setFfmpegPath(ffmpegBinaryPath))
    onStarted?.(command)

    const timeout = setTimeout(() => {
      command.kill('SIGKILL')
      untrackFfmpegCommand(command)
      const label = operationName ?? 'ffmpeg'
      reject(new Error(`${label} 执行超时 (${timeoutMs}ms)`))
    }, timeoutMs)

    trackFfmpegCommand(command)
    command
      .on('end', () => {
        clearTimeout(timeout)
        untrackFfmpegCommand(command)
        resolve()
      })
      .on('error', (err) => {
        clearTimeout(timeout)
        untrackFfmpegCommand(command)
        reject(err)
      })
      .run()
  })
}
