/**
 * 解密网络解码子进程入口单元测试
 *
 * 测试目标：src/main/decryption-worker/worker-entry.ts
 * 测试层级：L2（mock koffi 与 process.parentPort，无真实 DLL / 子进程）
 *
 * Mock 策略：
 * - koffi：struct/pointer/load/decode 全 stub，mockFns 动态控制各 FFI 返回值
 * - process.parentPort：EventEmitter + postMessage vi.fn()（必须在模块 import 前就位，
 *   入口在模块顶层注册 message 监听）
 * - process.exit / process.on：spy 捕获，afterEach 恢复并移除入口注册的进程级监听
 *
 * 关键时序约束：
 * - initDll 在 INIT 时把 mockFns 中的 vi.fn 引用绑定进 boundFns，
 *   因此用例必须先配置 mockFns 再 initWorker()；绑定后只能原地 mutate 同一 mock
 * - withMutex 经微任务链串行回传，decodeRequest 内 flush 一个宏任务确保 RESULT 已发出
 *
 * 测试覆盖：INIT 握手（READY 时机/ABI 校验）、NETWORK_DECODE 成功/失败/异常映射、
 * 无效分享码 status、DISPOSE 与致命异常的退出码语义、请求串行。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { DecryptionWorkerCommand, DecryptionWorkerEvent } from './worker-protocol'

// ---- Mock koffi（同 decryption-service.test.ts 手法）----
const mockFns: Record<string, ReturnType<typeof vi.fn>> = {}
const { decodeFn } = vi.hoisted(() => ({
  decodeFn: vi.fn((_ptr: unknown, _type: string, _len: number) => [] as number[])
}))

vi.mock('koffi', () => {
  const structFn = vi.fn((name: string, _def: unknown) => ({ _structName: name }))
  const pointerFn = vi.fn((type: string) => ({ _pointerTo: type }))
  const loadFn = vi.fn((_dllPath: string) => ({
    func: vi.fn((fnName: string, _retType: unknown, _argTypes: unknown) => {
      if (!mockFns[fnName]) {
        mockFns[fnName] = vi.fn()
      }
      return mockFns[fnName]
    }),
    unload: vi.fn()
  }))
  return {
    default: {
      struct: structFn,
      pointer: pointerFn,
      load: loadFn,
      decode: decodeFn
    }
  }
})

// ---- 假 parentPort：必须在动态 import 入口模块前就位 ----
const portEmitter = new EventEmitter()
const portPostMessage = vi.fn()
;(process as unknown as { parentPort: unknown }).parentPort = {
  on: portEmitter.on.bind(portEmitter),
  postMessage: portPostMessage
}

type ProcessHandler = (...args: unknown[]) => void
let registeredHandlers: Array<{ event: string; handler: ProcessHandler }> = []
let exitSpy: ReturnType<typeof vi.spyOn>

function send(cmd: DecryptionWorkerCommand): void {
  portEmitter.emit('message', { data: cmd })
}

function sentEventsOfType(type: DecryptionWorkerEvent['type']): DecryptionWorkerEvent[] {
  return portPostMessage.mock.calls
    .map((c) => c[0] as DecryptionWorkerEvent)
    .filter((e) => e.type === type)
}

function lastResult():
  { requestId: string; status: number; networkData?: string; errorMessage?: string } | undefined {
  const results = sentEventsOfType('NETWORK_DECODE_RESULT') as Array<{
    payload: { requestId: string; status: number; networkData?: string; errorMessage?: string }
  }>
  return results.length ? results[results.length - 1].payload : undefined
}

/** 完成 INIT（默认 ABI=1），返回入口是否就绪。必须先配置好 mockFns 再调用 */
function initWorker(abi = 1): boolean {
  mockFns['abi_version'] = vi.fn().mockReturnValue(abi)
  send({ type: 'DECRYPT_WORKER_INIT', payload: { dllPath: '/fake/nuan5_decryption.dll' } })
  return sentEventsOfType('WORKER_READY').length === 1
}

