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
  // 注入的候选根必须是**两侧宿主都能创建**的临时目录：`/mock/...` 这类假绝对路径
  // 在开发机上是盘符相对路径、建得起来，在 CI 的容器里 `/` 属 root ⇒ EACCES，
  // 于是被测代码的「首个可创建者采用」循环会静默跳到下一个候选，
  // 断言拿到的是未注入的真实 `os.homedir()`/`os.tmpdir()`（2026-10-19 CI 两条红即为此）。
  it('documents 可用时返回 documents/喵星图/Diagnostics 并确保目录已创建', async () => {
    const { getUserFacingDiagDir } = await import('./user-diag-path')
    const docs = path.join(tmpDiag, 'Documents')
    const dir = getUserFacingDiagDir({ getDocumentsPath: () => docs })
    expect(dir).toBe(path.join(docs, '喵星图', 'Diagnostics'))
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('documents 抛错时回退到 homedir', async () => {
    const { getUserFacingDiagDir } = await import('./user-diag-path')
    const home = path.join(tmpDiag, 'home')
    const dir = getUserFacingDiagDir({
      getDocumentsPath: () => {
        throw new Error('not ready')
      },
      getHomedir: () => home
    })
    expect(dir).toBe(path.join(home, '喵星图', 'Diagnostics'))
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('documents 存在但不可创建时回退到 homedir（候选链真的在试可写性，不是只看存在）', async () => {
    const { getUserFacingDiagDir } = await import('./user-diag-path')
    // 用一个**同名普通文件**占位：在它下面建子目录在 Windows 与 Linux 上都会失败
    // （ENOTDIR），这才是可移植的「不可写候选」装置；CI 上表现为 EACCES，同一分支。
    const blocker = path.join(tmpDiag, 'blocker.txt')
    fs.writeFileSync(blocker, 'x', 'utf-8')
    const home = path.join(tmpDiag, 'home2')
    const dir = getUserFacingDiagDir({
      getDocumentsPath: () => path.join(blocker, 'Documents'),
      getHomedir: () => home
    })
    expect(dir).toBe(path.join(home, '喵星图', 'Diagnostics'))
    expect(fs.existsSync(dir)).toBe(true)
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
    expect(dir).toBe(path.join('/mock/tmp', '喵星图-Diagnostics'))
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
    const emergency = path.join(os.tmpdir(), 'MeowStarMap-startup-errors.log')
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

/**
 * 缺陷背景（2026-10-15 v2.5.3 线上启动闪退，docs/archive/plans/2026-10-15-media-stream-cancel-race-fix.md（已归档，不入仓））：
 * undici 对 Node 流 body 的包装（ReadableStreamFrom）在请求取消竞态下对已关闭流执行
 * 无守卫 close，抛 ERR_INVALID_STATE: Invalid state: ReadableStream is already closed
 * （堆栈仅平台帧：ReadableByteStreamController.close ← undici ← processTicksAndRejections）。
 * 该异常发生在已分离的微任务中、无应用状态受损，但被本模块"一律致命"策略升级为
 * app.exit(1)，与渲染进程媒体请求取消风暴叠加形成崩溃循环（用户感知为"启动失败"）。
 *
 * 与 spawn 分级同理：已知良性的流状态竞态在应用已就绪（有主窗口）后降级为仅记录。
 */
describe('reportEarlyFatal 流状态竞态错误分级（2026-10-15 启动闪退修复）', () => {
  /** 构造与生产 startup-errors.log 完全同构的错误对象（code + message + TypeError 类型） */
  function makeStreamRaceError(): TypeError {
    return Object.assign(new TypeError('Invalid state: ReadableStream is already closed'), {
      code: 'ERR_INVALID_STATE'
    })
  }

  it('T5【缺陷复现】已开窗口时降级为仅记录：不弹致命框、不释放锁、不退出', async () => {
    const { reportEarlyFatal } = await import('./early-crash-guard')
    const { logFaultSync } = await import('./logger')
    const { diagLog } = await import('./startup-diagnostic')
    const showErrorBox = vi.fn()
    const exitApp = vi.fn()
    const releaseLock = vi.fn()

    reportEarlyFatal(makeStreamRaceError(), {
      stage: 'index.uncaughtException',
      deps: { showErrorBox, exitApp, releaseLock, hasMainWindow: () => true }
    })

    // 降级而非致命：不弹框、不退出、不释放锁
    expect(showErrorBox).not.toHaveBeenCalled()
    expect(exitApp).not.toHaveBeenCalled()
    expect(releaseLock).not.toHaveBeenCalled()
    // 但必须留痕：faults 通道带 declassified 标记，供线上检索同类竞态的来源
    expect(logFaultSync).toHaveBeenCalledWith(
      'uncaughtException',
      expect.any(TypeError),
      expect.objectContaining({ declassified: 'stream-race' })
    )
    expect(diagLog).toHaveBeenCalledWith(
      'STREAM-RACE-NONFATAL',
      expect.stringContaining('ReadableStream is already closed')
    )
  })

  it('T6【护栏·边界】未开窗口（启动期）时仍按致命处理：弹「启动失败」并退出', async () => {
    const { reportEarlyFatal } = await import('./early-crash-guard')
    const showErrorBox = vi.fn()
    const exitApp = vi.fn()

    reportEarlyFatal(makeStreamRaceError(), {
      deps: { showErrorBox, exitApp, hasMainWindow: () => false }
    })

    expect(String(showErrorBox.mock.calls[0][0])).toContain('启动失败')
    expect(exitApp).toHaveBeenCalledWith(1)
  })

  it('T7【护栏·窄分类】ERR_INVALID_STATE 但消息不匹配 / 非对象入参 → 仍致命或分类为否', async () => {
    const { reportEarlyFatal } = await import('./early-crash-guard')

    // 其他 invalid state（非 ReadableStream 竞态）+ 有窗口 → 仍致命（分类必须收窄）
    const otherInvalid = Object.assign(
      new TypeError('Invalid state: socket is already connected'),
      {
        code: 'ERR_INVALID_STATE'
      }
    )
    const showErrorBox = vi.fn()
    const exitApp = vi.fn()
    reportEarlyFatal(otherInvalid, {
      deps: { showErrorBox, exitApp, hasMainWindow: () => true }
    })
    expect(String(showErrorBox.mock.calls[0][0])).toContain('启动失败')
    expect(exitApp).toHaveBeenCalledWith(1)
  })

  it('T7b【护栏·边界】非对象入参不命中流竞态分类，仍走致命路径', async () => {
    const { reportEarlyFatal } = await import('./early-crash-guard')
    const showErrorBox = vi.fn()
    const exitApp = vi.fn()

    // 非对象入参（null/字符串等）无法携带 code/message，分类函数必须判否，
    // 不能被降级分支吞掉——否则真实的非异常值上报将静默丢失。
    reportEarlyFatal(null, {
      deps: { showErrorBox, exitApp, hasMainWindow: () => true }
    })

    expect(String(showErrorBox.mock.calls[0][0])).toContain('启动失败')
    expect(exitApp).toHaveBeenCalledWith(1)
  })
})
