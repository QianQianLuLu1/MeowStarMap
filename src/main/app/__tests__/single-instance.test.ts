/**
 * @layer L3
 * @module src/main/app/single-instance
 * @coverage 单实例锁获取 + 失败路径（6×1s 重试 / 三选项对话框 / 清理重启）
 * @dependencies electron (app/dialog)、child_process (execFileSync/exec)、i18n（真实 zh-CN）、
 *               utils/startup-diagnostic、app/exit-forensics、app/native-load-guard
 *
 * R1（2026-11-15）：锁获取从 lifecycle.ts（动态 import Application + 构造 16 服务之后）
 * 前移到 index.ts whenReady 首行。本文件从 lifecycle.test.ts 迁移锁用例簇
 * （用例 1/1c/2/3/4/5/6/6b/7/E1/36），调用对象从 bootstrapApplication(ctx) 改为
 * acquireSingleInstanceLockOrHandleFailure()，断言语义逐条对应、零丢失。
 *
 * 测试策略：
 * 1. electron / child_process / 诊断 / 取证 / native-load-guard 全部 vi.mock
 * 2. t() 走真实 i18n（zh-CN 静态加载，与 lifecycle.test.ts 同口径），文案断言用真实值
 * 3. 锁重试用 vi.useFakeTimers + advanceTimersByTimeAsync
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { setForensicsEnvProvider } from '../../utils/forensics-dir'
import { setDocumentsPathProvider } from '../../utils/user-diag-path'
import path from 'path'

// ============================================================================
// vi.hoisted：共享 mock
// ============================================================================
const m = vi.hoisted(() => {
  return {
    // electron app
    requestSingleInstanceLockMock: vi.fn(() => true),
    whenReadyMock: vi.fn(() => Promise.resolve()),
    appQuitMock: vi.fn(),
    appExitMock: vi.fn(),
    appRelaunchMock: vi.fn(),
    appReleaseSingleInstanceLockMock: vi.fn(),
    appGetPathMock: vi.fn((p: string) => `/mock/${p}`),
    // dialog
    dialogShowMessageBoxMock: vi.fn(() => Promise.resolve({ response: 0 })),
    // child_process
    execFileSyncMock: vi.fn(() => ''),
    execMock: vi.fn(),
    // diagnostic
    logStartupErrorMock: vi.fn(),
    diagLogMock: vi.fn(),
    // F3：清理并重启前复位死亡证据
    clearDeathEvidenceForRelaunchMock: vi.fn(),
    // 启动失败统一可见兜底
    showStartupFailureWithFallbackMock: vi.fn(),
    // 1c：锁失败路径零启动打点——新模块不得调用这些赢家专属打点
    initExitForensicsMock: vi.fn(),
    markExitStageMock: vi.fn(),
    markBootAttemptMock: vi.fn(),
    setupGpuProcessWatcherMock: vi.fn(),
    verifyCriticalNativeModulesMock: vi.fn()
  }
})

// ============================================================================
// vi.mock：外部依赖
// ============================================================================
vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: m.requestSingleInstanceLockMock,
    whenReady: m.whenReadyMock,
    quit: m.appQuitMock,
    exit: m.appExitMock,
    relaunch: m.appRelaunchMock,
    releaseSingleInstanceLock: m.appReleaseSingleInstanceLockMock,
    getPath: m.appGetPathMock
  },
  dialog: {
    showMessageBox: m.dialogShowMessageBoxMock
  }
}))

vi.mock('child_process', () => ({
  execFileSync: m.execFileSyncMock,
  exec: m.execMock
}))

vi.mock('../../utils/startup-diagnostic', () => ({
  logStartupError: m.logStartupErrorMock,
  diagLog: m.diagLogMock
}))

vi.mock('../exit-forensics', () => ({
  initExitForensics: m.initExitForensicsMock,
  markExitStage: m.markExitStageMock,
  clearDeathEvidenceForRelaunch: m.clearDeathEvidenceForRelaunchMock
}))

vi.mock('../gpu-fallback', () => ({
  markBootAttempt: m.markBootAttemptMock,
  setupGpuProcessWatcher: m.setupGpuProcessWatcherMock
}))

vi.mock('../native-load-guard', () => ({
  verifyCriticalNativeModules: m.verifyCriticalNativeModulesMock,
  showStartupFailureWithFallback: m.showStartupFailureWithFallbackMock
}))

import {
  acquireSingleInstanceLockOrHandleFailure,
  writeSecondInstanceAck
} from '../single-instance'

// ============================================================================
// 测试用例
// ============================================================================
describe('single-instance - acquireSingleInstanceLockOrHandleFailure', () => {
  beforeEach(() => {
    Object.values(m).forEach((mock) => {
      if (typeof mock === 'function' && 'mock' in mock) {
        mock.mockClear()
      }
    })
    // 默认实现
    m.requestSingleInstanceLockMock.mockReturnValue(true)
    m.whenReadyMock.mockResolvedValue(undefined)
    m.dialogShowMessageBoxMock.mockResolvedValue({ response: 0 })
    m.execFileSyncMock.mockReturnValue('')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('1. 首次拿到锁 → 返回 true，不弹任何对话框', async () => {
    await expect(acquireSingleInstanceLockOrHandleFailure()).resolves.toBe(true)
    expect(m.requestSingleInstanceLockMock).toHaveBeenCalledTimes(1)
    expect(m.dialogShowMessageBoxMock).not.toHaveBeenCalled()
  })

  it('2. 首次 false，1s 后重试拿到锁 → 返回 true，不弹"已有实例运行"', async () => {
    vi.useFakeTimers()
    // 第 1 次 false，第 2 次 true
    m.requestSingleInstanceLockMock.mockReturnValueOnce(false).mockReturnValueOnce(true)

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(1000)
    await expect(promise).resolves.toBe(true)

    // 首次 + 1 次重试 = 2 次
    expect(m.requestSingleInstanceLockMock).toHaveBeenCalledTimes(2)
    expect(m.dialogShowMessageBoxMock).not.toHaveBeenCalled()
  })

  it('3. 6 次重试均失败 → 弹"已有实例运行"三选项对话框', async () => {
    vi.useFakeTimers()
    m.requestSingleInstanceLockMock.mockReturnValue(false)
    // 用户选"退出"
    m.dialogShowMessageBoxMock.mockResolvedValue({ response: 2 })

    const promise = acquireSingleInstanceLockOrHandleFailure()
    // F4：6×1s 重试覆盖 before-quit 清理的 WAL checkpoint 耗时（2-5s）
    await vi.advanceTimersByTimeAsync(6000)
    await promise

    // 7 次调用（首次 + 6 次重试）
    expect(m.requestSingleInstanceLockMock).toHaveBeenCalledTimes(7)
    const firstDialog = m.dialogShowMessageBoxMock.mock.calls[0][0]
    expect(firstDialog.buttons).toHaveLength(3)
    expect(firstDialog.buttons).toEqual(['清理并重启', '手动处理', '退出'])
  })

  it('4. 用户选"清理并重启"：PowerShell 杀死其他进程后 relaunch + exit(0)', async () => {
    vi.useFakeTimers()
    m.requestSingleInstanceLockMock.mockReturnValue(false)
    // 用户选"清理并重启"
    m.dialogShowMessageBoxMock.mockResolvedValue({ response: 0 })
    // execFileSync：powershell 返回 PID 列表，taskkill 成功
    m.execFileSyncMock.mockImplementation((cmd: unknown) => {
      if (cmd === 'powershell') return '12345\n'
      return ''
    })

    const promise = acquireSingleInstanceLockOrHandleFailure()
    // 推进重试循环（6s）+ 微任务（whenReady + dialog）+ relaunch 定时器（2s）
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2000)
    await promise

    expect(m.appRelaunchMock).toHaveBeenCalledTimes(1)
    expect(m.appExitMock).toHaveBeenCalledWith(0)
    // F3：taskkill 留下的陈旧心跳会被 relaunch 后的新实例误判成"被原生层杀死"
    // 而白升 GPU 兼容档——重启前必须显式清掉这份死亡证据
    expect(m.clearDeathEvidenceForRelaunchMock).toHaveBeenCalledTimes(1)
  })

  it('5. PowerShell 杀进程全部失败（killedAny=false）→ 弹"清理失败"框，不重启', async () => {
    vi.useFakeTimers()
    m.requestSingleInstanceLockMock.mockReturnValue(false)
    // 用户选"清理并重启"，第二次选"退出"
    m.dialogShowMessageBoxMock
      .mockResolvedValueOnce({ response: 0 })
      .mockResolvedValueOnce({ response: 1 })
    // execFileSync 全部抛错
    m.execFileSyncMock.mockImplementation(() => {
      throw new Error('powershell failed')
    })

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(0)
    await promise

    // 弹了 2 次对话框
    expect(m.dialogShowMessageBoxMock).toHaveBeenCalledTimes(2)
    // 第二次是"清理失败"对话框
    const secondCall = m.dialogShowMessageBoxMock.mock.calls[1][0]
    expect(secondCall.title).toBe('清理失败')
    // 未重启
    expect(m.appRelaunchMock).not.toHaveBeenCalled()
    // 调用了 app.quit
    expect(m.appQuitMock).toHaveBeenCalledTimes(1)
  })

  it('6. 用户选"手动处理"：打开任务管理器后 app.quit', async () => {
    vi.useFakeTimers()
    m.requestSingleInstanceLockMock.mockReturnValue(false)
    m.dialogShowMessageBoxMock.mockResolvedValue({ response: 1 })

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(0)
    await promise

    expect(m.execMock).toHaveBeenCalledWith('taskmgr', { windowsHide: false })
    expect(m.appQuitMock).toHaveBeenCalledTimes(1)
  })

  it('6b. exec("taskmgr") 启动失败时错误被 error 监听记录，不冒泡为未捕获异常', async () => {
    vi.useFakeTimers()
    m.requestSingleInstanceLockMock.mockReturnValue(false)
    m.dialogShowMessageBoxMock.mockResolvedValue({ response: 1 })
    // exec 返回带 on() 的子进程句柄
    const onMock = vi.fn()
    m.execMock.mockReturnValueOnce({ on: onMock })

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(0)
    await promise

    expect(m.execMock).toHaveBeenCalledWith('taskmgr', { windowsHide: false })
    // 必须挂载 error 监听：否则 spawn 失败（如 taskmgr 被禁用）会冒泡成
    // uncaughtException → reportEarlyFatal → 假「启动失败 / 程序已退出」
    const errorCall = onMock.mock.calls.find((c) => c[0] === 'error')
    expect(errorCall).toBeDefined()

    const spawnErr = Object.assign(new Error('spawn EFTYPE'), {
      code: 'EFTYPE',
      syscall: 'spawn EFTYPE'
    })
    const handler = errorCall![1] as (e: unknown) => void
    expect(() => handler(spawnErr)).not.toThrow()
    expect(m.logStartupErrorMock).toHaveBeenCalledWith('exec-taskmgr', spawnErr)
  })

  it('7. 用户选"退出"：app.quit 且不 app.exit、不 relaunch（含原用例 36 语义）', async () => {
    vi.useFakeTimers()
    m.requestSingleInstanceLockMock.mockReturnValue(false)
    m.dialogShowMessageBoxMock.mockResolvedValue({ response: 2 })

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(0)
    await promise

    expect(m.appQuitMock).toHaveBeenCalledTimes(1)
    expect(m.appRelaunchMock).not.toHaveBeenCalled()
    // 原用例 36：锁失败实例不持锁，退出走 app.quit() 而非 app.exit(1)
    expect(m.appExitMock).not.toHaveBeenCalled()
  })

  it('1c. 锁失败路径（第二实例）不做任何启动打点与预检（F2+F5 赢家专属约束）', async () => {
    vi.useFakeTimers()
    m.requestSingleInstanceLockMock.mockReturnValue(false)
    // 用户选"退出"
    m.dialogShowMessageBoxMock.mockResolvedValue({ response: 2 })

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(0)
    await promise

    expect(m.verifyCriticalNativeModulesMock).not.toHaveBeenCalled()
    expect(m.initExitForensicsMock).not.toHaveBeenCalled()
    expect(m.markExitStageMock).not.toHaveBeenCalled()
    expect(m.markBootAttemptMock).not.toHaveBeenCalled()
    expect(m.setupGpuProcessWatcherMock).not.toHaveBeenCalled()
    expect(m.appQuitMock).toHaveBeenCalledTimes(1)
  })

  it('E1. 锁失败对话框抛错时仍有一次可见兜底，且正常退出', async () => {
    vi.useFakeTimers()
    m.requestSingleInstanceLockMock.mockReturnValue(false)
    m.dialogShowMessageBoxMock.mockRejectedValueOnce(new Error('dialog unavailable'))

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(0)
    await promise
    vi.useRealTimers()

    expect(m.showStartupFailureWithFallbackMock).toHaveBeenCalled()
    expect(m.appQuitMock).toHaveBeenCalled()
  })
})

// ============================================================================
// B（2026-11-15）：second-instance ack 静默让位
// 健康赢家运行/启动中时，输家 6s 重试耗尽后检测到新鲜 ack → app.quit 静默退出，
// 不弹「已有实例运行」（窗口已聚焦却又弹报错 = 用户感知异常）。
// 僵尸/挂死进程不写 ack（或陈旧）→ 仍走三选项对话框，「清理并重启」路径不变。
// 测试用真实 fs + 临时目录（userData 经 app.getPath mock 指向），时间边界用 fake timers 钉死。
// ============================================================================
describe('single-instance - second-instance ack 静默让位（B）', () => {
  let tmpDir: string

  beforeEach(() => {
    // 独立顶层 describe 不共享外层 beforeEach：必须自清 mock，否则跨用例调用计数累积
    Object.values(m).forEach((mock) => {
      if (typeof mock === 'function' && 'mock' in mock) {
        mock.mockClear()
      }
    })
    // 取证统一：ack 写入侧走 forensics-dir。让 tmpDir 本身成为取证根
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-ack-'))
    tmpDir = path.join(base, 'Diagnostics')
    fs.mkdirSync(tmpDir, { recursive: true })
    setForensicsEnvProvider(() => ({
      isPackaged: true,
      defaultApp: false,
      exePath: path.join(base, 'app.exe')
    }))
    m.appGetPathMock.mockImplementation((p: string) => (p === 'userData' ? tmpDir : `/mock/${p}`))
    // 输家路径：锁恒失败；对话框默认选「退出」
    m.requestSingleInstanceLockMock.mockReturnValue(false)
    m.dialogShowMessageBoxMock.mockResolvedValue({ response: 2 })
  })

  afterEach(() => {
    setForensicsEnvProvider(null)
    setDocumentsPathProvider(null)
    fs.rmSync(path.dirname(tmpDir), { recursive: true, force: true })
    m.appGetPathMock.mockImplementation((p: string) => `/mock/${p}`)
  })

  function writeAckFile(payload: unknown): void {
    fs.writeFileSync(path.join(tmpDir, 'second-instance-ack.json'), JSON.stringify(payload))
  }

  it('B1【正常】重试耗尽 + ack 新鲜（pid=当前进程）→ app.quit 静默退出，零对话框', async () => {
    vi.useFakeTimers()
    const t0 = 1_700_000_000_000
    vi.setSystemTime(t0)
    // 赢家在输家首次尝试锁时写 ack；输家 6s 重试耗尽后检查，age=6s ≤ 15s → 新鲜
    writeAckFile({ pid: process.pid, ts: t0 })

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await promise

    expect(m.dialogShowMessageBoxMock).not.toHaveBeenCalled()
    expect(m.appQuitMock).toHaveBeenCalledTimes(1)
    expect(m.appExitMock).not.toHaveBeenCalled()
    expect(m.appRelaunchMock).not.toHaveBeenCalled()
    // 静默让位必须留诊断痕（诊断包可裁决「为何双击后没反应」）
    expect(m.diagLogMock).toHaveBeenCalledWith('BOOT', expect.stringContaining('ack'))
  })

  it('B2【正常】ack 新鲜且 pid 与当前进程不同 → 同样静默让位（pid 不参与判定）', async () => {
    vi.useFakeTimers()
    const t0 = 1_700_000_000_000
    vi.setSystemTime(t0)
    writeAckFile({ pid: 4321, ts: t0 })

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await promise

    expect(m.dialogShowMessageBoxMock).not.toHaveBeenCalled()
    expect(m.appQuitMock).toHaveBeenCalledTimes(1)
  })

  it('B3【异常】ack 文件不存在 → 走三选项对话框（可能僵尸持锁）', async () => {
    vi.useFakeTimers()

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(0)
    await promise

    expect(m.dialogShowMessageBoxMock).toHaveBeenCalledTimes(1)
    expect(m.appQuitMock).toHaveBeenCalledTimes(1)
  })

  it('B4【异常】ack 读取抛错（路径被目录占用）→ 走三选项对话框', async () => {
    vi.useFakeTimers()
    // 同名目录使 readFileSync 抛 EISDIR → fail-open 视为无新鲜 ack
    fs.mkdirSync(path.join(tmpDir, 'second-instance-ack.json'))

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(0)
    await promise

    expect(m.dialogShowMessageBoxMock).toHaveBeenCalledTimes(1)
  })

  it('B5【异常】ack JSON 损坏 → 走三选项对话框', async () => {
    vi.useFakeTimers()
    writeAckFile('{not valid json')

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(0)
    await promise

    expect(m.dialogShowMessageBoxMock).toHaveBeenCalledTimes(1)
  })

  it('B6【异常】ack ts 为字符串 → 走三选项对话框', async () => {
    vi.useFakeTimers()
    writeAckFile({ pid: 4321, ts: '1700000000000' })

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(0)
    await promise

    expect(m.dialogShowMessageBoxMock).toHaveBeenCalledTimes(1)
  })

  it('B7【边界】检查时刻 age=14999ms → 仍新鲜，静默退出', async () => {
    vi.useFakeTimers()
    const t0 = 1_700_000_000_000
    vi.setSystemTime(t0)
    // 检查发生在 t0+6000（6 次重试后）：age = (t0+6000) - ts = 14999
    writeAckFile({ pid: 4321, ts: t0 + 6000 - 14_999 })

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await promise

    expect(m.dialogShowMessageBoxMock).not.toHaveBeenCalled()
    expect(m.appQuitMock).toHaveBeenCalledTimes(1)
  })

  it('B8【边界】检查时刻 age=15001ms → 陈旧，走三选项对话框', async () => {
    vi.useFakeTimers()
    const t0 = 1_700_000_000_000
    vi.setSystemTime(t0)
    writeAckFile({ pid: 4321, ts: t0 + 6000 - 15_001 })

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(0)
    await promise

    expect(m.dialogShowMessageBoxMock).toHaveBeenCalledTimes(1)
  })

  it('B9【边界】ts 来自未来（时钟异常保护）→ 走三选项对话框', async () => {
    vi.useFakeTimers()
    const t0 = 1_700_000_000_000
    vi.setSystemTime(t0)
    writeAckFile({ pid: 4321, ts: t0 + 6000 + 5000 })

    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(0)
    await promise

    expect(m.dialogShowMessageBoxMock).toHaveBeenCalledTimes(1)
  })

  it('B10【单元】writeSecondInstanceAck 写入 {pid, ts}', () => {
    const t0 = 1_700_000_123_456
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    writeSecondInstanceAck()

    const raw = fs.readFileSync(path.join(tmpDir, 'second-instance-ack.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual({ pid: process.pid, ts: t0 })
  })

  it('B11【单元】writeSecondInstanceAck 写入失败（取证根与全部回退候选均不可写）不抛出', () => {
    const blocker = path.join(tmpDir, 'blocker.txt')
    fs.writeFileSync(blocker, 'not a dir')
    // install 候选穿过普通文件 → 探测失败；回退链三候选也全部指向 blocker → 终极兜底写盘失败
    setForensicsEnvProvider(() => ({
      isPackaged: true,
      defaultApp: false,
      exePath: path.join(blocker, 'app.exe')
    }))
    setDocumentsPathProvider(() => blocker)
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(blocker)
    const tmpSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(blocker)
    try {
      expect(() => writeSecondInstanceAck()).not.toThrow()
    } finally {
      homeSpy.mockRestore()
      tmpSpy.mockRestore()
    }
  })
})

describe('single-instance 进程清理健壮性（审查修复轮 G1-F4）', () => {
  let tmpDir: string
  beforeEach(() => {
    // 独立顶层 describe 不共享外层 beforeEach：自清 mock 并置失败默认态（同 B 簇口径）
    Object.values(m).forEach((mock) => {
      if (typeof mock === 'function' && 'mock' in mock) mock.mockClear()
    })
    // mockReset 清掉前序用例残留的 mockResolvedValueOnce 队列（mockClear 不清实现）
    m.requestSingleInstanceLockMock.mockReset().mockReturnValue(false)
    m.whenReadyMock.mockReset().mockResolvedValue(undefined)
    m.dialogShowMessageBoxMock.mockReset().mockResolvedValue({ response: 0 })
    m.execFileSyncMock.mockReset().mockReturnValue('')
    // 取证根隔离：ack 判定不得读到前序用例/真实机器的残留 ack（同 B 簇口径）
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-tkill-'))
    tmpDir = path.join(base, 'Diagnostics')
    fs.mkdirSync(tmpDir, { recursive: true })
    setForensicsEnvProvider(() => ({
      isPackaged: true,
      defaultApp: false,
      exePath: path.join(base, 'app.exe')
    }))
  })

  afterEach(() => {
    setForensicsEnvProvider(null)
    fs.rmSync(path.dirname(tmpDir), { recursive: true, force: true })
  })

  it('t-kill. taskkill 必须携带 timeout（内核 I/O 挂起时输家不得同步卡死）', async () => {
    vi.useFakeTimers()
    m.requestSingleInstanceLockMock.mockReturnValue(false)
    m.dialogShowMessageBoxMock.mockResolvedValue({ response: 0 })
    m.execFileSyncMock.mockImplementation((cmd: unknown) => {
      if (cmd === 'powershell') return '12345\n'
      return ''
    })
    const promise = acquireSingleInstanceLockOrHandleFailure()
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2000)
    await promise
    const taskkillCalls = m.execFileSyncMock.mock.calls.filter((c) => c[0] === 'taskkill')
    expect(taskkillCalls.length).toBeGreaterThan(0)
    for (const call of taskkillCalls) {
      const opts = call[2] as { timeout?: number } | undefined
      expect(typeof opts?.timeout, 'taskkill 缺少 timeout 选项').toBe('number')
      expect(opts!.timeout!).toBeGreaterThan(0)
    }
    vi.useRealTimers()
  })
})
