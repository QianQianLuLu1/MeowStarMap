import fs from 'node:fs'
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as QRCode from 'qrcode'

import {
  buildPackagingContext,
  resolveDeepEntryUrl,
  resolveModuleRoot,
  type PackagingContext
} from './embedding-paths'
import { NIKKISYNC_PACKAGES, nikkisyncExport, type NikkiSyncModule } from './runtime-loader'
import {
  DESKTOP_CONTROL_SERVER_DEEP_ENTRY,
  DESKTOP_STATUS_SERVICE_DEEP_ENTRY,
  GALLERY_RUNTIME_DEEP_ENTRY,
  GAME_VERSION_UPDATE_SERVICE_DEEP_ENTRY,
  LAN_ADDRESS_DEEP_ENTRY,
  RUNTIME_MEMORY_MAINTENANCE_DEEP_ENTRY,
  WECHAT_DELETION_DEEP_ENTRY,
  WECHAT_GALLERY_SERVICE_DEEP_ENTRY,
  WECHAT_ICON_PROVIDER_DEEP_ENTRY,
  WECHAT_INSPIRATION_DEEP_ENTRY
} from './runtime-facade'
import type { NikkiSyncPcCompanionStatusInfo, PcCompanionServicesLike } from './runtime-types'

/**
 * N7：接入上游 PC 端 `desktop/*` 本机控制页 + `wechat/*` 微信画廊。
 *
 * 复用上游实现，不自行重写 HTTP/协议：本机控制页由 `createDesktopControlServer`
 * 提供（根路径 `/` 免 token 返回内嵌 token 的页面，API 才校验
 * `x-nikkisync-desktop-token`），微信画廊由 `WeChatGalleryService` 提供。上游 7 个
 * 深入口一律经 `resolveDeepEntryUrl` 组出的 `file://` URL **变量式动态 import**，
 * 不写字面量 `import('@nikkisync/...')`。
 *
 * 与上游 `windows-app.ts:196-254` 对齐的两端：
 * - 组装顺序：DesktopStatusService → 图标/内存/版本服务 → WeChatGalleryService →
 *   createDesktopControlServer → listen(随机端口, '127.0.0.1') → 后台服务 start；
 * - shutdown 顺序：versionUpdates.stop → memory.stop → wechat.stop → dashboard.close
 *   （`runtime.stop()` 由本仓 `stopNikkiSyncRuntime` 的 manager.stop() 负责，不在此重复）。
 *
 * 资源路径（4 份 legal 文档 / 品牌图 / 3 个 PS 脚本）由入参 `resourcesDir` 注入，
 * **不用上游 `import.meta.dirname` 拼路径**；ffmpeg/ffprobe 取本仓依赖导出的路径，
 * qrSvg 用本仓 `qrcode` 的 `QRCode.toString`。单测注入假 `PcCompanionSurface`，
 * 不依赖真实 `@nikkisync` 链接。
 */

export interface PcServerLike {
  listen(port: number, host: string, callback?: () => void): void
  close(callback?: (error?: unknown) => void): void
  address(): { port: number } | string | null
  on(event: string, listener: (...args: unknown[]) => void): void
  once(event: string, listener: (...args: unknown[]) => void): void
  removeListener(event: string, listener: (...args: unknown[]) => void): void
}

export interface PcWeChatLike {
  start(): Promise<{ qrSvg?: string } & Record<string, unknown>>
  stop(): Promise<void>
  status(): unknown
}

export interface PcLifecycleLike {
  start?(): void
  stop?(): void
  schedule?(): void
}

