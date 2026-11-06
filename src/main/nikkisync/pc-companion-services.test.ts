import { describe, it, expect, vi } from 'vitest'

import { createPcCompanionServices, type PcCompanionSurface } from './pc-companion-services'
import { stagePcAssets } from '../../../scripts/stage-nikkisync-pc-assets'

/**
 * N7 `pc-companion-services.ts` 单测（注入的假 surface，不依赖真实 @nikkisync 链接）。
 *
 * 正常 — 构造两个上游服务（createDesktopControlServer / WeChatGalleryService）+ 启停与 URL
 * 异常 — start 的 listen 失败只落日志，不把错误抛进退出链
 * 边界 — UP 根缺失时 stage 返回 skipped 且零拷贝
 */
interface FakeServer {
  listen: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  address: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
}

function makeSurface(opts: { listenFail?: boolean } = {}) {
  const server: FakeServer = {
    listen: vi.fn((_port: number, _host: string, cb?: () => void) => {
      if (opts.listenFail) throw new Error('EADDRINUSE')
      cb?.()
    }),
    close: vi.fn((cb?: () => void) => cb?.()),
    address: vi.fn(() => ({ port: 39123 })),
    on: vi.fn(),
    once: vi.fn()
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
  const memory = { start: vi.fn(), stop: vi.fn(), schedule: vi.fn() }
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
  return { surface, server, wechat, memory, versionUpdates }
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

  it('异常：start 的 listen 失败只落日志，不抛到退出链', async () => {
    const { surface } = makeSurface({ listenFail: true })
    const log = vi.fn()
    const services = createPcCompanionServices(options(surface, log))
    await expect(services.start()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalled()
    // 失败后 stop 仍必须能走完（每步独立 try/catch，绝不卡住退出链）
    await expect(services.stop()).resolves.toBeUndefined()
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
