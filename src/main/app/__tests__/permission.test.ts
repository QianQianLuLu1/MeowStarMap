import { describe, it, expect, vi, beforeEach } from 'vitest'

// 主进程模块，必须 mock electron 与 child_process
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    relaunch: vi.fn(),
    quit: vi.fn()
  },
  dialog: {
    showMessageBox: vi.fn()
  }
}))
vi.mock('child_process', () => ({
  spawn: vi.fn()
}))
vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

import { app, dialog } from 'electron'
import { spawn } from 'child_process'
import { logger } from '../../utils/logger'
import { promptAdminRelaunch, requestAdminRelaunch, __resetPermissionPrompt } from '../permission'

const mockRelaunch = app.relaunch as unknown as ReturnType<typeof vi.fn>
const mockQuit = app.quit as unknown as ReturnType<typeof vi.fn>
const mockShowMessageBox = dialog.showMessageBox as unknown as ReturnType<typeof vi.fn>
const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>
const mockLoggerError = logger.error as unknown as ReturnType<typeof vi.fn>

/** 构造带 on()/unref() 的 mock 子进程，errorHandlers 供测试触发 'error' 事件 */
function makeMockChild() {
  const handlers: Array<(err: Error) => void> = []
  return {
    on(event: string, cb: (err: Error) => void) {
      if (event === 'error') handlers.push(cb)
      return this
    },
    unref: vi.fn(),
    emitError(err: Error) {
      handlers.forEach((h) => h(err))
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetPermissionPrompt()
  ;(app as { isPackaged: boolean }).isPackaged = false
  // 默认返回一个合法的 mock 子进程（带 on / unref），适配新的 child.on / unref 调用
  mockSpawn.mockImplementation(() => makeMockChild())
})

describe('requestAdminRelaunch', () => {
  it('开发模式（非打包）：直接 relaunch + quit，不 spawn powershell', async () => {
    await requestAdminRelaunch()
    expect(mockRelaunch).toHaveBeenCalledTimes(1)
    expect(mockQuit).toHaveBeenCalledTimes(1)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('打包模式：通过 powershell Start-Process -Verb RunAs 提升并 quit（成功路径）', async () => {
    ;(app as { isPackaged: boolean }).isPackaged = true
    await requestAdminRelaunch()
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const args = mockSpawn.mock.calls[0] as unknown[]
    expect(String(args[0])).toContain('powershell.exe')
    expect(String(args[1])).toContain('RunAs')
    expect(mockQuit).toHaveBeenCalledTimes(1)
    expect(mockRelaunch).not.toHaveBeenCalled()
  })

  it('打包模式 spawn 异步 ENOENT 时降级为普通重启并打日志', async () => {
    ;(app as { isPackaged: boolean }).isPackaged = true
    const child = makeMockChild()
    mockSpawn.mockReturnValue(child)
    await requestAdminRelaunch()
    // 同步阶段已调用一次 quit，并注册了 error 监听器
    expect(mockQuit).toHaveBeenCalledTimes(1)
    expect(mockRelaunch).not.toHaveBeenCalled()

    // 模拟 PowerShell 被组策略禁用 / PATH 被裁剪 → 异步 error 事件
    child.emitError(new Error('spawn ENOENT'))

    // 降级：普通 relaunch + quit，且记录日志，且不抛未捕获异常
    expect(mockRelaunch).toHaveBeenCalledTimes(1)
    expect(mockQuit).toHaveBeenCalledTimes(2)
    expect(mockLoggerError).toHaveBeenCalledTimes(1)
  })

  it('打包模式 spawn 同步抛错也降级为普通重启', async () => {
    ;(app as { isPackaged: boolean }).isPackaged = true
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn sync error')
    })
    await requestAdminRelaunch()
    expect(mockRelaunch).toHaveBeenCalledTimes(1)
    expect(mockQuit).toHaveBeenCalledTimes(1)
  })
})

describe('promptAdminRelaunch', () => {
  it('用户确认后触发 requestAdminRelaunch', async () => {
    mockShowMessageBox.mockResolvedValue({ response: 0 })
    await promptAdminRelaunch()
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1)
    expect(mockRelaunch).toHaveBeenCalledTimes(1)
  })

  it('用户取消（response=1）不触发重启', async () => {
    mockShowMessageBox.mockResolvedValue({ response: 1 })
    await promptAdminRelaunch()
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1)
    expect(mockRelaunch).not.toHaveBeenCalled()
  })

  it('幂等：单次会话只弹窗一次，重复调用不再弹窗', async () => {
    mockShowMessageBox.mockResolvedValue({ response: 0 })
    await promptAdminRelaunch()
    await promptAdminRelaunch()
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1)
  })
})
