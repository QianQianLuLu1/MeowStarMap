/**
 * fluent-ffmpeg spawn EFTYPE 逃逸垫片单测（节点5，plan: fix-spawn-eftype-crash）
 *
 * 根因：fluent-ffmpeg@2.1.3 的 _spawnFfmpeg 内 spawn()（processor.js:150）在 Windows
 * 遇到损坏的 ffmpeg 二进制时会「同步抛出 EFTYPE」。而 .run()/availableFormats 的能力探测
 * 链路被内嵌 async@0.2.10 放进 setImmediate 宏任务（async.js:497-503），外层 try/catch 与
 * Promise executor 均失效、.on('error')（processor.js:156）永不到达 → 逃逸为进程
 * uncaughtException → early-crash-guard 弹「Runtime Error: spawn EFTYPE」。
 *
 * 测试策略：**不 mock fluent-ffmpeg**（必须让真实的 processor.js / capabilities.js /
 * async@0.2.10 参与）。fluent-ffmpeg 是外部化 CJS 模块，其顶层
 * `var spawn = require('child_process').spawn` 在模块求值时捕获引用，vi.mock 无法拦截，
 * 故直接补丁 node 内置 child_process 单例的 spawn 属性，并保证补丁先于 fluent-ffmpeg
 * 首次加载（所有相关模块一律动态 import）。补丁行为由 ctl.mode 控制：
 * - 'ok'    ：返回可发射 stdout/stderr/exit 事件的假子进程（正常路径）
 * - 'EFTYPE'：同步抛出 EFTYPE 错误（复现现场损坏二进制）
 *
 * 关键断言：装了垫片后，同步抛错被捕获并路由回 endCB（getAvailableFormats 的回调收到
 * code==='EFTYPE' 的错误），且 process 'uncaughtException' 间谍**未**被触发。
 * 未装垫片时本文件必须红：cb 不被调用 + 错误逃逸到 uncaughtException 间谍。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import childProcess from 'child_process'

// ---- 共享控制态 ----
const ctl = {
  /** spawn 行为：'ok' 正常返回假子进程；'EFTYPE' 同步抛 EFTYPE（现场损坏二进制） */
  mode: 'ok' as 'ok' | 'EFTYPE'
}

/** 构造现场同款 EFTYPE 错误（Windows 损坏二进制的同步 spawn 失败） */
function makeEftypeError(): Error {
  return Object.assign(new Error('spawn EFTYPE'), {
    code: 'EFTYPE',
    errno: -4028,
    syscall: 'spawn'
  })
}

// ---- 补丁 node 内置 child_process.spawn（必须先于 fluent-ffmpeg 首次加载执行） ----
const realSpawn = childProcess.spawn
/** 假 spawn：按 ctl.mode 决定同步抛 EFTYPE 还是返回可发射事件的假子进程 */
function fakeSpawn(): unknown {
  if (ctl.mode === 'EFTYPE') throw makeEftypeError()
  // 正常路径：stdout/stderr/exit 事件必须延迟到调用方挂好监听后再发射
  // （processor.js 在 spawn 返回后才 attach 监听器）
  // stderr 必须提供 setEncoding：processor.js:152-153 无条件调用 ffmpegProc.stderr.setEncoding('utf8')
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void }
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void }
  stdout.setEncoding = () => undefined
  stderr.setEncoding = () => undefined
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    pid: number
    kill: () => boolean
  }
  proc.stdout = stdout
  proc.stderr = stderr
  proc.pid = 4242
  proc.kill = () => true
  setImmediate(() => {
    // `ffmpeg -formats` 的真实输出行（匹配 capabilities.js:18 的 formatRegexp）
    stdout.emit('data', ' D  mp3               MP3 (MPEG audio layer 3)\n')
    stdout.emit('data', 'DE mp4               MP4 (MPEG-4 Part 14)\n')
    stdout.emit('close')
    stderr.emit('close')
    proc.emit('exit', 0, null)
  })
  return proc
}
// 外部化 CJS 的 processor.js 顶层解构捕获的正是这个内置单例属性
;(childProcess as unknown as { spawn: unknown }).spawn = fakeSpawn

