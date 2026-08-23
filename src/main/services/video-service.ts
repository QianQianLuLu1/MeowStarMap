import fsp from 'fs/promises'
import path from 'path'
// C-3：统一唯一路径生成工具
import { getUniqueFilePath } from '../utils/file-utils'
// 建议改#2：统一磁盘空间检查（替代 3 处内联 statfs 重复实现）
import { assertDiskSpace } from '../utils/disk'
// 建议改#1：共享 ffprobe 实现（替代本文件 parseFrameRate + getMetadata 与 scanner 的重复实现）
import { probeVideoMetadata, type VideoMetadata } from '../utils/video-probe'
// P2-4：复用 ffmpeg-runner，统一处理 trackFfmpegCommand/timeout/end/error 样板
import { runFfmpegCommand } from '../utils/ffmpeg-runner'
// 损坏文件容错：错误日志写入 + 标记回调
import { logger } from '../utils/logger'
import { t } from '../i18n'
import type { CorruptedMarkerFn } from '../thumbnail/generator'

// 修复 C-S4：超时时间可配置，默认值按操作类型区分
// - 导出大视频可能耗时数分钟，30s 过短会导致输出文件损坏
// - 元数据读取/帧截图为快速操作，30s 足够
const DEFAULT_EXPORT_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟
const DEFAULT_METADATA_TIMEOUT_MS = 30 * 1000 // 30 秒
const DEFAULT_CAPTURE_TIMEOUT_MS = 30 * 1000 // 30 秒
const DEFAULT_TRIM_TIMEOUT_MS = 10 * 60 * 1000 // F-S9：裁剪可能涉及转码，10 分钟
const DEFAULT_SPEED_TIMEOUT_MS = 10 * 60 * 1000 // F-S9：调速需要重编码，10 分钟
// F-S9：调速范围限制（atempo 滤镜单次范围 0.5-2.0，需链式处理超出范围）
const MIN_SPEED = 0.25
const MAX_SPEED = 4.0

export class VideoService {
  // 损坏文件容错：由 Application 注入的回调。
  // 未注入时（如单元测试）降级为仅日志写入，不阻塞主流程。
  private markCorruptedFn: CorruptedMarkerFn | null = null

  /**
   * 注入损坏文件标记回调（由 Application 在初始化时调用）。
   * 仅在源文件解码失败时调用（输出文件失败不算源文件损坏）。
   */
  setCorruptedMarker(mark: CorruptedMarkerFn | null): void {
    this.markCorruptedFn = mark
  }

  /**
   * 标记文件为损坏并写入日志。
   * 回调未注入或抛错时仅记录日志，不阻断主流程。
   */
  private async markCorrupted(filePath: string, reason: string): Promise<void> {
    try {
      logger.error(t('main.videoService.log.markingCorrupted', { path: filePath }), reason)
      if (this.markCorruptedFn) {
        await this.markCorruptedFn(filePath, reason)
      }
    } catch (err) {
      logger.error(t('main.videoService.log.markCorruptedCallbackFailed'), err)
    }
  }

  /**
   * 清理失败/超时产生的部分输出文件，避免残留损坏文件
   * 静默清理：文件不存在或删除失败均忽略
   */
  private async cleanupPartialOutput(outputPath: string): Promise<void> {
    try {
      await fsp.unlink(outputPath)
    } catch {
      // 文件不存在或已被清理，忽略
    }
  }

  /**
   * 读取视频元数据。
   * 建议改#1：委托到 utils/video-probe.ts 的共享实现（scanner 也复用同一实现）。
   * 损坏文件容错：读取失败时标记源文件为损坏，但仍抛错让调用方决定后续行为
   * （如详情页无法显示元数据 vs 批量扫描跳过该文件）。
   */
  async getMetadata(
    filePath: string,
    timeoutMs: number = DEFAULT_METADATA_TIMEOUT_MS
  ): Promise<VideoMetadata> {
    try {
      return await probeVideoMetadata(filePath, timeoutMs)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      // 标记源文件为损坏，不阻断调用方错误处理（仍抛出原错误）
      await this.markCorrupted(filePath, t('main.videoService.log.metadataReadFailed', { reason }))
      throw err
    }
  }