export interface PcCompanionSurface {
  createDesktopControlServer(config: Record<string, unknown>): PcServerLike
  DesktopStatusService: new (database: unknown) => { getStatus(input: unknown): unknown }
  WeChatGalleryService: new (config: Record<string, unknown>) => PcWeChatLike
  createIndexedPreviewSource: (...args: unknown[]) => unknown
  /** 上游具体类的 `get` 是必有方法（非可选），本仓最小面如实声明。 */
  WeChatIconProvider?: new (...args: unknown[]) => { get(descriptor: unknown): unknown }
  RuntimeMemoryMaintenance?: new (...args: unknown[]) => PcLifecycleLike
  GameVersionUpdateService?: new (...args: unknown[]) => PcLifecycleLike
  /**
   * 4cb71e2（v1.0.31）新增的可选面：两个微信画廊包装器（老链接缺深入口时为 undefined，
   * 组装据此整段跳过对应能力，不抛错）。字节变换函数（resizeForWeChat 等）自 589b932
   * 起即存在，按必需面装载（缺失在 loadPcCompanionSurface 即抛可诊断错误）。
   */
  withWeChatInspiration?: (
    source: unknown,
    store: unknown,
    resize: (bytes: Uint8Array) => Promise<Uint8Array>
  ) => unknown
  withWeChatDeletion?: (source: unknown, queue: unknown) => unknown
  resizeForWeChat: (bytes: Uint8Array, script: string) => Promise<Uint8Array>
  resizeWeChatIcon: (bytes: Uint8Array, script: string) => Promise<Uint8Array>
  rotatePng: (bytes: Uint8Array, rotation: number, script?: string) => Promise<Uint8Array>
  exportLive: (
    jpeg: Uint8Array,
    video: Uint8Array,
    options: Record<string, unknown>
  ) => Promise<{ image: Uint8Array; mime: string }>
  listLanIpv4?: () => string[]
}

export interface PcCompanionServicesOptions {
  /** 注入的上游服务面（真实装配由 `loadPcCompanionSurface` 产出）。 */
  surface: PcCompanionSurface
  /** 本仓暂存的上游资源目录（`ROOT/resources/nikkisync/pc`）。 */
  resourcesDir: string
  qrSvg?: (payload: string) => Promise<string>
  ffmpegPath?: string
  ffprobePath?: string
  host?: string | (() => string)
  database?: unknown
  /** C1：真实扫描根（由 `pcCompanionContext()` 下传）；缺省回落空数组。 */
  scanRoots?: readonly string[]
  pairingUri?: () => string
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** dashboard.close 永不回调时的放行时长（缺省 3000ms，与优雅停止同口径）；单测可注入缩短。 */
  closeTimeoutMs?: number
  /**
   * 4cb71e2（v1.0.31）：会话实例与 LAN 服务端口的只读透传（同一引用，缺席即不挂键）。
   * inspirations/deletions 供微信画廊两个包装器；extraDirectories/accounts 供控制页面板；
   * thumbnailCache 供 WeChatIconProvider（与 server 共享同一缓存实例）；syncPort 供
   * 控制页「同步与连接」的状态展示（D5）。
   */
  inspirations?: unknown
  deletions?: unknown
  extraDirectories?: unknown
  accounts?: unknown
  thumbnailCache?: unknown
  syncPort?: () => number | undefined
}

/** 4 份 legal 文档（键逐字对齐上游 windows-app.ts:226）。缺件不阻断，只留空。 */
function loadLegalDocuments(resourcesDir: string): Record<string, string> {
  const files: Record<string, string> = {
    privacy: 'PRIVACY_POLICY.md',
    terms: 'USER_AGREEMENT.md',
    permissions: 'PERMISSIONS_DATA.md',
    services: 'SDK_SERVICES.md'
  }
  const out: Record<string, string> = {}
  for (const [key, file] of Object.entries(files)) {
    try {
      out[key] = fs.readFileSync(path.join(resourcesDir, file), 'utf8')
    } catch {
      // 资源未暂存（CI / 首次运行）时不编造内容：上游 config 里该键缺省即不挂路由
    }
  }
  return out
}

function loadBrandImage(resourcesDir: string): Buffer | undefined {
  return loadPngAsset(resourcesDir, 'momo-camera.png')
}