/** 动态加载垫片与真实 fluent-ffmpeg（确保 processor.js 求值晚于上方补丁） */
async function loadModules(): Promise<{
  installFfmpegSpawnGuard: () => void
  ffmpeg: typeof import('fluent-ffmpeg').default
}> {
  const shim = await import('./fluent-ffmpeg-shim')
  const ffmpeg = (await import('fluent-ffmpeg')).default
  return { installFfmpegSpawnGuard: shim.installFfmpegSpawnGuard, ffmpeg }
}

/** 跨过 async@0.2.10 的 setImmediate 宏任务边界（waterfall 每个任务一次宏任务） */
function tickTwice(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve)).then(
    () => new Promise<void>((resolve) => setImmediate(resolve))
  )
}

afterAll(() => {
  // 恢复内置 spawn，避免污染同文件其他逻辑（vitest forks 池下文件间本就隔离）
  ;(childProcess as unknown as { spawn: unknown }).spawn = realSpawn
})

describe('installFfmpegSpawnGuard：fluent-ffmpeg spawn 同步抛错逃逸垫片', () => {
  let uncaughtSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ctl.mode = 'ok'
    vi.resetModules() // 重置垫片模块的幂等标记；外部化 fluent-ffmpeg 实例不受影响
    uncaughtSpy = vi.fn()
    process.on('uncaughtException', uncaughtSpy)
  })

  afterEach(() => {
    process.removeListener('uncaughtException', uncaughtSpy)
  })

  it('EFTYPE 路径：spawn 同步抛错 → 回调收到 code=EFTYPE 错误且不泄漏 uncaughtException', async () => {
    const { installFfmpegSpawnGuard, ffmpeg } = await loadModules()
    installFfmpegSpawnGuard()
    ffmpeg().setFfmpegPath('/fake/ffmpeg.exe')

    ctl.mode = 'EFTYPE'
    const cb = vi.fn()
    ffmpeg().getAvailableFormats(cb)
    // await 两次 setImmediate：跨过 async@0.2.10 waterfall 的宏任务边界。
    // 未装垫片时同步抛错在此宏任务内逃逸 → cb 永不被调用（红灯特征）
    await tickTwice()

    expect(cb).toHaveBeenCalledTimes(1)
    const err = cb.mock.calls[0][0] as NodeJS.ErrnoException
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('EFTYPE')
    expect(err.message).toContain('spawn EFTYPE')
    // 错误已被垫片收敛为回调形参，绝不允许再逃逸到进程级
    expect(uncaughtSpy).not.toHaveBeenCalled()
  })

  it('边界：无回调形态（endCB 归一化后缺失）→ 同步 rethrow，垫片不吞错', async () => {
    const { installFfmpegSpawnGuard, ffmpeg } = await loadModules()
    installFfmpegSpawnGuard()
    ffmpeg().setFfmpegPath('/fake/ffmpeg.exe')
    // 取共享 prototype（capabilities/processor 的方法都挂在 FfmpegCommand.prototype 上）
    const proto = Object.getPrototypeOf(ffmpeg()) as Record<string, unknown>

    ctl.mode = 'EFTYPE'
    const spawnFn = proto._spawnFfmpeg as (
      this: unknown,
      args: string[],
      options: Record<string, unknown>
    ) => void
    // _spawnFfmpeg(args, options)：无 processCB / endCB，归一化后 ecb 非函数 → 必须 rethrow
    expect(() => spawnFn.call(ffmpeg(), ['-formats'], {})).toThrowError(/spawn EFTYPE/)
    expect(uncaughtSpy).not.toHaveBeenCalled()
  })

  it('幂等：重复调用 installFfmpegSpawnGuard 只包裹一次原始方法', async () => {
    const { ffmpeg } = await loadModules()
    const proto = Object.getPrototypeOf(ffmpeg()) as Record<string, unknown>
    // 在安装垫片之前 spy 原始方法：垫片包裹后 spy 位于包裹层内侧，
    // 每次 _spawnFfmpeg 调用 spy 恰好 1 次；叠加「重复 install 后回调仍收到 EFTYPE」
    // 共同锁定幂等语义（重复包裹会导致错误被多层重复路由/行为异常）
    const origSpy = vi.spyOn(proto, '_spawnFfmpeg').mockImplementation(() => {
      throw makeEftypeError()
    })

    const { installFfmpegSpawnGuard } = await loadModules()
    installFfmpegSpawnGuard()
    installFfmpegSpawnGuard()
    installFfmpegSpawnGuard()
    ffmpeg().setFfmpegPath('/fake/ffmpeg.exe')

    const cb = vi.fn()
    ffmpeg().getAvailableFormats(cb)
    await tickTwice()

    expect(origSpy).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledTimes(1)
    expect((cb.mock.calls[0][0] as NodeJS.ErrnoException).code).toBe('EFTYPE')
    expect(uncaughtSpy).not.toHaveBeenCalled()
    origSpy.mockRestore()
  })

  it('兼容：fluent-ffmpeg 结构变更（_spawnFfmpeg 缺失）→ diagLog 告警且不抛错', async () => {
    // doMock 必须先于垫片模块的首次动态导入，否则垫片拿到的是真实 startup-diagnostic
    vi.doMock('./startup-diagnostic', () => ({
      diagLog: vi.fn(),
      logStartupError: vi.fn(),
      readStartupErrors: vi.fn(() => ''),
      clearStartupErrors: vi.fn(),
      getStartupLogPathValue: vi.fn(() => '')
    }))
    const ffmpeg = (await import('fluent-ffmpeg')).default
    const proto = Object.getPrototypeOf(ffmpeg()) as Record<string, unknown>
    const saved = proto._spawnFfmpeg
    delete proto._spawnFfmpeg // 模拟未来版本升级后私有方法更名/移除

    const { installFfmpegSpawnGuard } = await import('./fluent-ffmpeg-shim')
    const { diagLog } = await import('./startup-diagnostic')
    expect(() => installFfmpegSpawnGuard()).not.toThrow()
    expect(diagLog).toHaveBeenCalled()
    expect(uncaughtSpy).not.toHaveBeenCalled()

    proto._spawnFfmpeg = saved
    vi.doUnmock('./startup-diagnostic')
  })

  // 注意：本用例是唯一会成功 populate capabilities.js 模块级 cache.formats 的用例，
  // 必须放在最后执行；否则后续走 getAvailableFormats 的 EFTYPE/幂等用例会命中缓存短路、
  // 根本不再调用 spawn，EFTYPE 错误无从抛出（forks 池仅保证跨文件隔离，同文件内 cache 共享）。
  it('正常路径：spawn 成功 → getAvailableFormats 回调收到解析后的 formats', async () => {
    const { installFfmpegSpawnGuard, ffmpeg } = await loadModules()
    installFfmpegSpawnGuard()
    ffmpeg().setFfmpegPath('/fake/ffmpeg.exe')

    ctl.mode = 'ok'
    const cb = vi.fn()
    ffmpeg().getAvailableFormats(cb)
    await tickTwice()

    expect(cb).toHaveBeenCalledTimes(1)
    const [err, formats] = cb.mock.calls[0] as [
      Error | null,
      Record<string, { description: string; canDemux: boolean; canMux: boolean }>
    ]
    expect(err).toBeNull()
    expect(formats.mp4).toEqual({
      description: 'MP4 (MPEG-4 Part 14)',
      canDemux: true,
      canMux: true
    })
    expect(uncaughtSpy).not.toHaveBeenCalled()
  })
})
