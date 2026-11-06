import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'

import {
  createPcCompanionServices,
  startPcCompanionServices,
  type PcCompanionSurface
} from './pc-companion-services'
import { stagePcAssets } from '../../../scripts/stage-nikkisync-pc-assets'

/**
 * N7 `pc-companion-services.ts` 单测（注入的假 surface，不依赖真实 @nikkisync 链接）。
 *
 * 正常 — 构造两个上游服务（createDesktopControlServer / WeChatGalleryService）+ 启停与 URL
 * 异常 — start 失败回滚已启动后台服务并 rethrow（不再吞错）；装配入口失败返回 undefined
 * 边界 — UP 根缺失时 stage 返回 skipped 且零拷贝
 */
interface FakeServer {
  listen: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  address: ReturnType<typeof vi.fn>
  on: (event: string, listener: (...args: unknown[]) => void) => void
  once: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener: (event: string, listener: (...args: unknown[]) => void) => void
  listenerCount: (event: string) => number
}

function makeSurface(
  opts: {
    listenFail?: boolean
    closeHangs?: boolean
    closeError?: unknown
    memoryStartThrows?: boolean
    /** F5：listen 回调挂起不回调，用返回的 resolveListen() 手工放行（构造 stop/start 交错）。 */
    deferListen?: boolean
  } = {}
) {
  // 真实 EventEmitter 语义：B2 要断言成功路径后 error 监听归零，纯 vi.fn 记不到。
  const emitter = new EventEmitter()
  const deferredListenCbs: Array<() => void> = []
  const server: FakeServer = {
    listen: vi.fn((_port: number, _host: string, cb?: () => void) => {
      if (opts.listenFail) throw new Error('EADDRINUSE')
      if (opts.deferListen) {
        if (cb) deferredListenCbs.push(cb)
        return
      }
      cb?.()
    }),
    close: vi.fn((cb?: (error?: unknown) => void) => {
      if (opts.closeHangs) return
      cb?.(opts.closeError)
    }),
    address: vi.fn(() => ({ port: 39123 })),
    on: (event, listener) => {
      emitter.on(event, listener)
    },
    once: (event, listener) => {
      emitter.once(event, listener)
    },
    removeListener: (event, listener) => {
      emitter.removeListener(event, listener)
    },
    listenerCount: (event) => emitter.listenerCount(event)
  }
  const wechat = {
    start: vi.fn(async () => ({
      state: 'waiting',
      photoCount: 0,
      originalsSent: 0,
      qrSvg: '<svg/>'
    })),
    stop: vi.fn(async () => undefined),
    status: vi.fn(() => ({ state: 'idle', photoCount: 0, originalsSent: 0 }))
  }
  const memory = {
    start: vi.fn(() => {
      if (opts.memoryStartThrows) throw new Error('memory boom')
    }),
    stop: vi.fn(),
    schedule: vi.fn()
  }
  const versionUpdates = { start: vi.fn(), stop: vi.fn() }
  // 必须是可 new 的普通 function（箭头函数不能作构造器）；vi.fn 包装以断言构造次数
  const surface = {
    createDesktopControlServer: vi.fn(() => server),
    DesktopStatusService: vi.fn().mockImplementation(function () {
      return { getStatus: () => ({ firstRun: false }) }
    }),
    WeChatGalleryService: vi.fn().mockImplementation(function () {
      return wechat
    }),
    createIndexedPreviewSource: vi.fn(() => ({ count: 0 })),
    WeChatIconProvider: vi.fn().mockImplementation(function () {
      return { get: vi.fn() }
    }),
    RuntimeMemoryMaintenance: vi.fn().mockImplementation(function () {
      return memory
    }),
    GameVersionUpdateService: vi.fn().mockImplementation(function () {
      return versionUpdates
    })
  } as unknown as PcCompanionSurface
  return {
    surface,
    server,
    wechat,
    memory,
    versionUpdates,
    resolveListen: () => {
      const cbs = [...deferredListenCbs]
      deferredListenCbs.length = 0
      cbs.forEach((cb) => cb())
    }
  }
}

function options(surface: PcCompanionSurface, log = vi.fn()) {
  return {
    surface,
    resourcesDir: 'D:/ROOT/resources/nikkisync/pc',
    qrSvg: vi.fn(async () => '<svg/>'),
    ffmpegPath: 'D:/bin/ffmpeg.exe',
    ffprobePath: 'D:/bin/ffprobe.exe',
    log
  }
}