/** 4cb71e2：控制页 `/wechat-entry.png` 路由的图片源（缺件时上游不挂路由，故同样缺省不挂键）。 */
function loadWeChatEntryImage(resourcesDir: string): Buffer | undefined {
  return loadPngAsset(resourcesDir, 'wechat-mini-entry.png')
}

function loadPngAsset(resourcesDir: string, file: string): Buffer | undefined {
  try {
    return fs.readFileSync(path.join(resourcesDir, file))
  } catch {
    return undefined
  }
}

/**
 * 变量式动态 import 上游深入口（保持与 runtime-facade.loadDeepModule 同一护栏口径）。
 * 必需面（589b932 起即存在）缺失即抛可诊断错误；4cb71e2 新增的两个包装器按可选面装载
 * （老链接缺深入口 ⇒ undefined，组装层据此整段降级）。
 */
export async function loadPcCompanionSurface(
  projectRoot: string,
  context?: PackagingContext
): Promise<PcCompanionSurface> {
  const packaging = context ?? buildPackagingContext({ isPackaged: false, projectRoot })
  const root = resolveModuleRoot(NIKKISYNC_PACKAGES.pcCompanion, packaging)
  const load = async (segments: readonly string[]): Promise<NikkiSyncModule> =>
    await import(/* @vite-ignore */ resolveDeepEntryUrl(root.root, segments))
  /** 可选面装载：老链接缺深入口文件 ⇒ undefined（组装层据此整段降级）；必需面仍走 load 缺失即抛。 */
  const loadOptional = async (
    segments: readonly string[]
  ): Promise<NikkiSyncModule | undefined> => {
    try {
      return await load(segments)
    } catch {
      return undefined
    }
  }
  const [desktop, status, wechat, runtime, icons, memory, version, lan, deletion, inspiration] =
    await Promise.all([
      load(DESKTOP_CONTROL_SERVER_DEEP_ENTRY),
      load(DESKTOP_STATUS_SERVICE_DEEP_ENTRY),
      load(WECHAT_GALLERY_SERVICE_DEEP_ENTRY),
      load(GALLERY_RUNTIME_DEEP_ENTRY),
      load(WECHAT_ICON_PROVIDER_DEEP_ENTRY),
      load(RUNTIME_MEMORY_MAINTENANCE_DEEP_ENTRY),
      load(GAME_VERSION_UPDATE_SERVICE_DEEP_ENTRY),
      load(LAN_ADDRESS_DEEP_ENTRY),
      loadOptional(WECHAT_DELETION_DEEP_ENTRY),
      loadOptional(WECHAT_INSPIRATION_DEEP_ENTRY)
    ])
  const pick = (mod: NikkiSyncModule | undefined, name: string): unknown =>
    mod === undefined ? undefined : (mod as unknown as Record<string, unknown>)[name]
  /** 必需导出：缺失即抛（与 runtime-loader.nikkisyncExport 同一报错口径，含修复指令）。 */
  const pickRequired = <T>(mod: NikkiSyncModule, name: string): T => nikkisyncExport(mod, name) as T
  return {
    createDesktopControlServer: pickRequired<PcCompanionSurface['createDesktopControlServer']>(
      desktop,
      'createDesktopControlServer'
    ),
    DesktopStatusService: pickRequired<PcCompanionSurface['DesktopStatusService']>(
      status,
      'DesktopStatusService'
    ),
    WeChatGalleryService: pickRequired<PcCompanionSurface['WeChatGalleryService']>(
      wechat,
      'WeChatGalleryService'
    ),
    createIndexedPreviewSource: pickRequired<PcCompanionSurface['createIndexedPreviewSource']>(
      runtime,
      'createIndexedPreviewSource'
    ),
    // 字节变换函数：上游 createIndexedPreviewSource 契约的必需回调（589b932 起即导出）
    resizeForWeChat: pickRequired<PcCompanionSurface['resizeForWeChat']>(wechat, 'resizeForWeChat'),
    resizeWeChatIcon: pickRequired<PcCompanionSurface['resizeWeChatIcon']>(
      icons,
      'resizeWeChatIcon'
    ),
    rotatePng: pickRequired<PcCompanionSurface['rotatePng']>(runtime, 'rotatePng'),
    exportLive: pickRequired<PcCompanionSurface['exportLive']>(runtime, 'exportLive'),
    ...(pick(lan, 'listLanIpv4')
      ? { listLanIpv4: pick(lan, 'listLanIpv4') as () => string[] }
      : {}),
    // 4cb71e2 起存在的可选包装器：老链接缺件 ⇒ undefined（组装整段降级，绝不抛）
    ...(pick(deletion, 'withWeChatDeletion')
      ? {
          withWeChatDeletion: pick(
            deletion,
            'withWeChatDeletion'
          ) as PcCompanionSurface['withWeChatDeletion']
        }
      : {}),
    ...(pick(inspiration, 'withWeChatInspiration')
      ? {
          withWeChatInspiration: pick(
            inspiration,
            'withWeChatInspiration'
          ) as PcCompanionSurface['withWeChatInspiration']
        }
      : {}),
    ...(pick(icons, 'WeChatIconProvider')
      ? {
          WeChatIconProvider: pick(
            icons,
            'WeChatIconProvider'
          ) as PcCompanionSurface['WeChatIconProvider']
        }
      : {}),
    ...(pick(memory, 'RuntimeMemoryMaintenance')
      ? {
          RuntimeMemoryMaintenance: pick(
            memory,
            'RuntimeMemoryMaintenance'
          ) as PcCompanionSurface['RuntimeMemoryMaintenance']
        }
      : {}),
    ...(pick(version, 'GameVersionUpdateService')
      ? {
          GameVersionUpdateService: pick(
            version,
            'GameVersionUpdateService'
          ) as PcCompanionSurface['GameVersionUpdateService']
        }
      : {})
  }
}

