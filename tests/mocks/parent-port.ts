/**
 * 共享测试工具：process.parentPort 可控桩（成对 install / uninstall）
 *
 * 背景：utilityProcess worker 内通过 process.parentPort.postMessage 向主进程发消息、
 * 通过 parentPort.on('message', ...) 接收指令（见 src/main/media-worker/worker-entry.test.ts
 * 与 src/main/scanner/__tests__/scan-batch-write-failure.test.ts 的桩法）。
 * 测试环境（Node/vitest）无 parentPort，本工具用 Object.defineProperty 注入可控桩。
 *
 * 用法：
 * ```ts
 * let port: ParentPortStubHandle
 * beforeAll(() => {
 *   port = installParentPortStub()
 *   // 此时再 import worker-entry（模块加载期会注册 message 处理器）
 * })
 * afterAll(() => {
 *   uninstallParentPortStub()
 * })
 *
 * port.emitMessage({ type: 'SCAN_START', payload })   // 手动触发 message 事件
 * expect(port.messages).toContainEqual(...)            // 断言 postMessage 发出的消息
 * ```
 */
import { vi } from 'vitest'
import type { MockFn } from './logger'

/** worker message 事件回调签名 */
export type ParentPortMessageHandler = (event: { data: unknown }) => void

interface ActiveStubState {
  /** 安装前 process 上是否已存在 parentPort 属性 */
  existed: boolean
  /** 安装前的原值（可能为 undefined） */
  original: unknown
}

let activeState: ActiveStubState | null = null

/** installParentPortStub 返回的可断言句柄 */
export interface ParentPortStubHandle {
  /** 注入到 process.parentPort 的桩对象本体（postMessage / on 均为 vi.fn） */
  stub: { postMessage: MockFn; on: MockFn }
  /** postMessage 发出的全部消息（按调用顺序收集） */
  messages: unknown[]
  /** on('message', cb) 注册的回调列表（收集以便测试手动触发） */
  messageHandlers: ParentPortMessageHandler[]
  /** 手动触发 message 事件：以 { data } 调用全部已注册回调 */
  emitMessage: (data: unknown) => void
}

/**
 * 安装 process.parentPort 桩。重复安装（未先 uninstall）会抛错，避免原值丢失。
 * 必须在被测 worker 模块 import 之前调用（模块加载期即注册 message 处理器）。
 */
export function installParentPortStub(): ParentPortStubHandle {
  if (activeState) {
    throw new Error('parentPort 桩已安装，请先调用 uninstallParentPortStub()')
  }
  const proc = process as unknown as { parentPort?: unknown }
  activeState = { existed: 'parentPort' in proc, original: proc.parentPort }

  const messages: unknown[] = []
  const messageHandlers: ParentPortMessageHandler[] = []
  const postMessage = vi.fn((message: unknown) => {
    messages.push(message)
  })
  const on = vi.fn((type: string, handler: ParentPortMessageHandler) => {
    if (type === 'message') messageHandlers.push(handler)
  })
  const stub = { postMessage, on }

  Object.defineProperty(process, 'parentPort', {
    value: stub,
    configurable: true,
    writable: true
  })

  return {
    stub,
    messages,
    messageHandlers,
    emitMessage: (data: unknown) => {
      const event = { data }
      // 复制一份：回调内部可能注销/重注册 handler，避免迭代中数组变化
      for (const handler of [...messageHandlers]) handler(event)
    }
  }
}

/**
 * 卸载桩并还原：安装前存在该属性则还原原值，否则删除属性（原值可能为 undefined）。
 * 未安装时静默返回（afterAll 里可无条件调用）。
 */
export function uninstallParentPortStub(): void {
  if (!activeState) return
  if (activeState.existed) {
    Object.defineProperty(process, 'parentPort', {
      value: activeState.original,
      configurable: true,
      writable: true
    })
  } else {
    delete (process as { parentPort?: unknown }).parentPort
  }
  activeState = null
}
