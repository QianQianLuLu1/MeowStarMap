/**
 * @layer L3
 * @module src/main/app/nikkisync-runtime-setup
 * @coverage 内嵌 NikkiSync Runtime 的装配纯函数（阶段2：库位置 / 自启判定 / 会话参数）
 *
 * `initNikkiSyncRuntime` 的真实装载链由 `src/main/nikkisync/runtime-facade.linked.test.ts`
 * 在链接态覆盖；此处只锁「默认关闭 + userData 落点 + 开关优先级」这三条任务硬性口径。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/userdata'),
    getAppPath: vi.fn(() => '/mock/project'),
    isPackaged: false
  }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  electronLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../../utils/startup-diagnostic', () => ({
  diagLog: vi.fn()
}))

import {
  GAME_ROOT_ENV_FLAG,
  METADATA_ENV_FLAG,
  METADATA_RESOLVER_ENABLED_DEFAULT,
  MULTI_HOST_PAIRING_DEFAULT,
  NIKKISYNC_DB_SEGMENTS,
  RECYCLE_HELPER_ENV,
  RUNTIME_ENABLED_DEFAULT,
  RUNTIME_ENV_FLAG,
  SETTING_GAME_ROOT,
  SETTING_METADATA_RESOLVER,
  SETTING_RUNTIME_ENABLED,
  SETTING_SYNC_AUTOSTART,
  SETTING_SYNC_ENABLED,
  SETTING_SYNC_MDNS,
  SETTING_SYNC_PORT,
  SETTING_WATCHER,
  SYNC_AUTOSTART_DEFAULT,
  SYNC_ENABLED_DEFAULT,
  WATCHER_ENABLED_DEFAULT,
  buildSessionOptions,
  initNikkiSyncRuntime,
  nikkisyncDatabaseFile,
  resolveMetadataResolverEnabled,
  resolveRecycleHelperPath,
  resolveRuntimeEnabled,
  resolveSyncEnabled,
  stopNikkiSyncRuntime,
  type NikkiSyncSettingsPort
} from '../nikkisync-runtime-setup'
import {
  SYNC_SERVER_DEFAULT_HOST,
  SYNC_SERVER_DEFAULT_MDNS,
  SYNC_SERVER_DEFAULT_NAME,
  SYNC_SERVER_DEFAULT_PORT
} from '../../nikkisync/sync-server-view'
import { makeAppCtx } from '../../ipc/handlers/_test-helpers'

// 依赖以替身注入：本文件验证「装配 → 状态机」的接线（谁被调用、传什么参数），
// 真装载链由 src/main/nikkisync/runtime-facade.linked.test.ts 在链接态覆盖。
const { managerDouble, depsDouble, pcServicesDouble } = vi.hoisted(() => {
  const LIVE_DATABASE = { connection: { prepare: () => ({ all: () => [] }) } }
  return {
    pcServicesDouble: {
      LIVE_DATABASE,
      startPcCompanionServices: vi.fn(async () => undefined)
    },
    managerDouble: buildManagerDouble(LIVE_DATABASE),
    depsDouble: {
      defaults: {},
      createSession: vi.fn(),
      isLinkReady: vi.fn(() => true),
      ensureDatabaseDirectory: vi.fn(),
      log: vi.fn(),
      withTimeout: vi.fn()
    }
  }
})

/** manager 替身需自引用 capturedDeps，故在 hoisted 内用函数两步构建。 */
function buildManagerDouble(liveDatabase: unknown) {
  const managerDouble = {
    // F2：createRuntimeManager 的 mock 会把传入 deps 记到这里，供 start 模拟
    // 真实 manager 的回调契约（start 成功尾部触发 onSessionStarted）。
    capturedDeps: undefined as unknown,
    status: vi.fn(() => ({ state: 'running', dbPath: '', linkReady: true })),
    start: vi.fn(async () => ({
      state: 'running',
      dbPath: '/mock/userdata/nikkisync/nikkisync.db',
      linkReady: true,
      tables: ['assets']
    })),
    scan: vi.fn(async () => ({ scanId: 'scan_1' })),
    stop: vi.fn(async () => undefined),
    listAssets: vi.fn(async () => ({ items: [] })),
    getAssetDetail: vi.fn(async () => ({ asset: {} })),
    getResource: vi.fn(async () => ({})),
    // 阶段 3：同步服务编排面
    syncStatus: vi.fn(() => ({
      running: false,
      host: '0.0.0.0',
      port: 28080,
      mdnsEnabled: true
    })),
    startSyncServer: vi.fn(async () => ({
      running: true,
      host: '0.0.0.0',
      port: 28080,
      secure: true,
      mdnsEnabled: true
    })),
    stopSyncServer: vi.fn(async () => ({
      running: false,
      host: '0.0.0.0',
      port: 28080,
      mdnsEnabled: true
    })),
    pairingCode: vi.fn(async () => ({ content: 'NS1|x' })),
    listPairedDevices: vi.fn(async () => []),
    revokeDevice: vi.fn(async () => []),
    // C1：PC 端会话上下文（真实 database / 扫描根 / 配对串）
    pcCompanionContext: vi.fn(() => ({
      database: liveDatabase,
      scanRoots: ['/game/photos'],
      pairingUri: () => 'NS1|live-session'
    }))
  }
  return managerDouble
}

