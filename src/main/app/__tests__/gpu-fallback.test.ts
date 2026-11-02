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
  mockGetVersion,
  diagLogMock,
  loggerErrorMock
} = vi.hoisted(() => ({
  mockGetPath: vi.fn(),
  mockAppOn: vi.fn(),
  mockRelaunch: vi.fn(),
  mockExit: vi.fn(),
  mockReleaseLock: vi.fn(),
  mockGetVersion: vi.fn(),
  diagLogMock: vi.fn(),
  loggerErrorMock: vi.fn()
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
  recordBootLevel,
  resolveCompatLevel,
  MAX_COMPAT_LEVEL,
  requestSelfHeal,
  readGpuBootPrefs,
  writeGpuDiscretePref,
  readGpuFallbackState,
  classifyBootDecisionForStatus
} from '../gpu-fallback'

let tmpDir: string

function statePath(): string {
  return path.join(tmpDir, 'gpu-fallback.json')
}

function prefPath(): string {
  return path.join(tmpDir, 'gpu-pref.json')
}

function readRaw(): {
  consecutiveFailures: number
  fallbackActive: boolean
  fallbackVersion?: string
  compatLevel?: number
  compatLevelVersion?: string
} {
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
  mockGetVersion.mockReset().mockReturnValue('2.5.5')
  diagLogMock.mockReset()
  loggerErrorMock.mockReset()
  if (process.env.NIKKI_FORCE_GPU_COMPAT) delete process.env.NIKKI_FORCE_GPU_COMPAT
  if (process.env.NIKKI_GPU_FORCE_LEVEL) delete process.env.NIKKI_GPU_FORCE_LEVEL
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

  it('3. markBootSuccess 清零失败计数，但 fallbackActive 保留（同版本内仍回退；升级后获一次重试）', () => {
    writeRaw({ consecutiveFailures: 2, fallbackActive: true, fallbackVersion: '2.5.5' })
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

  it('7. fallbackActive=true（同版本戳）且 failures=0 → 仅凭激活标记即返回 true', () => {
    writeRaw({ consecutiveFailures: 0, fallbackActive: true, fallbackVersion: '2.5.5' })
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

  it('9. setupGpuProcessWatcher：GPU 触发回退标记；其他类型仅记日志、不写盘不自愈', () => {
    // 注：本文件不 resetModules，前序用例 3/8 的 markBootSuccess 已置 appBooted=true，
    // 故此处走「运行期崩溃 60s 窗口升级」路径：第 1 次仅告警，窗口内第 2 次才升级回退
    setupGpuProcessWatcher()
    expect(mockAppOn).toHaveBeenCalledWith('child-process-gone', expect.any(Function))
    const handler = mockAppOn.mock.calls[0][1] as (
      _e: unknown,
      details: { type: string; reason?: string; exitCode?: number }
    ) => void

    handler(null, { type: 'Utility', reason: 'crashed', exitCode: 1 })
    expect(fs.existsSync(statePath())).toBe(false) // 非忽略：不产生任何写盘
    expect(loggerErrorMock).not.toHaveBeenCalled()
    expect(diagLogMock).toHaveBeenCalledWith('CHILD-PROC', expect.stringContaining('type=Utility'))

    handler(null, { type: 'GPU', reason: 'crashed', exitCode: 1 }) // 运行期第 1 次：仅告警
    expect(fs.existsSync(statePath())).toBe(false)
    handler(null, { type: 'GPU', reason: 'crashed', exitCode: 1 }) // 窗口内第 2 次：升级回退
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
    // 同时带着已升到 2 级的兼容档位：用户明确要硬件加速时，档位指令也必须一并复位，
    // 否则设置开关会被陈旧档位悄悄架空（下次启动仍带 --disable-gpu）。
    writeRaw({
      consecutiveFailures: 0,
      fallbackActive: true,
      compatLevel: 2,
      compatLevelVersion: '2.5.5'
    })
    writeHardwareAccelPref(true)
    expect(fs.existsSync(prefPath())).toBe(true)
    expect(readHardwareAccelPref()).toBe(true)
    // 写盘时清空崩溃自愈标记，给用户一次干净重试
    expect(readRaw().fallbackActive).toBe(false)
    expect(readRaw().compatLevel).toBe(0)
    expect(shouldDisableHardwareAcceleration()).toBe(false)
    expect(recordBootLevel()).toBe(0)
  })

  it('b2. 用户显式开启硬件加速时，残留的连续失败计数不得架空该开关', () => {
    // 复现缺陷：计数已达 FAILURE_THRESHOLD=2 时，writeHardwareAccelPref(true) 只清
    // fallbackActive/compatLevel 而漏掉 consecutiveFailures，下次启动会落进阈值分支
    // 当场回手置 fallbackActive=true ⇒ 用户在设置页明确要硬件加速却被静默架空。
    writeRaw({
      consecutiveFailures: 2,
      fallbackActive: true,
      fallbackVersion: '2.5.5',
      compatLevel: 1,
      compatLevelVersion: '2.5.5'
    })
    writeHardwareAccelPref(true)
    expect(readHardwareAccelPref()).toBe(true)
    expect(readRaw().fallbackActive).toBe(false)
    expect(readRaw().compatLevel).toBe(0)
    // 计数轴也必须归零，否则「一次干净重试」立刻被阈值路径吃掉
    expect(readRaw().consecutiveFailures).toBe(0)
    expect(shouldDisableHardwareAcceleration()).toBe(false)
    expect(recordBootLevel()).toBe(0)
  })

  it('b3. 边界守卫：计数未达阈值（1）时开启硬件加速，行为与 b2 同向且不得过度清零', () => {
    // 本用例在修复前即绿，属不变量守卫（防「顺手把计数一律抹掉」把阈值慢路径拆掉）：
    // 阈值兜底靠真实累计，用户开关只复位一次干净重试所需的三轴。
    writeRaw({
      consecutiveFailures: 1,
      fallbackActive: true,
      fallbackVersion: '2.5.5',
      compatLevel: 1,
      compatLevelVersion: '2.5.5'
    })
    writeHardwareAccelPref(true)
    expect(readRaw().fallbackActive).toBe(false)
    expect(readRaw().compatLevel).toBe(0)
    expect(shouldDisableHardwareAcceleration()).toBe(false)
    expect(recordBootLevel()).toBe(0)
  })

  it('c. 无偏好镜像（undefined）且 fallbackActive=true（同版本戳）→ 返回 true（维持既有逻辑）', () => {
    writeRaw({ consecutiveFailures: 0, fallbackActive: true, fallbackVersion: '2.5.5' })
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

  it('c. 兼容档（level 1）仍崩 → 升 level 2 落盘并自动重启一次（旧「直接放弃」死胡同已封堵）', () => {
    writeRaw({
      consecutiveFailures: 0,
      fallbackActive: true,
      fallbackVersion: '2.5.5',
      compatLevel: 1
    })
    expect(recordBootLevel()).toBe(1) // 本次已在第一级兼容档
    const healed = requestSelfHeal('crashed', 1)
    expect(healed).toBe(true)
    expect(mockRelaunch).toHaveBeenCalledTimes(1)
    expect(mockExit).toHaveBeenCalledWith(0)
    // 升档指令必须先落盘，重启后的下一次启动才会带 --disable-gpu + --disable-software-rasterizer
    expect(readRaw().compatLevel).toBe(2)
  })

  it('d. 最大兼容档（level 2）仍崩 → 不重启、不升第三档、记 error（防死循环）', () => {
    writeRaw({
      consecutiveFailures: 0,
      fallbackActive: true,
      fallbackVersion: '2.5.5',
      compatLevel: 2
    })
    expect(recordBootLevel()).toBe(2)
    const healed = requestSelfHeal('crashed', 1)
    expect(healed).toBe(false)
    expect(mockRelaunch).not.toHaveBeenCalled()
    expect(mockExit).not.toHaveBeenCalled()
    expect(readRaw().compatLevel).toBe(MAX_COMPAT_LEVEL)
    expect(loggerErrorMock).toHaveBeenCalled()
  })
})

describe('gpu-fallback 版本级自动重试（fallbackVersion）', () => {
  it('v1. 回退戳为旧版本 → 本次判定 false（给一次干净重试）并落当前版本戳', () => {
    writeRaw({ consecutiveFailures: 0, fallbackActive: true, fallbackVersion: '2.5.4' })
    mockGetVersion.mockReturnValue('2.5.5')
    expect(shouldDisableHardwareAcceleration()).toBe(false) // 升级后自动重试硬件加速
    expect(readRaw().fallbackActive).toBe(true) // 历史标记保留（诊断可见）
    expect(readRaw().fallbackVersion).toBe('2.5.5') // 重试已记账，同版本不再重试
  })

  it('v2. 重试记账后同版本再判 → true（每版本至多一次重试，防每启动循环）', () => {
    writeRaw({ consecutiveFailures: 0, fallbackActive: true, fallbackVersion: '2.5.5' })
    mockGetVersion.mockReturnValue('2.5.5')
    expect(shouldDisableHardwareAcceleration()).toBe(true)
  })

  it('v3. 旧格式无 fallbackVersion 字段 → 恰好一次重试并落戳', () => {
    writeRaw({ consecutiveFailures: 0, fallbackActive: true }) // 历史遗留文件
    mockGetVersion.mockReturnValue('2.5.5')
    expect(shouldDisableHardwareAcceleration()).toBe(false)
    expect(readRaw().fallbackVersion).toBe('2.5.5')
    expect(shouldDisableHardwareAcceleration()).toBe(true) // 第二次不再重试
  })

  it('v4. 版本不可得（getVersion 抛错/返回空）→ 保守 true 不重试', () => {
    writeRaw({ consecutiveFailures: 0, fallbackActive: true, fallbackVersion: '2.5.4' })
    mockGetVersion.mockImplementation(() => {
      throw new Error('not ready')
    })
    expect(shouldDisableHardwareAcceleration()).toBe(true)

    mockGetVersion.mockReturnValue('')
    expect(shouldDisableHardwareAcceleration()).toBe(true)
  })

  it('v5. markGpuProcessCrash 激活回退时盖当前版本戳', () => {
    writeRaw({ consecutiveFailures: 1, fallbackActive: false })
    mockGetVersion.mockReturnValue('2.5.5')
    markGpuProcessCrash('crashed', 1)
    expect(readRaw().fallbackActive).toBe(true)
    expect(readRaw().fallbackVersion).toBe('2.5.5')
    // 崩溃后下次启动（同版本）→ 回退生效
    expect(shouldDisableHardwareAcceleration()).toBe(true)
  })

  it('v6. 连续失败阈值路径激活回退时同样盖版本戳', () => {
    writeRaw({ consecutiveFailures: 2, fallbackActive: false })
    mockGetVersion.mockReturnValue('2.5.5')
    expect(shouldDisableHardwareAcceleration()).toBe(true)
    expect(readRaw().fallbackActive).toBe(true)
    expect(readRaw().fallbackVersion).toBe('2.5.5')
    // 阈值路径盖戳后，下次启动不得再因「无戳」获得重试
    expect(shouldDisableHardwareAcceleration()).toBe(true)
  })

  it('v7. 用户显式关闭（pref=false）优先于版本重试 → true', () => {
    writePref({ hardwareAcceleration: false })
    writeRaw({ consecutiveFailures: 0, fallbackActive: true, fallbackVersion: '2.5.4' })
    mockGetVersion.mockReturnValue('2.5.5')
    expect(shouldDisableHardwareAcceleration()).toBe(true)
  })
})

describe('gpu-fallback 启动偏好镜像（gpu-pref.json 扩展字段）', () => {
  it('p1. readGpuBootPrefs 解析完整镜像；文件缺失/损坏/字段非法 → 相应 undefined', () => {
    writePref({ hardwareAcceleration: true, discretePreference: 'auto' })
    expect(readGpuBootPrefs()).toEqual({ hardwareAcceleration: true, discretePreference: 'auto' })

    fs.rmSync(prefPath())
    expect(readGpuBootPrefs()).toEqual({})

    fs.writeFileSync(prefPath(), 'not-json{{{')
    expect(readGpuBootPrefs()).toEqual({})

    writePref({ hardwareAcceleration: 'yes', discretePreference: 'foo' })
    expect(readGpuBootPrefs()).toEqual({})
  })

  it('p2. writeGpuDiscretePref 写入 discretePreference 且保留 hardwareAcceleration', () => {
    writePref({ hardwareAcceleration: false })
    writeGpuDiscretePref('high-performance')
    expect(readGpuBootPrefs()).toEqual({
      hardwareAcceleration: false,
      discretePreference: 'high-performance'
    })
  })

  it('p3. writeHardwareAccelPref 保留已有 discretePreference 字段（不互相覆盖）', () => {
    writePref({ hardwareAcceleration: true, discretePreference: 'auto' })
    writeHardwareAccelPref(false)
    expect(readGpuBootPrefs()).toEqual({
      hardwareAcceleration: false,
      discretePreference: 'auto'
    })
  })
})

describe('gpu-fallback 三级兼容阶梯（resolveCompatLevel / recordBootLevel）', () => {
  it('L1. 全新状态且无崩溃证据 → level 0，且判定只读不产生状态文件', () => {
    expect(recordBootLevel()).toBe(0)
    expect(fs.existsSync(statePath())).toBe(false)
    expect(recordBootDecision()).toBe(false)
  })

  it('L2. fallbackActive=true（同版本戳）→ level 至少 1（既有布尔判定不改语义）', () => {
    writeRaw({ consecutiveFailures: 0, fallbackActive: true, fallbackVersion: '2.5.5' })
    expect(recordBootLevel()).toBe(1)
  })

  it('L3. 上次被原生层杀死 → 在「上一次实际使用的档位」上加一级，封顶 2', () => {
    writeRaw({ consecutiveFailures: 0, fallbackActive: false, compatLevel: 0 })
    expect(recordBootLevel({ prevNativeKill: true })).toBe(1)

    writeRaw({ consecutiveFailures: 0, fallbackActive: true, compatLevel: 1 })
    expect(recordBootLevel({ prevNativeKill: true })).toBe(2)

    writeRaw({ consecutiveFailures: 0, fallbackActive: true, compatLevel: 2 })
    expect(recordBootLevel({ prevNativeKill: true })).toBe(MAX_COMPAT_LEVEL)
  })

  it('L3b. 升级指令回写状态文件（下一次启动才认得该档位）', () => {
    writeRaw({
      consecutiveFailures: 0,
      fallbackActive: true,
      compatLevel: 1,
      compatLevelVersion: '2.5.5'
    })
    expect(recordBootLevel({ prevNativeKill: true })).toBe(2)
    expect(readRaw().compatLevel).toBe(2)
    expect(readRaw().compatLevelVersion).toBe('2.5.5')
  })

  it('L4. compatLevel 非法值（字符串/负数/越界/NaN/null）→ 归一为合法档位且不抛错', () => {
    for (const bad of ['2', -1, 3, Number.NaN, null, undefined, {}, 1.9]) {
      writeRaw({
        consecutiveFailures: 0,
        fallbackActive: false,
        compatLevel: bad as unknown as number
      })
      expect(() => recordBootLevel()).not.toThrow()
    }
    // 纯函数口径：>MAX 夹取、负数/非数字/NaN 落 0、小数向下取整
    const s = { fallbackActive: false }
    expect(
      resolveCompatLevel(s, {
        prevNativeKill: false,
        currentVersion: '2.5.5',
        compatDisabled: false
      }).level
    ).toBe(0)
    expect(
      resolveCompatLevel(
        { ...s, compatLevel: 3 },
        { prevNativeKill: false, currentVersion: '2.5.5', compatDisabled: false }
      ).level
    ).toBe(MAX_COMPAT_LEVEL)
    expect(
      resolveCompatLevel(
        { ...s, compatLevel: 1.9 },
        { prevNativeKill: false, currentVersion: '2.5.5', compatDisabled: false }
      ).level
    ).toBe(1)
    expect(
      resolveCompatLevel(
        { ...s, compatLevel: 'x' as unknown as number },
        { prevNativeKill: false, currentVersion: '2.5.5', compatDisabled: false }
      ).level
    ).toBe(0)
  })

  it('L5. 上次是 JS 管理退出（prevNativeKill=false）→ 绝不由证据升级（避免用户主动退出被误判）', () => {
    writeRaw({
      consecutiveFailures: 0,
      fallbackActive: true,
      fallbackVersion: '2.5.5',
      compatLevel: 1
    })
    expect(recordBootLevel({ prevNativeKill: false })).toBe(1)
    expect(readRaw().compatLevel).toBe(1)
  })

  it('L6. 边界：consecutiveFailures=1 且无崩溃证据 → 不升级（保持既有阈值 2）', () => {
    writeRaw({ consecutiveFailures: 1, fallbackActive: false })
    expect(recordBootLevel()).toBe(0)
  })

  it('L7. 版本变更 → 档位复位 0 给一次干净硬件重试，并盖当前 compatLevelVersion', () => {
    writeRaw({
      consecutiveFailures: 0,
      fallbackActive: false,
      compatLevel: 2,
      compatLevelVersion: '2.5.4'
    })
    mockGetVersion.mockReturnValue('2.5.5')
    expect(recordBootLevel()).toBe(0)
    expect(readRaw().compatLevel).toBe(0)
    expect(readRaw().compatLevelVersion).toBe('2.5.5')
  })

  it('L8. markGpuProcessCrash 抬升并保留 compatLevel（不整体覆盖新字段）', () => {
    writeRaw({
      consecutiveFailures: 3,
      fallbackActive: true,
      compatLevel: 2,
      compatLevelVersion: '2.5.5'
    })
    markGpuProcessCrash('crashed', 1)
    expect(readRaw().compatLevel).toBe(2)
    expect(readRaw().consecutiveFailures).toBe(3) // 不动计数
    expect(readRaw().compatLevelVersion).toBe('2.5.5')
  })

  it('L9. NIKKI_GPU_FORCE_LEVEL 仅接受 0/1/2，其它值忽略并记日志', () => {
    process.env.NIKKI_GPU_FORCE_LEVEL = '2'
    expect(recordBootLevel()).toBe(2)
    for (const bad of ['01', '2.0', '3', '', 'foo', '-1']) {
      writeRaw({ consecutiveFailures: 0, fallbackActive: false, compatLevel: 0 })
      process.env.NIKKI_GPU_FORCE_LEVEL = bad
      diagLogMock.mockClear()
      expect(recordBootLevel({ prevNativeKill: true })).toBe(1) // 非法值 ⇒ 忽略强制，回落真实判定
      expect(diagLogMock).toHaveBeenCalledWith(
        'GPU',
        expect.stringContaining('NIKKI_GPU_FORCE_LEVEL')
      )
    }
    delete process.env.NIKKI_GPU_FORCE_LEVEL
  })
})

describe('gpu-fallback 状态查询导出（供 gpu-status，只读）', () => {
  it('q1. readGpuFallbackState：无文件 → 默认态；有文件 → 归一化透出（含兼容档位）', () => {
    expect(readGpuFallbackState()).toEqual({
      active: false,
      consecutiveFailures: 0,
      fallbackVersion: null,
      compatLevel: 0
    })

    writeRaw({
      consecutiveFailures: 3,
      fallbackActive: true,
      fallbackVersion: '2.5.4',
      compatLevel: 2
    })
    expect(readGpuFallbackState()).toEqual({
      active: true,
      consecutiveFailures: 3,
      fallbackVersion: '2.5.4',
      compatLevel: 2
    })

    // 旧格式（无 compatLevel 字段）→ 归一为 0，不得把 undefined 透出给渲染层
    writeRaw({ consecutiveFailures: 1, fallbackActive: false })
    expect(readGpuFallbackState().compatLevel).toBe(0)
  })

  it('q2. classifyBootDecisionForStatus 四分类：default / user-disabled / crash-fallback / retry-after-update', () => {
    // default：无任何标记
    expect(classifyBootDecisionForStatus()).toEqual({ enabled: true, reason: 'default' })

    // user-disabled：用户显式关闭（绝对优先）
    writePref({ hardwareAcceleration: false })
    expect(classifyBootDecisionForStatus()).toEqual({
      enabled: false,
      reason: 'user-disabled'
    })
    writePref({ hardwareAcceleration: true })

    // crash-fallback：回退激活且版本戳为当前版本
    writeRaw({ consecutiveFailures: 0, fallbackActive: true, fallbackVersion: '2.5.5' })
    expect(classifyBootDecisionForStatus()).toEqual({
      enabled: false,
      reason: 'crash-fallback'
    })

    // retry-after-update：回退激活但戳为旧版本（本版本将获一次重试）
    writeRaw({ consecutiveFailures: 0, fallbackActive: true, fallbackVersion: '2.5.4' })
    expect(classifyBootDecisionForStatus()).toEqual({
      enabled: true,
      reason: 'retry-after-update'
    })

    // crash-fallback：阈值路径（无 active 标记但连续失败达 2）
    writeRaw({ consecutiveFailures: 2, fallbackActive: false })
    expect(classifyBootDecisionForStatus()).toEqual({
      enabled: false,
      reason: 'crash-fallback'
    })
  })

  it('q3. classifyBootDecisionForStatus 只读：判定后状态文件不被改写（不落版本戳）', () => {
    writeRaw({ consecutiveFailures: 0, fallbackActive: true }) // 无戳旧格式
    classifyBootDecisionForStatus()
    expect(readRaw()).toEqual({ consecutiveFailures: 0, fallbackActive: true }) // 原样未动
    writeRaw({ consecutiveFailures: 2, fallbackActive: false })
    classifyBootDecisionForStatus()
    expect(readRaw()).toEqual({ consecutiveFailures: 2, fallbackActive: false }) // 阈值路径也不写盘
  })
})
