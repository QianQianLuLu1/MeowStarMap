/**
 * 内嵌 NikkiSync Runtime 的生命周期编排（整合阶段 2）。
 *
 * 职责边界（务必守住）：
 * - 本文件**只做编排**：状态机、幂等、降级、换根重建、优雅停止、未就绪拒绝。
 *   装载与查询在 `runtime-facade.ts`，Electron 装配在 `app/nikkisync-runtime-setup.ts`。
 * - 扫描/数据库/DTO 一律交给上游：这里只调 `scanner.start()/fullScan()/rescanPath()/stop()`
 *   与 `queries.*`，不解析、不改写、不重命名任何字段。
 * - 分段启动（见 docs/sync-integration/00-nikkisync-pc-audit-report.md §8.2 与风险 R2）：
 *   上游 `runtime.start()` 把 `scanner.start()` 当硬前置且随后启 LAN 服务；本模块因此
 *   **不用** `runtime.start()`，而是 scanner 与 server 各自独立启停：
 *   `start()` 只启 scanner，LAN 服务由 `startSyncServer()` 显式启（阶段 3）。
 *   上游 `LocalSyncServerConfig` 冻结在构造期 ⇒ 端口/mdns 变更走会话重建。
 * - 启动失败不外抛（验收：Runtime 启动失败时应用不崩溃），原因与修复指令进状态快照；
 *   `startSyncServer()` 同口径：端口占用归类成 `PORT_IN_USE` 写进状态，**不上抛**。
 */

import type {
  NikkiSyncPairedDeviceView,
  NikkiSyncPairingCode,
  NikkiSyncRuntimeHandle,
  NikkiSyncRuntimeSession,
  NikkiSyncRuntimeState,
  NikkiSyncRuntimeStatus,
  NikkiSyncSessionOptions,
  NikkiSyncSyncServerAddress,
  NikkiSyncSyncServerConfig,
  NikkiSyncSyncServerStatus
} from './runtime-types'
import {
  LOOPBACK_FALLBACK_HOST,
  buildSyncStatusSnapshot,
  classifySyncStartError,
  parsePairingUri,
  resolveSyncServerConfig
} from './sync-server-view'
// 阶段 4：会话拆除时收回 media:// 的资产路径授权（模块级单例，见 resource-allowlist）
import { clearNikkiSyncResourcePaths } from './resource-allowlist'

/**
 * 上游在「找不到游戏安装目录」时的原始消息（`scanner/ScannerService.ts` 内硬编码）。
 * 这里按原文匹配做降级判定，不改写、不本地化。
 */
export const installNotfoundMessage = 'Infinity Nikki installation was not found'

/** 未建链时给用户的可执行修复指令（英文，本地化归渲染层）。 */
export const linkMissingHint =
  'the @nikkisync/* links are not ready; run `npm run link:nikkisync` in WXNN XiangCe ' +
  'and `npm run build` in NikkiSync, then `npm run verify:nikkisync`'

/** 优雅停止单步兜底时长（watcher 关闭 / sqlite close 卡住时放行退出链）。 */
export const defaultStopTimeoutMs = 3000

/** 假会话编排形态（仅测试用；导出以便用例与实现共用一份口径）。 */
export interface FakeSessionPlan {
  startError?: 'notfound' | 'other'
  stopHangs?: boolean
  stopThrows?: boolean
  /** 整体覆盖 `scanner.getStatus()` 返回值（测试专用：注入非对象/缺字段等边界形态）。 */
  scannerStatusRaw?: unknown
  /** `server.start()` 的失败形态：`eaddrinuse` 用于验证 `PORT_IN_USE` 归类。 */
  serverStartError?: 'eaddrinuse' | 'other'
  /** `createPairingUri` 是否模拟上游「服务未启动」的原生抛错。 */
  pairingUriThrows?: boolean
  /** `revokePairedDevice` 的返回值（默认 true）。 */
  revokeResult?: boolean
}

