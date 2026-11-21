/**
 * N3（2026-11-20 视图闪屏软件渲染自动降级计划）：心跳看门狗睡眠/唤醒宽限。
 *
 * 缺陷：看门狗用 Date.now() 墙钟判父进程死亡（>15s 无 ping 即 abortScan + exit）；
 * 笔记本睡眠/唤醒墙钟跳变必触发误判，误杀正在进行的扫描（故障机 2026-11-19
 * 03:10 heartbeatTimeout 实证，父进程实际存活——bridge 每 5s 无条件 ping）。
 * 契约：超时先进入嫌疑宽限（HEARTBEAT_GRACE_MS，期间绝不 abort/exit）；
 * 任何父消息都是父存活证明、刷新时间戳续命；宽限耗尽才走原退出链
 * （父真死：退出延迟但必达，孤儿写库防护语义保留）。
 *
 * 工装：parentPort 桩必须先于 import worker-entry 安装（消息处理器与看门狗
 * 都是模块顶层副作用）；fake timers + setSystemTime 模拟墙钟跳变；
 * 每用例 vi.resetModules 取新看门狗实例。不开扫描、不触 better-sqlite3。
 *
 * 运行：npx vitest run src/main/scanner/__tests__/worker-heartbeat-sleep.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  installParentPortStub,
  uninstallParentPortStub,
  type ParentPortStubHandle
} from '../../../../tests/mocks/parent-port'

const BASE = new Date('2026-11-19T00:00:00Z').getTime()
const SLEEP_JUMP_MS = 8 * 3600_000

let port: ParentPortStubHandle
let exitSpy: ReturnType<typeof vi.spyOn>

async function loadWorker(): Promise<void> {
  vi.resetModules()
  await import('../worker-entry')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE)
  port = installParentPortStub()
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
})

afterEach(() => {
  exitSpy.mockRestore()
  uninstallParentPortStub()
  vi.useRealTimers()
  vi.resetModules()
})

describe('心跳看门狗睡眠宽限（N3）', () => {
  it('核心：墙钟 +8h 跳变（睡眠唤醒）后首个 tick 不得退出、不得中止扫描；ping 到达后续命', async () => {
    await loadWorker()
    vi.setSystemTime(BASE + SLEEP_JUMP_MS)
    vi.advanceTimersByTime(5000)
    expect(exitSpy).not.toHaveBeenCalled()
    // 嫌疑期看门狗不得 abortScan（误杀扫描正是本事故的伤害面）
    const { isScanAborted } = await import('../scan-abort')
    expect(isScanAborted()).toBe(false)
    // resume 后父进程 ping ≤5s 到达 → 续命（10s < 15s 超时窗，单次 ping 的合法存活期）
    port.emitMessage({ type: 'WORKER_PING' })
    vi.advanceTimersByTime(10000)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('守卫：父真死（无任何消息）→ 嫌疑 + 宽限耗尽后 exit 恰一次（延迟但必退出）', async () => {
    await loadWorker()
    vi.setSystemTime(BASE + SLEEP_JUMP_MS)
    vi.advanceTimersByTime(5000)
    vi.advanceTimersByTime(10000)
    expect(exitSpy).toHaveBeenCalledTimes(1)
  })

  it('任意父消息续命：嫌疑期收到 SCAN_STOP 后不得退出', async () => {
    await loadWorker()
    vi.setSystemTime(BASE + SLEEP_JUMP_MS)
    vi.advanceTimersByTime(5000)
    port.emitMessage({ type: 'SCAN_STOP' })
    vi.advanceTimersByTime(10000)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('边界：首个 tick 前 ping 已到达（跳变被消息吸收）→ 不退出', async () => {
    await loadWorker()
    vi.setSystemTime(BASE + SLEEP_JUMP_MS)
    port.emitMessage({ type: 'WORKER_PING' })
    vi.advanceTimersByTime(10000)
    expect(exitSpy).not.toHaveBeenCalled()
  })
})