/**
 * F2：让 managerDouble.start 遵守真实 runtime-manager 契约——会话建成成功尾部
 * 触发 deps.onSessionStarted（装配层在此重装配 PC 端服务）。
 * 以独立帮助函数提供：'阶段2' describe 的 beforeEach 用 mockResolvedValue 覆写
 * start 实现，依赖回调契约的 describe 必须在其 beforeEach 里重新安装本实现。
 */
function installManagerStartContract(): void {
  managerDouble.start.mockImplementation(async () => {
    const deps = managerDouble.capturedDeps as { onSessionStarted?: () => unknown } | undefined
    if (deps && typeof deps.onSessionStarted === 'function') await deps.onSessionStarted()
    return {
      state: 'running',
      dbPath: '/mock/userdata/nikkisync/nikkisync.db',
      linkReady: true,
      tables: ['assets']
    }
  })
}

vi.mock('../../nikkisync/runtime-facade', () => ({
  createManagerDependencies: vi.fn(() => depsDouble)
}))

vi.mock('../../nikkisync/runtime-manager', () => ({
  // F2：捕获传入 deps，让 managerDouble.start 能按真实契约触发 onSessionStarted
  createRuntimeManager: vi.fn((deps: unknown) => {
    managerDouble.capturedDeps = deps
    return managerDouble
  })
}))

// C1：PC 端服务装配用替身观察调用时序与入参（本文件不测上游真实装载）
vi.mock('../../nikkisync/pc-companion-services', () => ({
  startPcCompanionServices: pcServicesDouble.startPcCompanionServices
}))

// 局域网地址解析器复用移植面那一份实现（同文件导出）；本文件不测它，避免真碰网卡
vi.mock('../sync-server-setup', () => ({
  resolveLanHost: vi.fn(() => '192.168.7.7')
}))

function settings(values: Record<string, unknown>): NikkiSyncSettingsPort {
  return {
    getBoolean: (key, fallback) =>
      typeof values[key] === 'boolean' ? (values[key] as boolean) : fallback,
    getString: (key, fallback) =>
      typeof values[key] === 'string' ? (values[key] as string) : fallback,
    getNumber: (key, fallback) =>
      typeof values[key] === 'number' && Number.isFinite(values[key] as number)
        ? (values[key] as number)
        : fallback
  }
}

describe('nikkisync 库落点（阶段2：必须与宿主 userData 同源）', () => {
  it('databaseFile = {userData}/nikkisync/nikkisync.db', () => {
    // 用 path.join 口径断言（Windows 分隔符与 POSIX 不同，不靠字面串拼）
    expect(nikkisyncDatabaseFile('/app/userData')).toBe(
      path.join('/app/userData', 'nikkisync', 'nikkisync.db')
    )
    expect(NIKKISYNC_DB_SEGMENTS).toEqual(['nikkisync', 'nikkisync.db'])
  })
})

describe('resolveRecycleHelperPath（K8-a：回收 helper 路径）', () => {
  it('env 常量与上游 DeletionQueue 读取名逐字一致', () => {
    expect(RECYCLE_HELPER_ENV).toBe('NIKKISYNC_RECYCLE_HELPER')
  })

  it('打包态 = {resourcesPath}/nikkisync/（extraResources 落点）', () => {
    expect(
      resolveRecycleHelperPath({ isPackaged: true, resourcesPath: '/res', projectRoot: '/app' })
    ).toBe(path.join('/res', 'nikkisync', 'nikkisync-recycle-helper.exe'))
  })

  it('dev = 仓内 resources/nikkisync/ 产物（build:recycle-helper 输出位）', () => {
    expect(
      resolveRecycleHelperPath({ isPackaged: false, resourcesPath: '/res', projectRoot: '/app' })
    ).toBe(path.join('/app', 'resources', 'nikkisync', 'nikkisync-recycle-helper.exe'))
  })
})

describe('resolveRuntimeEnabled 开关优先级', () => {
  it('默认开启（缺省值与常量一致，对齐上游 PC 端）', () => {
    expect(RUNTIME_ENABLED_DEFAULT).toBe(true)
    expect(resolveRuntimeEnabled({}, settings({}))).toBe(true)
  })

  it('NIKKI_NIKKISYNC_RUNTIME=1 强开，=0 强关，均优先于设置项', () => {
    expect(resolveRuntimeEnabled({ [RUNTIME_ENV_FLAG]: '1' }, settings({}))).toBe(true)
    expect(
      resolveRuntimeEnabled(
        { [RUNTIME_ENV_FLAG]: '0' },
        settings({ [SETTING_RUNTIME_ENABLED]: true })
      )
    ).toBe(false)
  })

  it('无 env 时读设置项', () => {
    expect(
      resolveRuntimeEnabled(
        { [RUNTIME_ENV_FLAG]: '  ' },
        settings({ [SETTING_RUNTIME_ENABLED]: true })
      )
    ).toBe(true)
  })
})

