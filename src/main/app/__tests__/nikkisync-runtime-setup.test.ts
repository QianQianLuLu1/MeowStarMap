/**
 * @layer L3
 * @module src/main/app/nikkisync-runtime-setup
 * @coverage 内嵌 NikkiSync Runtime 的装配纯函数（阶段2：库位置 / 自启判定 / 会话参数）
 *
 * `initNikkiSyncRuntime` 的真实装载链由 `src/main/nikkisync/runtime-facade.linked.test.ts`
 * 在链接态覆盖；此处只锁「默认关闭 + userData 落点 + 开关优先级」这三条任务硬性口径。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
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
  NIKKISYNC_DB_SEGMENTS,
  RUNTIME_ENABLED_DEFAULT,
  RUNTIME_ENV_FLAG,
  SETTING_GAME_ROOT,
  SETTING_RUNTIME_ENABLED,
  SETTING_WATCHER,
  WATCHER_ENABLED_DEFAULT,
  buildSessionOptions,
  initNikkiSyncRuntime,
  nikkisyncDatabaseFile,
  resolveRuntimeEnabled,
  stopNikkiSyncRuntime,
  type NikkiSyncSettingsPort
} from '../nikkisync-runtime-setup'
import { makeAppCtx } from '../../ipc/handlers/_test-helpers'

// 依赖以替身注入：本文件验证「装配 → 状态机」的接线（谁被调用、传什么参数），
// 真装载链由 src/main/nikkisync/runtime-facade.linked.test.ts 在链接态覆盖。
const { managerDouble, depsDouble } = vi.hoisted(() => ({
  managerDouble: {
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
    getResource: vi.fn(async () => ({}))
  },
  depsDouble: {
    defaults: {},
    createSession: vi.fn(),
    isLinkReady: vi.fn(() => true),
    ensureDatabaseDirectory: vi.fn(),
    log: vi.fn(),
    withTimeout: vi.fn()
  }
}))

vi.mock('../../nikkisync/runtime-facade', () => ({
  createManagerDependencies: vi.fn(() => depsDouble)
}))

vi.mock('../../nikkisync/runtime-manager', () => ({
  createRuntimeManager: vi.fn(() => managerDouble)
}))

function settings(values: Record<string, unknown>): NikkiSyncSettingsPort {
  return {
    getBoolean: (key, fallback) =>
      typeof values[key] === 'boolean' ? (values[key] as boolean) : fallback,
    getString: (key, fallback) =>
      typeof values[key] === 'string' ? (values[key] as string) : fallback
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

describe('resolveRuntimeEnabled 开关优先级', () => {
  it('默认关闭（缺省值与常量一致）', () => {
    expect(RUNTIME_ENABLED_DEFAULT).toBe(false)
    expect(resolveRuntimeEnabled({}, settings({}))).toBe(false)
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
    managerDouble.start.mockResolvedValue({
      state: 'running',
      dbPath: '/mock/userdata/nikkisync/nikkisync.db',
      linkReady: true,
      tables: ['assets']
    })
  })

  it('开关关闭（缺省）：仅注入句柄，不自启', async () => {
    const ctx = makeAppCtx()
    const manager = await initNikkiSyncRuntime(ctx)
    expect(manager).toBe(managerDouble)
    expect(ctx.nikkisyncRuntime).toBe(managerDouble)
    expect(managerDouble.start).not.toHaveBeenCalled()
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

  it('正常：开发态给出 userData 库路径 + watcher 关闭 + 无 gameRoot 时省略该键', () => {
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
})
