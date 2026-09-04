/**
 * @layer L1
 * @module src/main/utils/ffmpeg-runner
 * @coverage runFfmpegCommand
 * @dependencies mock: fluent-ffmpeg, ./ffmpeg-paths, ./process-registry
 * @remarks 通过 EventEmitter 模拟 ffmpeg command 事件，验证注册/反注册/超时/事件清理
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

// 构造模拟 ffmpeg command（链式 API + EventEmitter）
function createMockCommand() {
  const ee = new EventEmitter()
  const command = {
    setFfmpegPath: vi.fn().mockReturnThis(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      ee.on(event, listener)
      return command
    }),
    run: vi.fn(),
    kill: vi.fn()
  }
  Object.defineProperty(command, '_emit', {
    value: (event: string, ...args: unknown[]): boolean => ee.emit(event, ...args),
    enumerable: false
  })
  return command as typeof command & {
    _emit: (event: string, ...args: unknown[]) => boolean
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

import { runFfmpegCommand } from './ffmpeg-runner'
import ffmpeg from 'fluent-ffmpeg'

// 将 ffmpeg 默认导出转为 vi.fn 类型便于断言
const ffmpegMock = ffmpeg as unknown as ReturnType<typeof vi.fn>

describe('ffmpeg-runner', () => {
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

  describe('runFfmpegCommand', () => {
    it('正常 end 事件触发 resolve', async () => {
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000)
      mockCommand._emit('end')
      await expect(promise).resolves.toBeUndefined()
    })

    it('调用 ffmpeg 工厂函数时传入 inputPath', async () => {
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000)
      mockCommand._emit('end')
      await promise
      expect(ffmpegMock).toHaveBeenCalledWith('/input.mp4')
    })

    it('调用 setFfmpegPath 设置二进制路径', async () => {
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000)
      mockCommand._emit('end')
      await promise
      expect(mockCommand.setFfmpegPath).toHaveBeenCalledWith('/fake/ffmpeg')
    })

    it('configure 回调接收 setFfmpegPath 后的 command 对象', async () => {
      const configure = vi.fn((cmd: unknown) => cmd)
      const promise = runFfmpegCommand('/input.mp4', configure, 5000)
      mockCommand._emit('end')
      await promise
      expect(configure).toHaveBeenCalledWith(mockCommand)
    })

    it('执行前调用 trackFfmpegCommand 注册', async () => {
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000)
      mockCommand._emit('end')
      await promise
      expect(trackFfmpegCommandMock).toHaveBeenCalledWith(mockCommand)
    })

    it('调用 command.run 启动执行', async () => {
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000)
      mockCommand._emit('end')
      await promise
      expect(mockCommand.run).toHaveBeenCalledTimes(1)
    })

    it('end 事件触发后调用 untrackFfmpegCommand', async () => {
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000)
      mockCommand._emit('end')
      await promise
      expect(untrackFfmpegCommandMock).toHaveBeenCalledWith(mockCommand)
    })

    it('error 事件触发 reject 并携带错误对象', async () => {
      const error = new Error('ffmpeg failed')
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000)
      mockCommand._emit('error', error)
      await expect(promise).rejects.toBe(error)
    })

    it('error 事件触发后调用 untrackFfmpegCommand', async () => {
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000)
      mockCommand._emit('error', new Error('fail'))
      try {
        await promise
      } catch {
        // 预期 reject
      }
      expect(untrackFfmpegCommandMock).toHaveBeenCalledWith(mockCommand)
    })

    it('超时后调用 kill SIGKILL', async () => {
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000)
      vi.advanceTimersByTime(5000)
      try {
        await promise
      } catch {
        // 预期 reject
      }
      expect(mockCommand.kill).toHaveBeenCalledWith('SIGKILL')
    })

    it('超时后调用 untrackFfmpegCommand', async () => {
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000)
      vi.advanceTimersByTime(5000)
      try {
        await promise
      } catch {
        // 预期 reject
      }
      expect(untrackFfmpegCommandMock).toHaveBeenCalledWith(mockCommand)
    })

    it('超时后 reject 使用默认操作名 ffmpeg', async () => {
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000)
      vi.advanceTimersByTime(5000)
      await expect(promise).rejects.toThrow('ffmpeg 执行超时 (5000ms)')
    })

    it('超时后 reject 使用自定义 operationName', async () => {
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000, 'livephoto')
      vi.advanceTimersByTime(5000)
      await expect(promise).rejects.toThrow('livephoto 执行超时 (5000ms)')
    })

    it('end 事件触发后清除超时定时器', async () => {
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000)
      mockCommand._emit('end')
      await promise
      vi.advanceTimersByTime(10000)
      expect(mockCommand.kill).not.toHaveBeenCalled()
    })

    it('error 事件触发后清除超时定时器', async () => {
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000)
      mockCommand._emit('error', new Error('fail'))
      try {
        await promise
      } catch {
        // 预期 reject
      }
      vi.advanceTimersByTime(10000)
      expect(mockCommand.kill).not.toHaveBeenCalled()
    })

    it('configure 返回不同对象时使用返回值进行事件绑定', async () => {
      const customCmd = createMockCommand()
      const configure = vi.fn(() => customCmd)
      const promise = runFfmpegCommand('/input.mp4', configure, 5000)
      expect(trackFfmpegCommandMock).toHaveBeenCalledWith(customCmd)
      customCmd._emit('end')
      await expect(promise).resolves.toBeUndefined()
      expect(untrackFfmpegCommandMock).toHaveBeenCalledWith(customCmd)
    })

    it('configure 返回不同对象时超时 kill 该对象', async () => {
      const customCmd = createMockCommand()
      const configure = vi.fn(() => customCmd)
      const promise = runFfmpegCommand('/input.mp4', configure, 5000, 'custom')
      vi.advanceTimersByTime(5000)
      try {
        await promise
      } catch {
        // 预期 reject
      }
      expect(customCmd.kill).toHaveBeenCalledWith('SIGKILL')
      expect(untrackFfmpegCommandMock).toHaveBeenCalledWith(customCmd)
    })

    it('未触发任何事件且未超时时 promise 保持 pending', async () => {
      let settled = false
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000)
      promise.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      // 让微任务队列执行
      await Promise.resolve()
      await Promise.resolve()
      expect(settled).toBe(false)
      // 清理：触发 end 避免悬挂 promise
      mockCommand._emit('end')
      await promise
    })

    it('end 与 error 同时触发时以先触发者为准（end 先）', async () => {
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 5000)
      mockCommand._emit('end')
      mockCommand._emit('error', new Error('late'))
      await expect(promise).resolves.toBeUndefined()
    })

    it('timeoutMs 为 0 时立即超时', async () => {
      const promise = runFfmpegCommand('/input.mp4', (cmd) => cmd, 0)
      // setTimeout(fn, 0) 在下一轮事件循环触发
      vi.advanceTimersByTime(0)
      await expect(promise).rejects.toThrow('ffmpeg 执行超时 (0ms)')
    })
  })
})
