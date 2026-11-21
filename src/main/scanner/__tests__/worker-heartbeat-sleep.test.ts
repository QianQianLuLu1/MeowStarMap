/**
 * N3（2026-11-20 视图闪屏软件渲染自动降级计划）：心跳看门狗睡眠/唤醒宽限。
 *
 * 2026-11-21 审查修复轮：静默/嫌疑/宽限度量由墙钟（Date.now()）切单调钟
 * （performance.now()）。残余缺陷：宽限窗本身仍用墙钟度量，嫌疑期内二次睡眠
 * （或 NTP 阶跃）会把宽限窗瞬间耗尽误杀扫描——单调钟睡眠期不走，墙钟跳变
 * 从根上退出全部度量面；宽限机制保留为第二道防线。
 *
 * 缺陷史：看门狗最初用 Date.now() 墙钟判父进程死亡（>15s 无 ping 即 abortScan +
 * exit），笔记本睡眠/唤醒墙钟跳变必触发误判，误杀正在进行的扫描（故障机
 * 2026-11-19 03:10 heartbeatTimeout 实证，父进程实际存活——bridge 每 5s 无条件 ping）。
 * 契约：静默/嫌疑/宽限全部以单调钟度量；超时先进入嫌疑宽限（HEARTBEAT_GRACE_MS，
 * 期间绝不 abort/exit）；任何父消息都是父存活证明、刷新时间戳续命；宽限耗尽才走
 * 原退出链（父真死：退出延迟但必达，孤儿写库防护语义保留）。
 *
 * 工装：parentPort 桩必须先于 import worker-entry 安装（消息处理器与看门狗
 * 都是模块顶层副作用）；fake timers 驱动 setInterval，performance.now 用 spy 手工
 * 驱动单调钟——tickMono 让墙钟与单调钟同步步进（唤醒态正常流逝），sleepJump 只推
 * 墙钟不推单调钟（系统睡眠）；每用例 vi.resetModules 取新看门狗实例。
 * 不开扫描、不触 better-sqlite3。
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
let monoSpy: ReturnType<typeof vi.spyOn>
let wallNow = BASE
let sleepOffsetMs = 0

/** 计时器与单调钟同步步进：模拟唤醒态的正常时间流逝（墙钟、单调钟同速） */
function tickMono(ms: number): void {
  wallNow += ms
  vi.advanceTimersByTime(ms)
}

/** 只推墙钟不推单调钟：模拟系统睡眠（单调钟睡眠期不走，唤醒后墙钟跳变） */
function sleepJump(ms: number): void {
  wallNow += ms
  sleepOffsetMs += ms
  vi.setSystemTime(wallNow)
}

async function loadWorker(): Promise<void> {
  vi.resetModules()
  await import('../worker-entry')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE)
  wallNow = BASE
  sleepOffsetMs = 0
  // 单调钟 = 模拟墙钟经过量 − 累计睡眠偏移：随计时器逐 tick 增长、睡眠期冻结
  monoSpy = vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - BASE - sleepOffsetMs)
  port = installParentPortStub()
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
})

afterEach(() => {
  exitSpy.mockRestore()
  monoSpy.mockRestore()
  uninstallParentPortStub()
  vi.useRealTimers()
  vi.resetModules()
})

describe('心跳看门狗睡眠宽限（N3 + 单调钟修复轮）', () => {
  it('核心：墙钟 +8h 跳变（睡眠唤醒）后首个 tick 不得退出、不得中止扫描；ping 到达后续命', async () => {
    await loadWorker()
    sleepJump(SLEEP_JUMP_MS)
    tickMono(5000)
    expect(exitSpy).not.toHaveBeenCalled()
    // 嫌疑期看门狗不得 abortScan（误杀扫描正是本事故的伤害面）
    const { isScanAborted } = await import('../scan-abort')
    expect(isScanAborted()).toBe(false)
    // resume 后父进程 ping ≤5s 到达 → 续命（10s < 15s 超时窗，单次 ping 的合法存活期）
    port.emitMessage({ type: 'WORKER_PING' })
    tickMono(10000)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('守卫：父真死（无任何消息）→ 嫌疑 + 宽限耗尽后 exit 恰一次（延迟但必退出）', async () => {
    await loadWorker()
    sleepJump(SLEEP_JUMP_MS)
    tickMono(30000)
    expect(exitSpy).toHaveBeenCalledTimes(1)
  })

  it('任意父消息续命：嫌疑期收到 SCAN_STOP 后不得退出', async () => {
    await loadWorker()
    sleepJump(SLEEP_JUMP_MS)
    tickMono(5000)
    port.emitMessage({ type: 'SCAN_STOP' })
    tickMono(10000)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('边界：首个 tick 前 ping 已到达（跳变被消息吸收）→ 不退出', async () => {
    await loadWorker()
    sleepJump(SLEEP_JUMP_MS)
    port.emitMessage({ type: 'WORKER_PING' })
    tickMono(10000)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('修复轮（红→绿）：嫌疑期内墙钟二次跳变（嫌疑期中再睡眠）不得耗尽宽限误杀', async () => {
    await loadWorker()
    sleepJump(SLEEP_JUMP_MS) // 第一次睡眠跳变：不得立即杀（既有契约）
    tickMono(5000) // 首个 tick：进入嫌疑宽限
    tickMono(5000) // 宽限进行中
    sleepJump(SLEEP_JUMP_MS) // 嫌疑期内二次睡眠：墙钟再跳 8h，单调钟不动
    tickMono(5000) // 下一 tick：墙钟旧实现按 8h 判宽限耗尽误杀；单调钟实现必须存活
    expect(exitSpy).not.toHaveBeenCalled()
    // 唤醒后父进程 ping ≤5s 到达（bridge 无条件 ping）→ 续命
    port.emitMessage({ type: 'WORKER_PING' })
    tickMono(15000)
    expect(exitSpy).not.toHaveBeenCalled()
  })
})
