import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * GPU 崩溃自愈完整链路集成测试。
 * 复用真实 fs + 临时目录 + 仅 mock 掉 electron 首方 API，确定性复现：
 *   崩溃 → 落盘标记 → 下次启动判定软件渲染 → 自动重启(relaunch+exit)。
 * 不复制业务逻辑，直接调用 src/main/app/gpu-fallback.ts 的导出。
 */
const {
  mockGetPath,
  mockAppOn,
  mockRelaunch,
  mockExit,
  mockReleaseLock,
  diagLogMock,
  loggerErrorMock
} = vi.hoisted(() => ({
  mockGetPath: vi.fn(),
  mockAppOn: vi.fn(),
  mockRelaunch: vi.fn(),
  mockExit: vi.fn(),
  mockReleaseLock: vi.fn(),
  diagLogMock: vi.fn(),
  loggerErrorMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
    on: mockAppOn,
    relaunch: mockRelaunch,
    exit: mockExit,
    releaseSingleInstanceLock: mockReleaseLock
  }
}))
vi.mock('../../utils/startup-diagnostic', () => ({ diagLog: diagLogMock }))
vi.mock('../../utils/logger', () => ({
  logger: { error: loggerErrorMock, info: vi.fn(), warn: vi.fn() }
}))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))

let tmpDir: string

beforeEach(() => {
  vi.resetModules()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-selfheal-'))
  mockGetPath.mockImplementation((name: string) => (name === 'userData' ? tmpDir : ''))
  mockAppOn.mockReset()
  mockRelaunch.mockReset()
  mockExit.mockReset()
  mockReleaseLock.mockReset()
  diagLogMock.mockReset()
  loggerErrorMock.mockReset()
  delete process.env.NIKKI_FORCE_GPU_COMPAT
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('GPU 崩溃自愈完整链路', () => {
  it('1. 硬件加速启动崩溃 → 落盘标记 + 自动重启(relaunch+exit)', async () => {
    const m = await import('../gpu-fallback')
    expect(m.recordBootDecision()).toBe(false) // 健康启动，保留硬件加速
    m.markBootAttempt()

    const healed = m.requestSelfHeal('crashed', 1)

    expect(healed).toBe(true)
    expect(mockRelaunch).toHaveBeenCalledTimes(1)
    expect(mockExit).toHaveBeenCalledWith(0)
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'gpu-fallback.json'), 'utf8'))
    expect(raw.fallbackActive).toBe(true)
  })

  it('2. 下次启动读到标记 → shouldDisableHardwareAcceleration 返回 true（软件渲染）', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'gpu-fallback.json'),
      JSON.stringify({ consecutiveFailures: 1, fallbackActive: true })
    )
    const m = await import('../gpu-fallback')
    expect(m.shouldDisableHardwareAcceleration()).toBe(true)
    expect(m.recordBootDecision()).toBe(true)
  })

  it('3. 已兼容模式仍崩溃 → requestSelfHeal 不自动重启（防死循环）', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'gpu-fallback.json'),
      JSON.stringify({ consecutiveFailures: 0, fallbackActive: true })
    )
    const m = await import('../gpu-fallback')
    expect(m.recordBootDecision()).toBe(true) // 本次已进入兼容模式
    const healed = m.requestSelfHeal('crashed', 1)
    expect(healed).toBe(false)
    expect(mockRelaunch).not.toHaveBeenCalled()
    expect(mockExit).not.toHaveBeenCalled()
  })

  it('4. NIKKI_FORCE_GPU_COMPAT=1 → 强制软件渲染且不触发重启', async () => {
    process.env.NIKKI_FORCE_GPU_COMPAT = '1'
    const m = await import('../gpu-fallback')
    expect(m.shouldDisableHardwareAcceleration()).toBe(true)
    expect(m.recordBootDecision()).toBe(true)
    const healed = m.requestSelfHeal('crashed', 1)
    expect(healed).toBe(false)
    expect(mockRelaunch).not.toHaveBeenCalled()
  })

  it('5. isStartupPhase: 首绘前 true，markAppBooted 后 false', async () => {
    const m = await import('../gpu-fallback')
    expect(m.isStartupPhase()).toBe(true)
    m.markAppBooted()
    expect(m.isStartupPhase()).toBe(false)
  })

  it('6. setupGpuProcessWatcher: GPU 崩溃触发自愈（标记 + 自动重启），非 GPU 类型忽略', async () => {
    const m = await import('../gpu-fallback')
    m.recordBootDecision() // false：硬件加速启动
    m.setupGpuProcessWatcher()
    expect(mockAppOn).toHaveBeenCalledWith('child-process-gone', expect.any(Function))
    const handler = mockAppOn.mock.calls[0][1]

    handler({}, { type: 'Utility', reason: 'crashed', exitCode: 1 })
    expect(mockRelaunch).not.toHaveBeenCalled() // 非 GPU，不处理

    handler({}, { type: 'GPU', reason: 'crashed', exitCode: 1 })
    expect(mockRelaunch).toHaveBeenCalledTimes(1)
    expect(mockExit).toHaveBeenCalledWith(0)
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'gpu-fallback.json'), 'utf8'))
    expect(raw.fallbackActive).toBe(true)
  })
})
