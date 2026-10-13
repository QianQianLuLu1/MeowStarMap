/**
 * 内嵌 NikkiSync Runtime 的生命周期编排（整合阶段 2）。
 *
 * 职责边界（务必守住）：
 * - 本文件**只做编排**：状态机、幂等、降级、换根重建、优雅停止、未就绪拒绝。
 *   装载与查询在 `runtime-facade.ts`，Electron 装配在 `app/nikkisync-runtime-setup.ts`。
 * - 扫描/数据库/DTO 一律交给上游：这里只调 `scanner.start()/fullScan()/rescanPath()/stop()`
 *   与 `queries.*`，不解析、不改写、不重命名任何字段。
 * - 分段启动（见 docs/sync-integration/00-nikkisync-pc-audit-report.md §8.2 与风险 R2）：
 *   上游 `runtime.start()` 把 `scanner.start()` 当硬前置且随后启 LAN 服务；本阶段只需要
 *   数据库 + 发现 + 扫描，因此显式只启 scanner，绝不 `server.start()`（不绑端口、不组播）。
 * - 启动失败不外抛（验收：Runtime 启动失败时应用不崩溃），原因与修复指令进状态快照。
 */

import type {
  NikkiSyncRuntimeHandle,
  NikkiSyncRuntimeSession,
  NikkiSyncRuntimeState,
  NikkiSyncRuntimeStatus,
  NikkiSyncSessionOptions
} from './runtime-types'

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
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function notReadyMessage(state: ManagerState): string {
  const reason = state.error ?? `runtime state is ${state.state}`
  // 链接就绪时不附提示，避免把「尚未启动」误报成「依赖缺失」
  return `NikkiSync runtime is not ready (${reason})${state.hint ? `; ${state.hint}` : ''}`
}

/** 由依赖构造状态机句柄（`ctx.nikkisyncRuntime` 的实际实现）。 */
export function createRuntimeManager(deps: RuntimeManagerDependencies): NikkiSyncRuntimeHandle {
  const state: ManagerState = {
    state: deps.isLinkReady(deps.defaults.projectRoot) ? 'idle' : 'unavailable',
    databaseFile: deps.defaults.databaseFile,
    hint: deps.isLinkReady(deps.defaults.projectRoot) ? undefined : linkMissingHint
  }

  function status(): NikkiSyncRuntimeStatus {
    const linkReady = deps.isLinkReady(deps.defaults.projectRoot)
    const snapshot: NikkiSyncRuntimeStatus = {
      state: linkReady ? state.state : 'unavailable',
      dbPath: state.databaseFile,
      linkReady
    }
    if (state.session) {
      snapshot.scanner = state.session.scanner.getStatus()
      snapshot.tables = state.session.tableNames()
    }
    if (state.error) snapshot.error = state.error
    if (state.hint) snapshot.hint = state.hint
    return snapshot
  }

  async function teardown(label: string): Promise<void> {
    const session = state.session
    if (!session) return
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

  return {
    status,
    start,
    scan,
    stop,
    listAssets: async (input) => requireSession().queries.listAssets(input),
    getAssetDetail: async (assetId) => requireSession().queries.getAssetDetail(assetId),
    getResource: async (assetId, resourceId, mode = 'meta') =>
      requireSession().queries.getResource(assetId, resourceId, mode)
  }
}
