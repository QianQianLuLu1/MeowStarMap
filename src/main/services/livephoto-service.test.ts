import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * @layer L2
 * @module src/main/services/livephoto-service
 * @coverage LivePhotoService.exportLivePhoto（JPG + MOV 配对）
 * @dependencies ffmpeg-runner, video-probe, disk, file-utils, logger
 * @remarks Mock ffmpeg-runner/video-probe/disk/logger；保留 file-utils 真实实现 + 临时目录
 */

// ============================================================
// Mock 声明（hoisted）
// ============================================================

vi.mock('../utils/ffmpeg-runner', () => ({
  runFfmpegCommand: vi.fn()
}))

vi.mock('../utils/video-probe', () => ({
  probeVideoMetadata: vi.fn()
}))

vi.mock('../utils/disk', () => ({
  assertDiskSpace: vi.fn()
}))

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}))

// crypto.randomUUID 默认返回固定值，便于断言文件名
// 使用 vi.hoisted 确保 FIXED_UUID 在 mock factory 执行时可访问
const { FIXED_UUID } = vi.hoisted(() => ({
  FIXED_UUID: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
}))
vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto')
  return {
    ...actual,
    default: { ...actual, randomUUID: () => FIXED_UUID }
  }
})

// ============================================================
// Import after mock
// ============================================================
import { LivePhotoService } from './livephoto-service'
import { runFfmpegCommand } from '../utils/ffmpeg-runner'
import { probeVideoMetadata } from '../utils/video-probe'
import { assertDiskSpace } from '../utils/disk'

// ============================================================
// Helpers
// ============================================================

let tmpRoot: string
let srcVideo: string
let outDir: string
let service: LivePhotoService

