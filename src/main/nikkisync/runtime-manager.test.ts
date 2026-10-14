import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createRuntimeManager,
  runWithTimeout,
  type RuntimeManagerDependencies,
  type FakeSessionPlan,
  installNotfoundMessage
} from './runtime-manager'
import type { NikkiSyncRuntimeSession, NikkiSyncSessionOptions } from './runtime-types'

/**
 * 内嵌 Runtime 状态机单测（整合阶段 2 · T2）。
 *
 * 这里只测「本仓新增的生命周期编排」：状态迁移、幂等、无游戏目录降级、
 * 换根重建、优雅停止、未就绪查询拒绝。会话本体（装载 + 组装 + 查询）由
 * `runtime-facade.linked.test.ts` 在链接态覆盖，故本文件不依赖 @nikkisync 链接。
 */

const DEFAULTS: NikkiSyncSessionOptions = {
  databaseFile: '/tmp/userData/nikkisync/nikkisync.db',
  watcher: false,
  projectRoot: '/tmp/XiangCe'
}

interface FakeCalls {
  createSession: string[]
  scannerStart: number
  scannerStop: number
  dispose: number
  fullScan: number
  rescanPath: string[]
  ensureDir: string[]
  logs: Array<{ level: string; message: string }>
}

/**
 * 造一个可编排失败形态的假会话：`plan` 决定 scanner.start() 抛什么、
 * 查询返回什么，calls 记录调用次数，用于断言幂等与重建。
 */
function createFakeSession(calls: FakeCalls, plan: FakeSessionPlan = {}): NikkiSyncRuntimeSession {
  const installation = { installRoot: '/game', source: 'manual' }
  const lastScan = { scanId: 'scan_1', roots: ['/game/photos'] }
  const scanner = {
    start: vi.fn(async () => {
      calls.scannerStart += 1
      if (plan.startError === 'notfound') throw new Error(installNotfoundMessage)
      if (plan.startError === 'other') throw new Error('EACCES: permission denied')
      return { scanId: 'scan_1', roots: ['/game/photos'] }
    }),
    stop: vi.fn(async () => {
      calls.scannerStop += 1
      if (plan.stopHangs) return new Promise<void>(() => {})
      if (plan.stopThrows) throw new Error('watcher close failed')
    }),
    fullScan: vi.fn(async () => {
      calls.fullScan += 1
      return { scanId: 'scan_full', filesObserved: 3 }
    }),
    rescanPath: vi.fn(async (filePath: string) => {
      calls.rescanPath.push(filePath)
      return { scanId: 'scan_path', roots: [filePath] }
    }),
    // 与上游 ScannerMetrics 同形：{ status, installation?, lastScan? }；
    // scannerStatusRaw 注入时整体覆盖（边界用例），以 `in` 判定便于注入 undefined
    getStatus: () =>
      'scannerStatusRaw' in plan
        ? plan.scannerStatusRaw
        : { status: 'running', installation, lastScan }
  }
  return {
    runtime: {
      database: {
        connection: {
          prepare: () => ({ all: () => [], get: () => undefined }),
          exec: () => {},
          close: () => {}
        },
        initialize: () => {},
        close: () => {}
      },
      scanner
    },
    scanner,
    queries: {
      listAssets: vi.fn(async () => ({ items: [{ assetId: 'asset_1' }], libraryRevision: 7 })),
      getAssetDetail: vi.fn(async (assetId: string) => ({ asset: { assetId } })),
      getResource: vi.fn(async (_assetId: string, resourceId: string, mode: string) =>
        mode === 'path' ? '/game/photos/1.jpg' : { resourceId }
      )
    },
    tableNames: () => ['assets', 'resources'],
    dispose: () => {
      calls.dispose += 1
    }
  }
}

function createDependencies(
  overrides: Partial<RuntimeManagerDependencies> = {},
  plan: FakeSessionPlan = {}
): { deps: RuntimeManagerDependencies; calls: FakeCalls } {
  const calls: FakeCalls = {
    createSession: [],
    scannerStart: 0,
    scannerStop: 0,
    dispose: 0,
    fullScan: 0,
    rescanPath: [],
    ensureDir: [],
    logs: []
  }
  const deps: RuntimeManagerDependencies = {
    defaults: DEFAULTS,
    // 记录本次会话绑定的游戏根，便于断言换根重建
    createSession: async (options) => {
      calls.createSession.push(options.gameRoot ?? '<auto>')
      return createFakeSession(calls, plan)
    },
    isLinkReady: () => true,
    ensureDatabaseDirectory: (file) => {
      calls.ensureDir.push(file)
    },
    log: (level, message) => {
      calls.logs.push({ level, message })
    },
    withTimeout: (_label, work) => work(),
    ...overrides
  }
  return { deps, calls }
}