export interface RuntimeManagerDependencies {
  /** 装配层提供的默认会话参数（userData 库路径、开关、projectRoot、打包态上下文）。 */
  defaults: NikkiSyncSessionOptions
  /** 装载 + 组装一个会话（真实现来自 `runtime-facade.createRuntimeSession`）。 */
  createSession(options: NikkiSyncSessionOptions): Promise<NikkiSyncRuntimeSession>
  isLinkReady(projectRoot: string): boolean
  ensureDatabaseDirectory(databaseFile: string): void
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** 停止类操作的超时包装：超时返回 undefined，不抛错。 */
  withTimeout<T>(label: string, work: () => Promise<T>): Promise<T | undefined>
  /**
   * 配对二维码里要写的局域网地址解析器（由装配层注入，本模块不碰 `os`/`network-address`）。
   * 缺省回落到回环地址并如实展示——**不假装**它是局域网 IP。
   */
  resolvePairingHost?(): string
}

/**
 * 带超时的放行包装：超时 resolves 为 undefined（退出链不能被上游卡死），
 * 正常结果透传，原始拒绝保持原样上抛。
 */
export async function runWithTimeout<T>(
  label: string,
  work: () => Promise<T>,
  timeoutMs: number,
  onTimeout?: (label: string) => void
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          onTimeout?.(label)
          resolve(undefined)
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

interface ManagerState {
  state: NikkiSyncRuntimeState
  session?: NikkiSyncRuntimeSession
  /** 当前会话绑定的游戏根；undefined = 交给上游 game-directory-discovery。 */
  activeRoot?: string
  databaseFile: string
  error?: string
  hint?: string
  /** 启动在途共享，避免并发 start 建出两个会话（两个 SQLite 句柄指向同一文件）。 */
  starting?: Promise<NikkiSyncRuntimeStatus>
  /**
   * 本会话**构造期**固化的 LAN 服务配置（上游把端口/mdns 冻结在构造期）。
   * 与 `startSyncServer(input)`  Desired 不一致时，必须整会话重建才能生效。
   */
  syncConfig: NikkiSyncSyncServerConfig
  /** 上游 `start()` 回显的实际监听地址；undefined 表示未监听。 */
  syncAddress?: NikkiSyncSyncServerAddress
  /** 最近一次启停失败原因（端口占用归一化为 `PORT_IN_USE`）。 */
  syncError?: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function notReadyMessage(state: ManagerState): string {
  const reason = state.error ?? `runtime state is ${state.state}`
  // 链接就绪时不附提示，避免把「尚未启动」误报成「依赖缺失」
  return `NikkiSync runtime is not ready (${reason})${state.hint ? `; ${state.hint}` : ''}`
}

/**
 * 上游 `ScannerService.getStatus()`（`ScannerMetrics`：`{ status, installation?, lastScan? }`）
 * 的安全展平：`ScannerServiceLike.getStatus()` 按阶段 9 自包含决策声明为 `unknown`，
 * 这里只做结构窄化——非对象整体降级为缺省；`installation` / `lastScan` 以键存在性
 * 写入，与上游「仅在有时出现」的条件键语义一致。`status()` 是 IPC / CLI 的常驻读取
 * 路径，不得因上游形状意外而抛错，故不加 try/catch（纯 getter，无 IO）。
 */
function readScannerSnapshot(raw: unknown): {
  scannerStatus?: string
  installation?: unknown
  lastScan?: unknown
} {
  if (typeof raw !== 'object' || raw === null) return {}
  const metrics = raw as { status?: unknown; installation?: unknown; lastScan?: unknown }
  return {
    ...(typeof metrics.status === 'string' ? { scannerStatus: metrics.status } : {}),
    ...('installation' in metrics ? { installation: metrics.installation } : {}),
    ...('lastScan' in metrics ? { lastScan: metrics.lastScan } : {})
  }
}

/** 由依赖构造状态机句柄（`ctx.nikkisyncRuntime` 的实际实现）。 */
export function createRuntimeManager(deps: RuntimeManagerDependencies): NikkiSyncRuntimeHandle {
  const state: ManagerState = {
    state: deps.isLinkReady(deps.defaults.projectRoot) ? 'idle' : 'unavailable',
    databaseFile: deps.defaults.databaseFile,
    hint: deps.isLinkReady(deps.defaults.projectRoot) ? undefined : linkMissingHint,
    syncConfig: resolveSyncServerConfig(deps.defaults.syncServer)
  }

  function status(): NikkiSyncRuntimeStatus {
    const linkReady = deps.isLinkReady(deps.defaults.projectRoot)
    const snapshot: NikkiSyncRuntimeStatus = {
      state: linkReady ? state.state : 'unavailable',
      dbPath: state.databaseFile,
      linkReady
    }
    if (state.session) {
      // 上游 ScannerMetrics 展平为 scannerStatus/installation/lastScan（键存在性透传）
      const scanner = readScannerSnapshot(state.session.scanner.getStatus())
      if ('scannerStatus' in scanner) snapshot.scannerStatus = scanner.scannerStatus
      if ('installation' in scanner) snapshot.installation = scanner.installation
      if ('lastScan' in scanner) snapshot.lastScan = scanner.lastScan
      snapshot.tables = state.session.tableNames()
      // 同步服务状态随会话一起给出（UI 只轮询一个通道即可拿到扫描 + 服务两面）
      snapshot.sync = syncStatus()
    }
    if (state.error) snapshot.error = state.error
    if (state.hint) snapshot.hint = state.hint
    return snapshot
  }

  async function teardown(label: string): Promise<void> {
    const session = state.session
    if (!session) return
    try {
      // 先停 LAN 服务：端口必须在关库之前释放，且 `server.stop()` 会关 WS 与 mDNS
      await deps.withTimeout(`${label}.server.stop`, () => session.server.stop())
    } catch (error) {
      deps.log('warn', `nikkisync server.stop failed: ${messageOf(error)}`)
    }
    state.syncAddress = undefined
    try {
      await deps.withTimeout(`${label}.scanner.stop`, () => session.scanner.stop())
    } catch (error) {
      // 停不动也要继续关库：退出链不能被上游 watcher 卡死
      deps.log('warn', `nikkisync scanner.stop failed: ${messageOf(error)}`)
    }
    try {
      session.dispose()
    } catch (error) {
      deps.log('warn', `nikkisync database close failed: ${messageOf(error)}`)
    }
    state.session = undefined
    state.activeRoot = undefined
    // 阶段 4：会话拆除（stop 或换根重建）即收回 media:// 的资产路径授权。
    // 库已关闭还允许显示旧路径，等于给不存在的文件开一张长期有效的通行证。
    clearNikkiSyncResourcePaths()
    // 会话已释放：状态回到 idle，否则随后的 start() 会被「已启动」短路吞掉
    if (state.state !== 'unavailable') state.state = 'idle'
  }

  async function start(options: NikkiSyncSessionOptions): Promise<NikkiSyncRuntimeStatus> {
    if (!deps.isLinkReady(options.projectRoot)) {
      state.state = 'unavailable'
      state.hint = linkMissingHint
      deps.log('warn', `nikkisync runtime unavailable: ${linkMissingHint}`)
      return status()
    }
    // running / degraded / scanning 视为已启动：degraded 的重试走 scan()（它会带新根重建）
    if (state.state === 'running' || state.state === 'degraded' || state.state === 'scanning') {
      return status()
    }
    if (state.starting) return state.starting

    state.hint = undefined
    state.error = undefined
    state.state = 'starting'
    state.databaseFile = options.databaseFile
    const inFlight = (async (): Promise<NikkiSyncRuntimeStatus> => {
      deps.ensureDatabaseDirectory(options.databaseFile)
      let session: NikkiSyncRuntimeSession
      try {
        session = await deps.createSession(options)
      } catch (error) {
        state.state = 'error'
        state.error = messageOf(error)
        deps.log('error', `nikkisync runtime assembly failed: ${state.error}`)
        return status()
      }
      state.session = session
      state.activeRoot = options.gameRoot
      // 会话构造期已把 LAN 配置固化进上游 LocalSyncServer：如实记录本会话实际用的那份
      state.syncConfig = resolveSyncServerConfig(options.syncServer)
      state.syncAddress = undefined
      state.syncError = undefined
      try {
        await session.scanner.start()
        state.state = 'running'
        deps.log('info', `nikkisync runtime started (gameRoot=${options.gameRoot ?? 'auto'})`)
      } catch (error) {
        state.error = messageOf(error)
        if (state.error.includes(installNotfoundMessage)) {
          // 无游戏目录 / 未配目录：库可用、扫描未起，绝不上抛（验收：应用不崩）
          state.state = 'degraded'
          deps.log('warn', `nikkisync scanner not started: ${state.error}`)
        } else {
          state.state = 'error'
          deps.log('error', `nikkisync scanner.start failed: ${state.error}`)
        }
      }
      return status()
    })()
    // 并发 start 共享同一次启动（两个会话 = 两个 SQLite 句柄指同一文件，绝不允许）
    state.starting = inFlight

    try {
      return await inFlight
    } finally {
      state.starting = undefined
    }
  }

  async function scan(input: { gameRoot?: string; path?: string }): Promise<unknown> {
    const desiredRoot = input.gameRoot
    const rootOptions: NikkiSyncSessionOptions =
      desiredRoot === undefined ? { ...deps.defaults } : { ...deps.defaults, gameRoot: desiredRoot }
    if (!state.session) {
      await start(rootOptions)
    } else if ((desiredRoot ?? '') !== (state.activeRoot ?? '')) {
      // ScannerService 会缓存 installation，换根只能整会话重建（库文件路径不变，代价只是重开）
      await teardown('nikkisync.restart')
      await start(rootOptions)
    }
    const session = state.session
    if (!session) throw new Error(notReadyMessage(state))
    state.state = 'scanning'
    try {
      return await (input.path
        ? session.scanner.rescanPath(input.path)
        : session.scanner.fullScan())
    } catch (error) {
      state.error = messageOf(error)
      state.state = state.error.includes(installNotfoundMessage) ? 'degraded' : 'error'
      deps.log('warn', `nikkisync scan failed: ${state.error}`)
      throw error
    } finally {
      if (state.state === 'scanning') state.state = 'running'
    }
  }

  async function stop(): Promise<void> {
    if (!state.session) {
      if (state.state !== 'unavailable') state.state = 'idle'
      return
    }
    state.state = 'stopping'
    await teardown('nikkisync.stop')
    state.state = 'idle'
    state.error = undefined
    deps.log('info', 'nikkisync runtime stopped')
  }

  function requireSession(): NikkiSyncRuntimeSession {
    if (!state.session) throw new Error(notReadyMessage(state))
    return state.session
  }

  /** 配对二维码与状态展示共用同一个局域网地址来源（装配层注入，缺省如实回落回环）。 */
  function pairingHost(): string {
    return (deps.resolvePairingHost ?? (() => LOOPBACK_FALLBACK_HOST))()
  }

  /**
   * 同步服务状态：只读内存状态 + 上游会话上的 TLS 身份与设备计数。
   * 未运行也把配置值如实给出（端口冲突时 UI 仍要能显示「配置端口 + PORT_IN_USE」）。
   */
  function syncStatus(): NikkiSyncSyncServerStatus {
    const session = state.session
    return buildSyncStatusSnapshot({
      running: Boolean(state.syncAddress),
      configured: state.syncConfig,
      ...(state.syncAddress ? { address: state.syncAddress } : {}),
      ...(session ? { serverId: session.server.serverId, tls: session.tlsIdentity() } : {}),
      ...(session ? { pairedDeviceCount: session.listPairedDevices().length } : {}),
      lanHost: pairingHost(),
      ...(state.syncError ? { error: state.syncError } : {})
    })
  }

  /**
   * 启动上游 LocalSyncServer（HTTPS + WS + mDNS 全在它内部）。
   * 与 `start()` 同口径**永不上抛**；端口占用按上游原样失败并归类 `PORT_IN_USE`
   * （上游 `start()` 无重试、无回退，本层不代其发明兜底策略）。
   */
  async function startSyncServer(input?: {
    port?: number
    mdnsEnabled?: boolean
  }): Promise<NikkiSyncSyncServerStatus> {
    const desired = resolveSyncServerConfig({
      ...state.syncConfig,
      ...(input?.port === undefined ? {} : { port: input.port }),
      ...(input?.mdnsEnabled === undefined ? {} : { mdns: input.mdnsEnabled })
    })
    const portChanged =
      desired.port !== state.syncConfig.port ||
      desired.mdns !== state.syncConfig.mdns ||
      desired.host !== state.syncConfig.host
    if (!state.session || portChanged) {
      // 端口/mdns 冻结在构造期 ⇒ 只能整会话重建（与 scan() 换根同一条路径）
      if (state.session) await teardown('nikkisync.resync')
      await start({ ...deps.defaults, syncServer: desired })
    }
    const session = state.session
    if (!session) {
      state.syncError = notReadyMessage(state)
      deps.log('warn', `nikkisync sync server not started: ${state.syncError}`)
      return syncStatus()
    }
    try {
      // 上游 start() 幂等：已在监听时直接回显原地址，不会二次 listen
      state.syncAddress = await session.server.start()
      state.syncError = undefined
      deps.log(
        'info',
        `nikkisync sync server listening on ${state.syncAddress.host}:${state.syncAddress.port} ` +
          `secure=${state.syncAddress.secure} mdns=${state.syncConfig.mdns}`
      )
    } catch (error) {
      state.syncAddress = undefined
      state.syncError = classifySyncStartError(error)
      deps.log('warn', `nikkisync sync server start failed: ${state.syncError}`)
    }
    return syncStatus()
  }

  /** 停止同步服务（幂等；会话已释放时只清状态）。 */
  async function stopSyncServer(): Promise<NikkiSyncSyncServerStatus> {
    const session = state.session
    if (session) {
      try {
        await deps.withTimeout('nikkisync.server.stop', () => session.server.stop())
      } catch (error) {
        deps.log('warn', `nikkisync server.stop failed: ${messageOf(error)}`)
      }
    }
    state.syncAddress = undefined
    state.syncError = undefined
    deps.log('info', 'nikkisync sync server stopped')
    return syncStatus()
  }

  /**
   * 一次性配对二维码。串本身由上游 `runtime.createPairingUri` 产出
   * （内含 `createPairingPayload` → 写 `pairing_sessions` 只存哈希的 token，TTL 5 分钟、单次消费），
   * 本层只解析出 UI 需要的字段；服务未启动时**上游原生抛错**，不在此处吞掉。
   */
  async function pairingCode(): Promise<NikkiSyncPairingCode> {
    const session = requireSession()
    const host = pairingHost()
    const content = session.pairingUri(host)
    const parsed = parsePairingUri(content)
    if (!parsed) {
      throw new Error(`NikkiSync returned an unparseable pairing payload: ${content.slice(0, 16)}…`)
    }
    return parsed
  }

  async function listPairedDevices(): Promise<NikkiSyncPairedDeviceView[]> {
    return requireSession().listPairedDevices()
  }

  /** 撤销走上游 `PairingRepository.revoke`；不存在/已撤销上抛，由 handler 映射 `notFound`。 */
  async function revokeDevice(deviceId: string): Promise<NikkiSyncPairedDeviceView[]> {
    const session = requireSession()
    if (!session.revokePairedDevice(deviceId)) {
      throw new Error(`NikkiSync device not found or already revoked: ${deviceId}`)
    }
    return session.listPairedDevices()
  }

  return {
    status,
    start,
    scan,
    stop,
    listAssets: async (input) => requireSession().queries.listAssets(input),
    getAssetDetail: async (assetId) => requireSession().queries.getAssetDetail(assetId),
    getResource: async (assetId, resourceId, mode = 'meta') =>
      requireSession().queries.getResource(assetId, resourceId, mode),
    // 阶段 4：全部是同一步 `requireSession().queries.*` 的薄委托，不加工返回值
    listResourceRecords: async (assetIds, mode = 'meta') =>
      requireSession().queries.listResourceRecords(assetIds, mode),
    listChanges: async (after, limit = 1000) => requireSession().queries.listChanges(after, limit),
    searchSuits: async (query) => requireSession().queries.searchSuits(query),
    searchClothing: async (query) => requireSession().queries.searchClothing(query),
    profileStats: async () => requireSession().queries.profileStats(),
    syncStatus,
    startSyncServer,
    stopSyncServer,
    pairingCode,
    listPairedDevices,
    revokeDevice
  }
}
