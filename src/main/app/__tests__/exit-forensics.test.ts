/**
 * @layer L2
 * @module src/main/app/exit-forensics
 * @coverage 异常终止检测全分支：首次启动/陈旧心跳+退出码/陈旧心跳无退出码/损坏容错/
 *           心跳落盘/退出码落盘/正常退出清理/里程碑打点
 * @dependencies electron (app)、fs、path、crypto（真实 fs I/O，临时目录）
 *
 * 设计说明：
 * - 使用真实 fs + 每用例独立临时目录（mkdtempSync），不 mock fs，
 *   验证端到端文件读写与容错（对齐 gpu-fallback.test.ts 模式）。
 * - electron 仅 mock app.getPath（指向当前临时目录）与 app.on（捕获监听器）。
 * - 模块含 bootId 等模块级状态：每用例 vi.resetModules() + 动态 import 获取新实例。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { mockGetPath, mockAppOn, mockAppExit, diagLogMock, loggerInfoMock, loggerFaultMock } =
  vi.hoisted(() => ({
    mockGetPath: vi.fn(),
    mockAppOn: vi.fn(),
    mockAppExit: vi.fn(),
    diagLogMock: vi.fn(),
    loggerInfoMock: vi.fn(),
    loggerFaultMock: vi.fn()
  }))

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
    on: mockAppOn,
    exit: mockAppExit
  }
}))

vi.mock('../../utils/startup-diagnostic', () => ({
  diagLog: diagLogMock
}))

vi.mock('../../utils/logger', () => ({
  logger: {
    error: vi.fn(),
    info: loggerInfoMock,
    warn: vi.fn(),
    fault: loggerFaultMock
  }
}))

type ExitForensics = typeof import('../exit-forensics')

// 每用例动态 import 新模块实例都会注册一个真实 process 'exit' 监听器，
// 用例数 > 10 会触发 Node MaxListeners 警告（仅测试环境，运行时只注册一次）
process.setMaxListeners(30)

/** 每用例重新加载模块，隔离 bootId / stage 等模块级状态 */
async function freshModule(): Promise<ExitForensics> {
  vi.resetModules()
  return await import('../exit-forensics')
}

let tmpDir: string

function heartbeatPath(): string {
  return path.join(tmpDir, 'heartbeat.json')
}

function lastExitPath(): string {
  return path.join(tmpDir, 'last-exit.json')
}