/** 纯装配：注入 surface 后构造服务对象（不触网络；listen 只在 start() 内发生）。 */
export function createPcCompanionServices(
  options: PcCompanionServicesOptions
): PcCompanionServicesLike {
  const { surface, resourcesDir } = options
  const log = options.log ?? (() => undefined)
  const safeLog = (level: 'info' | 'warn' | 'error', message: string): void => {
    try {
      log(level, message)
    } catch {
      // 日志通道不可用不得影响启停链
    }
  }
  const qrSvg = options.qrSvg ?? ((payload: string) => QRCode.toString(payload, { type: 'svg' }))
  const ffmpegPath = options.ffmpegPath ?? ''
  const ffprobePath = options.ffprobePath ?? ''
  const ps1Dir = path.join(resourcesDir, 'wechat')
  // C1：扫描根来自会话上下文，视为不可信输入（只收字符串）；缺省空数组 ⇒ 画廊仍可启停但无照片。
  const scanRoots = Array.isArray(options.scanRoots)
    ? options.scanRoots.filter((root): root is string => typeof root === 'string')
    : []

  // 组装顺序对齐 windows-app.ts:196-213
  const statusService = new surface.DesktopStatusService(options.database ?? {})
  const ps1Script = (name: string): string => path.join(ps1Dir, name)
  /** 上游 resize 契约的字节变换回调（D1 修复：修复前误传脚本路径）。 */
  const resizeBytes = (bytes: Uint8Array): Promise<Uint8Array> =>
    surface.resizeForWeChat(bytes, ps1Script('resize-preview.ps1'))
  /**
   * D4 修复：WeChatIconProvider 的上游构造契约是 (cache, resize) 必填（589b932 起）——
   * 缓存与 server 共享同一实例（对齐上游单实例共享），resize 委托上游 resizeWeChatIcon +
   * 暂存脚本。任一缺席（老链接/无缓存目录）⇒ 不构造图标面，preview options 相应省略
   * loadIcon（上游按可选处理），不伪造空实例。
   */
  const icons =
    surface.WeChatIconProvider && options.thumbnailCache
      ? new surface.WeChatIconProvider(options.thumbnailCache, (bytes: Uint8Array) =>
          surface.resizeWeChatIcon(bytes, ps1Script('resize-icon.ps1'))
        )
      : undefined
  const memory = surface.RuntimeMemoryMaintenance
    ? new surface.RuntimeMemoryMaintenance()
    : undefined
  const versionUpdates = surface.GameVersionUpdateService
    ? new surface.GameVersionUpdateService()
    : undefined

  /**
   * 微信画廊的资产源：复用上游 `createIndexedPreviewSource`，ffmpeg/ffprobe 与 3 个 PS
   * 脚本路径由本仓入参注入（不用上游 `import.meta.dirname` 拼 tools/ 路径）。
   * C1：扫描根来自会话上下文，视为不可信输入（只收字符串）；4cb71e2 起对齐上游逐个
   * `realpath`——不存在/别名根剔除，绝不伪造资产。
   * 4cb71e2：包装顺序对齐上游 windows-app.ts——灵感库在内、删除在外；包装器或实例缺席
   * （老链接/未开启）时整段跳过，不抛错。
   */
  const snapshot = async (): Promise<unknown> => {
    const roots = (
      await Promise.all(
        scanRoots.map(async (root) => {
          try {
            return await realpath(root)
          } catch {
            return undefined
          }
        })
      )
    ).filter((root): root is string => typeof root === 'string' && root.length > 0)
    let source: unknown = surface.createIndexedPreviewSource(options.database ?? {}, roots, {
      ...(icons ? { loadIcon: (descriptor: unknown) => icons.get(descriptor) } : {}),
      // 上游 4cb71e2 新增 motionFfmpeg：宿主等价物为 ffmpeg-static 的二进制路径
      ...(ffmpegPath ? { motionFfmpeg: ffmpegPath } : {}),
      // D1–D3 修复：三个回调必须是字节变换函数并委托上游实现（修复前误传脚本路径/options 对象）
      exportLive: (jpeg: Uint8Array, video: Uint8Array, extra?: Record<string, unknown>) =>
        surface.exportLive(jpeg, video, {
          ...(extra ?? {}),
          ...(ffmpegPath ? { ffmpeg: ffmpegPath } : {}),
          ...(ffprobePath ? { ffprobe: ffprobePath } : {})
        }),
      rotatePng: (bytes: Uint8Array, rotation: number) =>
        surface.rotatePng(bytes, rotation, ps1Script('rotate-png.ps1')),
      resize: (bytes: Uint8Array) => resizeBytes(bytes)
    })
    if (surface.withWeChatInspiration && options.inspirations) {
      source = surface.withWeChatInspiration(source, options.inspirations, resizeBytes)
    }
    if (surface.withWeChatDeletion && options.deletions) {
      source = surface.withWeChatDeletion(source, options.deletions)
    }
    return source
  }

  // 属性访问不进闭包收窄：先落到 const 局部再在条件展开里引用
  const listLanAddresses = surface.listLanIpv4
  const wechat = new surface.WeChatGalleryService({
    host: options.host ?? '127.0.0.1',
    // 4cb71e2：多网卡备选地址（上游服务内部过滤私网段并截 8）；装载缺席 ⇒ 降级单 host
    ...(listLanAddresses ? { hosts: () => listLanAddresses() } : {}),
    snapshot,
    qrSvg,
    onWorkSettled: () => memory?.schedule?.()
  })

  /** 目录成功变更后停掉旧快照的微信画廊（上游 onScopeChanged 联动）；失败只落日志。 */
  const stopWechatQuietly = async (): Promise<void> => {
    try {
      await wechat.stop()
    } catch (error) {
      safeLog('warn', `[pc-companion] wechat stop on scope change failed: ${String(error)}`)
    }
  }

  /**
   * 4cb71e2：控制页扫描目录面板——会话**同一实例**外裹薄包装：add/remove/rescan 成功后
   * 联动 wechat.stop；上游错误原样上抛（此刻不触发联动）。实例缺席 ⇒ 整键不挂。
   */
  const extra = options.extraDirectories as
    | {
        state(): unknown
        inspect(selected: unknown, source?: unknown): Promise<unknown>
        add(id: string): Promise<unknown>
        remove(id: string): Promise<unknown>
        rescan(): Promise<unknown>
        setSource(id: unknown, source: unknown): Promise<unknown>
      }
    | undefined
  const scanDirectoriesForDashboard = extra
    ? {
        state: () => extra.state(),
        inspect: (selected: unknown, source?: unknown) => extra.inspect(selected, source),
        add: async (id: string) => {
          const result = await extra.add(id)
          await stopWechatQuietly()
          return result
        },
        remove: async (id: string) => {
          const result = await extra.remove(id)
          await stopWechatQuietly()
          return result
        },
        rescan: async () => {
          const result = await extra.rescan()
          await stopWechatQuietly()
          return result
        },
        setSource: (id: unknown, source: unknown) => extra.setSource(id, source)
      }
    : undefined

  let desktopPort: number | undefined
  let running = false
  let starting: Promise<void> | undefined
  const closeTimeoutMs = options.closeTimeoutMs ?? 3000
  const desktopUrl = (): string =>
    desktopPort === undefined ? '' : `http://127.0.0.1:${desktopPort}/`
  const currentHost = (): string =>
    typeof options.host === 'function' ? options.host() : (options.host ?? '127.0.0.1')

  const brandImage = loadBrandImage(resourcesDir)
  const wechatEntryImage = loadWeChatEntryImage(resourcesDir)
  // F6 语义说明：dashboard 是「本机控制页 + 微信画廊」的**共同 HTTP 宿主**（上游
  // createDesktopControlServer 把两者的路由挂同一台 server 上）。因此
  // `desktopControl=false` 而 `wechatGallery=true` 时仍然会 listen——
  // `NIKKI_NIKKISYNC_DESKTOP=0` 只关「控制页能力位」（状态页不再对外暴露状态），
  // 并不关闭宿主监听；拆分 listen 会把微信画廊的出码/出图一并拆没，不属逃生阀语义。
  const dashboard = surface.createDesktopControlServer({
    legalDocuments: loadLegalDocuments(resourcesDir),
    ...(brandImage ? { brandImage } : {}),
    // 4cb71e2：小程序入口码（缺件时上游不挂 /wechat-entry.png 路由，同样缺省不挂键）
    ...(wechatEntryImage ? { wechatEntryImage } : {}),
    // D5 修复：控制页状态展示用 LAN 同步服务实际端口（修复前误传 dashboard 自身端口）
    getStatus: () =>
      statusService.getStatus({ host: currentHost(), port: options.syncPort?.() ?? 0 }),
    createPairingUri: () => {
      if (!options.pairingUri) return ''
      try {
        const uri = options.pairingUri()
        if (typeof uri === 'string') return uri
        safeLog('warn', '[pc-companion] pairing uri is not a string; falling back to empty')
        return ''
      } catch (error) {
        safeLog('warn', `[pc-companion] pairing uri unavailable: ${String(error)}`)
        return ''
      }
    },
    qrSvg,
    // 4cb71e2：控制页四面板（inspirations/accounts/deletions/scanDirectories，同一会话实例）
    ...(options.inspirations ? { inspirations: options.inspirations } : {}),
    ...(options.accounts ? { accounts: options.accounts } : {}),
    ...(options.deletions ? { deletions: options.deletions } : {}),
    ...(scanDirectoriesForDashboard ? { scanDirectories: scanDirectoriesForDashboard } : {}),
    wechatGallery: {
      start: () => wechat.start(),
      stop: () => wechat.stop(),
      status: () => wechat.status()
    }
  })

  /**
   * B3/F1 共用：dashboard.close 永不回调会卡死退出链 ⇒ Promise.race 超时兜底；
   * 回调带 err 也只落日志。定时器在 finally 立即释放，settled 保证迟到的回调
   * 不再二次 settle / 误报。stop() 与 start() 的回滚路径都走这里。
   */
  const closeDashboardQuietly = async (): Promise<void> => {
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          dashboard.close((error?: unknown) => {
            if (settled) return
            settled = true
            if (error) reject(error)
            else resolve()
          })
        }),
        new Promise<void>((resolve) => {
          closeTimer = setTimeout(() => {
            if (settled) return
            settled = true
            safeLog('warn', '[pc-companion] dashboard close timed out; releasing exit chain')
            resolve()
          }, closeTimeoutMs)
        })
      ])
    } catch (error) {
      safeLog('warn', `[pc-companion] dashboard close failed: ${String(error)}`)
    } finally {
      if (closeTimer !== undefined) clearTimeout(closeTimer)
    }
  }

  return {
    async start(): Promise<void> {
      // B2：running 守卫 + 启动 Promise 去重，并发 start 不得重复 listen / 重复挂监听。
      if (running) return
      if (starting) return starting
      const attempt = (async (): Promise<void> => {
        let onError: ((error: unknown) => void) | undefined
        let listened = false
        let versionStarted = false
        let memoryStarted = false
        try {
          await new Promise<void>((resolve, reject) => {
            // 具名监听：成功/失败路径都能在 finally 精确移除，不用匿名 reject 常驻。
            onError = (error: unknown): void => reject(error)
            dashboard.once('error', onError)
            dashboard.listen(0, '127.0.0.1', resolve)
          })
          // F1：listen 已成功（端口已被本服务占用），后续任何一步失败都必须把
          // dashboard 一并关闭——否则监听 socket 泄漏到进程退出，且 status/desktopUrl
          // 与实际监听状态背离，再无句柄能收回它。
          listened = true
          const address = dashboard.address()
          if (!address || typeof address === 'string') {
            throw new Error('desktop control server has no address')
          }
          desktopPort = address.port
          // 先置位再 start：start 中途抛错的服务可能已部分初始化，必须一并纳入回滚。
          versionStarted = true
          versionUpdates?.start?.()
          memoryStarted = true
          memory?.start?.()
          running = true
        } catch (error) {
          // B1：启动中途抛错必须回滚已启动的后台服务，绝不吞错返回半成品 services。
          // 逐步独立 try/catch：回滚失败不得掩盖原始启动错误。
          if (versionStarted) {
            try {
              versionUpdates?.stop?.()
            } catch (rollbackError) {
              safeLog(
                'warn',
                `[pc-companion] version updates rollback failed: ${String(rollbackError)}`
              )
            }
          }
          if (memoryStarted) {
            try {
              memory?.stop?.()
            } catch (rollbackError) {
              safeLog(
                'warn',
                `[pc-companion] memory maintenance rollback failed: ${String(rollbackError)}`
              )
            }
          }
          if (listened) {
            // F1：与 stop() 同款 race+超时兜底；close 失败只落日志，不掩盖原始错误。
            await closeDashboardQuietly()
          }
          running = false
          desktopPort = undefined
          safeLog('warn', `[pc-companion] desktop control start failed: ${String(error)}`)
          throw error
        } finally {
          // B2：成功路径也要移除 error 监听，listenerCount 归零。
          if (onError) dashboard.removeListener('error', onError)
        }
      })()
      starting = attempt.finally(() => {
        starting = undefined
      })
      return starting
    },

    async stop(): Promise<void> {
      // F5：start 在途时先等它落地（成功或失败）再拆除——否则本 stop 的 close 发生在
      // attempt 完成之前，attempt 随后把服务重新拉起，留下「stop 已返回但服务在监听」。
      if (starting) {
        await starting.catch(() => undefined)
      }
      // 每步独立 try/catch：任一上游服务抛错都不得卡住退出链
      try {
        versionUpdates?.stop?.()
      } catch (error) {
        safeLog('warn', `[pc-companion] version updates stop failed: ${String(error)}`)
      }
      try {
        memory?.stop?.()
      } catch (error) {
        safeLog('warn', `[pc-companion] memory maintenance stop failed: ${String(error)}`)
      }
      try {
        await wechat.stop()
      } catch (error) {
        safeLog('warn', `[pc-companion] wechat stop failed: ${String(error)}`)
      }
      // B3：close 永不回调会卡死退出链 ⇒ Promise.race 超时兜底；同时处理回调里的 err。
      await closeDashboardQuietly()
      running = false
      desktopPort = undefined
    },

    status(): NikkiSyncPcCompanionStatusInfo {
      return { running, desktopUrl: desktopUrl(), wechat: wechat.status() }
    },

    desktopUrl,

    async wechatStart() {
      const result = await wechat.start()
      return {
        status: wechat.status(),
        qrSvg: typeof result?.qrSvg === 'string' ? result.qrSvg : ''
      }
    },

    async wechatStop() {
      await wechat.stop()
      return { status: wechat.status() }
    },

    wechatStatus() {
      return wechat.status()
    }
  }
}