describe('pc-companion-services（N7 上游 PC 端服务装配）', () => {
  it('正常：构造两个上游服务，start 监听随机 127.0.0.1 端口，stop 逆序收尾', async () => {
    const { surface, server, wechat, versionUpdates } = makeSurface()
    const services = createPcCompanionServices(options(surface))

    expect(surface.createDesktopControlServer).toHaveBeenCalledTimes(1)
    expect(surface.WeChatGalleryService).toHaveBeenCalledTimes(1)

    await services.start()
    expect(server.listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function))
    expect(services.desktopUrl()).toContain('127.0.0.1:39123')
    expect(services.wechatStatus()).toEqual({
      state: 'idle',
      photoCount: 0,
      originalsSent: 0
    })

    await services.stop()
    // windows-app.ts:247-254 的 shutdown 顺序：wechat.stop() → dashboard.close()
    expect(wechat.stop).toHaveBeenCalledTimes(1)
    expect(server.close).toHaveBeenCalledTimes(1)
    expect(versionUpdates.stop).toHaveBeenCalled()
  })

  it('异常：start 的 listen 失败 ⇒ 回滚 + rethrow（不再吞错）；stop 仍能走完', async () => {
    const { surface, server } = makeSurface({ listenFail: true })
    const log = vi.fn()
    const services = createPcCompanionServices(options(surface, log))
    await expect(services.start()).rejects.toThrow('EADDRINUSE')
    expect(log).toHaveBeenCalled()
    expect(server.listenerCount('error')).toBe(0)
    // 失败后 stop 仍必须能走完（每步独立 try/catch，绝不卡住退出链）
    await expect(services.stop()).resolves.toBeUndefined()
  })

  it('B1 启动中途抛错：回滚已启动后台服务并 rethrow（不吞错返回半成品）', async () => {
    const { surface, versionUpdates, memory, server } = makeSurface({
      memoryStartThrows: true
    })
    const log = vi.fn()
    const services = createPcCompanionServices(options(surface, log))
    await expect(services.start()).rejects.toThrow('memory boom')
    expect(versionUpdates.start).toHaveBeenCalledTimes(1)
    expect(versionUpdates.stop).toHaveBeenCalledTimes(1)
    expect(memory.stop).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalled()
    expect(server.listenerCount('error')).toBe(0)
  })

  // F1：listen 已成功（端口已占用）后中途抛错，回滚必须一并关闭 dashboard——
  // 否则监听 socket 泄漏到进程退出，status/desktopUrl 还与实际监听背离。
  it('F1 listen 成功后中途抛错 ⇒ 回滚须一并关闭已监听的 dashboard', async () => {
    const { surface, server, versionUpdates, memory } = makeSurface({
      memoryStartThrows: true
    })
    const log = vi.fn()
    const services = createPcCompanionServices(options(surface, log))
    await expect(services.start()).rejects.toThrow('memory boom')
    expect(versionUpdates.stop).toHaveBeenCalledTimes(1)
    expect(memory.stop).toHaveBeenCalledTimes(1)
    // 修复前缺失：已监听的服务器从不 close ⇒ 泄漏
    expect(server.close).toHaveBeenCalledTimes(1)
    expect(services.status().running).toBe(false)
    expect(services.desktopUrl()).toBe('')
  })

  // F5：stop 与在途 start 交错——Node 允许 close 后再 listen，若 stop 不等 start 落地，
  // close 会发生在 attempt 完成之前，服务随后又被拉起（running 复位发生在 close 之后）。
  it('F5 stop 在 start 在途时先等其落地再拆除（close 晚于 attempt 完成）', async () => {
    const { surface, server, versionUpdates, resolveListen } = makeSurface({ deferListen: true })
    const services = createPcCompanionServices(options(surface))
    const startPromise = services.start()
    const stopPromise = services.stop()
    resolveListen()
    await expect(startPromise).resolves.toBeUndefined()
    await expect(stopPromise).resolves.toBeUndefined()
    // 修复前：close 先于 attempt 的后台服务启动（versionUpdates.start）发生 ⇒ 竞态窗口
    const closeOrder = server.close.mock.invocationCallOrder[0] as number
    const startOrder = versionUpdates.start.mock.invocationCallOrder[0] as number
    expect(startOrder).toBeLessThan(closeOrder)
    expect(services.status().running).toBe(false)
    expect(services.desktopUrl()).toBe('')
  })

  it('B1 装配入口失败 ⇒ 返回 undefined（不把半成品递给上层）', async () => {
    const log = vi.fn()
    const res = await startPcCompanionServices({
      projectRoot: 'D:/NO_SUCH_NIKKISYNC_ROOT_XYZ',
      resourcesDir: 'D:/ROOT/resources/nikkisync/pc',
      wechatGallery: true,
      log
    })
    expect(res).toBeUndefined()
    expect(log).toHaveBeenCalled()
  })

  it('B2 并发 start 去重：只 listen 一次，成功路径 error 监听归零', async () => {
    const { surface, server } = makeSurface()
    const services = createPcCompanionServices(options(surface))
    await Promise.all([services.start(), services.start(), services.start()])
    expect(server.listen).toHaveBeenCalledTimes(1)
    expect(server.listenerCount('error')).toBe(0)
  })

  it('B3 dashboard.close 永不回调 ⇒ 超时兜底放行退出链', async () => {
    const { surface, server } = makeSurface({ closeHangs: true })
    const services = createPcCompanionServices({ ...options(surface), closeTimeoutMs: 20 })
    await services.start()
    await expect(services.stop()).resolves.toBeUndefined()
    expect(server.close).toHaveBeenCalledTimes(1)
  }, 1500)

  it('B3 dashboard.close 回调带 err ⇒ 记录日志且退出链不卡死', async () => {
    const { surface } = makeSurface({ closeError: new Error('close failed') })
    const log = vi.fn()
    const services = createPcCompanionServices({ ...options(surface, log), closeTimeoutMs: 20 })
    await services.start()
    await expect(services.stop()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('close failed'))
  })

  it('边界：UP 根缺失时 stage 返回 skipped 且零拷贝', () => {
    const warn = vi.fn()
    const copyFile = vi.fn()
    const res = stagePcAssets({
      upRoot: 'D:/NO_SUCH_UP',
      targetRoot: 'D:/ROOT/resources/nikkisync/pc',
      apply: true,
      warn,
      fsPort: { exists: () => false, mkdir: vi.fn(), copyFile }
    })
    expect(res.status).toBe('skipped')
    expect(res.copied).toEqual([])
    expect(copyFile).not.toHaveBeenCalled()
  })
})

