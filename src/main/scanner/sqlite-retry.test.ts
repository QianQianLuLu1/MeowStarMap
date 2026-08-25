/**
 * @layer L1
 * @module src/main/scanner/sqlite-retry
 * @coverage isSqliteBusy 判定 / executeWriteSafely 退避重试（成功 / 非锁错误不重试 /
 *           锁错误重试一次成功 / 锁错误耗尽后 rethrow / 仅锁错误才续重试）/
 *           walCheckpoint pragma 拼接与透传异常
 * @dependencies 无（纯逻辑 + 极简 db 接口桩）
 * @remarks 验证扫描器写入路径的 SQLITE_BUSY 重试封装与扫描收尾 WAL 检查点辅助函数
 */
import { describe, it, expect, vi } from 'vitest'
import { isSqliteBusy, executeWriteSafely, walCheckpoint } from './sqlite-retry'

function busyErr(): Error {
  return Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
}
function lockedErr(): Error {
  return Object.assign(new Error('database is locked'), { code: 'SQLITE_LOCKED' })
}
function constraintErr(): Error {
  return Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT' })
}

describe('isSqliteBusy', () => {
  it('识别 SQLITE_BUSY / SQLITE_LOCKED（.code 判定）', () => {
    expect(isSqliteBusy(busyErr())).toBe(true)
    expect(isSqliteBusy(lockedErr())).toBe(true)
  })

  it('message 兜底识别 database is locked / busy', () => {
    expect(isSqliteBusy(new Error('database is locked'))).toBe(true)
    expect(isSqliteBusy(new Error('SQLITE_BUSY: database is locked'))).toBe(true)
  })

  it('非锁错误（约束/其他 code）不误判', () => {
    expect(isSqliteBusy(constraintErr())).toBe(false)
    expect(isSqliteBusy(Object.assign(new Error('x'), { code: 'SQLITE_ERROR' }))).toBe(false)
  })

  it('非对象 / 空值返回 false', () => {
    expect(isSqliteBusy(null)).toBe(false)
    expect(isSqliteBusy(undefined)).toBe(false)
    expect(isSqliteBusy(42)).toBe(false)
    expect(isSqliteBusy({})).toBe(false)
  })
})

describe('executeWriteSafely', () => {
  it('首次成功：直接返回结果，不重试、不写日志', async () => {
    const fn = vi.fn(() => 'ok')
    const log = vi.fn()
    const result = await executeWriteSafely(fn, { log })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
  })

  it('非锁错误：立即 rethrow，不重试', async () => {
    const fn = vi.fn(() => {
      throw constraintErr()
    })
    const log = vi.fn()
    await expect(executeWriteSafely(fn, { log })).rejects.toThrow('UNIQUE constraint failed')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
  })

  it('锁错误首次、二次成功：重试一次后返回结果', async () => {
    const fn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw busyErr()
      })
      .mockImplementationOnce(() => 'saved')
    const log = vi.fn()
    const result = await executeWriteSafely(fn, { retries: 3, baseDelayMs: 1, log })
    expect(result).toBe('saved')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('锁错误持续：耗尽重试后 rethrow 原错误，且重试次数为上限', async () => {
    const fn = vi.fn(() => {
      throw busyErr()
    })
    const log = vi.fn()
    await expect(executeWriteSafely(fn, { retries: 2, baseDelayMs: 1, log })).rejects.toThrow(
      'database is locked'
    )
    // 首次 + 2 次重试 = 3 次调用
    expect(fn).toHaveBeenCalledTimes(3)
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('仅锁错误才续重试：首次 BUSY、二次约束错误 → 立即 rethrow 约束错误', async () => {
    const fn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw busyErr()
      })
      .mockImplementationOnce(() => {
        throw constraintErr()
      })
    const log = vi.fn()
    await expect(executeWriteSafely(fn, { retries: 3, baseDelayMs: 1, log })).rejects.toThrow(
      'UNIQUE constraint failed'
    )
    expect(fn).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledTimes(1)
  })
})

describe('walCheckpoint', () => {
  it('默认 TRUNCATE 模式拼接 pragma', () => {
    const pragma = vi.fn()
    walCheckpoint({ pragma }, 'TRUNCATE')
    expect(pragma).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)')
  })

  it('PASSIVE 模式拼接 pragma', () => {
    const pragma = vi.fn()
    walCheckpoint({ pragma }, 'PASSIVE')
    expect(pragma).toHaveBeenCalledWith('wal_checkpoint(PASSIVE)')
  })

  it('pragma 抛错时透传异常（由调用方 try/catch 处理）', () => {
    const pragma = vi.fn(() => {
      throw new Error('io error')
    })
    expect(() => walCheckpoint({ pragma })).toThrow('io error')
  })
})
