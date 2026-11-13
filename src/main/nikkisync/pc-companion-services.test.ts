import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createPcCompanionServices,
  loadPcCompanionSurface,
  startPcCompanionServices,
  type PcCompanionSurface
} from './pc-companion-services'
import { PC_ASSET_SPECS, stagePcAssets } from '../../../scripts/stage-nikkisync-pc-assets'

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
    /** 4cb71e2 降级用例：省略 withWeChat* 两个包装器（模拟老链接缺深入口）。 */
    omitWrappers?: boolean
    /** 4cb71e2 降级用例：省略 listLanIpv4（多 host 深入口不可装载）。 */
    omitLanLister?: boolean
    /** a49764bb 降级用例：省略 convertWeChatWebp（老链接缺导出，本地图标模式必须回落在线）。 */
    omitWebpConverter?: boolean
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
      return { getStatus: vi.fn(() => ({ firstRun: false })) }
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
    }),
    // 4cb71e2：微信画廊两个包装器与字节变换函数（省略型降级用例经 opts 去掉）
    ...(opts.omitWrappers
      ? {}
      : {
          withWeChatInspiration: vi.fn((source: unknown) => ({
            wrappedAs: 'inspiration',
            source
          })),
          withWeChatDeletion: vi.fn((source: unknown) => ({ wrappedAs: 'deletion', source }))
        }),
    resizeForWeChat: vi.fn(async (bytes: Uint8Array) => bytes),
    resizeWeChatIcon: vi.fn(async (bytes: Uint8Array) => bytes),
    ...(opts.omitWebpConverter
      ? {}
      : { convertWeChatWebp: vi.fn(async (bytes: Uint8Array) => bytes) }),
    rotatePng: vi.fn(async (bytes: Uint8Array) => bytes),
    exportLive: vi.fn(async () => ({ image: new Uint8Array(8), mime: 'application/x-livp' })),
    ...(opts.omitLanLister ? {} : { listLanIpv4: vi.fn(() => ['192.168.1.10', '192.168.1.11']) })
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

  // 4cb71e2：上游控制页新增小程序入口码（/wechat-entry.png 路由），资源必须随暂存清单出货。
  it('暂存清单包含微信入口码 wechat-mini-entry.png 且目标不逃逸根目录', () => {
    const spec = PC_ASSET_SPECS.find((item) => path.basename(item.from) === 'wechat-mini-entry.png')
    expect(spec).toBeDefined()
    expect(spec!.from).toBe(path.join('assets', 'branding', 'wechat-mini-entry.png'))
    expect(spec!.to).toBe('wechat-mini-entry.png')
  })

  it('暂存清单全部 to 目标都落在目标根内（防 .. 逃逸回归锚）', () => {
    const targetRoot = path.resolve('D:/ROOT/resources/nikkisync/pc')
    for (const spec of PC_ASSET_SPECS) {
      const resolved = path.resolve(targetRoot, spec.to)
      expect(resolved.startsWith(targetRoot + path.sep)).toBe(true)
    }
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
  it('正常：真实 database、扫描根（realpath 后）与配对串逐字下传给上游消费点', async () => {
    const { surface } = makeSurface()
    const database = { connection: { prepare: () => ({ all: () => [] }) } }
    // 4cb71e2 起 snapshot 对扫描根逐个 realpath（对齐上游 windows-app.ts）：不存在的根被剔除
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nikki-c1-'))
    try {
      const first = path.join(base, 'GamePlayPhotos')
      const second = path.join(base, 'extra-photos')
      fs.mkdirSync(first)
      fs.mkdirSync(second)
      const scanRoots = [first, second, path.join(base, 'missing-photos')]
      createPcCompanionServices({
        ...options(surface),
        database,
        scanRoots,
        pairingUri: () => 'NS1|live-session'
      })

      // ① 本机控制页状态服务拿到真实 SQLite 句柄，而不是空对象
      expect(ctorCalls(surface.DesktopStatusService)[0]?.[0]).toBe(database)
      // ② 微信画廊资产源拿到存在根的 realpath（缺失根剔除、不伪造）
      const wechatConfig = ctorCalls(surface.WeChatGalleryService)[0]?.[0] as {
        snapshot: () => Promise<unknown>
      }
      await wechatConfig.snapshot()
      expect(ctorCalls(surface.createIndexedPreviewSource)[0]?.slice(0, 2)).toEqual([
        database,
        [fs.realpathSync(first), fs.realpathSync(second)]
      ])
      // ③ 控制页配对接口拿到真实配对串
      const desktopConfig = ctorCalls(surface.createDesktopControlServer)[0]?.[0] as {
        createPairingUri: () => string
      }
      expect(desktopConfig.createPairingUri()).toBe('NS1|live-session')
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
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

// ============================================================================
// 4cb71e2（v1.0.31）：微信画廊组装对齐上游 windows-app.ts + 控制页四面板 + D1–D5 修复
// ============================================================================
describe('4cb71e2 微信画廊组装与控制页面板', () => {
  /** 建一个带 wechat-mini-entry.png 的临时资源目录（wechatEntryImage 正例用）。 */
  function makeResourcesDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikki-pc-res-'))
    fs.writeFileSync(path.join(dir, 'wechat-mini-entry.png'), Buffer.from([137, 80, 78, 71]))
    return dir
  }

  function makeFakeExtraDirectories() {
    return {
      state: vi.fn(() => ({ directories: [] })),
      inspect: vi.fn(async () => ({})),
      add: vi.fn(async (id: string) => ({ added: id })),
      remove: vi.fn(async (id: string) => ({ removed: id })),
      rescan: vi.fn(async () => ({ rescanned: true })),
      setSource: vi.fn(async (id: string, source: string) => ({ id, source }))
    }
  }

  function wechatCtorConfig(surface: PcCompanionSurface): Record<string, unknown> {
    return ctorCalls(surface.WeChatGalleryService)[0]?.[0] as Record<string, unknown>
  }

  function desktopCtorConfig(surface: PcCompanionSurface, index = 0): Record<string, unknown> {
    return ctorCalls(surface.createDesktopControlServer)[index]?.[0] as Record<string, unknown>
  }

  it('正常：snapshot 依次经灵感库与删除两层包装，包装链与入参同引用', async () => {
    const { surface } = makeSurface()
    const inspirations = { mark: 'inspirations' }
    const deletions = { mark: 'deletions' }
    createPcCompanionServices({ ...options(surface), inspirations, deletions })
    const config = wechatCtorConfig(surface)
    const source = await (config.snapshot as () => Promise<Record<string, unknown>>)()

    // 包装顺序：previewSource → withWeChatInspiration(source, store, resize) → withWeChatDeletion(source, queue)
    const inspirationCalls = ctorCalls(surface.withWeChatInspiration!)
    expect(inspirationCalls).toHaveLength(1)
    expect(inspirationCalls[0][0]).toEqual({ count: 0 })
    expect(inspirationCalls[0][1]).toBe(inspirations)
    expect(typeof inspirationCalls[0][2]).toBe('function')
    const deletionCalls = ctorCalls(surface.withWeChatDeletion!)
    expect(deletionCalls).toHaveLength(1)
    expect(deletionCalls[0][0]).toEqual({ wrappedAs: 'inspiration', source: { count: 0 } })
    expect(deletionCalls[0][1]).toBe(deletions)
    // snapshot 终值 = 删除包装器的产物（内层是灵感库包装的产物）
    expect(source).toEqual({
      wrappedAs: 'deletion',
      source: { wrappedAs: 'inspiration', source: { count: 0 } }
    })
  })

  it('正常：resize/rotatePng/exportLive 为字节变换函数并委托上游实现（D1–D3 修复）', async () => {
    const { surface } = makeSurface()
    createPcCompanionServices({ ...options(surface) })
    const config = wechatCtorConfig(surface)
    await (config.snapshot as () => Promise<unknown>)()
    const previewOptions = ctorCalls(surface.createIndexedPreviewSource)[0]?.[2] as Record<
      string,
      unknown
    >

    // D1：resize 是 (bytes) => Promise<Uint8Array>，内部走上游 resizeForWeChat + 暂存脚本路径
    expect(typeof previewOptions.resize).toBe('function')
    const bytes = new Uint8Array([1, 2, 3])
    await (previewOptions.resize as (b: Uint8Array) => Promise<Uint8Array>)(bytes)
    expect(ctorCalls(surface.resizeForWeChat!)[0]).toEqual([
      bytes,
      expect.stringMatching(/resize-preview\.ps1$/)
    ])

    // D2：rotatePng 同口径
    expect(typeof previewOptions.rotatePng).toBe('function')
    await (previewOptions.rotatePng as (b: Uint8Array, r: number) => Promise<Uint8Array>)(bytes, 90)
    expect(ctorCalls(surface.rotatePng!)[0]).toEqual([
      bytes,
      90,
      expect.stringMatching(/rotate-png\.ps1$/)
    ])

    // D3：exportLive 委托上游并把 ffmpeg/ffprobe 并入 options
    expect(typeof previewOptions.exportLive).toBe('function')
    await (
      previewOptions.exportLive as (j: Uint8Array, v: Uint8Array, o: unknown) => Promise<unknown>
    )(bytes, bytes, { exif: true, metadata: {} })
    expect(ctorCalls(surface.exportLive!)[0]).toEqual([
      bytes,
      bytes,
      { exif: true, metadata: {}, ffmpeg: 'D:/bin/ffmpeg.exe', ffprobe: 'D:/bin/ffprobe.exe' }
    ])
    // 上游 4cb71e2 新增 motionFfmpeg：宿主等价物为 ffmpeg-static 的二进制路径
    expect(previewOptions.motionFfmpeg).toBe('D:/bin/ffmpeg.exe')
  })

  it('正常：WeChatIconProvider 以 (缩略图缓存, resize 回调) 构造（D4 修复），回调委托上游 resizeWeChatIcon', async () => {
    const { surface } = makeSurface()
    const thumbnailCache = { mark: 'cache' }
    createPcCompanionServices({ ...options(surface), thumbnailCache })
    const iconCalls = ctorCalls(surface.WeChatIconProvider)
    expect(iconCalls).toHaveLength(1)
    expect(iconCalls[0][0]).toBe(thumbnailCache)
    expect(typeof iconCalls[0][1]).toBe('function')
    const bytes = new Uint8Array([9, 8, 7])
    await (iconCalls[0][1] as (b: Uint8Array) => Promise<Uint8Array>)(bytes)
    expect(ctorCalls(surface.resizeWeChatIcon!)[0]).toEqual([
      bytes,
      expect.stringMatching(/resize-icon\.ps1$/)
    ])
    // loadIcon 挂进 preview options（委托图标实例）
    const config = wechatCtorConfig(surface)
    await (config.snapshot as () => Promise<unknown>)()
    const previewOptions = ctorCalls(surface.createIndexedPreviewSource)[0]?.[2] as Record<
      string,
      unknown
    >
    expect(typeof previewOptions.loadIcon).toBe('function')
  })

  it('正常：WeChatGalleryService 收到多 host 回调（listLanIpv4 装载在位时）', () => {
    const { surface } = makeSurface()
    createPcCompanionServices({ ...options(surface) })
    const config = wechatCtorConfig(surface)
    expect(typeof config.hosts).toBe('function')
    expect((config.hosts as () => string[])()).toEqual(['192.168.1.10', '192.168.1.11'])
  })

  it('正常：dashboard 收到 wechatEntryImage（暂存资源在位）与四面板实例', async () => {
    const { surface } = makeSurface()
    const resourcesDir = makeResourcesDir()
    try {
      const inspirations = { mark: 'inspirations' }
      const deletions = { mark: 'deletions' }
      const accounts = { mark: 'accounts' }
      const extra = makeFakeExtraDirectories()
      createPcCompanionServices({
        ...options(surface),
        resourcesDir,
        inspirations,
        deletions,
        accounts,
        extraDirectories: extra
      })
      const config = desktopCtorConfig(surface)
      expect(Buffer.isBuffer(config.wechatEntryImage)).toBe(true)
      expect(config.inspirations).toBe(inspirations)
      expect(config.deletions).toBe(deletions)
      expect(config.accounts).toBe(accounts)
      // scanDirectories 是薄包装：state 直 delegate，add 委托后联动 wechat.stop
      const scan = config.scanDirectories as Record<string, unknown>
      expect(scan).toBeDefined()
      scan.state()
      expect(extra.state).toHaveBeenCalledTimes(1)
      await (scan.add as (id: string) => Promise<unknown>)('dir_1')
      expect(extra.add).toHaveBeenCalledWith('dir_1')
      // 生命周期句柄未启动 ⇒ 联动 no-op 不抛（wechat 实例 start 从未被调）
      expect(ctorCalls(surface.WeChatGalleryService)).toHaveLength(1)
    } finally {
      fs.rmSync(resourcesDir, { recursive: true, force: true })
    }
  })

  it('正常：目录 add/remove/rescan 委托成功后各联动一次 wechat.stop（对齐上游 onScopeChanged）', async () => {
    const { surface, wechat } = makeSurface()
    const extra = makeFakeExtraDirectories()
    createPcCompanionServices({ ...options(surface), extraDirectories: extra })
    const config = desktopCtorConfig(surface)
    const scan = config.scanDirectories as Record<string, unknown>
    await (scan.add as (id: string) => Promise<unknown>)('a')
    await (scan.remove as (id: string) => Promise<unknown>)('b')
    await (scan.rescan as () => Promise<unknown>)()
    expect(extra.add).toHaveBeenCalledTimes(1)
    expect(extra.remove).toHaveBeenCalledTimes(1)
    expect(extra.rescan).toHaveBeenCalledTimes(1)
    // wechat.start 从未发生，stop 联动对未启动画廊同样安全（幂等）
    expect(wechat.stop).toHaveBeenCalledTimes(3)
  })

  it('异常：目录包装委托抛错时原样上抛且不触发 wechat.stop', async () => {
    const { surface, wechat } = makeSurface()
    const extra = makeFakeExtraDirectories()
    ;(extra.add as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('directory_not_found'))
    createPcCompanionServices({ ...options(surface), extraDirectories: extra })
    const config = desktopCtorConfig(surface)
    const scan = config.scanDirectories as Record<string, unknown>
    await expect((scan.add as (id: string) => Promise<unknown>)('bad')).rejects.toThrow(
      'directory_not_found'
    )
    expect(wechat.stop).not.toHaveBeenCalled()
  })

  it('异常：withWeChat* 深入口缺席（老链接）⇒ snapshot 不包装、组装不抛', async () => {
    const { surface } = makeSurface({ omitWrappers: true })
    const inspirations = { mark: 'inspirations' }
    const deletions = { mark: 'deletions' }
    expect(() =>
      createPcCompanionServices({ ...options(surface), inspirations, deletions })
    ).not.toThrow()
    const config = wechatCtorConfig(surface)
    const source = await (config.snapshot as () => Promise<Record<string, unknown>>)()
    expect(source).toEqual({ count: 0 })
  })

  it('异常：inspirations/deletions 实例缺席 ⇒ 包装器不被调用（整段跳过）', async () => {
    const { surface } = makeSurface()
    createPcCompanionServices({ ...options(surface) })
    const config = wechatCtorConfig(surface)
    await (config.snapshot as () => Promise<unknown>)()
    expect(ctorCalls(surface.withWeChatInspiration!)).toHaveLength(0)
    expect(ctorCalls(surface.withWeChatDeletion!)).toHaveLength(0)
  })

  it('异常：listLanIpv4 缺席 ⇒ 不传 hosts（降级单 host）；wechatEntryImage 缺失 ⇒ 不挂键', () => {
    const { surface } = makeSurface({ omitLanLister: true })
    createPcCompanionServices({ ...options(surface) })
    const config = wechatCtorConfig(surface)
    expect('hosts' in config).toBe(false)
    const desktopConfig = desktopCtorConfig(surface)
    expect('wechatEntryImage' in desktopConfig).toBe(false)
  })

  it('正常：getStatus 端口来自 syncPort（D5 修复），未提供时回落 0', () => {
    const { surface } = makeSurface()
    const statusInstances = () =>
      (
        surface.DesktopStatusService as unknown as {
          mock: { results: Array<{ value: { getStatus: ReturnType<typeof vi.fn> } }> }
        }
      ).mock.results.map((result) => result.value)
    createPcCompanionServices({ ...options(surface), syncPort: () => 38137 })
    // getStatus 是惰性闭包（上游在控制页路由内调用），须主动触发一次才能断言入参
    ;(desktopCtorConfig(surface).getStatus as () => unknown)()
    expect(statusInstances()[0]!.getStatus.mock.calls[0]?.[0]).toEqual({
      host: '127.0.0.1',
      port: 38137
    })

    // 未提供 syncPort ⇒ 回落 0（不得误报 dashboard 自身端口）
    createPcCompanionServices({ ...options(surface) })
    ;(desktopCtorConfig(surface, 1).getStatus as () => unknown)()
    expect(statusInstances()[1]!.getStatus.mock.calls[0]?.[0]).toEqual({
      host: '127.0.0.1',
      port: 0
    })
  })
})

describe('loadPcCompanionSurface 深入口装载（4cb71e2 可选面降级）', () => {
  /**
   * 造假 pc-companion 模块树供真实 file:// 动态 import（不依赖真实 junction）：
   * 8 个必需模块恒在位；两个 WeChat 包装器按 opts 造「模块缺席」（老链接 589b932
   * 无 WeChatDeletion.js / WeChatInspiration.js）或「模块在但导出缺席」。包根必须带
   * type:module，否则 .js 产物按 CJS 解析。每个用例独占临时目录，避免 import 缓存串味。
   */
  function makeFakePackageRoot(
    opts: {
      wrappers?: 'present' | 'absent-modules' | 'absent-exports'
      omitRequired?: boolean
    } = {}
  ): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nikki-pc-load-'))
    const pkgRoot = path.join(root, 'node_modules', '@nikkisync', 'pc-companion')
    const src = path.join(pkgRoot, 'dist', 'src')
    const write = (rel: string, code: string): void => {
      const target = path.join(src, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, code, 'utf8')
    }
    fs.mkdirSync(pkgRoot, { recursive: true })
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      '{"name":"@nikkisync/pc-companion","type":"module"}',
      'utf8'
    )
    if (!opts.omitRequired) {
      write(
        path.join('desktop', 'DesktopControlServer.js'),
        'export function createDesktopControlServer() {}\n'
      )
    }
    write(path.join('desktop', 'DesktopStatusService.js'), 'export class DesktopStatusService {}\n')
    write(
      path.join('wechat', 'WeChatGalleryService.js'),
      'export class WeChatGalleryService {}\nexport async function resizeForWeChat(bytes) { return bytes }\n'
    )
    write(
      path.join('wechat', 'GalleryRuntime.mjs'),
      'export function createIndexedPreviewSource() {}\n' +
        'export async function rotatePng(bytes) { return bytes }\n' +
        "export async function exportLive() { return { image: new Uint8Array(0), mime: 'image/jpeg' } }\n"
    )
    write(
      path.join('wechat', 'WeChatIconProvider.js'),
      'export async function resizeWeChatIcon(bytes) { return bytes }\n'
    )
    write('RuntimeMemoryMaintenance.js', 'export class RuntimeMemoryMaintenance {}\n')
    write(
      path.join('server', 'GameVersionUpdateService.js'),
      'export class GameVersionUpdateService {}\n'
    )
    write(path.join('server', 'LanAddress.js'), 'export function listLanIpv4() { return [] }\n')
    const wrappers = opts.wrappers ?? 'present'
    if (wrappers === 'present') {
      write(
        path.join('wechat', 'WeChatDeletion.js'),
        'export function withWeChatDeletion(source) { return source }\n'
      )
      write(
        path.join('wechat', 'WeChatInspiration.js'),
        'export function withWeChatInspiration(source) { return source }\n'
      )
    } else if (wrappers === 'absent-exports') {
      write(path.join('wechat', 'WeChatDeletion.js'), 'export const unrelated = 1\n')
      write(path.join('wechat', 'WeChatInspiration.js'), 'export const unrelated = 1\n')
    }
    return root
  }

  it('正常：10 个深入口齐全 ⇒ 必需导出与两个包装器都在位', async () => {
    const root = makeFakePackageRoot()
    try {
      const surface = await loadPcCompanionSurface(root)
      expect(typeof surface.createDesktopControlServer).toBe('function')
      expect(typeof surface.resizeForWeChat).toBe('function')
      expect(typeof surface.withWeChatDeletion).toBe('function')
      expect(typeof surface.withWeChatInspiration).toBe('function')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('异常：老链接缺两个包装器模块 ⇒ 装载不抛、包装器键缺席、必需面不受影响', async () => {
    const root = makeFakePackageRoot({ wrappers: 'absent-modules' })
    try {
      const surface = await loadPcCompanionSurface(root)
      expect('withWeChatDeletion' in surface).toBe(false)
      expect('withWeChatInspiration' in surface).toBe(false)
      expect(typeof surface.createDesktopControlServer).toBe('function')
      expect(typeof surface.WeChatGalleryService).toBe('function')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('边界：包装器模块在但导出缺席 ⇒ 键不挂（与模块缺席同口径降级）', async () => {
    const root = makeFakePackageRoot({ wrappers: 'absent-exports' })
    try {
      const surface = await loadPcCompanionSurface(root)
      expect('withWeChatDeletion' in surface).toBe(false)
      expect('withWeChatInspiration' in surface).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('边界：必需模块缺席 ⇒ 仍抛可诊断错误（不得过度降级成半套能力）', async () => {
    const root = makeFakePackageRoot({ omitRequired: true })
    try {
      await expect(loadPcCompanionSurface(root)).rejects.toThrow()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// ============================================================================
// a49764bb：本地服装/效果图标包（主包 + 1.0.40 滤镜补充包）注入画廊侧
// ============================================================================
describe('a49764bb 本地图标包注入（正常 / 异常 / 边界）', () => {
  const pack = { valid: true, cacheVersion: 'a'.repeat(64) }

  const previewOptionsOf = async (
    surface: PcCompanionSurface
  ): Promise<Record<string, unknown>> => {
    const config = ctorCalls(surface.WeChatGalleryService)[0]?.[0] as Record<string, unknown>
    await (config.snapshot as () => Promise<unknown>)()
    return ctorCalls(surface.createIndexedPreviewSource)[0]?.[2] as Record<string, unknown>
  }

  it('正常：注入 localClothingIcons + convertLocalWebp，停建在线图标 provider，loadIcon 不挂', async () => {
    const { surface } = makeSurface()
    createPcCompanionServices({
      ...options(surface),
      thumbnailCache: { mark: 'cache' },
      localClothingIcons: pack
    })
    expect(ctorCalls(surface.WeChatIconProvider)).toHaveLength(0)
    const preview = await previewOptionsOf(surface)
    expect(preview.localClothingIcons).toBe(pack)
    expect(typeof preview.convertLocalWebp).toBe('function')
    expect(preview.loadIcon).toBeUndefined()

    const bytes = new Uint8Array([137, 80, 78, 71])
    await (preview.convertLocalWebp as (b: Uint8Array) => Promise<Uint8Array>)(bytes)
    const converter = (surface as unknown as Record<string, unknown>).convertWeChatWebp
    expect(ctorCalls(converter)[0]).toEqual([bytes, 'D:/bin/ffmpeg.exe'])
  })

  it('异常 F1：无在线缓存且转换器缺席时，warn 不得误称「online icons retained」', async () => {
    const { surface } = makeSurface({ omitWebpConverter: true })
    const log = vi.fn()
    // 会话层下发本地包却不给 thumbnailCache 时，装配层两条图标链都建不起来；
    // 此时日志必须如实说明图标不可用，而不是宣称在线图标已保留。
    createPcCompanionServices({ ...options(surface, log), localClothingIcons: pack })
    const warnings = log.mock.calls
      .filter((call) => call[0] === 'warn')
      .map((call) => String(call[1]))
    expect(warnings.some((message) => message.includes('local icon pack'))).toBe(true)
    expect(warnings.some((message) => message.includes('online icons retained'))).toBe(false)
  })

  it('异常：convertWeChatWebp 缺席 ⇒ warn 且回落在线图标，不注入半套本地模式', async () => {
    const { surface } = makeSurface({ omitWebpConverter: true })
    const log = vi.fn()
    createPcCompanionServices({
      ...options(surface, log),
      thumbnailCache: { mark: 'cache' },
      localClothingIcons: pack
    })
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('local icon pack'))
    expect(ctorCalls(surface.WeChatIconProvider)).toHaveLength(1)
    const preview = await previewOptionsOf(surface)
    expect(preview.localClothingIcons).toBeUndefined()
    expect(typeof preview.loadIcon).toBe('function')
  })

  it('边界：未给 localClothingIcons ⇒ 与既有在线模式逐字一致', async () => {
    const { surface } = makeSurface()
    createPcCompanionServices({ ...options(surface), thumbnailCache: { mark: 'cache' } })
    expect(ctorCalls(surface.WeChatIconProvider)).toHaveLength(1)
    const preview = await previewOptionsOf(surface)
    expect(preview.localClothingIcons).toBeUndefined()
    expect(typeof preview.loadIcon).toBe('function')
  })
})
