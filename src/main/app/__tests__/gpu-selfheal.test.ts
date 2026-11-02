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
  mockGetVersion,
  diagLogMock,
  loggerErrorMock,
  loggerWarnMock
} = vi.hoisted(() => ({
  mockGetPath: vi.fn(),
  mockAppOn: vi.fn(),
  mockRelaunch: vi.fn(),
  mockExit: vi.fn(),
  mockReleaseLock: vi.fn(),
  mockGetVersion: vi.fn(),
  diagLogMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
    on: mockAppOn,
    relaunch: mockRelaunch,
    exit: mockExit,
    releaseSingleInstanceLock: mockReleaseLock,
    getVersion: mockGetVersion
  }
}))
vi.mock('../../utils/startup-diagnostic', () => ({ diagLog: diagLogMock }))
vi.mock('../../utils/logger', () => ({
  logger: { error: loggerErrorMock, info: vi.fn(), warn: loggerWarnMock }
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
  mockGetVersion.mockReset().mockReturnValue('2.5.5')
  diagLogMock.mockReset()
  loggerErrorMock.mockReset()
  loggerWarnMock.mockReset()
  delete process.env.NIKKI_FORCE_GPU_COMPAT
  delete process.env.NIKKI_GPU_FORCE_LEVEL
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

  it('2. 下次启动读到标记（同版本戳）→ shouldDisableHardwareAcceleration 返回 true（软件渲染）', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'gpu-fallback.json'),
      JSON.stringify({ consecutiveFailures: 1, fallbackActive: true, fallbackVersion: '2.5.5' })
    )
    const m = await import('../gpu-fallback')
    expect(m.shouldDisableHardwareAcceleration()).toBe(true)
    expect(m.recordBootDecision()).toBe(true)
  })

  it('3. 兼容档（level 1）仍崩 → 升 level 2 落盘并自动重启一次（旧「直接放弃」死胡同已封堵）', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'gpu-fallback.json'),
      JSON.stringify({
        consecutiveFailures: 0,
        fallbackActive: true,
        fallbackVersion: '2.5.5',
        compatLevel: 1
      })
    )
    const m = await import('../gpu-fallback')
    expect(m.recordBootLevel()).toBe(1) // 本次已在第一级兼容档
    const healed = m.requestSelfHeal('crashed', 1)
    expect(healed).toBe(true)
    expect(mockRelaunch).toHaveBeenCalledTimes(1)
    expect(mockExit).toHaveBeenCalledWith(0)
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'gpu-fallback.json'), 'utf8'))
    expect(raw.compatLevel).toBe(2) // 升档指令必须在重启前落盘
  })

  it('3b. 最大兼容档（level 2）仍崩 → 不重启、不升第三档、记 error（防死循环）', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'gpu-fallback.json'),
      JSON.stringify({
        consecutiveFailures: 0,
        fallbackActive: true,
        fallbackVersion: '2.5.5',
        compatLevel: 2
      })
    )
    const m = await import('../gpu-fallback')
    expect(m.recordBootLevel()).toBe(2)
    const healed = m.requestSelfHeal('crashed', 1)
    expect(healed).toBe(false)
    expect(mockRelaunch).not.toHaveBeenCalled()
    expect(mockExit).not.toHaveBeenCalled()
    expect(loggerErrorMock).toHaveBeenCalled()
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'gpu-fallback.json'), 'utf8'))
    expect(raw.compatLevel).toBe(2)
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

  it('7. 取证联动：上次被原生层杀死（陈旧心跳、无 last-exit）→ 证据判 native，据此升一档', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'heartbeat.json'),
      JSON.stringify({
        bootId: 'killed-boot',
        pid: 4321,
        startedAt: '2026-11-01T14:06:00.000Z',
        updatedAt: '2026-11-01T14:06:03.443Z',
        stage: 'initialized'
      })
    )
    fs.writeFileSync(
      path.join(tmpDir, 'gpu-fallback.json'),
      JSON.stringify({
        consecutiveFailures: 0,
        fallbackActive: true,
        fallbackVersion: '2.5.5',
        compatLevel: 1,
        compatLevelVersion: '2.5.5'
      })
    )
    const fx = await import('../exit-forensics')
    const m = await import('../gpu-fallback')
    const ev = fx.getPreviousExitEvidence()
    expect(ev.kind).toBe('native')
    // 兼容档仍被 FATAL 杀死 → 本次必须落到最大兼容档（2026-11-02 转储证实 1 级救不回来）
    expect(m.recordBootLevel({ prevNativeKill: ev.kind === 'native' })).toBe(2)
  })

  it('7b. 取证联动：JS 管理退出不得触发升档（避免用户主动关闭被当成 GPU 故障）', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'heartbeat.json'),
      JSON.stringify({
        bootId: 'same-boot',
        pid: 4321,
        startedAt: '2026-11-01T14:00:00.000Z',
        updatedAt: '2026-11-01T14:00:30.000Z',
        stage: 'cleanup'
      })
    )
    fs.writeFileSync(
      path.join(tmpDir, 'last-exit.json'),
      JSON.stringify({
        bootId: 'same-boot',
        code: 0,
        stage: 'cleanup',
        time: '2026-11-01T14:00:31.000Z',
        journal: [],
        uptime: 31
      })
    )
    fs.writeFileSync(
      path.join(tmpDir, 'gpu-fallback.json'),
      JSON.stringify({
        consecutiveFailures: 0,
        fallbackActive: true,
        fallbackVersion: '2.5.5',
        compatLevel: 1,
        compatLevelVersion: '2.5.5'
      })
    )
    const fx = await import('../exit-forensics')
    const m = await import('../gpu-fallback')
    expect(fx.getPreviousExitEvidence().kind).toBe('js')
    expect(
      m.recordBootLevel({ prevNativeKill: fx.getPreviousExitEvidence().kind === 'native' })
    ).toBe(1)
  })

  it('8. 取证联动：GPU 自愈主动重启（app.exit）不得留下 native 证据 → 下一次启动只按落盘档位走', async () => {
    // 实测前提（2026-11-02，electron 41.10.6 探针）：app.exit() 不触发 Node 'exit' 事件，
    // 因此若 last-exit.json 只由该事件写，自愈重启后的下一次启动会读到「心跳在、退出码无」
    // ⇒ 判成 native ⇒ 在刚写好的档位上再叠一级 ⇒ 0 级崩一次直接跳 2 级（三级阶梯塌成两级）。
    fs.writeFileSync(
      path.join(tmpDir, 'gpu-fallback.json'),
      JSON.stringify({ consecutiveFailures: 1, fallbackActive: false })
    )
    const fx = await import('../exit-forensics')
    fx.initExitForensics() // 生产顺序：ready 后先装载取证（含 app.exit 包装），再建窗
    const m = await import('../gpu-fallback')
    expect(m.recordBootLevel()).toBe(0) // 本次为硬件加速启动

    expect(m.requestSelfHeal('crashed', 1)).toBe(true) // 升 1 档落盘 + relaunch + app.exit(0)
    expect(mockExit).toHaveBeenCalledWith(0)

    const ev = fx.getPreviousExitEvidence()
    expect(ev.kind, '主动重启不能留 native 证据').not.toBe('native')
    expect(m.recordBootLevel({ prevNativeKill: ev.kind === 'native' })).toBe(1)
  })

  /** 取按事件名注册的监听器（child-process-gone 必须仍是首个注册者，既有用例按下标取它） */
  async function getQuitHandler(): Promise<(e: unknown) => void> {
    const m = await import('../gpu-fallback')
    m.setupGpuProcessWatcher()
    const call = mockAppOn.mock.calls.find((c) => c[0] === 'before-quit')
    expect(call, 'setupGpuProcessWatcher 应注册 before-quit 成功确认钩子').toBeTruthy()
    return call![1] as (e: unknown) => void
  }

  it('8. 已首绘后正常退出（before-quit）→ 清零失败计数：快速开合不得被误计为失败', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'gpu-fallback.json'),
      JSON.stringify({ consecutiveFailures: 2, fallbackActive: false })
    )
    const m = await import('../gpu-fallback')
    const quit = await getQuitHandler()
    m.markAppBooted() // 首绘已完成（用户看了一眼就关）
    quit({})

    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'gpu-fallback.json'), 'utf8'))
    expect(raw.consecutiveFailures).toBe(0)
  })

  it('8b. 未首绘就退出 → 不清零（真失败仍要计数，阈值兜底路径不变）', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'gpu-fallback.json'),
      JSON.stringify({ consecutiveFailures: 1, fallbackActive: false })
    )
    const quit = await getQuitHandler()
    quit({})

    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'gpu-fallback.json'), 'utf8'))
    expect(raw.consecutiveFailures).toBe(1)
  })
})