describe('resolveSyncEnabled 启动期自启开关', () => {
  it('默认关闭（干净安装不自启 LAN 服务）；RUNTIME=0 逃生阀可整体关闭', () => {
    expect(SYNC_AUTOSTART_DEFAULT).toBe(false)
    expect(resolveSyncEnabled(settings({}))).toBe(false)
    expect(
      resolveSyncEnabled(settings({ [SETTING_SYNC_AUTOSTART]: true }), {
        [RUNTIME_ENV_FLAG]: '0'
      })
    ).toBe(false)
  })

  it('自动启用设置为 true 时开启，且不受运行期主开关持久值影响', () => {
    expect(resolveSyncEnabled(settings({ [SETTING_SYNC_AUTOSTART]: true }))).toBe(true)
    expect(
      resolveSyncEnabled(
        settings({ [SETTING_SYNC_AUTOSTART]: true, [SETTING_SYNC_ENABLED]: false })
      )
    ).toBe(true)
  })
})

describe('initNikkiSyncRuntime 接线（阶段2）', () => {
  // 本仓 vitest 配置为 clearMocks: false（见 vitest.config.ts 注释），替身调用次数会
  // 在用例间累积，故这里显式归零，避开“上一个用例调过 start”带来的假失败/假通过
  beforeEach(() => {
    // 环境无关性：dev 验证会话可能把两个 flag 留在 shell 环境里，直接继承会
    // 让“缺省不自启”用例变成自启——这里一律先清掉，由各用例自己设定
    delete process.env[RUNTIME_ENV_FLAG]
    delete process.env[GAME_ROOT_ENV_FLAG]
    managerDouble.start.mockClear()
    managerDouble.stop.mockClear()
    managerDouble.startSyncServer.mockClear()
    pcServicesDouble.startPcCompanionServices.mockClear()
    managerDouble.startSyncServer.mockResolvedValue({
      running: true,
      host: '0.0.0.0',
      port: 28080,
      secure: true,
      mdnsEnabled: true
    })
    managerDouble.start.mockResolvedValue({
      state: 'running',
      dbPath: '/mock/userdata/nikkisync/nikkisync.db',
      linkReady: true,
      tables: ['assets']
    })
  })

  it('缺省不自启：注入句柄并启动 Runtime，但 LAN 同步服务保持停止', async () => {
    const ctx = makeAppCtx()
    const manager = await initNikkiSyncRuntime(ctx)
    expect(manager).toBe(managerDouble)
    expect(ctx.nikkisyncRuntime).toBe(managerDouble)
    expect(managerDouble.start).toHaveBeenCalledTimes(1)
    expect(managerDouble.startSyncServer).toHaveBeenCalledTimes(0)
  })

  it('env 强开：以 userData 库路径自启，并下传打包态上下文', async () => {
    const original = process.env[RUNTIME_ENV_FLAG]
    const originalRoot = process.env[GAME_ROOT_ENV_FLAG]
    process.env[RUNTIME_ENV_FLAG] = '1'
    process.env[GAME_ROOT_ENV_FLAG] = 'H:\\game'
    try {
      const ctx = makeAppCtx()
      await initNikkiSyncRuntime(ctx)
      expect(managerDouble.start).toHaveBeenCalledTimes(1)
      const options = managerDouble.start.mock.calls[0]![0] as Record<string, unknown>
      expect(options.databaseFile).toBe(nikkisyncDatabaseFile('/mock/userdata'))
      expect(options.gameRoot).toBe('H:\\game')
      expect(options.watcher).toBe(WATCHER_ENABLED_DEFAULT)
      expect((options.packagingContext as { isPackaged: boolean }).isPackaged).toBe(false)
    } finally {
      if (original === undefined) delete process.env[RUNTIME_ENV_FLAG]
      else process.env[RUNTIME_ENV_FLAG] = original
      if (originalRoot === undefined) delete process.env[GAME_ROOT_ENV_FLAG]
      else process.env[GAME_ROOT_ENV_FLAG] = originalRoot
    }
  })

  it('env 强关（=0）时不自启（优先级已由 resolveRuntimeEnabled 用例固定）', async () => {
    const original = process.env[RUNTIME_ENV_FLAG]
    process.env[RUNTIME_ENV_FLAG] = '0'
    try {
      const ctx = makeAppCtx()
      await initNikkiSyncRuntime(ctx)
      expect(ctx.nikkisyncRuntime).toBe(managerDouble)
      expect(managerDouble.start).not.toHaveBeenCalled()
    } finally {
      if (original === undefined) delete process.env[RUNTIME_ENV_FLAG]
      else process.env[RUNTIME_ENV_FLAG] = original
    }
  })

  it('start 抛错时装配层不静默吞掉（由 lifecycle 的 try/catch 统一落日志），句柄仍已注入', async () => {
    const original = process.env[RUNTIME_ENV_FLAG]
    process.env[RUNTIME_ENV_FLAG] = '1'
    managerDouble.start.mockRejectedValueOnce(new Error('assembly blew up'))
    try {
      const ctx = makeAppCtx()
      await expect(initNikkiSyncRuntime(ctx)).rejects.toThrow('assembly blew up')
      expect(ctx.nikkisyncRuntime).toBe(managerDouble)
    } finally {
      if (original === undefined) delete process.env[RUNTIME_ENV_FLAG]
      else process.env[RUNTIME_ENV_FLAG] = original
    }
  })

  it('开启自动启用（Runtime 开关未开）：仍起 Runtime 并随后 startSyncServer', async () => {
    const ctx = makeAppCtx()
    // 直接改写 ctx.dbManager.getSetting 的返回：设置项走真实 settingsFrom 收敛路径
    const getSetting = vi.fn((key: string, fallback: unknown) =>
      key === SETTING_SYNC_AUTOSTART ? true : fallback
    )
    ;(ctx as { dbManager: { getSetting: unknown } }).dbManager = { getSetting } as never
    await initNikkiSyncRuntime(ctx)
    expect(managerDouble.start).toHaveBeenCalledTimes(1)
    expect(managerDouble.startSyncServer).toHaveBeenCalledTimes(1)
    // 未开 Runtime 开关但开了服务 ⇒ start 传下的选项必须含 LAN 配置
    const options = managerDouble.start.mock.calls[0]![0] as { syncServer?: unknown }
    expect(options.syncServer).toBeDefined()
  })

  it('服务自启失败不外抛（状态里带 error 即可，UI 经 server-status 可见）', async () => {
    const ctx = makeAppCtx()
    const getSetting = vi.fn((key: string, fallback: unknown) =>
      key === SETTING_SYNC_AUTOSTART ? true : fallback
    )
    ;(ctx as { dbManager: { getSetting: unknown } }).dbManager = { getSetting } as never
    managerDouble.startSyncServer.mockResolvedValueOnce({
      running: false,
      host: '0.0.0.0',
      port: 28080,
      mdnsEnabled: true,
      error: 'PORT_IN_USE'
    })
    await expect(initNikkiSyncRuntime(ctx)).resolves.toBe(managerDouble)
    expect(managerDouble.startSyncServer).toHaveBeenCalledTimes(1)
  })

  it('把局域网地址解析器注入依赖表（配对二维码要写真实 LAN IP，第三参）', async () => {
    const { createManagerDependencies } = await import('../../nikkisync/runtime-facade')
    const { resolveLanHost } = await import('../sync-server-setup')
    const ctx = makeAppCtx()
    await initNikkiSyncRuntime(ctx)
    const call = vi.mocked(createManagerDependencies).mock.calls.at(-1)
    expect(call).toBeDefined()
    expect(call?.[2]).toBe(resolveLanHost)
  })

  // ===== 本次需求：软件启动时是否自动启用同步服务（默认关闭）=====
  it('A0 新增自启键常量与默认值', () => {
    expect(SETTING_SYNC_AUTOSTART).toBe('nikkisync.autoStartSyncServer')
    expect(SYNC_AUTOSTART_DEFAULT).toBe(false)
  })

  it('A1 默认配置不自动启动 LAN 服务，但 Runtime 仍建会话', async () => {
    const ctx = makeAppCtx()
    await initNikkiSyncRuntime(ctx)
    expect(managerDouble.start).toHaveBeenCalledTimes(1)
    expect(managerDouble.startSyncServer).toHaveBeenCalledTimes(0)
  })

  it('A2 回归：主开关持久值为 false 但自动启用为 true 时仍自启 LAN 服务', async () => {
    const ctx = makeAppCtx()
    const getSetting = vi.fn((key: string, fallback: unknown) => {
      if (key === 'nikkisync.syncServerEnabled') return false
      if (key === 'nikkisync.runtimeEnabled') return false
      if (key === 'nikkisync.autoStartSyncServer') return true
      return fallback
    })
    ;(ctx as { dbManager: { getSetting: unknown } }).dbManager = { getSetting } as never
    await initNikkiSyncRuntime(ctx)
    expect(managerDouble.startSyncServer).toHaveBeenCalledTimes(1)
  })

  it('A3 回归：启动期读取 nikkisync.autoStartSyncServer 作为自启决策', async () => {
    const ctx = makeAppCtx()
    const getSetting = vi.fn((key: string, fallback: unknown) => fallback)
    ;(ctx as { dbManager: { getSetting: unknown } }).dbManager = { getSetting } as never
    await initNikkiSyncRuntime(ctx)
    expect(getSetting).toHaveBeenCalledWith('nikkisync.autoStartSyncServer', false)
  })

  it('A4 边界：autoStartSyncServer 脏值一律收敛为 false，不得误开服务', async () => {
    for (const dirty of ['true', null, 1, {}]) {
      const ctx = makeAppCtx()
      const getSetting = vi.fn((key: string, fallback: unknown) =>
        key === 'nikkisync.autoStartSyncServer' ? dirty : fallback
      )
      ;(ctx as { dbManager: { getSetting: unknown } }).dbManager = { getSetting } as never
      managerDouble.startSyncServer.mockClear()
      await initNikkiSyncRuntime(ctx)
      expect(managerDouble.startSyncServer, `脏值 ${String(dirty)}`).toHaveBeenCalledTimes(0)
    }
  })
})

