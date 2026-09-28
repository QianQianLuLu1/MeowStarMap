/**
 * @layer L1
 * @module src/main/utils/early-crash-guard
 * @coverage getUserFacingDiagDir / showFatalStartupErrorBox / showNonFatalErrorBox / reportEarlyFatal（去重守卫、弹窗、落盘、退出）
 * @dependencies mock: electron (app/dialog/shell)、startup-diagnostic、logger
 * @remarks 每个用例 vi.resetModules + 动态 import，确保 reportEarlyFatal 的模块级去重/退出守卫回到初值
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// 模拟 startup-diagnostic 的真实落盘行为：logStartupError 写入 getStartupLogPathValue() 指向的文件
const { getDiagTmpDir, setDiagTmpDir, getDiagWriteOk, setDiagWriteOk } = vi.hoisted(() => {
  let dir = ''
  let writeOk = true
  return {
    getDiagTmpDir: () => dir,
    setDiagTmpDir: (v: string) => {
      dir = v
    },
    getDiagWriteOk: () => writeOk,
    setDiagWriteOk: (v: boolean) => {
      writeOk = v
    }
  }
})

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
  logStartupError: vi.fn((stage: string, err: unknown) => {
    if (!getDiagWriteOk()) return
    try {
      fs.appendFileSync(
        path.join(getDiagTmpDir(), 'startup-errors.log'),
        `[${stage}] ${String(err)}\n`
      )
    } catch {
      /* 模拟落盘失败 */
    }
  }),
  diagLog: vi.fn(),
  getStartupLogPathValue: vi.fn(() => path.join(getDiagTmpDir(), 'startup-errors.log'))
}))

vi.mock('./logger', () => ({
  logFaultSync: vi.fn(() => 'mock-fault-id')
}))

let tmpDiag = ''

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  tmpDiag = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-ecg-diag-'))
  setDiagTmpDir(tmpDiag)
  setDiagWriteOk(true)
})

afterEach(() => {
  fs.rmSync(tmpDiag, { recursive: true, force: true })
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

describe('reportEarlyFatal 诊断日志可定位（回归：弹窗路径下必须能找到日志）', () => {
  it('不注入 getDiagDir 时弹窗展示路径 === 真实落盘路径，且文件存在', async () => {
    const { reportEarlyFatal } = await import('./early-crash-guard')
    const showErrorBox = vi.fn()
    reportEarlyFatal(new Error('boom'), { deps: { showErrorBox } })

    const expected = path.join(tmpDiag, 'startup-errors.log')
    const content = showErrorBox.mock.calls[0][1] as string
    expect(content).toContain(expected)
    expect(fs.existsSync(expected)).toBe(true)
  })

  it('落盘校验失败时改展示 tmpdir 应急日志，且该文件存在', async () => {
    setDiagWriteOk(false)
    const emergency = path.join(os.tmpdir(), 'NikkiGallery-startup-errors.log')
    try {
      fs.rmSync(emergency, { force: true })
    } catch {
      /* 首次运行文件不存在 */
    }
    const { reportEarlyFatal } = await import('./early-crash-guard')
    const showErrorBox = vi.fn()
    reportEarlyFatal(new Error('boom-no-write'), { deps: { showErrorBox } })

    const content = showErrorBox.mock.calls[0][1] as string
    expect(content).toContain(emergency)
    expect(fs.existsSync(emergency)).toBe(true)
  })
})

describe('reportEarlyFatal 子进程 spawn 类错误分级', () => {
  function makeSpawnError(): Error {
    return Object.assign(new Error('spawn EFTYPE'), {
      code: 'EFTYPE',
      syscall: 'spawn EFTYPE',
      path: 'tar.exe',
      spawnargs: ['-c', '--format=zip']
    })
  }

  it('已开窗口时降级为非致命：只弹「程序出错」，不释放锁不退出', async () => {
    const { reportEarlyFatal } = await import('./early-crash-guard')
    const showErrorBox = vi.fn()
    const exitApp = vi.fn()
    const releaseLock = vi.fn()

    reportEarlyFatal(makeSpawnError(), {
      deps: { showErrorBox, exitApp, releaseLock, hasMainWindow: () => true }
    })

    expect(showErrorBox).toHaveBeenCalledTimes(1)
    expect(String(showErrorBox.mock.calls[0][0])).toContain('程序出错')
    expect(releaseLock).not.toHaveBeenCalled()
    expect(exitApp).not.toHaveBeenCalled()
  })

  it('未开窗口（启动期）时仍按致命处理：弹「启动失败」并退出', async () => {
    const { reportEarlyFatal } = await import('./early-crash-guard')
    const showErrorBox = vi.fn()
    const exitApp = vi.fn()

    reportEarlyFatal(makeSpawnError(), {
      deps: { showErrorBox, exitApp, hasMainWindow: () => false }
    })

    expect(String(showErrorBox.mock.calls[0][0])).toContain('启动失败')
    expect(exitApp).toHaveBeenCalledWith(1)
  })

  it('非致命去重：同一进程内连续 spawn 错误只弹一次模态框', async () => {
    const { reportEarlyFatal } = await import('./early-crash-guard')
    const showErrorBox = vi.fn()
    const deps = { showErrorBox, hasMainWindow: () => true, getDiagDir: () => '/mock/diag' }

    // 模拟 index.ts 与 error-handlers.ts 双监听器同时触发
    reportEarlyFatal(makeSpawnError(), { deps })
    reportEarlyFatal(makeSpawnError(), { deps })

    // 去重守卫应确保仅弹一次框
    expect(showErrorBox).toHaveBeenCalledTimes(1)
  })

  it('非致命分支补落盘：spawn 降级时仍写 startup-errors.log', async () => {
    const { reportEarlyFatal } = await import('./early-crash-guard')
    const { logStartupError } = await import('./startup-diagnostic')
    const showErrorBox = vi.fn()

    reportEarlyFatal(makeSpawnError(), {
      stage: 'video-extract',
      deps: { showErrorBox, hasMainWindow: () => true }
    })

    // 弹窗指向 startup-errors.log，该日志必须包含本次错误
    expect(logStartupError).toHaveBeenCalledWith('video-extract', expect.any(Error))
  })
})
