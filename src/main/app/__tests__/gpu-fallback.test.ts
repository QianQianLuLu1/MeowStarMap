/**
 * @layer L2
 * @module src/main/app/gpu-fallback
 * @coverage 状态机全分支：默认/阈值激活/成功清零/崩溃立即回退/损坏容错/不可写容错/幂等/watcher 过滤
 * @dependencies electron (app)、fs、path（真实 fs I/O，临时目录）
 *
 * 设计说明：
 * - 使用真实 fs + 每用例独立临时目录（mkdtempSync），不 mock fs，
 *   验证端到端文件读写与容错。
 * - electron 仅 mock app.getPath（指向当前临时目录）与 app.on（捕获监听器）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

vi.mock('../../utils/startup-diagnostic', () => ({
  diagLog: diagLogMock
}))

vi.mock('../../utils/logger', () => ({
  logger: { error: loggerErrorMock, info: vi.fn(), warn: vi.fn() }
}))

import {
  shouldDisableHardwareAcceleration,
  readHardwareAccelPref,
  writeHardwareAccelPref,
  markBootAttempt,
  markBootSuccess,
  markGpuProcessCrash,
  setupGpuProcessWatcher,
  recordBootDecision,
  requestSelfHeal
} from '../gpu-fallback'

let tmpDir: string

function statePath(): string {
  return path.join(tmpDir, 'gpu-fallback.json')
}

function prefPath(): string {
  return path.join(tmpDir, 'gpu-pref.json')
}

function readRaw(): { consecutiveFailures: number; fallbackActive: boolean } {
  return JSON.parse(fs.readFileSync(statePath(), 'utf8'))
}

function writeRaw(state: unknown): void {
  fs.writeFileSync(statePath(), JSON.stringify(state))
}

function writePref(value: unknown): void {
  fs.writeFileSync(prefPath(), JSON.stringify(value))
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-fb-'))
  mockGetPath.mockReset().mockReturnValue(tmpDir)
  mockAppOn.mockReset()
  mockRelaunch.mockReset()
  mockExit.mockReset()
  mockReleaseLock.mockReset()
  diagLogMock.mockReset()
  loggerErrorMock.mockReset()
  if (process.env.NIKKI_FORCE_GPU_COMPAT) delete process.env.NIKKI_FORCE_GPU_COMPAT
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('gpu-fallback 状态机', () => {
  it('1. 无状态文件（首次安装）→ 不禁用；markBootAttempt 落盘 failures=1 且 active=false', () => {
    expect(shouldDisableHardwareAcceleration()).toBe(false)
    expect(fs.existsSync(statePath())).toBe(false) // 判定只读，不产生文件

    markBootAttempt()
    const s = readRaw()
    expect(s.consecutiveFailures).toBe(1)
    expect(s.fallbackActive).toBe(false)
  })

  it('2. 连续失败达到阈值 2 → 激活回退并持久化，重复判定仍为 true', () => {
    writeRaw({ consecutiveFailures: 2, fallbackActive: false })
    expect(shouldDisableHardwareAcceleration()).toBe(true)
    // 激活标记已落盘：即使把 failures 清零，仍凭 active 保持 true
    expect(readRaw().fallbackActive).toBe(true)
    expect(shouldDisableHardwareAcceleration()).toBe(true)
  })

  it('3. markBootSuccess 清零失败计数，但 fallbackActive 保留（删文件才能恢复硬件加速）', () => {
    writeRaw({ consecutiveFailures: 2, fallbackActive: true })
    markBootSuccess()
    const s = readRaw()
    expect(s.consecutiveFailures).toBe(0)
    expect(s.fallbackActive).toBe(true)
    expect(shouldDisableHardwareAcceleration()).toBe(true)
  })

  it('4. markGpuProcessCrash 同步置 active=true（FATAL 自杀前的抢救写盘）→ 下次判定 true', () => {
    writeRaw({ consecutiveFailures: 1, fallbackActive: false })
    markGpuProcessCrash('crashed', 1)
    expect(readRaw().fallbackActive).toBe(true)
    expect(readRaw().consecutiveFailures).toBe(1) // 不动计数
    expect(shouldDisableHardwareAcceleration()).toBe(true)
    expect(diagLogMock).toHaveBeenCalledWith(
      'GPU',
      expect.stringContaining('reason=crashed exitCode=1')
    )
  })

  it('5. 状态文件损坏（非法 JSON / 字段非法）→ 视为默认状态，不抛错', () => {
    fs.writeFileSync(statePath(), 'not-json{{{')
    expect(shouldDisableHardwareAcceleration()).toBe(false)
    markBootAttempt()
    expect(readRaw().consecutiveFailures).toBe(1) // 从默认 1 重新计

    writeRaw({ consecutiveFailures: -5, fallbackActive: 'yes' }) // 负数与非布尔
    expect(shouldDisableHardwareAcceleration()).toBe(false)

    writeRaw({ consecutiveFailures: Number.NaN })
    expect(shouldDisableHardwareAcceleration()).toBe(false)
  })

  it('6. 状态路径不可读写（被目录占用）→ 全部操作静默不抛错，判定 false', () => {
    fs.mkdirSync(statePath()) // 占位目录：readFileSync/writeFileSync 均抛 EISDIR
    expect(() => shouldDisableHardwareAcceleration()).not.toThrow()
    expect(shouldDisableHardwareAcceleration()).toBe(false)
    expect(() => markBootAttempt()).not.toThrow()
    expect(() => markBootSuccess()).not.toThrow()
    expect(() => markGpuProcessCrash('crashed', 1)).not.toThrow()
  })

  it('7. fallbackActive=true 且 failures=0 → 仅凭激活标记即返回 true', () => {
    writeRaw({ consecutiveFailures: 0, fallbackActive: true })
    expect(shouldDisableHardwareAcceleration()).toBe(true)
  })

  it('8. 边界：failures=1 未达阈值 → false；markBootSuccess 幂等（已为 0 不重复写盘）', () => {
    writeRaw({ consecutiveFailures: 1, fallbackActive: false })
    expect(shouldDisableHardwareAcceleration()).toBe(false)

    writeRaw({ consecutiveFailures: 3, fallbackActive: false })
    markBootSuccess()
    const first = readRaw()
    expect(first.consecutiveFailures).toBe(0)
    const mtimeBefore = fs.statSync(statePath()).mtimeMs
    markBootSuccess() // 幂等：不再写盘
    expect(fs.statSync(statePath()).mtimeMs).toBe(mtimeBefore)
  })

  it('9. setupGpuProcessWatcher：仅 type=GPU 触发回退标记，其他子进程类型忽略', () => {
    setupGpuProcessWatcher()
    expect(mockAppOn).toHaveBeenCalledWith('child-process-gone', expect.any(Function))
    const handler = mockAppOn.mock.calls[0][1] as (
      _e: unknown,
      details: { type: string; reason?: string; exitCode?: number }
    ) => void

    handler(null, { type: 'Utility', reason: 'crashed', exitCode: 1 })
    expect(fs.existsSync(statePath())).toBe(false) // 非忽略：不产生任何写盘
    expect(loggerErrorMock).not.toHaveBeenCalled()

    handler(null, { type: 'GPU', reason: 'crashed', exitCode: 1 })
    expect(readRaw().fallbackActive).toBe(true)
    expect(loggerErrorMock).toHaveBeenCalled()
  })
})

describe('gpu-fallback 用户偏好镜像', () => {
  it('a. 用户显式关闭（pref=false）且 fallbackActive=true → 强制回退为 true（绝对优先）', () => {
    writePref({ hardwareAcceleration: false })
    writeRaw({ consecutiveFailures: 0, fallbackActive: true })
    expect(shouldDisableHardwareAcceleration()).toBe(true)
  })

  it('b. 用户显式开启（pref=true）且 fallbackActive=true → 返回 false，且 writeHardwareAccelPref(true) 清空 fallbackActive', () => {
    writeRaw({ consecutiveFailures: 0, fallbackActive: true })
    writeHardwareAccelPref(true)
    expect(fs.existsSync(prefPath())).toBe(true)
    expect(readHardwareAccelPref()).toBe(true)
    // 写盘时清空崩溃自愈标记，给用户一次干净重试
    expect(readRaw().fallbackActive).toBe(false)
    expect(shouldDisableHardwareAcceleration()).toBe(false)
  })

  it('c. 无偏好镜像（undefined）且 fallbackActive=true → 返回 true（维持既有逻辑）', () => {
    writeRaw({ consecutiveFailures: 0, fallbackActive: true })
    expect(fs.existsSync(prefPath())).toBe(false)
    expect(shouldDisableHardwareAcceleration()).toBe(true)
  })

  it('d. 无偏好镜像且无状态文件 → 返回 false（维持既有默认）', () => {
    expect(fs.existsSync(prefPath())).toBe(false)
    expect(fs.existsSync(statePath())).toBe(false)
    expect(shouldDisableHardwareAcceleration()).toBe(false)
  })

  it('e. 偏好镜像损坏（非法 JSON / 字段非布尔）→ readHardwareAccelPref 返回 undefined 且判定不抛错', () => {
    fs.writeFileSync(prefPath(), 'not-json{{{')
    expect(readHardwareAccelPref()).toBeUndefined()
    expect(() => shouldDisableHardwareAcceleration()).not.toThrow()

    writePref({ hardwareAcceleration: 'yes' }) // 字段非布尔
    expect(readHardwareAccelPref()).toBeUndefined()
    expect(() => shouldDisableHardwareAcceleration()).not.toThrow()
  })
})

describe('gpu-fallback 自愈重启（requestSelfHeal）', () => {
  it('a. NIKKI_FORCE_GPU_COMPAT=1 → shouldDisableHardwareAcceleration 强制 true', () => {
    process.env.NIKKI_FORCE_GPU_COMPAT = '1'
    expect(shouldDisableHardwareAcceleration()).toBe(true)
  })

  it('b. 硬件加速启动崩溃 → requestSelfHeal 标记并自动重启（relaunch+exit）', () => {
    expect(recordBootDecision()).toBe(false) // 硬件加速启动
    const healed = requestSelfHeal('crashed', 1)
    expect(healed).toBe(true)
    expect(mockRelaunch).toHaveBeenCalledTimes(1)
    expect(mockExit).toHaveBeenCalledWith(0)
    expect(readRaw().fallbackActive).toBe(true)
  })

  it('c. 已兼容模式仍崩溃 → requestSelfHeal 不重启（防死循环）', () => {
    writeRaw({ consecutiveFailures: 0, fallbackActive: true })
    expect(recordBootDecision()).toBe(true) // 已兼容模式
    const healed = requestSelfHeal('crashed', 1)
    expect(healed).toBe(false)
    expect(mockRelaunch).not.toHaveBeenCalled()
  })
})
