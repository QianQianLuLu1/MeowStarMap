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

import { app, dialog } from 'electron'
import { spawn } from 'child_process'
import { promptAdminRelaunch, requestAdminRelaunch, __resetPermissionPrompt } from '../permission'

const mockRelaunch = app.relaunch as unknown as ReturnType<typeof vi.fn>
const mockQuit = app.quit as unknown as ReturnType<typeof vi.fn>
const mockShowMessageBox = dialog.showMessageBox as unknown as ReturnType<typeof vi.fn>
const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  __resetPermissionPrompt()
  ;(app as { isPackaged: boolean }).isPackaged = false
})

describe('requestAdminRelaunch', () => {
  it('开发模式（非打包）：直接 relaunch + quit，不 spawn powershell', async () => {
    await requestAdminRelaunch()
    expect(mockRelaunch).toHaveBeenCalledTimes(1)
    expect(mockQuit).toHaveBeenCalledTimes(1)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('打包模式：通过 powershell Start-Process -Verb RunAs 提升并 quit', async () => {
    ;(app as { isPackaged: boolean }).isPackaged = true
    mockSpawn.mockImplementation(() => ({}) as never)
    await requestAdminRelaunch()
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const args = mockSpawn.mock.calls[0] as unknown[]
    expect(String(args[0])).toContain('powershell.exe')
    expect(String(args[1])).toContain('RunAs')
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