describe('stopNikkiSyncRuntime 接线（阶段2）', () => {
  beforeEach(() => {
    managerDouble.stop.mockClear()
  })

  it('未注入句柄时 no-op（退出链不得因此抛错）', async () => {
    const ctx = makeAppCtx()
    ctx.nikkisyncRuntime = undefined
    await expect(stopNikkiSyncRuntime(ctx)).resolves.toBeUndefined()
    expect(managerDouble.stop).not.toHaveBeenCalled()
  })

  it('已注入则优雅停止；stop 抛错只记日志不外抛', async () => {
    const ctx = makeAppCtx()
    ctx.nikkisyncRuntime = managerDouble as never
    await stopNikkiSyncRuntime(ctx)
    expect(managerDouble.stop).toHaveBeenCalledTimes(1)

    managerDouble.stop.mockRejectedValueOnce(new Error('watcher stuck'))
    await expect(stopNikkiSyncRuntime(ctx)).resolves.toBeUndefined()
  })
})

describe('buildSessionOptions', () => {
  const base = {
    userDataDir: 'U:',
    projectRoot: 'P:',
    isPackaged: false,
    resourcesPath: '',
    settings: settings({})
  }

  it('正常：开发态给出 userData 库路径 + watcher 取缺省 + 无 gameRoot 时省略该键', () => {
    const options = buildSessionOptions({ ...base, env: {} })
    expect(options.databaseFile).toBe(nikkisyncDatabaseFile('U:'))
    expect(options.watcher).toBe(WATCHER_ENABLED_DEFAULT)
    expect('gameRoot' in options).toBe(false)
    expect(options.projectRoot).toBe('P:')
    expect(options.packagingContext?.isPackaged).toBe(false)
  })

  it('gameRoot：env 优先于设置项，空值不落键', () => {
    expect(
      buildSessionOptions({
        ...base,
        env: { [GAME_ROOT_ENV_FLAG]: 'H:\\game' },
        settings: settings({ [SETTING_GAME_ROOT]: 'D:\\other' })
      }).gameRoot
    ).toBe('H:\\game')
    expect(
      buildSessionOptions({
        ...base,
        env: {},
        settings: settings({ [SETTING_GAME_ROOT]: 'D:\\other' })
      }).gameRoot
    ).toBe('D:\\other')
    expect(
      buildSessionOptions({
        ...base,
        env: { [GAME_ROOT_ENV_FLAG]: '   ' },
        settings: settings({ [SETTING_GAME_ROOT]: '   ' })
      }).gameRoot
    ).toBeUndefined()
  })

  it('打包态必须带 resourcesPath（否则 buildPackagingContext 抛错，不静默回落开发态）', () => {
    expect(() =>
      buildSessionOptions({ ...base, isPackaged: true, resourcesPath: '', env: {} })
    ).toThrow(/resourcesPath/)
    const options = buildSessionOptions({
      ...base,
      isPackaged: true,
      resourcesPath: 'R:',
      env: {},
      settings: settings({ [SETTING_WATCHER]: true })
    })
    expect(options.packagingContext?.isPackaged).toBe(true)
    expect(options.packagingContext?.resourcesPath).toBe('R:')
    expect(options.watcher).toBe(true)
  })

  it('syncServer：缺省取上游桌面版口径（0.0.0.0 / 28080 / mdns 开），构造期即下传', () => {
    const options = buildSessionOptions({ ...base, env: {} })
    expect(options.syncServer).toEqual({
      host: SYNC_SERVER_DEFAULT_HOST,
      port: SYNC_SERVER_DEFAULT_PORT,
      mdns: SYNC_SERVER_DEFAULT_MDNS,
      name: SYNC_SERVER_DEFAULT_NAME
    })
  })

  it('syncServer：设置项覆盖端口与 mdns；非法端口回落默认（不把坏值递给上游）', () => {
    const overridden = buildSessionOptions({
      ...base,
      env: {},
      settings: settings({ [SETTING_SYNC_PORT]: 39139, [SETTING_SYNC_MDNS]: false })
    })
    expect(overridden.syncServer?.port).toBe(39139)
    expect(overridden.syncServer?.mdns).toBe(false)

    const illegal = buildSessionOptions({
      ...base,
      env: {},
      settings: settings({ [SETTING_SYNC_PORT]: 70000 })
    })
    expect(illegal.syncServer?.port).toBe(SYNC_SERVER_DEFAULT_PORT)
  })
})

