/**
 * @layer L3
 * @module src/main/ipc/handlers/theme-handler
 * @coverage ui-theme 域 IPC handler（ui-theme:get / set）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler } from './_test-helpers'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock, on: vi.fn() } }))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerThemeHandlers } from './theme-handler'

describe('registerThemeHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
  })

  it('应注册 ui-theme:get / ui-theme:set channel', () => {
    registerThemeHandlers(makeCtx({}))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('ui-theme:get')
    expect(channels).toContain('ui-theme:set')
  })

  it('ui-theme:get 从 settings 读取，默认为 default', async () => {
    const ctx = makeCtx({})
    ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockReturnValue('soft-pink-luxury')
    registerThemeHandlers(ctx)
    const result = (await getHandler(handleMock, 'ui-theme:get')()) as {
      success: true
      data: { theme: string }
    }
    expect(ctx.dbManager.getSetting).toHaveBeenCalledWith('uiTheme', 'default')
    expect(result.data.theme).toBe('soft-pink-luxury')
  })

  it('ui-theme:set 调用 applyUITheme', async () => {
    const ctx = makeCtx({})
    registerThemeHandlers(ctx)
    const result = (await getHandler(handleMock, 'ui-theme:set')(['soft-pink-luxury'])) as {
      success: true
      data: { applied: boolean }
    }
    expect(ctx.applyUITheme).toHaveBeenCalledWith('soft-pink-luxury')
    expect(result.data.applied).toBe(true)
  })
})