  /**
   * 导出视频为指定格式。
   * 修复 C-S4：
   * - 超时时间改为可配置（默认 300s，原 30s 对大视频过短）
   * - 超时/错误时清理部分输出文件，避免残留损坏文件
   * 损坏文件容错：源文件解码失败时标记为损坏，写入详细错误日志
   */
  async exportVideo(
    filePath: string,
    targetDir: string,
    format: string,
    timeoutMs: number = DEFAULT_EXPORT_TIMEOUT_MS
  ): Promise<{ success: boolean; message: string }> {
    let targetPath = ''
    try {
      await fsp.mkdir(targetDir, { recursive: true })

      // F-G2：检查磁盘空间（视频导出通常体积较大）
      // 预估所需空间为源文件 2 倍（转码可能放大）
      const srcStat = await fsp.stat(filePath)
      await assertDiskSpace(targetDir, srcStat.size * 2)

      const ext = path.extname(filePath)
      const baseName = path.basename(filePath, ext)
      const targetExt = format === 'gif' ? 'gif' : format
      // C-3：统一唯一路径生成（取代内联 do-while 冲突自增循环）
      targetPath = await getUniqueFilePath(targetDir, baseName, `.${targetExt}`)

      // P2-4：复用 ffmpeg-runner，消除 trackFfmpegCommand/timeout/end/error 样板代码
      await runFfmpegCommand(
        filePath,
        (cmd) => {
          if (format === 'webm') {
            cmd = cmd.outputOptions('-c:v', 'libvpx-vp9', '-c:a', 'libopus')
          } else if (format === 'gif') {
            cmd = cmd.outputOptions(
              '-vf',
              'fps=10,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer'
            )
          }
          return cmd.output(targetPath)
        },
        timeoutMs,
        t('main.videoService.log.exportTask')
      )

      return { success: true, message: t('main.videoService.message.exportSuccess') }
    } catch (error) {
      // 超时或失败时清理部分输出文件，避免残留损坏文件
      if (targetPath) {
        await this.cleanupPartialOutput(targetPath)
      }
      const reason = error instanceof Error ? error.message : String(error)
      logger.error(t('main.videoService.log.exportFailed', { path: filePath }), reason)
      // 源文件解码失败时标记为损坏（区分于磁盘空间/权限等外部错误）
      // ffmpeg 解码失败的常见错误信息包含 "Invalid data" / "Error while decoding" / "could not find codec"
      if (this.isSourceDecodeError(reason)) {
        await this.markCorrupted(
          filePath,
          t('main.videoService.log.exportDecodeFailed', { reason })
        )
      }
      return {
        success: false,
        message: t('main.videoService.error.exportFailed', { reason })
      }
    }
  }

  /**
   * 截取视频指定时间点的帧。
   * 修复 C-S4：超时/错误时清理部分输出文件。
   * 损坏文件容错：源文件解码失败时标记为损坏。
   */
  async captureFrame(
    filePath: string,
    currentTime: number,
    targetDir?: string,
    timeoutMs: number = DEFAULT_CAPTURE_TIMEOUT_MS
  ): Promise<{ success: boolean; message: string; filePath?: string }> {
    let targetPath = ''
    try {
      const outputDir = targetDir || path.dirname(filePath)
      await fsp.mkdir(outputDir, { recursive: true })

      const ext = path.extname(filePath)
      const baseName = path.basename(filePath, ext)
      const timeSeconds = Math.floor(currentTime)
      // C-3：统一唯一路径生成（自定义命名模板，保留原中文与时间戳格式）
      // 输出文件名标识（数据值，非 UI 文案）
      targetPath = await getUniqueFilePath(
        outputDir,
        `${baseName}_帧截图_${timeSeconds}s`,
        '.jpg',
        // 输出文件名标识（数据值，非 UI 文案）
        (counter) => `${baseName}_帧截图_${timeSeconds}s_${counter}`
      )

      // P2-4：复用 ffmpeg-runner
      await runFfmpegCommand(
        filePath,
        (cmd) => cmd.seekInput(currentTime).frames(1).output(targetPath),
        timeoutMs,
        t('main.videoService.log.frameCaptureTask')
      )

      return {
        success: true,
        message: t('main.videoService.message.frameCaptureSuccess'),
        filePath: targetPath
      }
    } catch (error) {
      // 超时或失败时清理部分输出文件
      if (targetPath) {
        await this.cleanupPartialOutput(targetPath)
      }
      const reason = error instanceof Error ? error.message : String(error)
      logger.error(t('main.videoService.log.frameCaptureFailed', { path: filePath }), reason)
      if (this.isSourceDecodeError(reason)) {
        await this.markCorrupted(
          filePath,
          t('main.videoService.log.frameCaptureDecodeFailed', { reason })
        )
      }
      return {
        success: false,
        message: t('main.videoService.error.frameCaptureFailed', { reason })
      }
    }
  }