describe('阶段 6：元数据解析开关（默认开 + env 优先 + 脏值回落）', () => {
  const base = {
    userDataDir: 'U:',
    projectRoot: 'P:',
    isPackaged: false,
    resourcesPath: '',
    settings: settings({})
  }

  it('默认开启：常量与无设置、无 env 时的判定一致（上游 PC 端口径）', () => {
    expect(METADATA_RESOLVER_ENABLED_DEFAULT).toBe(true)
    expect(SETTING_METADATA_RESOLVER).toBe('nikkisync.metadataResolverEnabled')
    expect(METADATA_ENV_FLAG).toBe('NIKKI_NIKKISYNC_METADATA')
    expect(resolveMetadataResolverEnabled({}, settings({}))).toBe(true)
  })

  it('env 逃生阀优先于设置项（dev / 验证强启与强关两个方向都要压过）', () => {
    expect(resolveMetadataResolverEnabled({ [METADATA_ENV_FLAG]: '1' }, settings({}))).toBe(true)
    expect(
      resolveMetadataResolverEnabled(
        { [METADATA_ENV_FLAG]: '0' },
        settings({ [SETTING_METADATA_RESOLVER]: true })
      )
    ).toBe(false)
  })

  it('正常：设置项为布尔 true 时开启', () => {
    expect(
      resolveMetadataResolverEnabled({}, settings({ [SETTING_METADATA_RESOLVER]: true }))
    ).toBe(true)
  })

  it('边界：脏值一律回落到缺省开启，不被脏数据改成字符串或任意对象', () => {
    for (const dirty of ['true', 1, 'yes', {}, []]) {
      expect(
        resolveMetadataResolverEnabled({}, settings({ [SETTING_METADATA_RESOLVER]: dirty }))
      ).toBe(true)
    }
    // 非 1/0 的 env 视为未设置，交回设置项判断
    expect(
      resolveMetadataResolverEnabled(
        { [METADATA_ENV_FLAG]: 'on' },
        settings({ [SETTING_METADATA_RESOLVER]: true })
      )
    ).toBe(true)
    expect(
      resolveMetadataResolverEnabled(
        { [METADATA_ENV_FLAG]: 'on' },
        settings({ [SETTING_METADATA_RESOLVER]: false })
      )
    ).toBe(false)
  })

  it('buildSessionOptions 把判定结果下传会话参数（默认 true，显式关闭后为 false）', () => {
    expect(buildSessionOptions({ ...base, env: {} }).metadataResolverEnabled).toBe(true)
    expect(
      buildSessionOptions({
        ...base,
        env: {},
        settings: settings({ [SETTING_METADATA_RESOLVER]: true })
      }).metadataResolverEnabled
    ).toBe(true)
    expect(
      buildSessionOptions({ ...base, env: { [METADATA_ENV_FLAG]: '1' } }).metadataResolverEnabled
    ).toBe(true)
  })
})

