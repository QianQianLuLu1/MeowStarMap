/**
 * @layer L1
 * @module src/main/utils/process-registry
 * @coverage trackProcess/trackFfmpegCommand/untrackFfmpegCommand/killAllProcesses/getProcessRegistryStats
 * @dependencies none（使用 EventEmitter 模拟 ChildProcess）
 * @remarks 隔离 ChildProcess 类型依赖后的纯逻辑测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import {
  trackProcess,
  trackFfmpegCommand,
  untrackFfmpegCommand,
  killAllProcesses,
  getProcessRegistryStats
} from './process-registry'

// 构造模拟 ChildProcess 对象（具备 EventEmitter 接口 + killed + kill）
function createFakeChildProcess(killed = false): EventEmitter & {
  killed: boolean
  kill: ReturnType<typeof vi.fn>
  pid?: number
} {
  const child = new EventEmitter() as EventEmitter & {
    killed: boolean
    kill: ReturnType<typeof vi.fn>
    pid?: number
  }
  child.killed = killed
  child.kill = vi.fn()
  child.pid = Math.floor(Math.random() * 100000)
  return child
}

// 构造模拟 ffmpeg command（具备 on/kill）
function createFakeCommand(): {
  on: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => boolean
} {
  const ee = new EventEmitter()
  return {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      ee.on(event, listener)
      return ee
    }) as unknown as ReturnType<typeof vi.fn>,
    kill: vi.fn(),
    emit: (event: string, ...args: unknown[]) => ee.emit(event, ...args)
  }
}

describe('process-registry', () => {
  beforeEach(() => {
    // 每个用例前清空注册表
    killAllProcesses()
  })

  describe('getProcessRegistryStats', () => {
    it('初始状态返回 0/0', () => {
      const stats = getProcessRegistryStats()
      expect(stats).toEqual({ childProcessCount: 0, ffmpegCommandCount: 0 })
    })

    it('注册 ChildProcess 后计数 +1', () => {
      const child = createFakeChildProcess()
      trackProcess(child)
      expect(getProcessRegistryStats().childProcessCount).toBe(1)
    })

    it('注册 ffmpeg command 后 ffmpegCommandCount +1', () => {
      const cmd = createFakeCommand()
      trackFfmpegCommand(cmd as never)
      expect(getProcessRegistryStats().ffmpegCommandCount).toBe(1)
    })
  })

  describe('trackProcess', () => {
    it('返回原 ChildProcess 对象便于链式调用', () => {
      const child = createFakeChildProcess()
      const returned = trackProcess(child)
      expect(returned).toBe(child)
    })

    it('触发 close 事件后从注册表移除', () => {
      const child = createFakeChildProcess()
      trackProcess(child)
      expect(getProcessRegistryStats().childProcessCount).toBe(1)
      child.emit('close')
      expect(getProcessRegistryStats().childProcessCount).toBe(0)
    })

    it('触发 exit 事件后从注册表移除', () => {
      const child = createFakeChildProcess()
      trackProcess(child)
      child.emit('exit')
      expect(getProcessRegistryStats().childProcessCount).toBe(0)
    })

    it('触发 error 事件后从注册表移除', () => {
      const child = createFakeChildProcess()
      trackProcess(child)
      child.emit('error', new Error('child error'))
      expect(getProcessRegistryStats().childProcessCount).toBe(0)
    })

    it('多个事件触发不会重复删除（幂等）', () => {
      const child = createFakeChildProcess()
      trackProcess(child)
      child.emit('close')
      child.emit('exit')
      child.emit('error', new Error('late'))
      expect(getProcessRegistryStats().childProcessCount).toBe(0)
    })

    it('可注册多个 ChildProcess', () => {
      const c1 = createFakeChildProcess()
      const c2 = createFakeChildProcess()
      const c3 = createFakeChildProcess()
      trackProcess(c1)
      trackProcess(c2)
      trackProcess(c3)
      expect(getProcessRegistryStats().childProcessCount).toBe(3)
    })
  })

  describe('trackFfmpegCommand', () => {
    it('返回原 command 对象便于链式调用', () => {
      const cmd = createFakeCommand()
      const returned = trackFfmpegCommand(cmd as never)
      expect(returned).toBe(cmd)
    })

    it('触发 end 事件后从注册表移除', () => {
      const cmd = createFakeCommand()
      trackFfmpegCommand(cmd as never)
      expect(getProcessRegistryStats().ffmpegCommandCount).toBe(1)
      cmd.emit('end')
      expect(getProcessRegistryStats().ffmpegCommandCount).toBe(0)
    })

    it('触发 error 事件后从注册表移除', () => {
      const cmd = createFakeCommand()
      trackFfmpegCommand(cmd as never)
      cmd.emit('error', new Error('ffmpeg error'))
      expect(getProcessRegistryStats().ffmpegCommandCount).toBe(0)
    })

    it('可注册多个 command', () => {
      const c1 = createFakeCommand()
      const c2 = createFakeCommand()
      trackFfmpegCommand(c1 as never)
      trackFfmpegCommand(c2 as never)
      expect(getProcessRegistryStats().ffmpegCommandCount).toBe(2)
    })

    it('自动绑定 end 与 error 事件（on 被调用 2 次）', () => {
      const cmd = createFakeCommand()
      trackFfmpegCommand(cmd as never)
      expect(cmd.on).toHaveBeenCalledWith('end', expect.any(Function))
      expect(cmd.on).toHaveBeenCalledWith('error', expect.any(Function))
    })
  })

  describe('untrackFfmpegCommand', () => {
    it('手动移除已注册的 command', () => {
      const cmd = createFakeCommand()
      trackFfmpegCommand(cmd as never)
      expect(getProcessRegistryStats().ffmpegCommandCount).toBe(1)
      untrackFfmpegCommand(cmd as never)
      expect(getProcessRegistryStats().ffmpegCommandCount).toBe(0)
    })

    it('移除未注册的 command 不抛错（幂等）', () => {
      const cmd = createFakeCommand()
      expect(() => untrackFfmpegCommand(cmd as never)).not.toThrow()
    })
  })

  describe('killAllProcesses', () => {
    it('kill 所有已注册的 ChildProcess', () => {
      const c1 = createFakeChildProcess()
      const c2 = createFakeChildProcess()
      trackProcess(c1)
      trackProcess(c2)
      killAllProcesses()
      expect(c1.kill).toHaveBeenCalledTimes(1)
      expect(c2.kill).toHaveBeenCalledTimes(1)
    })

    it('kill 所有已注册的 ffmpeg command', () => {
      const c1 = createFakeCommand()
      const c2 = createFakeCommand()
      trackFfmpegCommand(c1 as never)
      trackFfmpegCommand(c2 as never)
      killAllProcesses()
      expect(c1.kill).toHaveBeenCalledTimes(1)
      expect(c2.kill).toHaveBeenCalledTimes(1)
    })

    it('默认信号为 SIGKILL', () => {
      const child = createFakeChildProcess()
      trackProcess(child)
      killAllProcesses()
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    })

    it('自定义信号生效', () => {
      const child = createFakeChildProcess()
      trackProcess(child)
      killAllProcesses('SIGTERM')
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    })

    it('已被 killed 的 ChildProcess 不再 kill', () => {
      const child = createFakeChildProcess(true)
      trackProcess(child)
      killAllProcesses()
      expect(child.kill).not.toHaveBeenCalled()
    })

    it('kill 抛错时静默处理不影响其他进程', () => {
      const c1 = createFakeChildProcess()
      const c2 = createFakeChildProcess()
      c1.kill = vi.fn(() => {
        throw new Error('kill fail')
      })
      trackProcess(c1)
      trackProcess(c2)
      expect(() => killAllProcesses()).not.toThrow()
      expect(c2.kill).toHaveBeenCalledTimes(1)
    })

    it('command kill 抛错时静默处理', () => {
      const cmd = createFakeCommand()
      cmd.kill = vi.fn(() => {
        throw new Error('cmd kill fail')
      })
      trackFfmpegCommand(cmd as never)
      expect(() => killAllProcesses()).not.toThrow()
    })

    it('调用后注册表清空', () => {
      const child = createFakeChildProcess()
      const cmd = createFakeCommand()
      trackProcess(child)
      trackFfmpegCommand(cmd as never)
      killAllProcesses()
      const stats = getProcessRegistryStats()
      expect(stats.childProcessCount).toBe(0)
      expect(stats.ffmpegCommandCount).toBe(0)
    })

    it('空注册表调用不抛错', () => {
      expect(() => killAllProcesses()).not.toThrow()
    })

    it('重复调用安全（幂等）', () => {
      const child = createFakeChildProcess()
      trackProcess(child)
      killAllProcesses()
      killAllProcesses()
      // 第二次调用不会再次 kill（已被清空）
      expect(child.kill).toHaveBeenCalledTimes(1)
    })
  })
})
