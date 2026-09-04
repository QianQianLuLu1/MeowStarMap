/**
 * @layer L1
 * @module src/main/app/cleanup (collectExitDiagnosis only)
 * @coverage collectExitDiagnosis 纯诊断函数（仅读 process 状态 + ctx 状态）
 * @dependencies electron (app)、utils/process-registry、utils/startup-diagnostic
 *
 * 注：cleanup.ts 同时包含 performCleanup（第三层）与 collectExitDiagnosis（第一层）。
 * 本文件仅覆盖 collectExitDiagnosis，避免 performCleanup 的复杂 mock 影响纯函数测试。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeAppCtx } from '../../ipc/handlers/_test-helpers'

// 共享 mock：getProcessRegistryStats 返回可控统计数据
const { getProcessRegistryStatsMock, logStartupErrorMock } = vi.hoisted(() => ({
  getProcessRegistryStatsMock: vi.fn(),
  logStartupErrorMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/userData') }
}))

vi.mock('../../utils/process-registry', () => ({
  getProcessRegistryStats: getProcessRegistryStatsMock,
  killAllProcesses: vi.fn()
}))

vi.mock('../../utils/startup-diagnostic', () => ({
  logStartupError: logStartupErrorMock
}))

vi.mock('../../services/share-wifi-service', () => ({
  wifiShareService: { stop: vi.fn() }
}))

vi.mock('../../services/backup-service', () => ({
  backupService: { dispose: vi.fn() }
}))

import { collectExitDiagnosis } from '../cleanup'

describe('collectExitDiagnosis', () => {
  let originalGetActiveHandles: (() => unknown[]) | undefined
  let originalGetActiveRequests: (() => unknown[]) | undefined

  beforeEach(() => {
    getProcessRegistryStatsMock.mockReset()
    logStartupErrorMock.mockReset()
    // 默认：无活跃子进程 / ffmpeg 命令
    getProcessRegistryStatsMock.mockReturnValue({ childProcessCount: 0, ffmpegCommandCount: 0 })
    // 保存原 process 内部方法
    const p = process as unknown as {
      _getActiveHandles?: () => unknown[]
      _getActiveRequests?: () => unknown[]
    }
    originalGetActiveHandles = p._getActiveHandles
    originalGetActiveRequests = p._getActiveRequests
    // 默认：返回空数组
    p._getActiveHandles = () => []
    p._getActiveRequests = () => []
  })

  afterEach(() => {
    const p = process as unknown as {
      _getActiveHandles?: () => unknown[]
      _getActiveRequests?: () => unknown[]
    }
    if (originalGetActiveHandles === undefined) {
      delete p._getActiveHandles
    } else {
      p._getActiveHandles = originalGetActiveHandles
    }
    if (originalGetActiveRequests === undefined) {
      delete p._getActiveRequests
    } else {
      p._getActiveRequests = originalGetActiveRequests
    }
  })

  it('1. 返回对象含全部必备字段（stage / timestamp / pid / uptime / startupTimers / hasMediaUpdateTimer / childProcessCount / ffmpegCommandCount）', () => {
    const ctx = makeAppCtx()
    const result = collectExitDiagnosis('before-cleanup', ctx) as Record<string, unknown>
    expect(result).toHaveProperty('stage', 'before-cleanup')
    expect(result).toHaveProperty('timestamp')
    expect(typeof result['timestamp']).toBe('string')
    expect(result).toHaveProperty('pid')
    expect(result).toHaveProperty('uptime')
    expect(result).toHaveProperty('startupTimers', 0)
    expect(result).toHaveProperty('hasMediaUpdateTimer', false)
    expect(result).toHaveProperty('childProcessCount', 0)
    expect(result).toHaveProperty('ffmpegCommandCount', 0)
    // activeHandles / activeRequests 在 _getActiveHandles 存在时被写入
    expect(result).toHaveProperty('activeHandles')
    expect(result).toHaveProperty('activeRequests')
  })

  it('2. stage 参数透传到返回对象', () => {
    const ctx = makeAppCtx()
    const before = collectExitDiagnosis('before-cleanup', ctx) as Record<string, unknown>
    expect(before['stage']).toBe('before-cleanup')
    const after = collectExitDiagnosis('after-cleanup', ctx) as Record<string, unknown>
    expect(after['stage']).toBe('after-cleanup')
  })

  it('3. startupTimers.length 反映 ctx 中的数组长度', () => {
    // 用 setTimeout 创建真实 timer（fakeTimers 模式下也能产生 Timeout 对象）
    const t1 = setTimeout(() => {}, 1000)
    const t2 = setTimeout(() => {}, 2000)
    const ctx = makeAppCtx({ startupTimers: [t1, t2] })
    const result = collectExitDiagnosis('test', ctx) as Record<string, unknown>
    expect(result['startupTimers']).toBe(2)
    clearTimeout(t1)
    clearTimeout(t2)
  })

  it('4. getMediaUpdateTimer 返回非 null 时 hasMediaUpdateTimer: true', () => {
    const timer = setTimeout(() => {}, 1000)
    const ctx = makeAppCtx({ mediaUpdateTimer: timer })
    const result = collectExitDiagnosis('test', ctx) as Record<string, unknown>
    expect(result['hasMediaUpdateTimer']).toBe(true)
    clearTimeout(timer)
  })

  it('5. process._getActiveHandles 返回空数组时 activeHandles: []', () => {
    const p = process as unknown as { _getActiveHandles: () => unknown[] }
    p._getActiveHandles = () => []
    const ctx = makeAppCtx()
    const result = collectExitDiagnosis('test', ctx) as Record<string, unknown>
    expect(result['activeHandles']).toEqual([])
  })

  it('6. process._getActiveHandles 不存在时（undefined 兜底）函数仍返回，不抛错', () => {
    // 源码用 `process._getActiveHandles?.() || []` 容错：方法不存在时返回 undefined，经 || [] 兜底为空数组
    // 模拟 Node.js 旧版本不支持该内部 API 的场景
    const p = process as unknown as {
      _getActiveHandles?: () => unknown[]
      _getActiveRequests?: () => unknown[]
    }
    delete p._getActiveHandles
    delete p._getActiveRequests
    const ctx = makeAppCtx()
    expect(() => collectExitDiagnosis('test', ctx)).not.toThrow()
    const result = collectExitDiagnosis('test', ctx) as Record<string, unknown>
    // 方法不存在时 activeHandles / activeRequests 字段不写入（?.() 返回 undefined，但 catch 不会触发）
    // 实际：handles = undefined || [] = []，map 返回 []，赋值成功
    expect(result['activeHandles']).toEqual([])
    expect(result['activeRequests']).toEqual([])
  })

  it('7. activeHandles / activeRequests / childProcessCount / startupTimers 任一非空/非 0 时调用 logStartupError（4 个分支各测一次）', () => {
    const p = process as unknown as {
      _getActiveHandles: () => unknown[]
      _getActiveRequests: () => unknown[]
    }

    // 7a. activeHandles 非空
    p._getActiveHandles = () => [{ constructor: { name: 'Socket' } }]
    p._getActiveRequests = () => []
    getProcessRegistryStatsMock.mockReturnValue({ childProcessCount: 0, ffmpegCommandCount: 0 })
    let ctx = makeAppCtx()
    collectExitDiagnosis('test-handles', ctx)
    expect(logStartupErrorMock).toHaveBeenCalledTimes(1)

    // 7b. activeRequests 非空
    logStartupErrorMock.mockClear()
    p._getActiveHandles = () => []
    p._getActiveRequests = () => [{ constructor: { name: 'TCPWRAP' } }]
    ctx = makeAppCtx()
    collectExitDiagnosis('test-requests', ctx)
    expect(logStartupErrorMock).toHaveBeenCalledTimes(1)

    // 7c. childProcessCount > 0
    logStartupErrorMock.mockClear()
    p._getActiveRequests = () => []
    getProcessRegistryStatsMock.mockReturnValue({ childProcessCount: 3, ffmpegCommandCount: 0 })
    ctx = makeAppCtx()
    collectExitDiagnosis('test-child', ctx)
    expect(logStartupErrorMock).toHaveBeenCalledTimes(1)

    // 7d. startupTimers > 0
    logStartupErrorMock.mockClear()
    getProcessRegistryStatsMock.mockReturnValue({ childProcessCount: 0, ffmpegCommandCount: 0 })
    const t = setTimeout(() => {}, 1000)
    ctx = makeAppCtx({ startupTimers: [t] })
    collectExitDiagnosis('test-timers', ctx)
    expect(logStartupErrorMock).toHaveBeenCalledTimes(1)
    clearTimeout(t)
  })

  it('8. 所有指标均正常（空/0）时不调用 logStartupError', () => {
    const p = process as unknown as {
      _getActiveHandles: () => unknown[]
      _getActiveRequests: () => unknown[]
    }
    p._getActiveHandles = () => []
    p._getActiveRequests = () => []
    getProcessRegistryStatsMock.mockReturnValue({ childProcessCount: 0, ffmpegCommandCount: 0 })
    const ctx = makeAppCtx()
    collectExitDiagnosis('test-normal', ctx)
    expect(logStartupErrorMock).not.toHaveBeenCalled()
  })
})