// ============================================================================
// 审查发现 F3：`nikkisync.gameRoot` 的**写入端**与**读取端**分处两层，键名各写一份字面量。
// 读端用本模块导出的 `SETTING_GAME_ROOT`；写端（`nikkisync:handler`）为守住「handler 不 import
// app/ 常量」的分层（见该文件 SETTING_GAME_ROOT_KEY 的注释）另写了一份串。
// 两次变异实测（口径以实测为准，原判断在此订正）：
//   M1 改**写端**字面量 ⇒ `nikkisync-handler.test.ts` 4 例红（它们断言的是 `setSetting` 收到的
//      实际键，写端漂移本来就兜得住）；
//   M2 改**读端**常量值 ⇒ 全仓仅本守卫红（实测 1179 例仍绿）——读端测试用 `[SETTING_GAME_ROOT]`
//      符号化供键，改值后自洽通过，这才是真正无人兜的那一侧。
// 所以本用例钉的是「读端值 = 历史串」+「写端串 = 读端常量」两条：改任何一侧、删常量、挪文件都红
//（源码里提不到声明即抛，不 skip）。
// ============================================================================

describe('gameRoot 设置键：写入端与读取端必须同源（F3 漂移守卫）', () => {
  /** 从 handler 源码文本提取写端键名字面量；提不到 = 声明被动过 = 直接红。 */
  function extractHandlerGameRootKey(): string {
    // 只当 IO 用（约定 §6 第 2 档）：按 cwd 拼真实文件路径读源码，保持宿主绑定，
    // 与 favorites-handler.test.ts 取 connection.ts DDL 的写法同口径。
    const source = readFileSync(
      path.resolve(process.cwd(), 'src', 'main', 'ipc', 'handlers', 'nikkisync-handler.ts'),
      'utf-8'
    )
    const match = source.match(/const SETTING_GAME_ROOT_KEY = '([^']*)'/)
    const key = match ? match[1] : undefined
    if (typeof key !== 'string') {
      throw new Error('nikkisync-handler.ts 中找不到 SETTING_GAME_ROOT_KEY 的字面量声明')
    }
    return key
  }

  it('写端字面量 === 读端 SETTING_GAME_ROOT（任一侧改名即红）', () => {
    expect(extractHandlerGameRootKey()).toBe(SETTING_GAME_ROOT)
  })

  it('读端常量仍为历史值 nikkisync.gameRoot（改它等于作废已入库的设置行）', () => {
    expect(SETTING_GAME_ROOT).toBe('nikkisync.gameRoot')
  })
})