describe('createRuntimeManager 初始状态', () => {
  let calls: FakeCalls
  let deps: RuntimeManagerDependencies

  beforeEach(() => {
    const built = createDependencies()
    deps = built.deps
    calls = built.calls
  })

  it('链接就绪时为 idle，未就绪时为 unavailable 且给出修复提示', () => {
    const ready = createRuntimeManager(deps)
    expect(ready.status().state).toBe('idle')
    expect(ready.status().dbPath).toBe(DEFAULTS.databaseFile)
    expect(ready.status().linkReady).toBe(true)
    expect(calls.createSession).toEqual([])

    const unready = createRuntimeManager({ ...deps, isLinkReady: () => false })
    expect(unready.status().state).toBe('unavailable')
    expect(unready.status().linkReady).toBe(false)
    expect(unready.status().hint).toContain('npm run link:nikkisync')
  })

  it('未启动时查询直接拒绝（不把空结果伪装成正常）', async () => {
    const manager = createRuntimeManager(deps)
    await expect(manager.listAssets({ limit: 10 })).rejects.toThrow(/not ready/)
    await expect(manager.getAssetDetail('asset_1')).rejects.toThrow(/not ready/)
    await expect(manager.getResource('asset_1', 'resource_1')).rejects.toThrow(/not ready/)
  })
})

describe('createRuntimeManager 启动', () => {
  it('正常路径：starting → running，建目录、启 scanner、状态带表名与扫描器三字段', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    const status = await manager.start(DEFAULTS)
    expect(status.state).toBe('running')
    expect(status.tables).toEqual(['assets', 'resources'])
    // 上游 ScannerMetrics 展平透传：scannerStatus/installation/lastScan（回归：
    // runtime-types 字段变更后生产者未同步时，这三条必须失败）
    expect(status.scannerStatus).toBe('running')
    expect(status.installation).toEqual({ installRoot: '/game', source: 'manual' })
    expect(status.lastScan).toEqual({ scanId: 'scan_1', roots: ['/game/photos'] })
    expect(calls.ensureDir).toEqual([DEFAULTS.databaseFile])
    expect(calls.createSession).toEqual(['<auto>'])
    expect(calls.scannerStart).toBe(1)
  })

  it('降级：无游戏目录时不外抛，状态 degraded 且仍可查询（库已建）', async () => {
    const { deps, calls } = createDependencies({}, { startError: 'notfound' })
    const manager = createRuntimeManager(deps)
    const status = await manager.start(DEFAULTS)
    expect(status.state).toBe('degraded')
    expect(status.error).toContain(installNotfoundMessage)
    expect(calls.scannerStart).toBe(1)
    await expect(manager.listAssets({ limit: 5 })).resolves.toMatchObject({ libraryRevision: 7 })
  })

  it('失败：会话创建抛错时状态 error、记录日志、仍不外抛', async () => {
    const { deps, calls } = createDependencies({
      createSession: async () => {
        throw new Error('ERR_REQUIRE_ASYNC_MODULE')
      }
    })
    const manager = createRuntimeManager(deps)
    const status = await manager.start(DEFAULTS)
    expect(status.state).toBe('error')
    expect(status.error).toContain('ERR_REQUIRE_ASYNC_MODULE')
    expect(calls.logs.some((item) => item.level === 'error')).toBe(true)
  })

  it('幂等：running 下重复 start 不再建会话；并发 start 共享同一次启动', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    const [first, second] = await Promise.all([manager.start(DEFAULTS), manager.start(DEFAULTS)])
    expect(first.state).toBe('running')
    expect(second.state).toBe('running')
    expect(calls.createSession).toHaveLength(1)
    expect(calls.scannerStart).toBe(1)
    await manager.start(DEFAULTS)
    expect(calls.createSession).toHaveLength(1)
  })

  it('unavailable 时 start 不装载任何东西，只回状态与提示', async () => {
    const { deps, calls } = createDependencies({ isLinkReady: () => false })
    const manager = createRuntimeManager(deps)
    const status = await manager.start(DEFAULTS)
    expect(status.state).toBe('unavailable')
    expect(calls.createSession).toEqual([])
    expect(calls.scannerStart).toBe(0)
  })
})

describe('createRuntimeManager 状态快照的扫描器字段', () => {
  it('异常路径：getStatus() 返回非对象时快照不含扫描器字段且不抛错', async () => {
    const { deps } = createDependencies({}, { scannerStatusRaw: 'oops' })
    const manager = createRuntimeManager(deps)
    const status = await manager.start(DEFAULTS)
    expect(status.state).toBe('running')
    expect(status.scannerStatus).toBeUndefined()
    expect(status.installation).toBeUndefined()
    expect(status.lastScan).toBeUndefined()
    expect(status.tables).toEqual(['assets', 'resources'])
  })

  it('边界：getStatus() 返回缺字段对象时三字段缺省，不影响其余快照', async () => {
    const { deps } = createDependencies({}, { scannerStatusRaw: {} })
    const manager = createRuntimeManager(deps)
    const status = await manager.start(DEFAULTS)
    expect(status.state).toBe('running')
    expect(status.scannerStatus).toBeUndefined()
    expect(status.installation).toBeUndefined()
    expect(status.lastScan).toBeUndefined()
    expect(status.tables).toEqual(['assets', 'resources'])
  })
})