describe('GPU 崩溃升级策略（clean-exit 过滤 + 运行期 60s 窗口计数）', () => {
  /** 取本用例注册的 child-process-gone 监听器（每用例 resetModules + mockReset，取首个即本用例注册者） */
  function getChildGoneHandler(): (_e: unknown, details: unknown) => void {
    expect(mockAppOn).toHaveBeenCalledWith('child-process-gone', expect.any(Function))
    return mockAppOn.mock.calls[0][1] as (_e: unknown, details: unknown) => void
  }

  it('r1. clean-exit（正常退出）不触发回退：不落盘、不重启', async () => {
    const m = await import('../gpu-fallback')
    m.recordBootDecision() // false：硬件加速启动
    m.setupGpuProcessWatcher()
    getChildGoneHandler()({}, { type: 'GPU', reason: 'clean-exit', exitCode: 0 })
    expect(mockRelaunch).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(tmpDir, 'gpu-fallback.json'))).toBe(false)
  })

  it('r2. 运行期（首绘后）单次崩溃：仅告警，不置回退、不重启', async () => {
    const m = await import('../gpu-fallback')
    m.recordBootDecision() // false：硬件加速启动
    m.markBootSuccess() // 首绘完成，退出启动期
    m.setupGpuProcessWatcher()
    getChildGoneHandler()({}, { type: 'GPU', reason: 'crashed', exitCode: 1 })
    expect(mockRelaunch).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(tmpDir, 'gpu-fallback.json'))).toBe(false)
    expect(loggerWarnMock).toHaveBeenCalled()
  })

  it('r3. 运行期 60s 窗口内第二次崩溃：置回退并自动重启', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    try {
      const m = await import('../gpu-fallback')
      m.recordBootDecision() // false：硬件加速启动
      m.markBootSuccess()
      m.setupGpuProcessWatcher()
      const handler = getChildGoneHandler()

      handler({}, { type: 'GPU', reason: 'crashed', exitCode: 1 }) // 第 1 次：仅告警
      expect(mockRelaunch).not.toHaveBeenCalled()

      vi.advanceTimersByTime(30_000)
      handler({}, { type: 'GPU', reason: 'crashed', exitCode: 1 }) // 第 2 次（窗口内）：升级
      expect(mockRelaunch).toHaveBeenCalledTimes(1)
      expect(mockExit).toHaveBeenCalledWith(0)
      const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'gpu-fallback.json'), 'utf8'))
      expect(raw.fallbackActive).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('r4. 运行期两次崩溃相隔超过 60s：不升级', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    try {
      const m = await import('../gpu-fallback')
      m.recordBootDecision() // false：硬件加速启动
      m.markBootSuccess()
      m.setupGpuProcessWatcher()
      const handler = getChildGoneHandler()

      handler({}, { type: 'GPU', reason: 'crashed', exitCode: 1 }) // 第 1 次
      vi.advanceTimersByTime(60_001) // 越过窗口
      handler({}, { type: 'GPU', reason: 'crashed', exitCode: 1 }) // 窗口外的第 2 次
      expect(mockRelaunch).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(tmpDir, 'gpu-fallback.json'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('r5. 纯函数 shouldEscalateRuntimeGpuCrash：含本次时间戳，窗口外条目剔除（60s 边界含）', async () => {
    const m = await import('../gpu-fallback')
    const now = 1_000_000
    expect(m.shouldEscalateRuntimeGpuCrash([now], now)).toBe(false) // 仅本次
    expect(m.shouldEscalateRuntimeGpuCrash([now - 30_000, now], now)).toBe(true) // 窗口内两次
    expect(m.shouldEscalateRuntimeGpuCrash([now - 60_000, now], now)).toBe(true) // 边界：恰好 60s 仍算窗口内
    expect(m.shouldEscalateRuntimeGpuCrash([now - 60_001, now], now)).toBe(false) // 窗口外剔除
    expect(m.shouldEscalateRuntimeGpuCrash([], now)).toBe(false) // 空数组
  })
})
