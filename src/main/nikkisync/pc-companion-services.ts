import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import * as QRCode from 'qrcode'

import {
  buildPackagingContext,
  resolveDeepEntryUrl,
  resolveModuleRoot,
  type PackagingContext
} from './embedding-paths'
import { NIKKISYNC_PACKAGES, type NikkiSyncModule } from './runtime-loader'
import {
  DESKTOP_CONTROL_SERVER_DEEP_ENTRY,
  DESKTOP_STATUS_SERVICE_DEEP_ENTRY,
  GALLERY_RUNTIME_DEEP_ENTRY,
  GAME_VERSION_UPDATE_SERVICE_DEEP_ENTRY,
  RUNTIME_MEMORY_MAINTENANCE_DEEP_ENTRY,
  WECHAT_GALLERY_SERVICE_DEEP_ENTRY,
  WECHAT_ICON_PROVIDER_DEEP_ENTRY
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
  WeChatIconProvider?: new (...args: unknown[]) => { get?(descriptor: unknown): unknown }
  RuntimeMemoryMaintenance?: new (...args: unknown[]) => PcLifecycleLike
  GameVersionUpdateService?: new (...args: unknown[]) => PcLifecycleLike
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
  try {
    return fs.readFileSync(path.join(resourcesDir, 'momo-camera.png'))
  } catch {
    return undefined
  }
}

/** 变量式动态 import 上游 7 个深入口（保持与 runtime-facade.loadDeepModule 同一护栏口径）。 */
export async function loadPcCompanionSurface(
  projectRoot: string,
  context?: PackagingContext
): Promise<PcCompanionSurface> {
  const packaging = context ?? buildPackagingContext({ isPackaged: false, projectRoot })
  const root = resolveModuleRoot(NIKKISYNC_PACKAGES.pcCompanion, packaging)
  const load = async (segments: readonly string[]): Promise<NikkiSyncModule> =>
    await import(/* @vite-ignore */ resolveDeepEntryUrl(root.root, segments))
  const [desktop, status, wechat, runtime, icons, memory, version] = await Promise.all([
    load(DESKTOP_CONTROL_SERVER_DEEP_ENTRY),
    load(DESKTOP_STATUS_SERVICE_DEEP_ENTRY),
    load(WECHAT_GALLERY_SERVICE_DEEP_ENTRY),
    load(GALLERY_RUNTIME_DEEP_ENTRY),
    load(WECHAT_ICON_PROVIDER_DEEP_ENTRY),
    load(RUNTIME_MEMORY_MAINTENANCE_DEEP_ENTRY),
    load(GAME_VERSION_UPDATE_SERVICE_DEEP_ENTRY)
  ])
  const pick = (mod: NikkiSyncModule, name: string): unknown =>
    (mod as unknown as Record<string, unknown>)[name]
  return {
    createDesktopControlServer: pick(
      desktop,
      'createDesktopControlServer'
    ) as PcCompanionSurface['createDesktopControlServer'],
    DesktopStatusService: pick(
      status,
      'DesktopStatusService'
    ) as PcCompanionSurface['DesktopStatusService'],
    WeChatGalleryService: pick(
      wechat,
      'WeChatGalleryService'
    ) as PcCompanionSurface['WeChatGalleryService'],
    createIndexedPreviewSource: pick(
      runtime,
      'createIndexedPreviewSource'
    ) as PcCompanionSurface['createIndexedPreviewSource'],
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
  const icons = surface.WeChatIconProvider ? new surface.WeChatIconProvider() : undefined
  const memory = surface.RuntimeMemoryMaintenance
    ? new surface.RuntimeMemoryMaintenance()
    : undefined
  const versionUpdates = surface.GameVersionUpdateService
    ? new surface.GameVersionUpdateService()
    : undefined

  /**
   * 微信画廊的资产源：复用上游 `createIndexedPreviewSource`，但 ffmpeg/ffprobe 与
   * 3 个 PS 脚本路径全部由本仓入参注入（不用上游 `import.meta.dirname` 拼 tools/ 路径）。
   * C1：第二参改为会话上下文下传的真实扫描根，画廊因此能列出真实照片；
   * 无根时仍是空集合（可启停与出二维码），绝不伪造资产。
   */
  const snapshot = async (): Promise<unknown> =>
    surface.createIndexedPreviewSource(options.database ?? {}, [...scanRoots], {
      loadIcon: (descriptor: unknown) => icons?.get?.(descriptor),
      exportLive: (_jpeg: unknown, _video: unknown, extra?: Record<string, unknown>) => ({
        ...(extra ?? {}),
        ffmpeg: ffmpegPath,
        ffprobe: ffprobePath
      }),
      rotatePng: () => path.join(ps1Dir, 'rotate-png.ps1'),
      resize: () => path.join(ps1Dir, 'resize-preview.ps1'),
      resizeIcon: () => path.join(ps1Dir, 'resize-icon.ps1')
    })

  const wechat = new surface.WeChatGalleryService({
    host: options.host ?? '127.0.0.1',
    snapshot,
    qrSvg,
    onWorkSettled: () => memory?.schedule?.()
  })

  let desktopPort: number | undefined
  let running = false
  let starting: Promise<void> | undefined
  const closeTimeoutMs = options.closeTimeoutMs ?? 3000
  const desktopUrl = (): string =>
    desktopPort === undefined ? '' : `http://127.0.0.1:${desktopPort}/`
  const currentHost = (): string =>
    typeof options.host === 'function' ? options.host() : (options.host ?? '127.0.0.1')

  const brandImage = loadBrandImage(resourcesDir)
  const dashboard = surface.createDesktopControlServer({
    legalDocuments: loadLegalDocuments(resourcesDir),
    ...(brandImage ? { brandImage } : {}),
    getStatus: () => statusService.getStatus({ host: currentHost(), port: desktopPort ?? 0 }),
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
    wechatGallery: {
      start: () => wechat.start(),
      stop: () => wechat.stop(),
      status: () => wechat.status()
    }
  })

  return {
    async start(): Promise<void> {
      // B2：running 守卫 + 启动 Promise 去重，并发 start 不得重复 listen / 重复挂监听。
      if (running) return
      if (starting) return starting
      const attempt = (async (): Promise<void> => {
        let onError: ((error: unknown) => void) | undefined
        let versionStarted = false
        let memoryStarted = false
        try {
          await new Promise<void>((resolve, reject) => {
            // 具名监听：成功/失败路径都能在 finally 精确移除，不用匿名 reject 常驻。
            onError = (error: unknown): void => reject(error)
            dashboard.once('error', onError)
            dashboard.listen(0, '127.0.0.1', resolve)
          })
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
      // 定时器在 finally 立即释放，settled 保证迟到的回调不再二次 settle / 误报。
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
}

/** 生产装配入口：装载真实上游面 → 构造 → start；任一开关都没开则返回 undefined。 */
export async function startPcCompanionServices(
  options: StartPcCompanionOptions
): Promise<PcCompanionServicesLike | undefined> {
  if (options.wechatGallery !== true && options.desktopControl !== true) return undefined
  try {
    const surface = await loadPcCompanionSurface(options.projectRoot, options.packagingContext)
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