function writeStaleHeartbeat(bootId = 'prev-boot'): void {
  fs.writeFileSync(
    heartbeatPath(),
    JSON.stringify({
      bootId,
      pid: 4321,
      startedAt: '2026-08-29T06:00:00.000Z',
      updatedAt: '2026-08-29T06:00:18.000Z',
      stage: 'initialized'
    })
  )
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-fx-'))
  mockGetPath.mockReset().mockReturnValue(tmpDir)
  mockAppOn.mockReset()
  mockAppExit.mockReset()
  diagLogMock.mockReset()
  loggerInfoMock.mockReset()
  loggerFaultMock.mockReset()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('exit-forensics 上次运行判别', () => {
  it('1. 首次启动（无陈旧心跳）→ 不告警；心跳文件创建且含 bootId/pid/stage', async () => {
    const fx = await freshModule()
    fx.initExitForensics()

    expect(loggerFaultMock).not.toHaveBeenCalled()
    expect(fs.existsSync(heartbeatPath())).toBe(true)
    const hb = JSON.parse(fs.readFileSync(heartbeatPath(), 'utf8'))
    expect(typeof hb.bootId).toBe('string')
    expect(hb.bootId.length).toBeGreaterThan(0)
    expect(hb.pid).toBe(process.pid)
    expect(hb.stage).toBe('boot')
    // 注册 will-quit 清理监听器
    expect(mockAppOn).toHaveBeenCalledWith('will-quit', expect.any(Function))
  })

  it('2. 陈旧心跳存在且无 last-exit → 记录 exitDiagnosis 故障（外部/原生层终止）', async () => {
    writeStaleHeartbeat()
    const fx = await freshModule()
    fx.initExitForensics()

    expect(loggerFaultMock).toHaveBeenCalledTimes(1)
    expect(loggerFaultMock.mock.calls[0][0]).toBe('exitDiagnosis')
    expect(String(loggerFaultMock.mock.calls[0][1]?.message)).toContain('外部/原生层终止')
    expect(diagLogMock).toHaveBeenCalledWith('EXIT-FX', expect.stringContaining('prev-boot'))
  })

  it('3. 陈旧心跳 + 匹配的 last-exit（同一 bootId）→ 仅记 info，不告警', async () => {
    writeStaleHeartbeat('prev-boot')
    fs.writeFileSync(
      lastExitPath(),
      JSON.stringify({
        bootId: 'prev-boot',
        code: 0,
        stage: 'cleanup',
        time: '2026-08-29T06:00:20Z'
      })
    )
    const fx = await freshModule()
    fx.initExitForensics()

    expect(loggerFaultMock).not.toHaveBeenCalled()
    expect(loggerInfoMock).toHaveBeenCalledWith(expect.stringContaining('code=0'))
  })

  it('4. 陈旧心跳 + last-exit bootId 不匹配 → 视为异常终止（无有效退出痕迹）', async () => {
    writeStaleHeartbeat('prev-boot')
    fs.writeFileSync(
      lastExitPath(),
      JSON.stringify({ bootId: 'another-boot', code: 0, stage: 'cleanup', time: '' })
    )
    const fx = await freshModule()
    fx.initExitForensics()

    expect(loggerFaultMock).toHaveBeenCalledTimes(1)
    expect(loggerFaultMock.mock.calls[0][0]).toBe('exitDiagnosis')
  })

  it('5. 文件损坏（心跳非法 JSON / last-exit 字段非法 / 心跳为目录）→ 不抛错、按默认分支', async () => {
    fs.writeFileSync(heartbeatPath(), 'not-json{{{')
    let fx = await freshModule()
    expect(() => fx.initExitForensics()).not.toThrow()
    expect(loggerFaultMock).not.toHaveBeenCalled() // 心跳损坏 = 视为不存在

    // 心跳合法但 last-exit 损坏 → last-exit 视为缺失 → 异常终止
    fs.writeFileSync(lastExitPath(), 'corrupt{{{')
    fs.rmSync(heartbeatPath(), { force: true })
    writeStaleHeartbeat()
    fx = await freshModule()
    expect(() => fx.initExitForensics()).not.toThrow()
    expect(loggerFaultMock).toHaveBeenCalledTimes(1)

    // 心跳路径是目录 → 读写均 EISDIR，静默降级
    fx = await freshModule()
    fs.rmSync(heartbeatPath(), { force: true })
    fs.mkdirSync(heartbeatPath())
    expect(() => fx.initExitForensics()).not.toThrow()
  })

  it('6. initExitForensics 幂等：重复调用不重复注册监听器', async () => {
    const fx = await freshModule()
    fx.initExitForensics()
    fx.initExitForensics()
    const willQuitCalls = mockAppOn.mock.calls.filter((c) => c[0] === 'will-quit')
    expect(willQuitCalls).toHaveLength(1)
  })
})

describe('exit-forensics 退出码与清理', () => {
  it('7. process exit 事件处理器 → 同步写 last-exit.json（bootId/code/stage/time）', async () => {
    const spy = vi.spyOn(process, 'on')
    try {
      const fx = await freshModule()
      fx.initExitForensics()
      fx.markExitStage('initialized')

      const exitCalls = spy.mock.calls.filter((c) => c[0] === 'exit')
      expect(exitCalls).toHaveLength(1)
      const handler = exitCalls[0][1] as (code: number) => void
      handler(1)

      const rec = JSON.parse(fs.readFileSync(lastExitPath(), 'utf8'))
      const hb = JSON.parse(fs.readFileSync(heartbeatPath(), 'utf8'))
      expect(rec.bootId).toBe(hb.bootId)
      expect(rec.code).toBe(1)
      expect(rec.stage).toBe('initialized')
      expect(typeof rec.time).toBe('string')
    } finally {
      spy.mockRestore()
    }
  })

  it('8. will-quit 清理处理器 → 删除心跳文件（下次启动不误报）', async () => {
    const fx = await freshModule()
    fx.initExitForensics()
    expect(fs.existsSync(heartbeatPath())).toBe(true)

    const willQuit = mockAppOn.mock.calls.find((c) => c[0] === 'will-quit')?.[1] as () => void
    expect(() => willQuit()).not.toThrow()
    expect(fs.existsSync(heartbeatPath())).toBe(false)
  })

  it('9. markCleanShutdown → 删除心跳并切到 cleanup 阶段（目录占位也不抛错）', async () => {
    const fx = await freshModule()
    fx.initExitForensics()
    fx.markCleanShutdown()
    expect(fs.existsSync(heartbeatPath())).toBe(false)

    // 心跳路径为目录（EISDIR）→ 静默
    fs.rmSync(heartbeatPath(), { force: true, recursive: true })
    fs.mkdirSync(heartbeatPath())
    expect(() => fx.markCleanShutdown()).not.toThrow()
  })

  it('10. 心跳定时器随里程碑打点刷新 stage（fake timers 推进 5s）', async () => {
    vi.useFakeTimers()
    try {
      const fx = await freshModule()
      fx.initExitForensics()
      fx.markExitStage('when-ready')
      await vi.advanceTimersByTimeAsync(5100)

      const hb = JSON.parse(fs.readFileSync(heartbeatPath(), 'utf8'))
      expect(hb.stage).toBe('when-ready')
    } finally {
      vi.useRealTimers()
    }
  })

  it('11. app.exit / beforeExit 均记录事件链，退出时随 last-exit.json 落盘', async () => {
    const spy = vi.spyOn(process, 'on')
    try {
      const fx = await freshModule()
      fx.initExitForensics()
      fx.markExitStage('initialized')

      // 模拟渲染层/主进程路径调用 app.exit（经取证包装层）
      expect(mockAppExit).not.toHaveBeenCalled()
      // 包装层在 installExitCallSpies 中替换 mock 上的 exit，再调用应透传原实现
      // （此处通过 app.on 注册的 quit 链事件直接验证 journal 机制）
      process.emit('beforeExit', 0)

      const exitCalls = spy.mock.calls.filter((c) => c[0] === 'exit')
      const handler = exitCalls[0][1] as (code: number) => void
      handler(0)

      const rec = JSON.parse(fs.readFileSync(lastExitPath(), 'utf8'))
      expect(Array.isArray(rec.journal)).toBe(true)
      expect(rec.journal.length).toBeGreaterThan(0)
      expect(rec.journal.join()).toContain('beforeExit')
      expect(rec.uptime).toBeGreaterThanOrEqual(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('12. app.exit 取证包装透传原实现并记录堆栈事件', async () => {
    const fx = await freshModule()
    fx.initExitForensics()
    expect(mockAppExit).not.toHaveBeenCalled()

    const electronApp = (await import('electron')).app as unknown as { exit: (c?: number) => void }
    electronApp.exit(0)

    // 透传原实现
    expect(mockAppExit).toHaveBeenCalledTimes(1)
    expect(mockAppExit).toHaveBeenCalledWith(0)
    // 事件链已记录（含调用点堆栈）
    expect(diagLogMock).toHaveBeenCalledWith(
      'EXIT-FX',
      expect.stringContaining('app.exit code=0 stack=')
    )
  })
})
