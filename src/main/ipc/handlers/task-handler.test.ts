/**
 * @layer L3
 * @module src/main/ipc/handlers/task-handler
 * @coverage task 域 IPC handler（task:cancel）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../../shared/errors/app-error'
import { createSchemasMock, makeCtx, getHandler } from './_test-helpers'

const { handleMock, taskRegistryCancelMock, assertFileReadPathMock, assertFileWritePathMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    taskRegistryCancelMock: vi.fn(),
    assertFileReadPathMock: vi.fn(),
    assertFileWritePathMock: vi.fn()
  }))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock, on: vi.fn() } }))

vi.mock('../../utils/task-registry', () => ({
  taskRegistry: { cancel: taskRegistryCancelMock }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

vi.mock('../validator', () => ({
  wrapHandler: vi.fn(
    (ctx: unknown, _schema: unknown, handler: (args: unknown[]) => unknown) =>
      async (...args: unknown[]) => {
        try {
          const data = await handler(args.length === 1 && Array.isArray(args[0]) ? args[0] : args)
          return { success: true as const, data }
        } catch (e) {
          if (e instanceof AppError) return { success: false as const, error: e.toIpcError() }
          return {
            success: false as const,
            error: {
              code: 'IPC_INTERNAL_ERROR',
              message: e instanceof Error ? e.message : String(e)
            }
          }
        }
      }
  ),
  wrapHandlerNoArgs: vi.fn(),
  wrapHandlerRaw: vi.fn(),
  schemas: createSchemasMock(),
  assertFileReadPath: assertFileReadPathMock,
  assertFileWritePath: assertFileWritePathMock
}))

import { registerTaskHandlers } from './task-handler'

describe('registerTaskHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    taskRegistryCancelMock.mockReset()
    assertFileReadPathMock.mockReset()
    assertFileWritePathMock.mockReset()
  })

  it('应注册 task:cancel channel', () => {
    registerTaskHandlers(makeCtx({}))
    expect(handleMock.mock.calls.map((c) => c[0])).toContain('task:cancel')
  })

  it('task:cancel 调用 taskRegistry.cancel 并返回 cancelled=true', async () => {
    taskRegistryCancelMock.mockReturnValue(true)
    registerTaskHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'task:cancel')(['task-1'])) as {
      success: true
      data: { cancelled: boolean; taskId: string }
    }
    expect(taskRegistryCancelMock).toHaveBeenCalledWith('task-1')
    expect(result.data.cancelled).toBe(true)
    expect(result.data.taskId).toBe('task-1')
  })

  it('task:cancel 任务不存在时返回 cancelled=false', async () => {
    taskRegistryCancelMock.mockReturnValue(false)
    registerTaskHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'task:cancel')(['no-exist'])) as {
      success: true
      data: { cancelled: boolean }
    }
    expect(result.data.cancelled).toBe(false)
  })
})