async function decodeRequest(
  requestId: string,
  kind: 'clothDiy' | 'homeBuild',
  codeStr: string
): Promise<void> {
  send({ type: 'NETWORK_DECODE', payload: { requestId, kind, codeStr } })
  await new Promise((resolve) => setImmediate(resolve))
}

describe('decryption-worker worker-entry', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    for (const k of Object.keys(mockFns)) {
      delete mockFns[k]
    }
    registeredHandlers = []
    // 关键：resetModules 后重新 import 会再注册一个 message 监听，
    // 必须先清空旧实例的监听，否则同一条消息被多个模块实例处理（结果重复/状态错乱）
    portEmitter.removeAllListeners()

    // 捕获入口注册的进程级监听（uncaughtException 等），afterEach 移除避免泄漏
    const origOn = process.on.bind(process)
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: ProcessHandler) => {
      registeredHandlers.push({ event, handler })
      return origOn(event as never, handler as never)
    }) as never)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    vi.resetModules()
    await import('./worker-entry')
  })

  afterEach(() => {
    for (const { event, handler } of registeredHandlers) {
      process.removeListener(event as never, handler as never)
    }
    vi.restoreAllMocks()
  })

  // ============ INIT 握手 ============

  it('INIT 成功（ABI 匹配）后发送 WORKER_READY', () => {
    expect(initWorker(1)).toBe(true)
  })

  it('INIT 时 ABI 不匹配：发 WORKER_ERROR 并 exit(1)，不发 WORKER_READY', () => {
    initWorker(2)
    expect(sentEventsOfType('WORKER_READY')).toHaveLength(0)
    const errors = sentEventsOfType('WORKER_ERROR')
    expect(errors).toHaveLength(1)
    expect((errors[0] as { payload: { message: string } }).payload.message).toContain('ABI')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  // ============ NETWORK_DECODE ============
  // 时序：所有 mockFns 配置必须先于 initWorker()（见文件头"关键时序约束"）

  it('clothDiy 成功：返回 status=0 + utf8 networkData，且释放 C 内存', async () => {
    const fakeNet = '{"color":"red"}'
    mockFns['cloth_diy_share_code_from_code_str'] = vi.fn().mockReturnValue({})
    mockFns['cloth_diy_decode_network'] = vi.fn().mockReturnValue({
      status: 0,
      bytes: { data: {}, len: fakeNet.length, cap: fakeNet.length + 16 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    mockFns['free_cloth_diy_share_code'] = vi.fn()
    decodeFn.mockReturnValue(Array.from(Buffer.from(fakeNet)))
    expect(initWorker(1)).toBe(true)

    await decodeRequest('r1', 'clothDiy', 'valid_code')

    expect(lastResult()).toEqual({ requestId: 'r1', status: 0, networkData: fakeNet })
    expect(mockFns['free_c_bytes']).toHaveBeenCalled()
    expect(mockFns['free_cloth_diy_share_code']).toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('homeBuild 成功：返回 status=0 + networkData', async () => {
    mockFns['home_build_share_code_from_code_str'] = vi.fn().mockReturnValue({})
    mockFns['home_build_decode_network'] = vi.fn().mockReturnValue({
      status: 0,
      bytes: { data: {}, len: 2, cap: 16 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    mockFns['free_home_build_share_code'] = vi.fn()
    decodeFn.mockReturnValue(Array.from(Buffer.from('{}')))
    expect(initWorker(1)).toBe(true)

    await decodeRequest('r2', 'homeBuild', 'valid_code')

    expect(lastResult()).toEqual({ requestId: 'r2', status: 0, networkData: '{}' })
  })

  it('DLL status≠0 透传，不产生 networkData', async () => {
    mockFns['cloth_diy_share_code_from_code_str'] = vi.fn().mockReturnValue({})
    mockFns['cloth_diy_decode_network'] = vi.fn().mockReturnValue({
      status: 10,
      bytes: { data: null, len: 0, cap: 0 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    mockFns['free_cloth_diy_share_code'] = vi.fn()
    expect(initWorker(1)).toBe(true)

    await decodeRequest('r3', 'clothDiy', 'code')
    const r = lastResult()
    expect(r?.status).toBe(10)
    expect(r?.networkData).toBeUndefined()
  })

  it('无效分享码（from_code_str=null）：clothDiy 回 status=8，homeBuild 回 status=11', async () => {
    mockFns['cloth_diy_share_code_from_code_str'] = vi.fn().mockReturnValue(null)
    mockFns['home_build_share_code_from_code_str'] = vi.fn().mockReturnValue(null)
    expect(initWorker(1)).toBe(true)

    await decodeRequest('r4', 'clothDiy', 'bad')
    expect(lastResult()?.status).toBe(8)

    await decodeRequest('r5', 'homeBuild', 'bad')
    expect(lastResult()?.status).toBe(11)
  })

  it('FFI 抛异常：回 status=-1 + errorMessage，进程存活（不 exit）', async () => {
    mockFns['cloth_diy_share_code_from_code_str'] = vi.fn().mockReturnValue({})
    mockFns['cloth_diy_decode_network'] = vi.fn().mockImplementation(() => {
      throw new Error('ffi boom')
    })
    mockFns['free_cloth_diy_share_code'] = vi.fn()
    expect(initWorker(1)).toBe(true)

    await decodeRequest('r6', 'clothDiy', 'code')
    const r = lastResult()
    expect(r?.status).toBe(-1)
    expect(r?.errorMessage).toContain('ffi boom')
    expect(exitSpy).not.toHaveBeenCalled()

    // worker 存活：绑定已建立，只能原地 mutate 同一 mock，不能替换记录项
    mockFns['cloth_diy_decode_network']!.mockReturnValue({
      status: 0,
      bytes: { data: {}, len: 0, cap: 0 }
    })
    await decodeRequest('r7', 'clothDiy', 'code')
    expect(lastResult()?.requestId).toBe('r7')
  })

  it('未 INIT 就收到请求：回 status=-1 而非崩溃', async () => {
    await decodeRequest('r8', 'clothDiy', 'code')
    const r = lastResult()
    expect(r?.status).toBe(-1)
    expect(r?.errorMessage).toContain('DLL')
  })

  it('连发 3 个请求按到达顺序串行回传（mutex 不丢不乱）', async () => {
    mockFns['cloth_diy_share_code_from_code_str'] = vi.fn().mockReturnValue({})
    mockFns['home_build_share_code_from_code_str'] = vi.fn().mockReturnValue({})
    mockFns['cloth_diy_decode_network'] = vi.fn().mockReturnValue({
      status: 0,
      bytes: { data: {}, len: 0, cap: 0 }
    })
    mockFns['home_build_decode_network'] = vi.fn().mockReturnValue({
      status: 0,
      bytes: { data: {}, len: 0, cap: 0 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    mockFns['free_cloth_diy_share_code'] = vi.fn()
    mockFns['free_home_build_share_code'] = vi.fn()
    expect(initWorker(1)).toBe(true)

    await Promise.all([
      decodeRequest('a', 'clothDiy', 'c1'),
      decodeRequest('b', 'homeBuild', 'h1'),
      decodeRequest('c', 'clothDiy', 'c2')
    ])

    const ids = sentEventsOfType('NETWORK_DECODE_RESULT').map(
      (e) => (e as { payload: { requestId: string } }).payload.requestId
    )
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  // ============ 生命周期与致命异常 ============

  it('DISPOSE：exit(0)（正常退出码，bridge 不触发重启）', () => {
    expect(initWorker(1)).toBe(true)
    send({ type: 'DECRYPT_WORKER_DISPOSE' })
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('uncaughtException：发 WORKER_ERROR 后 exit(1)', () => {
    expect(initWorker(1)).toBe(true)
    const handler = registeredHandlers.find((h) => h.event === 'uncaughtException')?.handler
    expect(handler).toBeDefined()
    handler?.(new Error('unexpected'))
    const errors = sentEventsOfType('WORKER_ERROR')
    expect(errors).toHaveLength(1)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
