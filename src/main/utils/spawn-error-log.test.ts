/**
 * @layer L1
 * @module src/main/utils/spawn-error-log
 * @coverage isChildProcessSpawnError/maybeLogSpawnError
 * @dependencies mock: ./startup-diagnostic
 * @remarks 运行期 spawn 类错误落盘诊断：仅 spawn 类错误/非 Error 值记录，业务错误不记
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./startup-diagnostic', () => ({
  logStartupError: vi.fn(),
  diagLog: vi.fn()
}))

import { logStartupError } from './startup-diagnostic'
import { maybeLogSpawnError, isChildProcessSpawnError } from './spawn-error-log'

/** 复刻 early-crash-guard.test.ts 的 spawn 错误 fixture（code/syscall/path/spawnargs） */
function makeSpawnError(overrides: Partial<NodeJS.ErrnoException> = {}): NodeJS.ErrnoException {
  return Object.assign(new Error('spawn EFTYPE'), {
    code: 'EFTYPE',
    errno: -4054,
    syscall: 'spawn EFTYPE',
    path: 'C:\\fake\\ffmpeg.exe',
    spawnargs: ['-i', 'input.mp4'],
    ...overrides
  }) as NodeJS.ErrnoException
}

describe('isChildProcessSpawnError', () => {
  it('syscall 以 spawn 开头返回 true', () => {
    expect(isChildProcessSpawnError(makeSpawnError({ syscall: 'spawn ffmpeg' }))).toBe(true)
  })
  it('spawnSync 同样命中（边界）', () => {
    expect(isChildProcessSpawnError(makeSpawnError({ syscall: 'spawnSync reg' }))).toBe(true)
  })
  it('EFTYPE/ENOENT/EACCES code 命中（边界）', () => {
    expect(isChildProcessSpawnError(makeSpawnError({ code: 'ENOENT', syscall: undefined }))).toBe(
      true
    )
    expect(isChildProcessSpawnError(makeSpawnError({ code: 'EACCES', syscall: undefined }))).toBe(
      true
    )
  })
  it('普通业务 Error（无 code/syscall）返回 false（异常）', () => {
    expect(isChildProcessSpawnError(new Error('boom'))).toBe(false)
  })
  it('null/undefined/字符串返回 false（参数校验）', () => {
    expect(isChildProcessSpawnError(null)).toBe(false)
    expect(isChildProcessSpawnError(undefined)).toBe(false)
    expect(isChildProcessSpawnError('spawn EFTYPE')).toBe(false)
  })
})

describe('maybeLogSpawnError', () => {
  beforeEach(() => {
    vi.mocked(logStartupError).mockClear()
  })

  it('spawn EFTYPE 错误记录到 startup-errors.log，stage 含来源（正常）', () => {
    const err = makeSpawnError()
    maybeLogSpawnError('ffmpeg-runner', err)
    expect(logStartupError).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logStartupError).mock.calls[0][0]).toBe('runtime-spawn-error:ffmpeg-runner')
    expect(vi.mocked(logStartupError).mock.calls[0][1]).toBe(err)
  })

  it('ENOENT 错误同样记录（边界）', () => {
    const err = Object.assign(new Error('spawn wmic ENOENT'), {
      code: 'ENOENT',
      syscall: 'spawn wmic',
      path: 'wmic'
    }) as NodeJS.ErrnoException
    maybeLogSpawnError('share-clipboard', err)
    expect(logStartupError).toHaveBeenCalledTimes(1)
  })

  it('普通业务 Error 不记录，避免噪音（异常）', () => {
    maybeLogSpawnError('video-service', new Error('编码失败'))
    expect(logStartupError).not.toHaveBeenCalled()
  })

  it('非 Error 值（字符串 reject）String 化后仍记录（边界）', () => {
    maybeLogSpawnError('legacy-path', 'spawn EFTYPE 原始字符串')
    expect(logStartupError).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logStartupError).mock.calls[0][0]).toBe('runtime-spawn-error:legacy-path')
  })

  it('null/undefined 不记录（参数校验）', () => {
    maybeLogSpawnError('x', null)
    maybeLogSpawnError('x', undefined)
    expect(logStartupError).not.toHaveBeenCalled()
  })

  it('EACCES 错误同样记录（边界）', () => {
    const err = Object.assign(new Error('spawn EACCES'), {
      code: 'EACCES',
      syscall: 'spawn ffmpeg',
      path: 'C:\\fake\\ffmpeg.exe'
    }) as NodeJS.ErrnoException
    maybeLogSpawnError('thumbnail-generator', err)
    expect(logStartupError).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logStartupError).mock.calls[0][0]).toBe(
      'runtime-spawn-error:thumbnail-generator'
    )
  })

  it('非 spawn 类 code（如 EBUSY）的对象不记录（异常）', () => {
    maybeLogSpawnError(
      'video-probe',
      Object.assign(new Error('resource busy'), { code: 'EBUSY', syscall: 'open' })
    )
    expect(logStartupError).not.toHaveBeenCalled()
  })

  it('logStartupError 自身抛错时绝不向业务冒泡（兜底）', () => {
    vi.mocked(logStartupError).mockImplementation(() => {
      throw new Error('EACCES: log write failed')
    })
    expect(() => maybeLogSpawnError('ffmpeg-runner', makeSpawnError())).not.toThrow()
  })
})