/** 从 vi.fn 构造器替身里取调用参数（假 surface 被 as unknown 收窄过，故显式断言）。 */
function ctorCalls(fn: unknown): unknown[][] {
  return (fn as unknown as { mock: { calls: unknown[][] } }).mock.calls
}

// ============================================================================
// C1：三处降级的装配证据 —— 真实 database / 真实扫描根 / 真实配对串
// ============================================================================
describe('C1 PC 端真实会话上下文装配', () => {
  it('正常：真实 database、扫描根与配对串逐字下传给上游三个消费点', async () => {
    const { surface } = makeSurface()
    const database = { connection: { prepare: () => ({ all: () => [] }) } }
    const scanRoots = ['D:/game/GamePlayPhotos', 'D:/extra/photos']
    createPcCompanionServices({
      ...options(surface),
      database,
      scanRoots,
      pairingUri: () => 'NS1|live-session'
    })

    // ① 本机控制页状态服务拿到真实 SQLite 句柄，而不是空对象
    expect(ctorCalls(surface.DesktopStatusService)[0]?.[0]).toBe(database)
    // ② 微信画廊资产源拿到真实扫描根（修复前恒为空数组 ⇒ 无照片）
    const wechatConfig = ctorCalls(surface.WeChatGalleryService)[0]?.[0] as {
      snapshot: () => Promise<unknown>
    }
    await wechatConfig.snapshot()
    expect(ctorCalls(surface.createIndexedPreviewSource)[0]?.slice(0, 2)).toEqual([
      database,
      scanRoots
    ])
    // ③ 控制页配对接口拿到真实配对串
    const desktopConfig = ctorCalls(surface.createDesktopControlServer)[0]?.[0] as {
      createPairingUri: () => string
    }
    expect(desktopConfig.createPairingUri()).toBe('NS1|live-session')
  })

  it('异常：配对串工厂返回非法值时回落空串，不把脏值递给控制页', () => {
    const { surface } = makeSurface()
    createPcCompanionServices({
      ...options(surface),
      database: {},
      scanRoots: ['/game/photos'],
      pairingUri: (() => 123) as unknown as () => string
    })
    const desktopConfig = ctorCalls(surface.createDesktopControlServer)[0]?.[0] as {
      createPairingUri: () => string
    }
    expect(desktopConfig.createPairingUri()).toBe('')
  })
})
