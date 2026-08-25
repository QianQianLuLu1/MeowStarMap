/**
 * FIX(组6-2) 回归测试：plugin:db.query 表白名单校验收紧为
 * "SQL 中出现的所有已知表名都必须 ∈ 白名单"，堵住子查询绕过。
 *
 * @layer L2（依赖 mock：electron / validator / plugin-host / permission-guard / i18n）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../../../shared/errors/app-error'

const { handleMock, assertPluginPermissionMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  assertPluginPermissionMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() }
}))

vi.mock('../validator', () => ({
  wrapHandler: vi.fn(),
  wrapHandlerNoArgs: vi.fn(),
  ok: vi.fn(),
  pathGuard: { register: vi.fn(), registerRoots: vi.fn() },
  // 简化包装器：直接调用 handler(args, ctx, event)，AppError → toIpcError
  wrapHandlerRaw: vi.fn(
    (_ctx: unknown, handler: (args: unknown[], ctx?: unknown, event?: unknown) => unknown) =>
      async (_event: unknown, ...args: unknown[]) => {
        try {
          const data = await handler(args, _ctx, _event)
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
  )
}))

vi.mock('../../../plugins/plugin-host', () => ({ pluginHost: {} }))
vi.mock('../../../plugins/permission-guard', () => ({
  assertPluginPermission: assertPluginPermissionMock,
  assertTrustedManagementCaller: vi.fn(),
  inferPluginName: vi.fn(() => 'test-plugin')
}))
vi.mock('../../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../../database/media-repository', () => ({ MediaRepository: vi.fn() }))
vi.mock('../../../utils/progress-throttle', () => ({ ProgressThrottle: vi.fn() }))
vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fault: vi.fn() }
}))

import { registerPluginBridgeHandlers } from '../plugin-bridge-handler'

/** 从 handleMock 中取出指定 channel 的包装后 handler */
function getHandler(channel: string): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  const call = handleMock.mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`channel ${channel} 未注册`)
  return call[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>
}

describe('plugin:db.query 表白名单（组6-2）', () => {
  const prepareMock = vi.fn(() => ({ all: vi.fn(() => [{ id: 1 }]) }))
  const ctx = {
    dbManager: { getDatabase: () => ({ prepare: prepareMock }) }
  } as unknown as Parameters<typeof registerPluginBridgeHandlers>[0]

  beforeEach(() => {
    handleMock.mockClear()
    assertPluginPermissionMock.mockReset()
    prepareMock.mockClear()
    registerPluginBridgeHandlers(ctx)
  })

  it('合法查询（白名单表 + 参数绑定）通过校验并执行', async () => {
    const result = (await getHandler('plugin:db.query')(
      { sender: {} },
      'SELECT id, file_path FROM media_files WHERE rating > ?',
      [3]
    )) as { success: boolean }
    expect(result.success).toBe(true)
    expect(prepareMock).toHaveBeenCalledWith(
      'SELECT id, file_path FROM media_files WHERE rating > ?'
    )
  })

  it('FIX(组6-2): 外层含白名单表但子查询引用非白名单表 → 拒绝且不触达 DB', async () => {
    const result = (await getHandler('plugin:db.query')(
      { sender: {} },
      'SELECT id FROM media_files WHERE id IN (SELECT id FROM operation_history)'
    )) as { success: boolean; error: { code: string } }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_PATH_FORBIDDEN')
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('FIX(组6-2): 仅查询 sqlite_master 等内部表（无白名单表）→ 拒绝', async () => {
    const result = (await getHandler('plugin:db.query')(
      { sender: {} },
      'SELECT name, sql FROM sqlite_master'
    )) as { success: boolean }
    expect(result.success).toBe(false)
  })

  it('FIX(组6-2): 字符串字面量中出现受保护表名不误伤（合法查询放行）', async () => {
    const result = (await getHandler('plugin:db.query')(
      { sender: {} },
      "SELECT id FROM media_files WHERE notes = 'operation_history'"
    )) as { success: boolean }
    expect(result.success).toBe(true)
    expect(prepareMock).toHaveBeenCalled()
  })

  it('非 SELECT 语句 → 拒绝（既有行为保持）', async () => {
    const result = (await getHandler('plugin:db.query')(
      { sender: {} },
      'DELETE FROM media_files'
    )) as { success: boolean }
    expect(result.success).toBe(false)
  })
})