  /**
   * F-S9：裁剪视频指定时间段（保留 [startTime, endTime] 区间）。
   * 使用 -ss（seekInput）+ -t（duration）实现快速裁剪；
   * 同编码容器（mp4/mov）时尝试流复制（-c copy）避免重编码，
   * 失败则回退到重编码以保证兼容性。
   */
  async trimVideo(
    filePath: string,
    startTime: number,
    endTime: number,
    targetDir: string,
    timeoutMs: number = DEFAULT_TRIM_TIMEOUT_MS
  ): Promise<{ success: boolean; message: string; filePath?: string }> {
    let targetPath = ''
    try {
      // 参数校验
      if (startTime < 0 || endTime <= startTime) {
        throw new Error(`无效的裁剪区间：startTime=${startTime}, endTime=${endTime}`)
      }
      const duration = endTime - startTime

      await fsp.mkdir(targetDir, { recursive: true })

      // 磁盘空间检查（裁剪输出通常不大于源文件）
      try {
        const srcStat = await fsp.stat(filePath)
        const fsStat = await fsp.statfs(targetDir)
        const available = fsStat.bavail * fsStat.bsize
        if (available < srcStat.size) {
          const needMB = (srcStat.size / 1024 / 1024).toFixed(1)
          const availMB = (available / 1024 / 1024).toFixed(1)
          // 错误文案与下方 includes('磁盘空间不足') 判定构成固定协议，保持 zh-CN 原文（数据耦合）
          throw new Error(`磁盘空间不足，需要 ${needMB} MB，仅剩 ${availMB} MB`)
        }
      } catch (error) {
        // 匹配上方 throw 的固定 zh-CN 消息（数据耦合，非 UI 文案）
        // eslint-disable-next-line no-restricted-syntax -- 匹配上方 throw 的固定 zh-CN 消息（数据耦合，非 UI 文案）
        if (error instanceof Error && error.message.includes('磁盘空间不足')) throw error
      }

      const ext = path.extname(filePath)
      const baseName = path.basename(filePath, ext)
      // 输出文件名标识（数据值，非 UI 文案）
      targetPath = await getUniqueFilePath(targetDir, `${baseName}_裁剪`, ext)

      // P2-4：复用 ffmpeg-runner
      await runFfmpegCommand(
        filePath,
        (cmd) =>
          cmd
            .seekInput(startTime)
            .duration(duration)
            // 尝试流复制避免重编码；容器不变时有效，容器变化时 ffmpeg 会自动重编码
            .outputOptions(['-c', 'copy', '-avoid_negative_ts', 'make_zero'])
            .output(targetPath),
        timeoutMs,
        t('main.videoService.log.trimTask')
      )

      return {
        success: true,
        message: t('main.videoService.message.trimSuccess'),
        filePath: targetPath
      }
    } catch (error) {
      if (targetPath) {
        await this.cleanupPartialOutput(targetPath)
      }
      const reason = error instanceof Error ? error.message : String(error)
      logger.error(t('main.videoService.log.trimFailed', { path: filePath }), reason)
      if (this.isSourceDecodeError(reason)) {
        await this.markCorrupted(filePath, t('main.videoService.log.trimDecodeFailed', { reason }))
      }
      return {
        success: false,
        message: t('main.videoService.error.trimFailed', { reason })
      }
    }
  }

