/**
 * @layer L2
 * @module src/main/ipc/ipc-observability
 * @coverage IPC 单点拦截器：失败落 fault / 校验失败 warn / CANCELED 静默 / 慢调用 warn / 抛错留痕后原样重抛 / 安装幂等
 * @dependencies utils/logger（logger + logFault）、shared/types/ipc-types（错误码常量）
 *
 * 契约：拦截器不改变 IPC 响应形状——成功且快的调用零写盘；
 * 所有观测逻辑 fail-open，观测自身异常绝不影响业务响应。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { performance } from 'node:perf_hooks'
import type { IpcMainInvokeEvent } from 'electron'

const { loggerWarnMock, loggerInfoMock, logFaultMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  logFaultMock: vi.fn(() => Promise.resolve())
}))

vi.mock('../utils/logger', () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: vi.fn(),
    debug: vi.fn()
  },
  logFault: logFaultMock
}))

import { observeIpcListener, installIpcObservability } from './ipc-observability'
import { IPC_ERROR_CODES } from '../../shared/types/ipc-types'

const event = {} as IpcMainInvokeEvent

beforeEach(() => {
  loggerWarnMock.mockClear()
  loggerInfoMock.mockClear()
  logFaultMock.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('observeIpcListener（响应观测）', () => {
  it('o1. 成功且快的调用：响应原样透传，零写盘', async () => {
    const payload = { success: true, data: [1, 2] }
    const wrapped = observeIpcListener('media:list', async () => payload)
    const res = await wrapped(event)
    expect(res).toBe(payload)
    expect(loggerWarnMock).not.toHaveBeenCalled()
    expect(loggerInfoMock).not.toHaveBeenCalled()
    expect(logFaultMock).not.toHaveBeenCalled()
  })

  it('o2. 业务失败（AppError 转 IpcError）→ logFault(ipcError) 带通道/错误码/details', async () => {
    const failure = {
      success: false,
      error: { code: 'IPC_PATH_FORBIDDEN', message: '路径不在白名单内', details: { path: '<...>' } }
    }
    const wrapped = observeIpcListener('file:delete', async () => failure)
    const res = await wrapped(event)
    expect(res).toBe(failure)
    expect(logFaultMock).toHaveBeenCalledWith(
      'ipcError',
      expect.any(Error),
      expect.objectContaining({ channel: 'file:delete', code: 'IPC_PATH_FORBIDDEN' })
    )
  })

  it('o3. CANCELED 静默：用户取消对话框不是故障，不落任何日志', async () => {
    const wrapped = observeIpcListener('log:exportZip', async () => ({
      success: false,
      error: { code: IPC_ERROR_CODES.CANCELED, message: '已取消' }
    }))
    await wrapped(event)
    expect(logFaultMock).not.toHaveBeenCalled()
    expect(loggerWarnMock).not.toHaveBeenCalled()
  })

  it('o4. VALIDATION_ERROR → logger.warn（含通道与校验细节），不升级为 fault', async () => {
    const wrapped = observeIpcListener('media:rate', async () => ({
      success: false,
      error: {
        code: IPC_ERROR_CODES.VALIDATION_ERROR,
        message: '参数校验失败',
        details: [{ path: [0], message: 'expected number' }]
      }
    }))
    await wrapped(event)
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('media:rate'),
      expect.objectContaining({ code: IPC_ERROR_CODES.VALIDATION_ERROR })
    )
    expect(logFaultMock).not.toHaveBeenCalled()
  })

  it('o5. 慢调用（>500ms）→ logger.warn 含通道与耗时', async () => {
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(600)
    const wrapped = observeIpcListener('scan:start', async () => ({ success: true, data: null }))
    await wrapped(event)
    expect(loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining('scan:start'))
    expect(String(loggerWarnMock.mock.calls[0][0])).toContain('600')
    nowSpy.mockRestore()
  })

  it('o6. listener 抛错（wrap* 之外的异常）→ 记 fault 后原样重抛，不吞契约', async () => {
    const boom = new Error('unexpected')
    const wrapped = observeIpcListener('app:probe', () => {
      throw boom
    })
    await expect(wrapped(event)).rejects.toBe(boom)
    expect(logFaultMock).toHaveBeenCalledWith(
      'ipcError',
      boom,
      expect.objectContaining({ channel: 'app:probe' })
    )
  })
})

describe('installIpcObservability（注册期单点安装）', () => {
  it('o7. 幂等：重复安装不双重包装（失败只记一次 fault）', async () => {
    const registered: Array<(event: unknown, ...args: unknown[]) => unknown> = []
    const fakeIpcMain = {
      handle: vi.fn((_channel: string, listener: (...args: unknown[]) => unknown) => {
        registered.push(listener)
      })
    }
    installIpcObservability(fakeIpcMain)
    installIpcObservability(fakeIpcMain)
    fakeIpcMain.handle('dup:channel', async () => ({
      success: false,
      error: { code: 'IPC_INTERNAL_ERROR', message: 'x' }
    }))
    expect(registered).toHaveLength(1)
    await registered[0](event)
    expect(logFaultMock).toHaveBeenCalledTimes(1)
  })
})
