/**
 * @layer L1
 * @module src/main/utils/video-probe
 * @coverage probeVideoMetadata/parseFrameRate（间接）/VideoMetadata
 * @dependencies mock: fluent-ffmpeg, ./ffmpeg-paths, ./process-registry
 * @remarks 捕获 ffprobe 回调测试元数据解析；parseFrameRate 未导出，通过 r_frame_rate 间接覆盖
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// 构造模拟 ffmpeg command（含 ffprobe 回调捕获）
function createMockCommand() {
  let ffprobeCallback: ((err: Error | null, data: unknown) => void) | null = null
  const command = {
    setFfprobePath: vi.fn().mockReturnThis(),
    kill: vi.fn(),
    ffprobe: vi.fn((cb: (err: Error | null, data: unknown) => void) => {
      ffprobeCallback = cb
    })
  }
  Object.defineProperty(command, '_invokeFfprobe', {
    value: (err: Error | null, data: unknown): void => {
      if (ffprobeCallback) ffprobeCallback(err, data)
    },
    enumerable: false
  })
  return command as typeof command & {
    _invokeFfprobe: (err: Error | null, data: unknown) => void
  }
}

let mockCommand: ReturnType<typeof createMockCommand>

vi.mock('fluent-ffmpeg', () => ({
  default: vi.fn(() => mockCommand)
}))

vi.mock('./ffmpeg-paths', () => ({
  ffmpegPath: '/fake/ffmpeg',
  ffprobePath: '/fake/ffprobe'
}))

const trackFfmpegCommandMock = vi.fn((cmd: unknown) => cmd)
const untrackFfmpegCommandMock = vi.fn()

vi.mock('./process-registry', () => ({
  trackFfmpegCommand: (...args: unknown[]) => trackFfmpegCommandMock(...args),
  untrackFfmpegCommand: (...args: unknown[]) => untrackFfmpegCommandMock(...args)
}))

import { probeVideoMetadata } from './video-probe'
import ffmpeg from 'fluent-ffmpeg'

const ffmpegMock = ffmpeg as unknown as ReturnType<typeof vi.fn>

describe('video-probe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockCommand = createMockCommand()
    trackFfmpegCommandMock.mockClear()
    untrackFfmpegCommandMock.mockClear()
    ffmpegMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('probeVideoMetadata', () => {
    it('正常返回视频元数据', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [
          {
            codec_type: 'video',
            width: 1920,
            height: 1080,
            codec_name: 'h264',
            r_frame_rate: '30/1'
          }
        ],
        format: { duration: 120.7 }
      })
      const result = await promise
      expect(result).toEqual({
        width: 1920,
        height: 1080,
        duration: 121,
        codec: 'h264',
        frameRate: 30
      })
    })

    it('调用 ffmpeg 工厂时传入文件路径', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, { streams: [], format: {} })
      await promise
      expect(ffmpegMock).toHaveBeenCalledWith('/video.mp4')
    })

    it('调用 setFfprobePath 设置二进制路径', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, { streams: [], format: {} })
      await promise
      expect(mockCommand.setFfprobePath).toHaveBeenCalledWith('/fake/ffprobe')
    })

    it('执行前调用 trackFfmpegCommand', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, { streams: [], format: {} })
      await promise
      expect(trackFfmpegCommandMock).toHaveBeenCalledWith(mockCommand)
    })

    it('正常完成后调用 untrackFfmpegCommand', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, { streams: [], format: {} })
      await promise
      expect(untrackFfmpegCommandMock).toHaveBeenCalledWith(mockCommand)
    })

    it('ffprobe 回调出错时 reject 含文件路径与错误消息', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(new Error('ffprobe failed'), null)
      await expect(promise).rejects.toThrow('读取视频元数据失败 /video.mp4: ffprobe failed')
    })

    it('ffprobe 出错时调用 untrackFfmpegCommand', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(new Error('fail'), null)
      try {
        await promise
      } catch {
        // 预期 reject
      }
      expect(untrackFfmpegCommandMock).toHaveBeenCalledWith(mockCommand)
    })

    it('超时后调用 kill SIGKILL', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      vi.advanceTimersByTime(5000)
      try {
        await promise
      } catch {
        // 预期 reject
      }
      expect(mockCommand.kill).toHaveBeenCalledWith('SIGKILL')
    })

    it('超时后 reject 包含文件路径与超时时间', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      vi.advanceTimersByTime(5000)
      await expect(promise).rejects.toThrow('读取视频元数据超时 (5000ms): /video.mp4')
    })

    it('超时后调用 untrackFfmpegCommand', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      vi.advanceTimersByTime(5000)
      try {
        await promise
      } catch {
        // 预期 reject
      }
      expect(untrackFfmpegCommandMock).toHaveBeenCalledWith(mockCommand)
    })

    it('未指定 timeoutMs 时默认 30000ms', async () => {
      const promise = probeVideoMetadata('/video.mp4')
      vi.advanceTimersByTime(29999)
      let rejected = false
      promise.catch(() => {
        rejected = true
      })
      await Promise.resolve()
      expect(rejected).toBe(false)
      vi.advanceTimersByTime(1)
      await expect(promise).rejects.toThrow('读取视频元数据超时 (30000ms): /video.mp4')
    })

    it('正常完成后清除超时定时器', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, { streams: [], format: {} })
      await promise
      vi.advanceTimersByTime(10000)
      expect(mockCommand.kill).not.toHaveBeenCalled()
    })

    it('ffprobe 出错后清除超时定时器', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(new Error('fail'), null)
      try {
        await promise
      } catch {
        // 预期 reject
      }
      vi.advanceTimersByTime(10000)
      expect(mockCommand.kill).not.toHaveBeenCalled()
    })

    it('无视频流时返回 undefined 字段', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'audio' }],
        format: { duration: 60 }
      })
      const result = await promise
      expect(result).toEqual({
        width: undefined,
        height: undefined,
        duration: 60,
        codec: undefined,
        frameRate: undefined
      })
    })

    it('streams 为空数组时所有字段为 undefined', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [],
        format: {}
      })
      const result = await promise
      expect(result.width).toBeUndefined()
      expect(result.height).toBeUndefined()
      expect(result.duration).toBeUndefined()
      expect(result.codec).toBeUndefined()
      expect(result.frameRate).toBeUndefined()
    })

    it('多个视频流时取第一个', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [
          {
            codec_type: 'video',
            width: 1920,
            height: 1080,
            codec_name: 'h264',
            r_frame_rate: '30/1'
          },
          {
            codec_type: 'video',
            width: 1280,
            height: 720,
            codec_name: 'hevc',
            r_frame_rate: '60/1'
          }
        ],
        format: { duration: 100 }
      })
      const result = await promise
      expect(result.width).toBe(1920)
      expect(result.codec).toBe('h264')
      expect(result.frameRate).toBe(30)
    })

    it('duration 使用 Math.round 取整', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [],
        format: { duration: 99.4 }
      })
      const result = await promise
      expect(result.duration).toBe(99)
    })

    it('duration 0.5 进位为 1', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [],
        format: { duration: 0.5 }
      })
      const result = await promise
      expect(result.duration).toBe(1)
    })

    it('duration 0.4 下舍为 0', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [],
        format: { duration: 0.4 }
      })
      const result = await promise
      expect(result.duration).toBe(0)
    })

    it('duration 为 0 时返回 undefined（0 是 falsy 走 else 分支）', async () => {
      // 源码：data.format.duration ? Math.round(...) : undefined
      // 0 是 falsy，因此返回 undefined（固化当前实现行为）
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [],
        format: { duration: 0 }
      })
      const result = await promise
      expect(result.duration).toBeUndefined()
    })

    it('format.duration 为 undefined 时返回 undefined', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [],
        format: {}
      })
      const result = await promise
      expect(result.duration).toBeUndefined()
    })

    it('format.duration 为 null 时返回 undefined', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [],
        format: { duration: null }
      })
      const result = await promise
      expect(result.duration).toBeUndefined()
    })

    it('format.duration 为负数时按 Math.round 处理', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [],
        format: { duration: -1.6 }
      })
      const result = await promise
      expect(result.duration).toBe(-2)
    })
  })

  describe('parseFrameRate（通过 r_frame_rate 间接测试）', () => {
    it('"30000/1001" 解析为约 29.97', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'video', r_frame_rate: '30000/1001' }],
        format: {}
      })
      const result = await promise
      expect(result.frameRate).toBeCloseTo(29.97, 1)
    })

    it('"30/1" 解析为 30', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'video', r_frame_rate: '30/1' }],
        format: {}
      })
      const result = await promise
      expect(result.frameRate).toBe(30)
    })

    it('"60/1" 解析为 60', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'video', r_frame_rate: '60/1' }],
        format: {}
      })
      const result = await promise
      expect(result.frameRate).toBe(60)
    })

    it('单个数字 "24" 解析为 24', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'video', r_frame_rate: '24' }],
        format: {}
      })
      const result = await promise
      expect(result.frameRate).toBe(24)
    })

    it('"0/0" 返回 undefined（分母为 0）', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'video', r_frame_rate: '0/0' }],
        format: {}
      })
      const result = await promise
      expect(result.frameRate).toBeUndefined()
    })

    it('非数字字符串 "N/A" 返回 undefined', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'video', r_frame_rate: 'N/A' }],
        format: {}
      })
      const result = await promise
      expect(result.frameRate).toBeUndefined()
    })

    it('r_frame_rate 为 undefined 时返回 undefined', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'video' }],
        format: {}
      })
      const result = await promise
      expect(result.frameRate).toBeUndefined()
    })

    it('r_frame_rate 为空字符串时返回 undefined', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'video', r_frame_rate: '' }],
        format: {}
      })
      const result = await promise
      expect(result.frameRate).toBeUndefined()
    })

    it('分子非数字 "abc/1" 返回 undefined', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'video', r_frame_rate: 'abc/1' }],
        format: {}
      })
      const result = await promise
      expect(result.frameRate).toBeUndefined()
    })

    it('分母非数字 "30/abc" 返回 undefined', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'video', r_frame_rate: '30/abc' }],
        format: {}
      })
      const result = await promise
      expect(result.frameRate).toBeUndefined()
    })

    it('分母为 0 "30/0" 返回 undefined', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'video', r_frame_rate: '30/0' }],
        format: {}
      })
      const result = await promise
      expect(result.frameRate).toBeUndefined()
    })

    it('三段式 "1/2/3" 走单数字解析返回 undefined', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'video', r_frame_rate: '1/2/3' }],
        format: {}
      })
      const result = await promise
      // split('/') length=3 不进入分数分支，Number('1/2/3')=NaN
      expect(result.frameRate).toBeUndefined()
    })

    it('负数帧率 "-30/1" 解析为 -30', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'video', r_frame_rate: '-30/1' }],
        format: {}
      })
      const result = await promise
      expect(result.frameRate).toBe(-30)
    })

    it('小数帧率 "29.97" 解析为 29.97', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'video', r_frame_rate: '29.97' }],
        format: {}
      })
      const result = await promise
      expect(result.frameRate).toBeCloseTo(29.97, 2)
    })

    it('codec_type 大小写敏感（仅匹配小写 video）', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'Video', width: 1920, height: 1080 }],
        format: {}
      })
      const result = await promise
      // 大写 Video 不匹配，返回 undefined
      expect(result.width).toBeUndefined()
      expect(result.codec).toBeUndefined()
    })

    it('视频流缺少 width/height/codec_name 时返回 undefined', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      mockCommand._invokeFfprobe(null, {
        streams: [{ codec_type: 'video' }],
        format: {}
      })
      const result = await promise
      expect(result.width).toBeUndefined()
      expect(result.height).toBeUndefined()
      expect(result.codec).toBeUndefined()
    })

    it('format 对象缺失时同步抛出 TypeError（源码未做可选链保护，固化当前行为）', async () => {
      // 源码：data.format.duration ? ... : undefined
      // data.format 为 undefined 时直接访问 .duration 同步抛 TypeError
      // Promise 内部回调同步抛错不会被 Promise 捕获，错误冒泡到调用方
      probeVideoMetadata('/video.mp4', 5000)
      expect(() =>
        mockCommand._invokeFfprobe(null, {
          streams: []
        })
      ).toThrow(TypeError)
    })

    it('ffprobe 回调错误对象 message 为空字符串时仍 reject', async () => {
      const promise = probeVideoMetadata('/video.mp4', 5000)
      const err = new Error('')
      mockCommand._invokeFfprobe(err, null)
      await expect(promise).rejects.toThrow('读取视频元数据失败 /video.mp4: ')
    })
  })
})
