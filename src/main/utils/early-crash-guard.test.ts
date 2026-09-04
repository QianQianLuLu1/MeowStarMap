/**
 * @layer L1
 * @module src/main/utils/early-crash-guard
 * @coverage getUserFacingDiagDir / showFatalStartupErrorBox / showNonFatalErrorBox / reportEarlyFatal（去重守卫、弹窗、落盘、退出）
 * @dependencies mock: electron (app/dialog/shell)、startup-diagnostic、logger
 * @remarks 每个用例 vi.resetModules + 动态 import，确保 reportEarlyFatal 的模块级去重/退出守卫回到初值
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

vi.mock('electron', () => ({
  app: {
    exit: vi.fn(),
    releaseSingleInstanceLock: vi.fn(),
    getPath: vi.fn((name: string) => `/mock/${name}`)
  },
  dialog: {
    showErrorBox: vi.fn()
  },
  shell: {
    showItemInFolder: vi.fn()
  }
}))

vi.mock('./startup-diagnostic', () => ({
  logStartupError: vi.fn(),
  diagLog: vi.fn()
}))

vi.mock('./logger', () => ({
  logFaultSync: vi.fn(() => 'mock-fault-id')
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('getUserFacingDiagDir', () => {
  it('documents 可用时返回 documents/NikkiGallery/Diagnostics 并确保目录已创建', async () => {
    const { getUserFacingDiagDir } = await import('./user-diag-path')
    const dir = getUserFacingDiagDir({ getDocumentsPath: () => '/mock/Documents' })
    expect(dir).toBe(path.join('/mock/Documents', 'NikkiGallery', 'Diagnostics'))
    expect(fs.existsSync(dir)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('documents 抛错时回退到 homedir', async () => {
    const { getUserFacingDiagDir } = await import('./user-diag-path')
    const dir = getUserFacingDiagDir({
      getDocumentsPath: () => {
        throw new Error('not ready')
      },
      getHomedir: () => '/mock/home'
    })
    expect(dir).toBe(path.join('/mock/home', 'NikkiGallery', 'Diagnostics'))
  })

  it('documents 与 homedir 均抛错时回退到 tmpdir', async () => {
    const { getUserFacingDiagDir } = await import('./user-diag-path')
    const dir = getUserFacingDiagDir({
      getDocumentsPath: () => {
        throw new Error('no')
      },
      getHomedir: () => {
        throw new Error('no')
      },
      getTmpdir: () => '/mock/tmp'
    })
    expect(dir).toBe(path.join('/mock/tmp', 'NikkiGallery-Diagnostics'))
  })
})

describe('showFatalStartupErrorBox', () => {
  it('弹框含「启动失败」与友好日志路径，并高亮日志文件', async () => {
    const { showFatalStartupErrorBox } = await import('./early-crash-guard')
    const showErrorBox = vi.fn()
    const showItem = vi.fn()
    showFatalStartupErrorBox(new Error('boom'), {
      deps: { showErrorBox, shellShowItemInFolder: showItem, getDiagDir: () => '/mock/diag' }
    })
    expect(showErrorBox).toHaveBeenCalledTimes(1)
    const [title, content] = showErrorBox.mock.calls[0]
    expect(String(title)).toContain('启动失败')
    expect(String(content)).toContain('boom')
    expect(String(content)).toContain(path.join('/mock/diag', 'startup-errors.log'))
    expect(showItem).toHaveBeenCalledWith(path.join('/mock/diag', 'startup-errors.log'))
  })
})

describe('showNonFatalErrorBox', () => {
  it('弹框含「程序出错」与友好日志路径，不退出', async () => {
    const { showNonFatalErrorBox } = await import('./early-crash-guard')
    const showErrorBox = vi.fn()
    const exitApp = vi.fn()
    showNonFatalErrorBox(new Error('oops'), {
      deps: { showErrorBox, exitApp, getDiagDir: () => '/mock/diag' }
    })
    expect(showErrorBox).toHaveBeenCalledTimes(1)
    const [title] = showErrorBox.mock.calls[0]
    expect(String(title)).toContain('程序出错')
    expect(exitApp).not.toHaveBeenCalled()
  })
})

describe('reportEarlyFatal', () => {
  it('完整致命处理：落盘 + 弹框 + 释放锁 + 退出', async () => {
    const { reportEarlyFatal } = await import('./early-crash-guard')
    const { logStartupError, diagLog } = await import('./startup-diagnostic')
    const { logFaultSync } = await import('./logger')
    const showErrorBox = vi.fn()
    const exitApp = vi.fn()
    const releaseLock = vi.fn()
    const showItem = vi.fn()

    reportEarlyFatal(new Error('fatal-boom'), {
      stage: 'init',
      deps: {
        showErrorBox,
        exitApp,
        releaseLock,
        shellShowItemInFolder: showItem,
        getDiagDir: () => '/mock/diag'
      }
    })

    expect(logStartupError).toHaveBeenCalledWith('init', expect.any(Error))
    expect(diagLog).toHaveBeenCalled()
    expect(logFaultSync).toHaveBeenCalledWith(
      'uncaughtException',
      expect.any(Error),
      expect.any(Object)
    )
    expect(showErrorBox).toHaveBeenCalledTimes(1)
    const content = showErrorBox.mock.calls[0][1] as string
    expect(content).toContain('fatal-boom')
    expect(content).toContain(path.join('/mock/diag', 'startup-errors.log'))
    expect(showItem).toHaveBeenCalledWith(path.join('/mock/diag', 'startup-errors.log'))
    expect(releaseLock).toHaveBeenCalledTimes(1)
    expect(exitApp).toHaveBeenCalledTimes(1)
    expect(exitApp).toHaveBeenCalledWith(1)
  })

  it('去重守卫：同一进程内重复调用只弹框/退出一次', async () => {
    const { reportEarlyFatal } = await import('./early-crash-guard')
    const showErrorBox = vi.fn()
    const exitApp = vi.fn()
    const deps = { showErrorBox, exitApp, getDiagDir: () => '/mock/diag' }
    reportEarlyFatal(new Error('first'), { deps })
    reportEarlyFatal(new Error('second'), { deps })
    expect(showErrorBox).toHaveBeenCalledTimes(1)
    expect(exitApp).toHaveBeenCalledTimes(1)
  })
})
