// 视频命名空间：对应主进程 handlers/video.ts 注册的 video:* 通道
import { call } from '../ipc'
import type {
  FileOpResult,
  VideoEditBatchRequest,
  VideoEditBatchResponse,
  VideoEditRequest,
  VideoEditResponse,
  VideoMetadata,
  VideoThumbnailResult
} from '../../../shared/types/electron-api'

/** electronAPI.video：视频缩略图 / 元数据 / 导出 / 裁剪 / 调速 / 编辑 */
export const videoAPI = {
  thumbnail: (filePath: string) => call<VideoThumbnailResult>('video:thumbnail', filePath),
  metadata: (filePath: string) => call<VideoMetadata>('video:metadata', filePath),
  export: (filePath: string, targetDir: string, format: string) =>
    call<FileOpResult>('video:export', filePath, targetDir, format),
  captureFrame: (filePath: string, currentTime: number, targetDir?: string) =>
    call<{ filePath?: string; message?: string }>(
      'video:captureFrame',
      filePath,
      currentTime,
      targetDir
    ),
  // F-S9：视频裁剪（保留 [startTime, endTime] 区间，单位秒）
  trim: (filePath: string, startTime: number, endTime: number, targetDir: string) =>
    call<{ output: string; duration: number; message?: string }>(
      'video:trim',
      filePath,
      startTime,
      endTime,
      targetDir
    ),
  // F-S9：视频调速（speed 范围 0.25-4.0）
  changeSpeed: (filePath: string, speed: number, targetDir: string) =>
    call<{ output: string; message?: string }>('video:changeSpeed', filePath, speed, targetDir),
  // P1-05：导出 Apple Live Photo（JPG + MOV 配对文件）
  exportLivePhoto: (filePath: string, targetDir: string) =>
    call<{ jpgPath: string; movPath: string; message?: string }>(
      'video:exportLivePhoto',
      filePath,
      targetDir
    ),
  // 视频编辑（调色 + 水印 + 可选裁剪/调速/格式）→ utilityProcess 渲染 ffmpeg
  edit: (payload: VideoEditRequest) => call<VideoEditResponse>('video:edit', payload),
  // 批量视频编辑
  editBatch: (payload: VideoEditBatchRequest) =>
    call<VideoEditBatchResponse>('video:editBatch', payload)
}