// ============================================================================
// N1：同步图库与上游 PC 端对齐 —— 用户口径「默认全部翻转为开」。
// 这些断言在改码前必须红：它们锁定的是本次要修的根因（能力位默认全关）。
// ============================================================================
describe('PC 端能力默认开启（N1）', () => {
  const base = {
    userDataDir: 'U:',
    projectRoot: 'P:',
    isPackaged: false,
    resourcesPath: '',
    settings: settings({})
  }
  const ALL_ON = {
    remoteBridge: true,
    metadataDictionary: true,
    gameVersionUpdates: true,
    runtimeMemoryMaintenance: true,
    wechatGallery: true,
    desktopControl: true
  }

  it('all runtime switches default to true', () => {
    expect(RUNTIME_ENABLED_DEFAULT).toBe(true)
    expect(WATCHER_ENABLED_DEFAULT).toBe(true)
    expect(METADATA_RESOLVER_ENABLED_DEFAULT).toBe(true)
    expect(MULTI_HOST_PAIRING_DEFAULT).toBe(true)
    expect(SYNC_ENABLED_DEFAULT).toBe(true)
  })

  it('B6 守护：五项默认开启常量仍为 true（恢复同意门 fail-closed 不得撤销产品意图）', () => {
    // 源码文本级守护：常量若被改成 false 或删掉声明，即便改用字面量绕过也会当场红。
    const source = readFileSync(
      path.resolve(process.cwd(), 'src', 'main', 'app', 'nikkisync-runtime-setup.ts'),
      'utf-8'
    )
    for (const name of [
      'RUNTIME_ENABLED_DEFAULT',
      'WATCHER_ENABLED_DEFAULT',
      'METADATA_RESOLVER_ENABLED_DEFAULT',
      'MULTI_HOST_PAIRING_DEFAULT',
      'SYNC_ENABLED_DEFAULT'
    ]) {
      const match = source.match(new RegExp(`export const ${name} = (true|false)`))
      expect(match?.[1], name).toBe('true')
    }
    expect(RUNTIME_ENABLED_DEFAULT).toBe(true)
    expect(WATCHER_ENABLED_DEFAULT).toBe(true)
    expect(METADATA_RESOLVER_ENABLED_DEFAULT).toBe(true)
    expect(MULTI_HOST_PAIRING_DEFAULT).toBe(true)
    expect(SYNC_ENABLED_DEFAULT).toBe(true)
  })

  it('Runtime/元数据缺省放行、LAN 服务自启缺省关闭；env=0 仍可一键回到旧形态', () => {
    const empty = settings({})
    expect(resolveRuntimeEnabled({}, empty)).toBe(true)
    expect(resolveSyncEnabled(empty)).toBe(false)
    expect(resolveMetadataResolverEnabled({}, empty)).toBe(true)
    expect(resolveRuntimeEnabled({ [RUNTIME_ENV_FLAG]: '0' }, empty)).toBe(false)
  })

  it('buildSessionOptions exposes every PC companion switch enabled by default', () => {
    const options = buildSessionOptions({ ...base, env: {} }) as unknown as Record<string, unknown>
    expect(options.watcher).toBe(true)
    expect(options.metadataResolverEnabled).toBe(true)
    expect(options.pcCompanion).toEqual(ALL_ON)
  })

  it('六个 env 逃生阀各自可单独关闭对应能力', () => {
    const options = buildSessionOptions({
      ...base,
      env: {
        NIKKI_NIKKISYNC_REMOTE_BRIDGE: '0',
        NIKKI_NIKKISYNC_DICTIONARY: '0',
        NIKKI_NIKKISYNC_VERSION_UPDATES: '0',
        NIKKI_NIKKISYNC_MEMORY_MAINTENANCE: '0',
        NIKKI_NIKKISYNC_WECHAT: '0',
        NIKKI_NIKKISYNC_DESKTOP: '0'
      }
    }) as unknown as Record<string, unknown>
    expect(options.pcCompanion).toEqual(
      Object.fromEntries(Object.keys(ALL_ON).map((key) => [key, false]))
    )
  })
})

// ============================================================================
// C1：装配时序 + 真实会话上下文（修复「PC 服务在 start 之前构造 ⇒ 拿不到 database」）
// ============================================================================
describe('C1 PC 端服务装配时序与会话上下文', () => {
  beforeEach(() => {
    pcServicesDouble.startPcCompanionServices.mockClear()
    managerDouble.start.mockClear()
    managerDouble.startSyncServer.mockClear()
    managerDouble.pcCompanionContext.mockClear()
    installManagerStartContract()
  })

  it('正常：PC 服务在 manager.start 之后装配，且逐字拿到真实 database / 扫描根 / 配对串', async () => {
    const ctx = makeAppCtx()
    await initNikkiSyncRuntime(ctx)

    expect(managerDouble.start).toHaveBeenCalledTimes(1)
    expect(pcServicesDouble.startPcCompanionServices).toHaveBeenCalledTimes(1)
    const startOrder = managerDouble.start.mock.invocationCallOrder[0] as number
    const pcOrder = pcServicesDouble.startPcCompanionServices.mock.invocationCallOrder[0] as number
    expect(pcOrder).toBeGreaterThan(startOrder)

    const passed = pcServicesDouble.startPcCompanionServices.mock.calls[0]![0] as Record<
      string,
      unknown
    >
    expect(passed.database).toBe(pcServicesDouble.LIVE_DATABASE)
    expect(passed.scanRoots).toEqual(['/game/photos'])
    expect((passed.pairingUri as () => string)()).toBe('NS1|live-session')
  })

  it('异常：会话上下文缺席时跳过 PC 服务装配，不抛进启动链', async () => {
    const original = managerDouble.pcCompanionContext.getMockImplementation()
    managerDouble.pcCompanionContext.mockReturnValueOnce(undefined)
    try {
      const ctx = makeAppCtx()
      await expect(initNikkiSyncRuntime(ctx)).resolves.toBe(managerDouble)
      expect(pcServicesDouble.startPcCompanionServices).not.toHaveBeenCalled()
    } finally {
      if (original) managerDouble.pcCompanionContext.mockImplementation(original)
    }
  })
})

