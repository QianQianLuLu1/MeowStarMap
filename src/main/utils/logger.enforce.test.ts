import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// 节流窗口需与 logger.ts 的 ENFORCE_INTERVAL_MS 保持一致
const ENFORCE_INTERVAL_MS = 8000

// fake timers 仅拦截定时器/Date，真实 fs I/O 仍需靠真实 setImmediate 冲刷
const realSetImmediate = setImmediate

// 不放进 vi.hoisted：hoisted 工厂会被提升到 import 之前，此时 os/path 仍处 TDZ。
// 改为普通变量，由 beforeEach 按用例赋值；electron mock 的 getPath 不引用它
// （initLogger 因 logDir 已被 setLogDirectory 设置而跳过，getPath 实际不会被调用）。
// 为什么必须按用例唯一：曾经写成模块级常量 + beforeAll 建目录 + afterEach rmSync，
// 于是第二个用例全程对着「已被上一个用例删除」的目录跑——readdir 照样被调用（计数断言数的是
// 调用次数，不看成败），用例绿着但真实扫描从未发生，并留下 25 条无人持有的写盘 reject。
let tmpDir = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => '/mock-user-data',
    getVersion: () => '1.0.0'
  }
}))
vi.mock('../i18n', () => ({ t: (k: string) => k }))

async function flushRealIO(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => realSetImmediate(resolve))
  }
}

describe('logger enforceMaxSize 写放大节流', () => {
  beforeEach(() => {
    // mkdtempSync 顺带把目录建好（setLogDirectory 只设路径不建目录，而 initLogger 因 logDir
    // 非空被跳过，所以目录必须由套件自己准备）。前缀与 logger.test.ts 的 wxnn-logger-test-
    // 区分开：全量输出按目录名归因时，两份同前缀的套件会混成一团。
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-logger-enforce-'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    // 先排空在途的真实写盘再删目录：未被人持有的 appendFile 回调若活到钩子之外，
    // 正是本套件要消灭的那类逃逸形状（Windows 上还会让 rmSync 抛 ENOTEMPTY）。
    await flushRealIO()
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // Windows: electron-log 落盘的句柄可能未及时释放。重试仍放在钩子内 await——
      // 原先写成一条未持有的 realSetImmediate(...)，本身就是同类逃逸形状。
      await new Promise<void>((resolve) => realSetImmediate(resolve))
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // 临时目录残留不影响任何判定，交给系统清理
      }
    }
  })

  it('burst: 连续 200 条 logFault 在 8s 窗口内真实扫描次数 ≤ 2', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const mod = await import('./logger')
    mod.setLogDirectory(tmpDir)

    const readdirSpy = vi.spyOn(fs.promises, 'readdir')
    const fault = new Error('boom')

    for (let i = 0; i < 200; i++) {
      await mod.logFault('manual', fault)
    }

    await flushRealIO()
    const scansBeforeTrailing = readdirSpy.mock.calls.length
    await vi.advanceTimersByTimeAsync(ENFORCE_INTERVAL_MS)
    await flushRealIO()

    const totalScans = readdirSpy.mock.calls.length
    readdirSpy.mockRestore()

    console.log(
      `[burst] readdir 真实扫描次数 = ${totalScans}` +
        `（首触 ${scansBeforeTrailing} + 尾部补扫 ${totalScans - scansBeforeTrailing}）；` +
        `基线最坏 200 次/200 条`
    )
    expect(totalScans).toBeLessThanOrEqual(2)
    expect(fs.readdirSync(tmpDir).length, 'burst 用例应当真的落了盘').toBeGreaterThan(0)
  })

  it('throttle: 每 4s 一条故障（窗口内），10 条真实扫描 = 5 次（≤ 每 8s 一次）', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const mod = await import('./logger')
    mod.setLogDirectory(tmpDir)

    const readdirSpy = vi.spyOn(fs.promises, 'readdir')
    const fault = new Error('boom')

    for (let i = 0; i < 10; i++) {
      await mod.logFault('manual', fault)
      if (i < 9) await vi.advanceTimersByTimeAsync(4000) // 模拟真实 4s 间隔
    }
    await flushRealIO()
    const totalScans = readdirSpy.mock.calls.length
    readdirSpy.mockRestore()

    // 夹具有效性：本用例声称「真实扫描」，日志目录就必须真的存在、且真的收过写盘。
    // 缺这两条时，目录被上一个用例的 afterEach 删掉也能拿到 5 次 readdir 调用数（数的是调用不是成败），
    // 用例绿着、被测语义却从未发生——2026-10-28 查 DEBT-039 时实测到的正是这一状态。
    expect(fs.existsSync(tmpDir), '日志目录在用例内不存在，节流计数来自的是失败扫描').toBe(true)
    expect(fs.readdirSync(tmpDir)).toContain(`main-${new Date().toISOString().slice(0, 10)}.log`)

    console.log(`[throttle] 10 条/每4s，真实扫描次数 = ${totalScans}（理论 1/8s = 5）`)
    expect(totalScans).toBe(5)
  })

  /**
   * 环境卫生探针（@hygiene-probe）：`writeLog()` 是
   * `fs.promises.appendFile(...).catch(err => console.error('[Logger] 写入失败:', err))` 的
   * fire-and-forget，Promise 无人持有；reject 的 console.error 若排到环境拆解之后送达，Vitest 抛
   * `EnvironmentTeardownError`（Closing rpc while "onUserConsoleLog" was pending）并按未处理错误退出 1
   * ——2026-10-28 CI run 23 的 Test (shard 5/10) 即「45 文件全通过仍退出 1」。
   * 本套件刻意保留真实写盘（节流计数要靠真实 readdir/stat 才有意义），因此判据不是「静默掉」而是
   * 「目录必须真的存在」：探针直接数逃逸条数，夹具再次退化时这里先红。
   */
  it('探针：按用例重建的真实目录不得留下 [Logger] 写入失败', async () => {
    vi.resetModules()
    const mod = await import('./logger')
    mod.setLogDirectory(tmpDir)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      mod.logger.info('logger.enforce 环境卫生探针')
      await flushRealIO()
      const failures = errorSpy.mock.calls.filter((args) =>
        String(args[0]).includes('[Logger] 写入失败')
      )
      expect(failures, '真实 fs.promises.appendFile 被调用且 reject，会逃逸到环境拆解之外').toEqual(
        []
      )
    } finally {
      errorSpy.mockRestore()
    }
  })
})
