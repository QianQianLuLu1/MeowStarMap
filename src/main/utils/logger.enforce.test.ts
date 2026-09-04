import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// 节流窗口需与 logger.ts 的 ENFORCE_INTERVAL_MS 保持一致
const ENFORCE_INTERVAL_MS = 8000

// fake timers 仅拦截定时器/Date，真实 fs I/O 仍需靠真实 setImmediate 冲刷
const realSetImmediate = setImmediate

// 不放进 vi.hoisted：hoisted 工厂会被提升到 import 之前，此时 os/path 仍处 TDZ。
// 改为普通常量；electron mock 的 getPath 不再引用 tmpDir（initLogger 因 logDir
// 已被 setLogDirectory 设置而跳过，getPath 实际不会被调用）。
const tmpDir = path.join(
  os.tmpdir(),
  `wxnn-logger-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
)

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
  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // Windows: electron-log 异步写盘可能仍在进行，rmSync 争抢时
      // 会抛 ENOTEMPTY（目录非空无法删除）。重试一次。
      realSetImmediate(() => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      })
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

    console.log(`[throttle] 10 条/每4s，真实扫描次数 = ${totalScans}（理论 1/8s = 5）`)
    expect(totalScans).toBe(5)
  })
})