describe('createRuntimeManager 扫描', () => {
  it('惰性启动后走 fullScan，结束回到 running', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    const result = await manager.scan({})
    expect(result).toMatchObject({ scanId: 'scan_full' })
    expect(calls.createSession).toEqual(['<auto>'])
    expect(calls.fullScan).toBe(1)
    expect(manager.status().state).toBe('running')
  })

  it('给定 path 时走上游 rescanPath（按 uid 目录收敛）', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.scan({ path: '/game/photos/10001/a.jpg' })
    expect(calls.rescanPath).toEqual(['/game/photos/10001/a.jpg'])
    expect(calls.fullScan).toBe(0)
  })

  it('换根重建：gameRoot 与当前不同即先停旧会话再按新根建（上游会缓存 installation）', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.scan({})
    await manager.scan({ gameRoot: '/second/game/root' })
    expect(calls.createSession).toEqual(['<auto>', '/second/game/root'])
    expect(calls.scannerStop).toBe(1)
    expect(calls.dispose).toBe(1)
    expect(calls.fullScan).toBe(2)
    expect(manager.status().dbPath).toBe(DEFAULTS.databaseFile)
  })

  it('同根重复扫描不重建会话', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.scan({ gameRoot: '/same' })
    await manager.scan({ gameRoot: '/same' })
    expect(calls.createSession).toEqual(['/same'])
    expect(calls.dispose).toBe(0)
  })
})

describe('createRuntimeManager 优雅停止', () => {
  it('先停 scanner 再关库，二次调用幂等', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.stop()
    expect(manager.status().state).toBe('idle')
    expect(calls.scannerStop).toBe(1)
    expect(calls.dispose).toBe(1)
    await manager.stop()
    expect(calls.scannerStop).toBe(1)
    expect(calls.dispose).toBe(1)
  })

  it('stop 抛错只记日志，不阻塞退出链', async () => {
    const { deps, calls } = createDependencies({}, { stopThrows: true })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await expect(manager.stop()).resolves.toBeUndefined()
    expect(calls.dispose).toBe(1)
    expect(calls.logs.some((item) => item.message.includes('watcher close failed'))).toBe(true)
  })

  it('stop 卡住时由超时兜底放行（不拖住退出链）', async () => {
    const { deps, calls } = createDependencies(
      {
        // 真实现是 3s，测试里压到 5ms 以保证挂起的 stop 仍被放行
        withTimeout: (label, work) => runWithTimeout(label, work, 5)
      },
      { stopHangs: true }
    )
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await expect(manager.stop()).resolves.toBeUndefined()
    expect(calls.scannerStop).toBe(1)
    expect(calls.dispose).toBe(1)
    expect(manager.status().state).toBe('idle')
  })

  it('runWithTimeout：超时返回 undefined，正常路径透传结果，拒绝原样上抛', async () => {
    await expect(runWithTimeout('t', async () => 'done', 20)).resolves.toBe('done')
    await expect(
      runWithTimeout('t', () => new Promise<string>(() => {}), 5)
    ).resolves.toBeUndefined()
    await expect(
      runWithTimeout('t', async () => Promise.reject(new Error('boom')), 20)
    ).rejects.toThrow('boom')
  })

  it('停止后查询恢复拒绝态，避免访问已关闭的库', async () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.stop()
    await expect(manager.listAssets({ limit: 5 })).rejects.toThrow(/not ready/)
  })
})

describe('createRuntimeManager 查询透传', () => {
  it('原样返回查询面结果，不做字段包装', async () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await expect(manager.listAssets({ limit: 10 })).resolves.toEqual({
      items: [{ assetId: 'asset_1' }],
      libraryRevision: 7
    })
    await expect(manager.getAssetDetail('asset_9')).resolves.toEqual({
      asset: { assetId: 'asset_9' }
    })
    await expect(manager.getResource('a', 'r', 'path')).resolves.toBe('/game/photos/1.jpg')
  })

  it('degraded 状态下 status 仍带 dbPath 与降级原因（供 IPC 展示）', async () => {
    const { deps } = createDependencies({}, { startError: 'notfound' })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    const status = manager.status()
    expect(status.state).toBe('degraded')
    expect(status.dbPath).toBe(DEFAULTS.databaseFile)
    expect(status.error).toContain(installNotfoundMessage)
  })
})
