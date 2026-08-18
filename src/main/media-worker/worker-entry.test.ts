/**
 * @layer L3
 * @module src/main/media-worker/worker-entry
 * @coverage withFileTimeout（单文件处理超时兜底）
 *
 * 覆盖三条路径：
 * 1. 正常完成 → 返回原结果，不产生日志
 * 2. 内部任务超时（fake timers 推进）→ 返回 null 并记 MEDIA_WORKER_LOG warn
 * 3. 内部任务 reject → 返回 null 并记 warn（不向上抛）
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { withFileTimeout } from './worker-entry'

// worker 内部日志经 process.parentPort.postMessage 转发到主进程；
// 测试环境无 parentPort，这里注入一个可控的 postMessage 供断言。
function mockParentPort(): ReturnType<typeof vi.fn> {
  const postMessage = vi.fn()
  Object.defineProperty(process, 'parentPort', {
    value: { postMessage },
    configurable: true
  })
  return postMessage
}

afterEach(() => {
  vi.useRealTimers()
})

describe('withFileTimeout', () => {
  it('正常完成 → 返回原结果', async () => {
    const postMessage = mockParentPort()

    const result = await withFileTimeout(async () => 42, 1000, '/ok.jpg', 'Thumbnail')

    expect(result).toBe(42)
    // workerLog 仅转发 warn/error；正常完成不产生日志
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('内部任务超时 → 返回 null 并记 MEDIA_WORKER_LOG warn（含"单文件处理超时"）', async () => {
    vi.useFakeTimers()
    const postMessage = mockParentPort()

    const p = withFileTimeout(
      // 永久挂起的重活（模拟 sharp/ffmpeg 无取消 API 卡死）
      async () => new Promise(() => {}),
      1000,
      '/hang.jpg',
      'Thumbnail'
    )
    await vi.advanceTimersByTimeAsync(1000)
    await expect(p).resolves.toBeNull()

    const event = postMessage.mock.calls[0]?.[0] as {
      type: string
      payload: { level: string; message: string }
    }
    expect(event.type).toBe('MEDIA_WORKER_LOG')
    expect(event.payload.level).toBe('warn')
    expect(event.payload.message).toContain('单文件处理超时')
  })

  it('内部任务 reject → 返回 null 并记 warn（不向上抛）', async () => {
    const postMessage = mockParentPort()

    const result = await withFileTimeout(
      async () => {
        throw new Error('boom')
      },
      1000,
      '/bad.jpg',
      'pHash'
    )

    expect(result).toBeNull()
    const event = postMessage.mock.calls[0]?.[0] as {
      type: string
      payload: { level: string; message: string }
    }
    expect(event.type).toBe('MEDIA_WORKER_LOG')
    expect(event.payload.level).toBe('warn')
    expect(event.payload.message).toContain('单文件处理失败')
  })
})

// ============ FIX(组11-2): 致命错误退出码 ============
describe('致命错误退出码（组11-2）', () => {
  it('uncaughtException 处理器先发 WORKER_ERROR 再以非零码退出（触发 bridge 崩溃重启）', () => {
    const postMessage = mockParentPort()
    // 桩掉 process.exit：cleanupAndExit 会真的退出测试进程
    const realExit = process.exit
    const exitMock = vi.fn()
    process.exit = exitMock as unknown as typeof process.exit
    try {
      // 直接调用 worker-entry 注册的监听器（import 后为最后一个），
      // 绕过 process.emit 以免同时触发 vitest 自身的 uncaughtException 处理
      const listeners = process.listeners('uncaughtException') as ((err: Error) => void)[]
      const workerHandler = listeners[listeners.length - 1]
      expect(workerHandler).toBeTruthy()
      workerHandler(new Error('sharp native crash'))

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'WORKER_ERROR',
          payload: expect.objectContaining({ message: 'sharp native crash' })
        })
      )
      // 原实现固定 exit(0)，bridge 的 isCrash（code !== 0）判定恒为 false，
      // 自动重启与崩溃通知永不触发；修复后致命路径以 1 退出
      expect(exitMock).toHaveBeenCalledWith(1)
    } finally {
      process.exit = realExit
    }
  })
})