// ============================================================================
// F2：会话重建后 PC 端服务重装配——旧服务持已关闭旧库的上下文，重建路径
// （换根 / 端口变更 / resync）必须先停旧再从新鲜 pcCompanionContext() 重装配。
// ============================================================================
describe('F2 会话重建后 PC 端服务重装配', () => {
  beforeEach(() => {
    pcServicesDouble.startPcCompanionServices.mockClear()
    managerDouble.startSyncServer.mockClear()
    managerDouble.pcCompanionContext.mockClear()
    installManagerStartContract()
  })

  /** 构造一个可被 stop 的 PC 服务替身（装配成功返回值）。 */
  const serviceStub = () =>
    ({
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      status: vi.fn(() => ({ running: true, desktopUrl: 'http://127.0.0.1:1/', wechat: {} })),
      desktopUrl: vi.fn(() => 'http://127.0.0.1:1/'),
      wechatStart: vi.fn(async () => ({ status: {}, qrSvg: '<svg/>' })),
      wechatStop: vi.fn(async () => ({ status: {} })),
      wechatStatus: vi.fn(() => ({}))
    }) as never

  /** 从捕获的 deps 取两个生命周期回调（真实 manager 按此契约调用）。 */
  const lifecycleCallbacks = () =>
    managerDouble.capturedDeps as {
      onSessionStopping?: () => Promise<void> | void
      onSessionStarted?: () => Promise<void> | void
    }

  it('正常：stopping 先停旧服务；started 以新鲜上下文重装配', async () => {
    // 首启装配返回旧服务（前提：旧服务在位）
    const oldStop = vi.fn(async () => undefined)
    const stub = serviceStub() as { stop: ReturnType<typeof vi.fn> }
    stub.stop = oldStop
    pcServicesDouble.startPcCompanionServices.mockResolvedValueOnce(stub as never)
    const ctx = makeAppCtx()
    await initNikkiSyncRuntime(ctx)
    expect(pcServicesDouble.startPcCompanionServices).toHaveBeenCalledTimes(1)
    expect(managerDouble.pcCompanionServices).toBe(stub)

    // 模拟换根重建：teardown 触发 stopping → 新会话建成触发 started，且上下文已换新
    const NEW_DATABASE = { connection: { prepare: () => ({ all: () => [] }) } }
    managerDouble.pcCompanionContext.mockReturnValueOnce({
      database: NEW_DATABASE,
      scanRoots: ['/new/root'],
      pairingUri: () => 'NS1|new'
    })
    const stub2 = serviceStub()
    pcServicesDouble.startPcCompanionServices.mockResolvedValueOnce(stub2 as never)
    const callbacks = lifecycleCallbacks()
    await callbacks.onSessionStopping?.()
    expect(oldStop).toHaveBeenCalledTimes(1)
    expect(managerDouble.pcCompanionServices).toBeUndefined()

    await callbacks.onSessionStarted?.()
    expect(pcServicesDouble.startPcCompanionServices).toHaveBeenCalledTimes(2)
    const passed = pcServicesDouble.startPcCompanionServices.mock.calls[1]![0] as Record<
      string,
      unknown
    >
    expect(passed.database).toBe(NEW_DATABASE)
    expect(passed.scanRoots).toEqual(['/new/root'])
    expect(managerDouble.pcCompanionServices).toBe(stub2)
  })

  it('异常：重建后上下文缺席（如 stop 后回调误触发）⇒ 只停旧不装配，不抛', async () => {
    // 首启装配返回旧服务（前提：旧服务在位）
    const oldStop = vi.fn(async () => undefined)
    const stub = serviceStub() as { stop: ReturnType<typeof vi.fn> }
    stub.stop = oldStop
    pcServicesDouble.startPcCompanionServices.mockResolvedValueOnce(stub as never)
    const ctx = makeAppCtx()
    await initNikkiSyncRuntime(ctx)
    expect(managerDouble.pcCompanionServices).toBe(stub)
    // 重建：上下文缺席
    managerDouble.pcCompanionContext.mockReturnValueOnce(undefined)

    const callbacks = lifecycleCallbacks()
    await expect(callbacks.onSessionStarted?.()).resolves.toBeUndefined()
    expect(oldStop).toHaveBeenCalledTimes(1)
    // 上下文缺席 ⇒ 装配在取上下文一步即提前返回，不再触发 startPcCompanionServices
    expect(pcServicesDouble.startPcCompanionServices).toHaveBeenCalledTimes(1)
    expect(managerDouble.pcCompanionServices).toBeUndefined()
  })
})