beforeEach(() => {
  vi.clearAllMocks()
  // mockReset 清除 once 队列和默认实现，避免跨测试泄漏
  ;(runFfmpegCommand as any).mockReset()
  ;(assertDiskSpace as any).mockReset()
  ;(probeVideoMetadata as any).mockReset()
  ;(runFfmpegCommand as any).mockResolvedValue(undefined)
  ;(assertDiskSpace as any).mockResolvedValue(undefined)
  ;(probeVideoMetadata as any).mockResolvedValue({ duration: 10, width: 1920, height: 1080 })

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-livephoto-'))
  srcVideo = path.join(tmpRoot, 'src.mp4')
  fs.writeFileSync(srcVideo, Buffer.from('fake-video-content'))
  outDir = path.join(tmpRoot, 'output')
  fs.mkdirSync(outDir, { recursive: true })
  service = new LivePhotoService()
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

// ============================================================
// describe: LivePhotoService.exportLivePhoto
// ============================================================

describe('LivePhotoService.exportLivePhoto', () => {
  it('成功路径：生成 IMG_AAAAAAAA.jpg + IMG_AAAAAAAA.mov 并返回 success=true', async () => {
    const r = await service.exportLivePhoto(srcVideo, outDir)

    expect(r.success).toBe(true)
    expect(r.message).toBe('Live Photo 导出成功')
    expect(r.uuid).toBe(FIXED_UUID.toUpperCase())
    expect(r.jpgPath).toBeTruthy()
    expect(r.movPath).toBeTruthy()
    expect(path.basename(r.jpgPath!)).toBe('IMG_AAAAAAAA.jpg')
    expect(path.basename(r.movPath!)).toBe('IMG_AAAAAAAA.mov')

    // ffmpeg 应被调用两次：first frame + transcode
    expect(runFfmpegCommand).toHaveBeenCalledTimes(2)
    // 磁盘空间检查使用 3 倍源文件大小
    expect(assertDiskSpace).toHaveBeenCalledWith(outDir, expect.any(Number))
    const expectedBytes = fs.statSync(srcVideo).size * 3
    expect(assertDiskSpace).toHaveBeenCalledWith(outDir, expectedBytes)
  })

  it('成功路径：probeVideoMetadata 调用时传入 30s 超时', async () => {
    await service.exportLivePhoto(srcVideo, outDir)

    expect(probeVideoMetadata).toHaveBeenCalledWith(srcVideo, 30000)
  })

  it('成功路径：传入自定义 timeoutMs 时透传给 ffmpeg', async () => {
    await service.exportLivePhoto(srcVideo, outDir, 60_000)

    expect(runFfmpegCommand).toHaveBeenCalled()
    for (const call of (runFfmpegCommand as any).mock.calls) {
      expect(call[2]).toBe(60_000)
    }
  })

  it('目标目录不存在时自动创建', async () => {
    const newDir = path.join(tmpRoot, 'newly-created')
    expect(fs.existsSync(newDir)).toBe(false)

    await service.exportLivePhoto(srcVideo, newDir)

    expect(fs.existsSync(newDir)).toBe(true)
  })

  it('异常路径：源文件不存在时返回 success=false', async () => {
    const r = await service.exportLivePhoto(path.join(tmpRoot, 'no-such.mp4'), outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('Live Photo 导出失败')
    expect(runFfmpegCommand).not.toHaveBeenCalled()
  })

  it('异常路径：assertDiskSpace 抛错时返回失败且不调用 ffmpeg', async () => {
    ;(assertDiskSpace as any).mockRejectedValue(new Error('磁盘空间不足，需要 100 MB，仅剩 10 MB'))

    const r = await service.exportLivePhoto(srcVideo, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('磁盘空间不足')
    expect(runFfmpegCommand).not.toHaveBeenCalled()
  })

  it('异常路径：duration=0 抛错"无法读取视频时长"', async () => {
    ;(probeVideoMetadata as any).mockResolvedValue({ duration: 0 })

    const r = await service.exportLivePhoto(srcVideo, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('无法读取视频时长')
    expect(runFfmpegCommand).not.toHaveBeenCalled()
  })

  it('异常路径：duration=undefined 抛错"无法读取视频时长"', async () => {
    ;(probeVideoMetadata as any).mockResolvedValue({ width: 1920, height: 1080 })

    const r = await service.exportLivePhoto(srcVideo, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('无法读取视频时长')
  })

  it('异常路径：duration 为负数也判为无效', async () => {
    ;(probeVideoMetadata as any).mockResolvedValue({ duration: -5 })

    const r = await service.exportLivePhoto(srcVideo, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('无法读取视频时长')
  })

  it('异常路径：JPG 拆帧失败时清理已生成的部分输出', async () => {
    ;(runFfmpegCommand as any)
      .mockRejectedValueOnce(new Error('capture failed')) // 第一次调用（JPG）失败
      .mockResolvedValueOnce(undefined) // 不会执行

    const r = await service.exportLivePhoto(srcVideo, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('capture failed')
    // r.jpgPath 应为 undefined 或对应文件不存在（cleanupPartial 清理部分输出）
    if (r.jpgPath) {
      expect(fs.existsSync(r.jpgPath)).toBe(false)
    }
    if (r.movPath) {
      expect(fs.existsSync(r.movPath)).toBe(false)
    }
  })

  it('异常路径：MOV 转码失败时清理已生成的 JPG 与部分 MOV', async () => {
    ;(runFfmpegCommand as any)
      .mockResolvedValueOnce(undefined) // JPG 成功
      .mockRejectedValueOnce(new Error('transcode failed')) // MOV 失败

    const r = await service.exportLivePhoto(srcVideo, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('transcode failed')
    // JPG 应被清理（cleanupPartial 接收 jpgPath + movPath）
    expect(fs.existsSync(path.join(outDir, 'IMG_AAAAAAAA.jpg'))).toBe(false)
  })

  it('异常路径：cleanupPartial 在文件不存在时静默忽略', async () => {
    ;(runFfmpegCommand as any).mockRejectedValue(new Error('capture failed'))

    // 不预先创建任何文件，cleanupPartial 应静默通过
    const r = await service.exportLivePhoto(srcVideo, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('capture failed')
  })

  it('异常路径：非 Error 对象抛出时使用 String 转换', async () => {
    ;(probeVideoMetadata as any).mockRejectedValue('string-error')

    const r = await service.exportLivePhoto(srcVideo, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('string-error')
  })

  it('文件名冲突时 getUniqueFilePath 自动追加 _1 后缀', async () => {
    // 预先占用 IMG_AAAAAAAA.jpg，应触发 _1 后缀
    fs.writeFileSync(path.join(outDir, 'IMG_AAAAAAAA.jpg'), Buffer.from('existing'))
    fs.writeFileSync(path.join(outDir, 'IMG_AAAAAAAA.mov'), Buffer.from('existing'))

    const r = await service.exportLivePhoto(srcVideo, outDir)

    expect(r.success).toBe(true)
    expect(path.basename(r.jpgPath!)).toBe('IMG_AAAAAAAA_1.jpg')
    expect(path.basename(r.movPath!)).toBe('IMG_AAAAAAAA_1.mov')
  })
})
