/**
 * @layer L3
 * @module src/renderer/utils/preview-worker-bridge
 * @coverage 预览 worker 的握手、超时、崩溃回落与终止
 * @dependencies 无（Worker 由调用环境提供，测试内注入桩）
 * @remarks
 * B0 可行性闸门（docs/plans/2026-10-18-fix-editor-preview-realtime.md）：
 * worker 不可用时必须**静默回落**主线程，预览功能不得因此变差。
 * jsdom 不提供 Worker，因此每个用例自行注入桩；环境无 Worker 时必须得到 null。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  PREVIEW_WORKER_READY_TIMEOUT_MS,
  createPreviewWorkerBridge,
  openPreviewWorker
} from './preview-worker-bridge'

/** 可控的 Worker 桩：记录构造参数，暴露 emit/emitError 让用例驱动握手 */
function installWorkerStub() {
  const constructed: { url: string | undefined; options: unknown }[] = []
  const instances: StubWorker[] = []

  class StubWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: ((event: { message?: string }) => void) | null = null
    terminated = false
    postMessage = vi.fn()
    terminate = vi.fn(() => {
      this.terminated = true
    })

    constructor(url: string | undefined, options?: unknown) {
      constructed.push({ url: url === undefined ? undefined : String(url), options })
      instances.push(this)
    }

    emit(data: unknown): void {
      this.onmessage?.({ data })
    }

    emitError(message = 'boom'): void {
      this.onerror?.({ message })
    }
  }

  vi.stubGlobal('Worker', StubWorker)
  return {
    constructed,
    get last(): StubWorker {
      const latest = instances[instances.length - 1]
      if (!latest) throw new Error('Worker 未被构造')
      return latest
    }
  }
}

describe('createPreviewWorkerBridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('收到 READY 后返回可用 bridge（正常）', async () => {
    const stub = installWorkerStub()
    const bridge = createPreviewWorkerBridge(() => new Worker('./preview-worker.js'))
    stub.last.emit({ type: 'READY' })
    const handle = await bridge

    expect(handle).not.toBeNull()
    expect(handle?.worker).toBe(stub.last as unknown as Worker)
    handle?.terminate()
    expect(stub.last.terminated).toBe(true)
  })

  it('环境无 Worker 时静默返回 null，不抛错（异常：回落主线程）', async () => {
    vi.stubGlobal('Worker', undefined)
    await expect(
      createPreviewWorkerBridge(() => new Worker('./preview-worker.js'))
    ).resolves.toBeNull()
  })

  it('握手期 onerror 触发时返回 null 并已 terminate（异常：脚本 404 / CSP 拒绝）', async () => {
    const stub = installWorkerStub()
    const pending = createPreviewWorkerBridge(() => new Worker('./preview-worker.js'))
    stub.last.emitError('blocked by CSP')
    await expect(pending).resolves.toBeNull()
    expect(stub.last.terminated).toBe(true)
  })

  it('READY 超时返回 null 并 terminate（边界：卡死的 worker）', async () => {
    vi.useFakeTimers()
    const stub = installWorkerStub()
    const pending = createPreviewWorkerBridge(() => new Worker('./preview-worker.js'))
    await vi.advanceTimersByTimeAsync(PREVIEW_WORKER_READY_TIMEOUT_MS + 10)
    await expect(pending).resolves.toBeNull()
    expect(stub.last.terminated).toBe(true)
  })

  it('READY 之后的错误不回收 handle，交由调用方决定重启（边界）', async () => {
    const stub = installWorkerStub()
    const bridge = createPreviewWorkerBridge(() => new Worker('./preview-worker.js'))
    stub.last.emit({ type: 'READY' })
    const handle = await bridge
    expect(handle).not.toBeNull()

    let crashed = false
    handle?.attachErrorWatcher(() => {
      crashed = true
    })
    stub.last.emitError('runtime crash')
    expect(crashed).toBe(true)
  })

  it('非法握手消息不得误判为就绪（边界：伪造/畸形 data）', async () => {
    // 必须先装假定时器再建 bridge：否则 READY 超时用的是真实定时器，
    // 后面的 advanceTimersByTimeAsync 推不动它，用例会拖到真实 3s 才结束
    vi.useFakeTimers()
    const stub = installWorkerStub()
    const pending = createPreviewWorkerBridge(() => new Worker('./preview-worker.js'))
    stub.last.emit(null)
    stub.last.emit({ type: 123 })
    stub.last.emit('READY')
    await vi.advanceTimersByTimeAsync(PREVIEW_WORKER_READY_TIMEOUT_MS + 10)
    await expect(pending).resolves.toBeNull()
  })

  /**
   * B0 踩过的坑（必须常驻守护）：`new URL(...)` 一旦被提成变量或经参数传入，
   * Vite 就不再把它当 worker，而是按普通资源处理——`.ts` 会被识别成
   * `data:video/mp2t;base64,…` 内联进去，既没有 worker chunk 也起不来。
   * 这里断言 openPreviewWorker 交出去的是真实脚本 URL 而非 data URL。
   */
  it('openPreviewWorker 以脚本 URL 构造 worker，不得退化为 data URL', async () => {
    const stub = installWorkerStub()
    const bridge = openPreviewWorker()
    stub.last.emit({ type: 'READY' })
    const handle = await bridge

    expect(handle).not.toBeNull()
    expect(stub.constructed).toHaveLength(1)
    const url = stub.constructed[0]?.url as string
    expect(url.startsWith('data:')).toBe(false)
    expect(url.endsWith('preview-worker.ts')).toBe(true)
    handle?.terminate()
  })
})