export interface StartPcCompanionOptions {
  projectRoot: string
  resourcesDir: string
  packagingContext?: PackagingContext
  database?: unknown
  /** C1：真实扫描根（由 `pcCompanionContext()` 下传）。 */
  scanRoots?: readonly string[]
  host?: string | (() => string)
  pairingUri?: () => string
  /** 上游能力位：外部输入默认不可信，两个开关都只认显式 true。 */
  wechatGallery?: boolean
  desktopControl?: boolean
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** 4cb71e2：会话实例与 LAN 服务端口的只读透传（见 PcCompanionServicesOptions）。 */
  inspirations?: unknown
  deletions?: unknown
  extraDirectories?: unknown
  accounts?: unknown
  thumbnailCache?: unknown
  syncPort?: () => number | undefined
}

/** 生产装配入口：装载真实上游面 → 构造 → start；任一开关都没开则返回 undefined。 */
export async function startPcCompanionServices(
  options: StartPcCompanionOptions
): Promise<PcCompanionServicesLike | undefined> {
  if (options.wechatGallery !== true && options.desktopControl !== true) return undefined
  try {
    const surface = await loadPcCompanionSurface(options.projectRoot, options.packagingContext)
    // 可选包装器缺席（老链接/未重建）只 warn 不阻断：画廊不带灵感库/删除包装继续装配
    if (!surface.withWeChatInspiration || !surface.withWeChatDeletion) {
      try {
        options.log?.(
          'warn',
          '[pc-companion] WeChat inspiration/deletion wrappers unavailable; continuing without them'
        )
      } catch {
        // 日志通道不可用不得影响装配结果
      }
    }
    // 不用 import.meta（主进程 tsconfig 的 module 不允许该元属性）：以工程 package.json
    // 为 require 基准解析 ffmpeg-static / ffprobe-static 的包导出路径。
    const require = createRequire(path.join(options.projectRoot, 'package.json'))
    const services = createPcCompanionServices({
      surface,
      resourcesDir: options.resourcesDir,
      ffmpegPath: String(require('ffmpeg-static')),
      ffprobePath: String((require('ffprobe-static') as { path?: string }).path ?? ''),
      qrSvg: (payload) => QRCode.toString(payload, { type: 'svg' }),
      database: options.database,
      scanRoots: options.scanRoots,
      host: options.host,
      pairingUri: options.pairingUri,
      inspirations: options.inspirations,
      deletions: options.deletions,
      extraDirectories: options.extraDirectories,
      accounts: options.accounts,
      thumbnailCache: options.thumbnailCache,
      syncPort: options.syncPort,
      log: options.log
    })
    await services.start()
    return services
  } catch (error) {
    // B1：装配 / start 失败一律返回 undefined，绝不把半成品服务递给上层；留 warn 不静默。
    try {
      options.log?.('warn', `[pc-companion] companion services assembly failed: ${String(error)}`)
    } catch {
      // 日志通道不可用不得影响装配结果
    }
    return undefined
  }
}
