import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
// A6：ffmpeg 执行逻辑抽取到 utils/ffmpeg-runner，消除 captureFirstFrame 与 transcodeToLivePhotoMov 间的重复
import { runFfmpegCommand } from '../utils/ffmpeg-runner'
import { getUniqueFilePath } from '../utils/file-utils'
import { assertDiskSpace } from '../utils/disk'
import { probeVideoMetadata } from '../utils/video-probe'
import { logger } from '../utils/logger'

// Live Photo 转码耗时较长，超时放宽到 10 分钟
const DEFAULT_LIVEPHOTO_TIMEOUT_MS = 10 * 60 * 1000

export interface LivePhotoResult {
  success: boolean
  message: string
  jpgPath?: string
  movPath?: string
  uuid?: string
}

export class LivePhotoService {
  /**
   * 将视频导出为 Apple Live Photo（JPG + MOV 配对文件）。
   *
   * 实现策略（不引入新依赖）：
   * 1. 生成 UUID v4 作为 ContentIdentifier
   * 2. ffmpeg 提取视频第一帧为 JPG（与 MOV 共享文件名主体）
   * 3. ffmpeg 转码为 MOV（H.264 + AAC），写入 com.apple.quicktime.content.identifier 元数据
   *
   * 配对识别：iPhone 导入时通过 MOV 的 content.identifier + JPG/MOV 同名（除扩展名）识别为 Live Photo。
   * 已知限制：JPG 未写入 Apple MakerNote ContentIdentifier（需 piexifjs 库），
   *          iCloud 同步可能丢失配对，本地导入正常。
   */
  async exportLivePhoto(
    filePath: string,
    targetDir: string,
    timeoutMs: number = DEFAULT_LIVEPHOTO_TIMEOUT_MS
  ): Promise<LivePhotoResult> {
    let jpgPath = ''
    let movPath = ''
    try {
      await fsp.mkdir(targetDir, { recursive: true })

      // 磁盘空间检查：MOV 转码 + JPG 拆帧，预估源文件 3 倍
      const srcStat = await fsp.stat(filePath)
      await assertDiskSpace(targetDir, srcStat.size * 3)

      // 探测视频元数据（用于 JPG 分辨率对齐 + 时长日志）
      const meta = await probeVideoMetadata(filePath, 30000)
      if (!meta.duration || meta.duration <= 0) {
        throw new Error('无法读取视频时长，可能不是有效视频文件')
      }

      // 生成 ContentIdentifier UUID（小写无连字符，符合 Apple 规范）
      const uuid = crypto.randomUUID().toUpperCase()
      logger.info(`[LivePhoto] 开始导出: ${path.basename(filePath)} → UUID ${uuid}`)

      // 文件名主体：IMG_{8位UUID前缀}，遵循 Apple 命名风格
      const baseName = `IMG_${uuid.slice(0, 8)}`

      // JPG 路径（与 MOV 共享文件名主体）
      jpgPath = await getUniqueFilePath(targetDir, baseName, '.jpg')
      // MOV 路径（与 JPG 同名，仅扩展名不同）
      movPath = await getUniqueFilePath(targetDir, baseName, '.mov')

      // 步骤 1：提取第一帧为 JPG（高质量，分辨率与原视频一致）
      await this.captureFirstFrame(filePath, jpgPath, timeoutMs)
      logger.info(`[LivePhoto] JPG 拆帧完成: ${path.basename(jpgPath)}`)

      // 步骤 2：转码为 MOV + 写入 ContentIdentifier
      await this.transcodeToLivePhotoMov(filePath, movPath, uuid, timeoutMs)
      logger.info(`[LivePhoto] MOV 转码完成: ${path.basename(movPath)}`)

      return {
        success: true,
        message: 'Live Photo 导出成功',
        jpgPath,
        movPath,
        uuid
      }
    } catch (error) {
      // 任一步失败都清理部分输出，避免残留半成品
      await this.cleanupPartial(jpgPath, movPath)
      const msg = error instanceof Error ? error.message : String(error)
      logger.error(`[LivePhoto] 导出失败: ${msg}`)
      return {
        success: false,
        message: `Live Photo 导出失败: ${msg}`
      }
    }
  }

  /**
   * 提取视频第一帧为 JPG（高质量，与原视频同分辨率）。
   * 失败时调用方负责清理输出文件。
   */
  private captureFirstFrame(
    filePath: string,
    outputPath: string,
    timeoutMs: number
  ): Promise<void> {
    return runFfmpegCommand(
      filePath,
      (cmd) =>
        cmd
          .frames(1)
          .outputOptions('-q:v', '2') // 高质量 JPEG（qscale 2）
          .output(outputPath),
      timeoutMs
    )
  }

  /**
   * 转码视频为 Apple Live Photo 兼容的 MOV。
   * - H.264 视频 + AAC 音频（QuickTime 标准）
   * - 写入 com.apple.quicktime.content.identifier 元数据
   * - faststart 优化流式播放
   */
  private transcodeToLivePhotoMov(
    filePath: string,
    outputPath: string,
    uuid: string,
    timeoutMs: number
  ): Promise<void> {
    return runFfmpegCommand(
      filePath,
      (cmd) =>
        cmd
          .outputOptions(
            '-c:v',
            'libx264',
            '-preset',
            'medium',
            '-crf',
            '20', // 视觉无损质量
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-movflags',
            '+faststart',
            // 写入 Live Photo ContentIdentifier（关键元数据）
            '-metadata',
            `com.apple.quicktime.content.identifier=${uuid}`
          )
          .format('mov')
          .output(outputPath),
      timeoutMs
    )
  }

  /** 静默清理部分输出文件（任一不存在或删除失败均忽略） */
  private async cleanupPartial(...paths: string[]): Promise<void> {
    for (const p of paths) {
      if (!p) continue
      try {
        await fsp.unlink(p)
      } catch {
        // 文件不存在或已被清理，忽略
      }
    }
  }
}

export const livePhotoService = new LivePhotoService()
