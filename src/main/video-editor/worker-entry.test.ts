/**
 * FIX(组16-2) 回归测试：EDIT_STOP 立即终止进行中的 ffmpeg + 跳过已取消批次的排队任务。
 *
 * 原实现 EDIT_STOP 仅置 shouldStop 标志：当前编码完整执行（超时上限 10 分钟）后才被
 * 当作部分输出清理；且 handleEditStart 开头无条件 shouldStop=false，批量取消时消息
 * 队列中已排队的任务仍被完整执行。
 *
 * Mock 策略：fs/promises、ffmpeg-runner、process-registry 桩替换；parentPort 在
 * 动态 import 前注入（worker-entry 在模块顶层注册 message 监听）。
 *
 * 运行：npx vitest run src/main/video-editor/worker-entry.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const { mockRunFfmpegCommand, portMock, messageHandlers } = vi.hoisted(() => ({
  // ffmpeg 桩：默认实现由各用例注入
  mockRunFfmpegCommand: vi.fn(),
  portMock: {
    postMessage: vi.fn()
  },
  messageHandlers: new Map<string, (event: { data: unknown }) => void>()
}))

vi.mock('fs/promises', () => ({
  default: { mkdir: vi.fn(async () => {}), unlink: vi.fn(async () => {}) }
}))

vi.mock('../utils/ffmpeg-runner', () => ({
  runFfmpegCommand: (...args: unknown[]) => mockRunFfmpegCommand(...args)
}))

vi.mock('../utils/process-registry', () => ({
  killAllProcesses: vi.fn()
}))

/** 向 worker 注入一条主进程指令 */
function sendCommand(msg: unknown): void {
  const handler = messageHandlers.get('message')
  if (!handler) throw new Error('worker 未注册 message 监听')
  handler({ data: msg })
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function editStartMessage(taskId: string, index: number) {
  return {
    type: 'EDIT_START' as const,
    payload: {
      task: { inputPath: '/in/a.mp4', outputPath: `/out/${index}.mp4`, params: {} },
      taskId,
      index,
      total: 2
    }
  }
}

/** 收集 worker 发出的指定类型事件 */
function eventsOfType(type: string): Array<{ payload: Record<string, unknown> }> {
  return portMock.postMessage.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type)
}

beforeAll(async () => {
  portMock.on = ((event: string, handler: (e: { data: unknown }) => void) => {
    messageHandlers.set(event, handler)
  }) as unknown as typeof portMock.on
  Object.defineProperty(process, 'parentPort', {
    value: portMock,
    configurable: true
  })
  // 动态 import：确保 parentPort 注入先于模块顶层的监听注册
  await import('./worker-entry')
})

beforeEach(() => {
  mockRunFfmpegCommand.mockReset()
  portMock.postMessage.mockClear()
})

describe('EDIT_STOP 取消语义（组16-2）', () => {
  it('取消立即 kill 进行中的 ffmpeg，编码被中断后按取消上报失败', async () => {
    // ffmpeg 挂起等待 kill：onStarted 上报句柄，promise 由用例手动 reject 模拟被 kill
    let rejectRun: ((err: Error) => void) | null = null
    const kill = vi.fn()
    mockRunFfmpegCommand.mockImplementation(
      (_input, _configure, _timeout, _name, onStarted?: (cmd: { kill: typeof kill }) => void) => {
        onStarted?.({ kill })
        return new Promise<void>((_, reject) => {
          rejectRun = reject
        })
      }
    )

    sendCommand(editStartMessage('cancel-running', 0))
    await tick()
    expect(mockRunFfmpegCommand).toHaveBeenCalledTimes(1)

    sendCommand({ type: 'EDIT_STOP' })
    expect(kill).toHaveBeenCalledWith('SIGKILL')

    // 模拟 kill 触发 ffmpeg error → runFfmpegCommand reject → 取消清理路径
    rejectRun?.(new Error('ffmpeg was killed'))
    await vi.waitFor(() => {
      expect(eventsOfType('EDIT_COMPLETE')).toHaveLength(1)
    })
    const complete = eventsOfType('EDIT_COMPLETE')[0]
    expect(complete.payload.success).toBe(false)
    expect(String(complete.payload.message)).toContain('任务已取消')
  })

  it('批量取消后，消息队列中同批次排队任务被跳过，不再启动 ffmpeg', async () => {
    let rejectRun: ((err: Error) => void) | null = null
    mockRunFfmpegCommand.mockImplementation(
      (_input, _configure, _timeout, _name, onStarted?: (cmd: { kill: () => void }) => void) => {
        onStarted?.({ kill: vi.fn() })
        return new Promise<void>((_, reject) => {
          rejectRun = reject
        })
      }
    )

    // 第 1 条开始执行，第 2 条进入消息队列排队
    sendCommand(editStartMessage('cancel-batch', 0))
    await tick()
    sendCommand(editStartMessage('cancel-batch', 1))
    sendCommand({ type: 'EDIT_STOP' })
    expect(mockRunFfmpegCommand).toHaveBeenCalledTimes(1)

    // 第 1 条被 kill 中断后，排队的第 2 条应直接按取消上报而非再次启动编码
    rejectRun?.(new Error('ffmpeg was killed'))
    await vi.waitFor(() => {
      expect(eventsOfType('EDIT_COMPLETE')).toHaveLength(2)
    })
    expect(mockRunFfmpegCommand).toHaveBeenCalledTimes(1)

    const queued = eventsOfType('EDIT_COMPLETE').find((e) => e.payload.index === 1) as unknown as {
      payload: { success: boolean; message: string }
    }
    expect(queued.payload.success).toBe(false)
    expect(queued.payload.message).toContain('批量取消后跳过排队任务')
  })
})