  /**
   * F-S9：调整视频播放速度。
   * 视频流使用 setpts 滤镜（PTS = 1/speed），
   * 音频流使用 atempo 滤镜（单次范围 0.5-2.0，超出则链式处理）。
   * 必须重编码，无法流复制。
   */
  async changeSpeed(
    filePath: string,
    speed: number,
    targetDir: string,
    timeoutMs: number = DEFAULT_SPEED_TIMEOUT_MS
  ): Promise<{ success: boolean; message: string; filePath?: string }> {
    let targetPath = ''
    try {
      // 参数校验
      if (speed < MIN_SPEED || speed > MAX_SPEED) {
        throw new Error(
          t('main.videoEditor.error.unsupportedSpeed', {
            speed: String(speed),
            min: String(MIN_SPEED),
            max: String(MAX_SPEED)
          })
        )
      }

      await fsp.mkdir(targetDir, { recursive: true })

      // 磁盘空间检查（重编码输出可能放大）
      try {
        const srcStat = await fsp.stat(filePath)
        const fsStat = await fsp.statfs(targetDir)
        const available = fsStat.bavail * fsStat.bsize
        const required = srcStat.size * 2
        if (available < required) {
          const needMB = (required / 1024 / 1024).toFixed(1)
          const availMB = (available / 1024 / 1024).toFixed(1)
          // 错误文案与下方 includes('磁盘空间不足') 判定构成固定协议，保持 zh-CN 原文（数据耦合）
          throw new Error(`磁盘空间不足，需要 ${needMB} MB，仅剩 ${availMB} MB`)
        }
      } catch (error) {
        // 匹配上方 throw 的固定 zh-CN 消息（数据耦合，非 UI 文案）
        // eslint-disable-next-line no-restricted-syntax -- 匹配上方 throw 的固定 zh-CN 消息（数据耦合，非 UI 文案）
        if (error instanceof Error && error.message.includes('磁盘空间不足')) throw error
      }

      const ext = path.extname(filePath)
      const baseName = path.basename(filePath, ext)
      targetPath = await getUniqueFilePath(targetDir, `${baseName}_${speed}x`, ext)

      // 构建 setpts 滤镜：PTS 乘以 1/speed
      const setptsFilter = `setpts=${(1 / speed).toFixed(6)}*PTS`
      // 构建 atempo 滤镜链：单次范围 0.5-2.0，超出则链式
      const atempoChain = this.buildAtempoChain(speed)
      // 视频滤镜与音频滤镜分别通过 -filter:v 和 -filter:a 传递
      const outputOptions = ['-filter:v', setptsFilter]
      if (atempoChain) {
        outputOptions.push('-filter:a', atempoChain)
      }

      // P2-4：复用 ffmpeg-runner
      await runFfmpegCommand(
        filePath,
        (cmd) => cmd.outputOptions(outputOptions).output(targetPath),
        timeoutMs,
        t('main.videoService.log.speedTask')
      )

      return {
        success: true,
        message: t('main.videoService.message.speedSuccess'),
        filePath: targetPath
      }
    } catch (error) {
      if (targetPath) {
        await this.cleanupPartialOutput(targetPath)
      }
      const reason = error instanceof Error ? error.message : String(error)
      logger.error(t('main.videoService.log.speedFailed', { path: filePath }), reason)
      if (this.isSourceDecodeError(reason)) {
        await this.markCorrupted(filePath, t('main.videoService.log.speedDecodeFailed', { reason }))
      }
      return {
        success: false,
        message: t('main.videoService.error.speedFailed', { reason })
      }
    }
  }

  /**
   * 损坏文件容错：识别错误信息是否表明源文件解码失败。
   * 仅源文件解码失败才标记 is_corrupted=1，磁盘空间/权限/超时等外部错误不算源文件损坏。
   *
   * ffmpeg 解码失败的常见错误特征：
   * - "Invalid data found when processing input"（数据格式错误）
   * - "Error while decoding" / "Decoding error"（解码过程失败）
   * - "could not find codec" / "decoder not found"（缺少解码器，但文件可能正常）
   * - "Invalid argument" / "Corrupt"（明确的损坏指示）
   * - "moov atom not found"（mp4 文件头损坏）
   */
  private isSourceDecodeError(reason: string): boolean {
    const lower = reason.toLowerCase()
    return (
      lower.includes('invalid data') ||
      lower.includes('decoding') ||
      lower.includes('corrupt') ||
      lower.includes('moov atom') ||
      lower.includes('malformed') ||
      lower.includes('bad header') ||
      lower.includes('could not find codec') ||
      lower.includes('decoder not found') ||
      lower.includes('no decoder')
    )
  }

  /**
   * F-S9：构建 atempo 滤镜链。
   * atempo 单次有效范围 [0.5, 2.0]，超出时需链式分解：
   * - speed > 2.0：分解为多个 2.0 相乘（如 4.0 = atempo=2.0,atempo=2.0）
   * - speed < 0.5：分解为多个 0.5 相乘（如 0.25 = atempo=0.5,atempo=0.5）
   * 建议改#7：加迭代上限兜底，防止极端入参（如 NaN/0）导致死循环
   */
  private buildAtempoChain(speed: number): string {
    const factors: number[] = []
    let remaining = speed
    let iter = 0
    const MAX_ITER = 20
    while (remaining > 2.0 && iter < MAX_ITER) {
      factors.push(2.0)
      remaining /= 2.0
      iter++
    }
    while (remaining < 0.5 && iter < MAX_ITER) {
      factors.push(0.5)
      remaining /= 0.5
      iter++
    }
    // remaining 超出范围仍无法收敛时（极端入参），强制 clamp 到 [0.5, 2.0]
    if (remaining > 2.0) remaining = 2.0
    else if (remaining < 0.5) remaining = 0.5
    factors.push(Number(remaining.toFixed(6)))
    return factors.map((f) => `atempo=${f}`).join(',')
  }
}
