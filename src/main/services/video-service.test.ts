import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * @layer L2
 * @module src/main/services/video-service
 * @coverage VideoService.getMetadata / exportVideo / captureFrame / trimVideo / changeSpeed / buildAtempoChain
 * @dependencies ffmpeg-runner, video-probe, disk, file-utils
 * @remarks Mock ffmpeg-runner/video-probe/disk；保留 file-utils 真实实现 + 临时目录
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

// logger 内部依赖 electron app.getPath('userData')，测试环境无 electron 实例会抛
// "Cannot read properties of undefined (reading 'getPath')"，需 mock logger
vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/tmp/test-logs'),
  initLogger: vi.fn(),
  setLogDirectory: vi.fn(),
  getRecentLogs: vi.fn(() => [])
}))

// ============================================================
// Import after mock
// ============================================================
import { VideoService } from './video-service'
import { runFfmpegCommand } from '../utils/ffmpeg-runner'
import { probeVideoMetadata } from '../utils/video-probe'
import { assertDiskSpace } from '../utils/disk'

// ============================================================
// Helpers
// ============================================================

let tmpRoot: string
let srcVideo: string
let outDir: string
let service: VideoService

beforeEach(() => {
  vi.clearAllMocks()
  // 模拟真实 ffmpeg 行为：源文件不存在时拒绝，存在时成功
  ;(runFfmpegCommand as any).mockImplementation(async (input: string) => {
    if (!fs.existsSync(input)) {
      throw new Error(`Input file not found: ${input}`)
    }
  })
  ;(assertDiskSpace as any).mockResolvedValue(undefined)
  ;(probeVideoMetadata as any).mockResolvedValue({
    width: 1920,
    height: 1080,
    duration: 10,
    codec: 'h264',
    frameRate: 30
  })

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-video-'))
  srcVideo = path.join(tmpRoot, 'src.mp4')
  fs.writeFileSync(srcVideo, Buffer.from('fake-video-content'))
  outDir = path.join(tmpRoot, 'output')
  fs.mkdirSync(outDir, { recursive: true })
  service = new VideoService()
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

// 模拟 ffmpeg 写入半成品文件后失败，用于验证 cleanup 逻辑
// 通过调用 configure 提取真实 targetPath，避免与 getUniqueFilePath 冲突逻辑冲突
function mockFfmpegWritePartialThenFail(errorMsg: string) {
  ;(runFfmpegCommand as any).mockImplementation(
    async (_input: string, configure: (cmd: any) => any) => {
      let outputPath = ''
      const fakeCmd = {
        outputOptions: () => fakeCmd,
        seekInput: () => fakeCmd,
        frames: () => fakeCmd,
        duration: () => fakeCmd,
        output: (p: string) => {
          outputPath = p
          return fakeCmd
        }
      }
      configure(fakeCmd)
      if (outputPath) fs.writeFileSync(outputPath, Buffer.from('partial'))
      throw new Error(errorMsg)
    }
  )
}

// ============================================================
// describe: VideoService.getMetadata
// ============================================================

describe('VideoService.getMetadata', () => {
  it('成功路径：委托给 probeVideoMetadata', async () => {
    const r = await service.getMetadata(srcVideo)

    expect(probeVideoMetadata).toHaveBeenCalledWith(srcVideo, 30000)
    expect(r).toEqual({ width: 1920, height: 1080, duration: 10, codec: 'h264', frameRate: 30 })
  })

  it('传入自定义 timeoutMs 时透传给 probeVideoMetadata', async () => {
    await service.getMetadata(srcVideo, 60_000)

    expect(probeVideoMetadata).toHaveBeenCalledWith(srcVideo, 60_000)
  })

  it('默认 timeoutMs=30000（DEFAULT_METADATA_TIMEOUT_MS）', async () => {
    await service.getMetadata(srcVideo)

    expect(probeVideoMetadata).toHaveBeenCalledWith(srcVideo, 30000)
  })

  it('probeVideoMetadata 抛错时向上抛出', async () => {
    ;(probeVideoMetadata as any).mockRejectedValue(new Error('ffprobe failed'))

    await expect(service.getMetadata(srcVideo)).rejects.toThrow('ffprobe failed')
  })
})

// ============================================================
// describe: VideoService.exportVideo
// ============================================================

describe('VideoService.exportVideo', () => {
  it('成功路径：调用 ffmpeg + 返回 success=true', async () => {
    const r = await service.exportVideo(srcVideo, outDir, 'mp4')

    expect(r.success).toBe(true)
    expect(r.message).toBe('视频导出成功')
    expect(runFfmpegCommand).toHaveBeenCalledTimes(1)
    expect(assertDiskSpace).toHaveBeenCalledWith(outDir, fs.statSync(srcVideo).size * 2)
  })

  it('默认 timeoutMs=300000（5 分钟）', async () => {
    await service.exportVideo(srcVideo, outDir, 'mp4')

    const call = (runFfmpegCommand as any).mock.calls[0]
    expect(call[2]).toBe(5 * 60 * 1000)
  })

  it('传入自定义 timeoutMs 时透传给 ffmpeg', async () => {
    await service.exportVideo(srcVideo, outDir, 'mp4', 120_000)

    const call = (runFfmpegCommand as any).mock.calls[0]
    expect(call[2]).toBe(120_000)
  })

  it('目标目录不存在时自动创建', async () => {
    const newDir = path.join(tmpRoot, 'new-dir')
    expect(fs.existsSync(newDir)).toBe(false)

    await service.exportVideo(srcVideo, newDir, 'mp4')

    expect(fs.existsSync(newDir)).toBe(true)
  })

  it('源文件不存在时返回 success=false', async () => {
    const r = await service.exportVideo(path.join(tmpRoot, 'no-such.mp4'), outDir, 'mp4')

    expect(r.success).toBe(false)
    expect(r.message).toContain('视频导出失败')
  })

  it('磁盘空间不足时返回 success=false 且不调用 ffmpeg', async () => {
    ;(assertDiskSpace as any).mockRejectedValue(new Error('磁盘空间不足'))

    const r = await service.exportVideo(srcVideo, outDir, 'mp4')

    expect(r.success).toBe(false)
    expect(r.message).toContain('磁盘空间不足')
    expect(runFfmpegCommand).not.toHaveBeenCalled()
  })

  it('ffmpeg 失败时清理部分输出文件', async () => {
    // 模拟 ffmpeg 写入半成品后失败
    mockFfmpegWritePartialThenFail('encode failed')

    const expected = path.join(outDir, 'src.mp4')

    const r = await service.exportVideo(srcVideo, outDir, 'mp4')

    expect(r.success).toBe(false)
    expect(r.message).toContain('encode failed')
    // 部分输出应被清理
    expect(fs.existsSync(expected)).toBe(false)
  })

  it('ffmpeg 抛非 Error 类型时使用 String 转换', async () => {
    ;(runFfmpegCommand as any).mockRejectedValue('string-error')

    const r = await service.exportVideo(srcVideo, outDir, 'mp4')

    expect(r.success).toBe(false)
    expect(r.message).toContain('string-error')
  })

  it('format=gif 时 targetExt 仍为 gif', async () => {
    const r = await service.exportVideo(srcVideo, outDir, 'gif')

    expect(r.success).toBe(true)
    const call = (runFfmpegCommand as any).mock.calls[0]
    // configure 函数接收 cmd 参数；输出路径基于 .gif
    expect(call[1]).toBeTypeOf('function')
  })

  it('format=webm 时调用 ffmpeg', async () => {
    const r = await service.exportVideo(srcVideo, outDir, 'webm')

    expect(r.success).toBe(true)
    expect(runFfmpegCommand).toHaveBeenCalled()
  })
})

// ============================================================
// describe: VideoService.captureFrame
// ============================================================

describe('VideoService.captureFrame', () => {
  it('成功路径：使用 currentTime 截图 + 返回 success=true + filePath', async () => {
    const r = await service.captureFrame(srcVideo, 5.7, outDir)

    expect(r.success).toBe(true)
    expect(r.message).toBe('帧截图保存成功')
    expect(r.filePath).toBeTruthy()
    // 文件名包含 Math.floor(5.7) = 5
    expect(path.basename(r.filePath!)).toContain('_5s')
    expect(runFfmpegCommand).toHaveBeenCalledTimes(1)
  })

  it('默认 timeoutMs=30000（30 秒）', async () => {
    await service.captureFrame(srcVideo, 1, outDir)

    const call = (runFfmpegCommand as any).mock.calls[0]
    expect(call[2]).toBe(30_000)
  })

  it('未传入 targetDir 时使用源文件所在目录', async () => {
    const r = await service.captureFrame(srcVideo, 2)

    expect(r.success).toBe(true)
    expect(r.filePath).toBeTruthy()
    expect(path.dirname(r.filePath!)).toBe(path.dirname(srcVideo))
  })

  it('currentTime 为浮点数时使用 Math.floor 转秒数', async () => {
    const r = await service.captureFrame(srcVideo, 12.99, outDir)

    expect(r.success).toBe(true)
    expect(path.basename(r.filePath!)).toContain('_12s')
  })

  it('ffmpeg 失败时清理部分输出文件', async () => {
    // 模拟 ffmpeg 写入半成品后失败
    mockFfmpegWritePartialThenFail('capture failed')

    const partial = path.join(outDir, 'src_帧截图_5s.jpg')

    const r = await service.captureFrame(srcVideo, 5, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('capture failed')
    expect(fs.existsSync(partial)).toBe(false)
  })

  it('源文件不存在时返回 success=false', async () => {
    const r = await service.captureFrame(path.join(tmpRoot, 'no-such.mp4'), 1, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('帧截图失败')
  })

  it('自定义命名模板：文件名冲突时追加 _1 后缀', async () => {
    // 预先占用默认路径
    const expected = path.join(outDir, 'src_帧截图_5s.jpg')
    fs.writeFileSync(expected, Buffer.from('existing'))

    const r = await service.captureFrame(srcVideo, 5, outDir)

    expect(r.success).toBe(true)
    expect(path.basename(r.filePath!)).toBe('src_帧截图_5s_1.jpg')
  })
})

// ============================================================
// describe: VideoService.trimVideo
// ============================================================

describe('VideoService.trimVideo', () => {
  it('成功路径：返回 success=true + filePath', async () => {
    const r = await service.trimVideo(srcVideo, 2, 8, outDir)

    expect(r.success).toBe(true)
    expect(r.message).toBe('视频裁剪成功')
    expect(r.filePath).toBeTruthy()
    expect(path.basename(r.filePath!)).toContain('_裁剪')
    expect(runFfmpegCommand).toHaveBeenCalledTimes(1)
  })

  it('默认 timeoutMs=600000（10 分钟）', async () => {
    await service.trimVideo(srcVideo, 1, 5, outDir)

    const call = (runFfmpegCommand as any).mock.calls[0]
    expect(call[2]).toBe(10 * 60 * 1000)
  })

  it('startTime<0 抛错"无效的裁剪区间"', async () => {
    const r = await service.trimVideo(srcVideo, -1, 5, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('无效的裁剪区间')
    expect(r.message).toContain('startTime=-1')
    expect(runFfmpegCommand).not.toHaveBeenCalled()
  })

  it('endTime<=startTime 抛错"无效的裁剪区间"', async () => {
    const r = await service.trimVideo(srcVideo, 5, 5, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('无效的裁剪区间')
    expect(runFfmpegCommand).not.toHaveBeenCalled()
  })

  it('endTime<startTime 抛错"无效的裁剪区间"', async () => {
    const r = await service.trimVideo(srcVideo, 10, 5, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('无效的裁剪区间')
    expect(runFfmpegCommand).not.toHaveBeenCalled()
  })

  it('磁盘空间不足时返回 success=false', async () => {
    // mock fsp.statfs 返回低空间
    const statfsSpy = vi.spyOn(fs.promises, 'statfs').mockResolvedValue({
      bavail: 1,
      bsize: 1,
      blocks: 1,
      bfree: 1,
      files: 0,
      ffree: 0,
      favail: 0,
      type: 0,
      flags: 0
    } as any)

    // 源文件大小 > 1 字节，必触发不足
    const r = await service.trimVideo(srcVideo, 1, 5, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('磁盘空间不足')
    expect(runFfmpegCommand).not.toHaveBeenCalled()
    statfsSpy.mockRestore()
  })

  it('ffmpeg 失败时清理部分输出文件', async () => {
    // 模拟 ffmpeg 写入半成品后失败
    mockFfmpegWritePartialThenFail('trim failed')

    const partial = path.join(outDir, 'src_裁剪.mp4')

    const r = await service.trimVideo(srcVideo, 1, 5, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('trim failed')
    expect(fs.existsSync(partial)).toBe(false)
  })

  it('目标目录不存在时自动创建', async () => {
    const newDir = path.join(tmpRoot, 'new-trim-dir')
    expect(fs.existsSync(newDir)).toBe(false)

    const r = await service.trimVideo(srcVideo, 1, 5, newDir)

    expect(r.success).toBe(true)
    expect(fs.existsSync(newDir)).toBe(true)
  })

  it('源文件不存在时返回 success=false', async () => {
    const r = await service.trimVideo(path.join(tmpRoot, 'no-such.mp4'), 1, 5, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('视频裁剪失败')
  })
})

// ============================================================
// describe: VideoService.changeSpeed
// ============================================================

describe('VideoService.changeSpeed', () => {
  it('成功路径：speed=1.0 返回 success=true + filePath', async () => {
    const r = await service.changeSpeed(srcVideo, 1.0, outDir)

    expect(r.success).toBe(true)
    expect(r.message).toBe('视频调速成功')
    expect(r.filePath).toBeTruthy()
    expect(path.basename(r.filePath!)).toContain('_1x')
    expect(runFfmpegCommand).toHaveBeenCalledTimes(1)
  })

  it('默认 timeoutMs=600000（10 分钟）', async () => {
    await service.changeSpeed(srcVideo, 2.0, outDir)

    const call = (runFfmpegCommand as any).mock.calls[0]
    expect(call[2]).toBe(10 * 60 * 1000)
  })

  it('speed=0.25（MIN_SPEED 边界）成功', async () => {
    const r = await service.changeSpeed(srcVideo, 0.25, outDir)

    expect(r.success).toBe(true)
  })

  it('speed=4.0（MAX_SPEED 边界）成功', async () => {
    const r = await service.changeSpeed(srcVideo, 4.0, outDir)

    expect(r.success).toBe(true)
  })

  it('speed<0.25 抛错"不支持的速度"', async () => {
    const r = await service.changeSpeed(srcVideo, 0.1, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('不支持的速度')
    // 源码 ${MIN_SPEED}-${MAX_SPEED} 中 4.0 在模板字符串中被转为 "4"
    expect(r.message).toContain('0.25-4')
    expect(runFfmpegCommand).not.toHaveBeenCalled()
  })

  it('speed>4.0 抛错"不支持的速度"', async () => {
    const r = await service.changeSpeed(srcVideo, 5.0, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('不支持的速度')
    expect(runFfmpegCommand).not.toHaveBeenCalled()
  })

  it('磁盘空间不足时返回 success=false', async () => {
    const statfsSpy = vi.spyOn(fs.promises, 'statfs').mockResolvedValue({
      bavail: 1,
      bsize: 1,
      blocks: 1,
      bfree: 1,
      files: 0,
      ffree: 0,
      favail: 0,
      type: 0,
      flags: 0
    } as any)

    const r = await service.changeSpeed(srcVideo, 1.0, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('磁盘空间不足')
    expect(runFfmpegCommand).not.toHaveBeenCalled()
    statfsSpy.mockRestore()
  })

  it('ffmpeg 失败时清理部分输出文件', async () => {
    // 模拟 ffmpeg 写入半成品后失败
    mockFfmpegWritePartialThenFail('speed failed')

    const partial = path.join(outDir, 'src_1x.mp4')

    const r = await service.changeSpeed(srcVideo, 1.0, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('speed failed')
    expect(fs.existsSync(partial)).toBe(false)
  })

  it('speed=2.0 时 atempo 链为单层 atempo=2', async () => {
    await service.changeSpeed(srcVideo, 2.0, outDir)

    const call = (runFfmpegCommand as any).mock.calls[0]
    const configure = call[1] as (cmd: any) => any
    const fakeCmd = {
      outputOptions: vi.fn().mockReturnThis(),
      output: vi.fn().mockReturnThis()
    }
    configure(fakeCmd)
    // outputOptions 被调用时传入数组 ['-filter:v', setpts, '-filter:a', atempo]
    const optsArg = fakeCmd.outputOptions.mock.calls[0][0]
    expect(optsArg).toContain('-filter:v')
    expect(optsArg).toContain('-filter:a')
    const atempo = optsArg.find((o: string) => o.startsWith('atempo='))
    expect(atempo).toBe('atempo=2')
  })

  it('speed=4.0 时 atempo 链为 atempo=2,atempo=2（链式分解）', async () => {
    await service.changeSpeed(srcVideo, 4.0, outDir)

    const call = (runFfmpegCommand as any).mock.calls[0]
    const configure = call[1] as (cmd: any) => any
    const fakeCmd = {
      outputOptions: vi.fn().mockReturnThis(),
      output: vi.fn().mockReturnThis()
    }
    configure(fakeCmd)
    const optsArg = fakeCmd.outputOptions.mock.calls[0][0]
    const atempo = optsArg.find((o: string) => o.startsWith('atempo='))
    expect(atempo).toBe('atempo=2,atempo=2')
  })

  it('speed=0.5 时 atempo 链为 atempo=0.5（在范围内，单层）', async () => {
    await service.changeSpeed(srcVideo, 0.5, outDir)

    const call = (runFfmpegCommand as any).mock.calls[0]
    const configure = call[1] as (cmd: any) => any
    const fakeCmd = {
      outputOptions: vi.fn().mockReturnThis(),
      output: vi.fn().mockReturnThis()
    }
    configure(fakeCmd)
    const optsArg = fakeCmd.outputOptions.mock.calls[0][0]
    const atempo = optsArg.find((o: string) => o.startsWith('atempo='))
    expect(atempo).toBe('atempo=0.5')
  })

  it('speed=0.25 时 atempo 链为 atempo=0.5,atempo=0.5（链式分解）', async () => {
    await service.changeSpeed(srcVideo, 0.25, outDir)

    const call = (runFfmpegCommand as any).mock.calls[0]
    const configure = call[1] as (cmd: any) => any
    const fakeCmd = {
      outputOptions: vi.fn().mockReturnThis(),
      output: vi.fn().mockReturnThis()
    }
    configure(fakeCmd)
    const optsArg = fakeCmd.outputOptions.mock.calls[0][0]
    const atempo = optsArg.find((o: string) => o.startsWith('atempo='))
    expect(atempo).toBe('atempo=0.5,atempo=0.5')
  })

  it('speed=1.5 时 atempo 链为单层 atempo=1.5', async () => {
    await service.changeSpeed(srcVideo, 1.5, outDir)

    const call = (runFfmpegCommand as any).mock.calls[0]
    const configure = call[1] as (cmd: any) => any
    const fakeCmd = {
      outputOptions: vi.fn().mockReturnThis(),
      output: vi.fn().mockReturnThis()
    }
    configure(fakeCmd)
    const optsArg = fakeCmd.outputOptions.mock.calls[0][0]
    const atempo = optsArg.find((o: string) => o.startsWith('atempo='))
    expect(atempo).toBe('atempo=1.5')
  })

  it('setpts 滤镜按 1/speed 计算（speed=2.0 → 0.5）', async () => {
    await service.changeSpeed(srcVideo, 2.0, outDir)

    const call = (runFfmpegCommand as any).mock.calls[0]
    const configure = call[1] as (cmd: any) => any
    const fakeCmd = {
      outputOptions: vi.fn().mockReturnThis(),
      output: vi.fn().mockReturnThis()
    }
    configure(fakeCmd)
    const optsArg = fakeCmd.outputOptions.mock.calls[0][0]
    const setpts = optsArg.find((o: string) => o.startsWith('setpts='))
    expect(setpts).toContain('0.5')
    expect(setpts).toContain('*PTS')
  })

  it('目标目录不存在时自动创建', async () => {
    const newDir = path.join(tmpRoot, 'speed-dir')
    expect(fs.existsSync(newDir)).toBe(false)

    const r = await service.changeSpeed(srcVideo, 1.0, newDir)

    expect(r.success).toBe(true)
    expect(fs.existsSync(newDir)).toBe(true)
  })
})

// ============================================================
// describe: VideoService.buildAtempoChain（通过 changeSpeed 间接测试）
// ============================================================

describe('VideoService.buildAtempoChain 极端边界', () => {
  it('speed=8.0（超出 MAX_SPEED）抛错"不支持的速度"', async () => {
    const r = await service.changeSpeed(srcVideo, 8.0, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('不支持的速度')
    expect(runFfmpegCommand).not.toHaveBeenCalled()
  })

  it('speed=0.1（低于 MIN_SPEED）抛错"不支持的速度"', async () => {
    const r = await service.changeSpeed(srcVideo, 0.1, outDir)

    expect(r.success).toBe(false)
    expect(r.message).toContain('不支持的速度')
    expect(runFfmpegCommand).not.toHaveBeenCalled()
  })
})
