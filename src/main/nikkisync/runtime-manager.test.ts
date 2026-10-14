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
  serverStart: number
  serverStop: number
  /** 每次建会话时拿到的 LAN 配置（断言端口变更确实重建）。 */
  syncPorts: Array<string>
  /** 停止链的调用次序（验收「先停服务再关库」）。 */
  order: string[]
  revoke: string[]
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
      calls.order.push('scanner.stop')
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
  /**
   * 上游同步服务器的假面：`start()` 回显固定地址（真实端口由上游 `start()` 给出，
   * 本层只透传），`stop()` 计数；`serverStartError` 注入 EADDRINUSE 以验证归类。
   */
  const server = {
    serverId: 'server_fake_1',
    start: vi.fn(async () => {
      calls.serverStart += 1
      if (plan.serverStartError === 'eaddrinuse') {
        throw new Error('listen EADDRINUSE: address already in use 0.0.0.0:38137')
      }
      if (plan.serverStartError === 'other') {
        throw new Error('listen EACCES: permission denied 0.0.0.0:80')
      }
      return { host: '127.0.0.1', port: 38137, secure: true }
    }),
    stop: vi.fn(async () => {
      calls.serverStop += 1
      calls.order.push('server.stop')
    }),
    createPairingPayload: vi.fn(() => ({ scheme: 'nikki-sync' }))
  }
  const pairingUri = (host: string): string => {
    if (plan.pairingUriThrows) {
      throw new Error('Server must be started before creating a pairing payload')
    }
    const expiresAtSeconds = Math.floor((Date.now() + 5 * 60_000) / 1000)
    return `NS1|server_fake_1|${host}|38137|tok_value|${expiresAtSeconds}|${'a'.repeat(64)}`
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
      scanner,
      server,
      createPairingUri: (host: string) => pairingUri(host)
    },
    scanner,
    server,
    tlsIdentity: () => ({
      certPem: '-----BEGIN CERTIFICATE-----fake-----END CERTIFICATE-----',
      fingerprintSha256: 'a'.repeat(64)
    }),
    pairingUri: (host: string) => pairingUri(host),
    listPairedDevices: () => [
      {
        deviceId: 'phone_1',
        deviceName: 'Pixel',
        platform: 'android' as const,
        pairedAt: '2026-10-14T00:00:00.000Z',
        lastSeenAt: null
      }
    ],
    revokePairedDevice: (deviceId: string) => {
      calls.revoke.push(deviceId)
      return plan.revokeResult !== false
    },
    queries: {
      listAssets: vi.fn(async () => ({ items: [{ assetId: 'asset_1' }], libraryRevision: 7 })),
      getAssetDetail: vi.fn(async (assetId: string) => ({ asset: { assetId } })),
      getResource: vi.fn(async (_assetId: string, resourceId: string, mode: string) =>
        mode === 'path' ? '/game/photos/1.jpg' : { resourceId }
      )
    },
    tableNames: () => ['assets', 'resources'],
    dispose: () => {
      calls.order.push('dispose')
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
    logs: [],
    serverStart: 0,
    serverStop: 0,
    syncPorts: [],
    order: [],
    revoke: []
  }
  const deps: RuntimeManagerDependencies = {
    defaults: DEFAULTS,
    // 记录本次会话绑定的游戏根与 LAN 配置，便于断言换根/换端口重建
    createSession: async (options) => {
      calls.createSession.push(options.gameRoot ?? '<auto>')
      calls.syncPorts.push(
        `${options.syncServer?.port ?? '<unset>'}/${String(options.syncServer?.mdns ?? '<unset>')}`
      )
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

describe('createRuntimeManager 同步服务编排（阶段 3）', () => {
  it('未建会话时 syncStatus 回落配置默认值且 running=false（默认端口取上游桌面版 28080）', () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    const sync = manager.syncStatus()
    expect(sync.running).toBe(false)
    expect(sync.host).toBe('0.0.0.0')
    expect(sync.port).toBe(28080)
    expect(sync.mdnsEnabled).toBe(false)
    // 未在监听时不下「是否安全」的判断，也不虚构 serverId / 指纹
    expect(sync.secure).toBeUndefined()
    expect(sync.serverId).toBeUndefined()
    expect(sync.tlsFingerprintSha256).toBeUndefined()
    expect(sync.error).toBeUndefined()
  })

  it('startSyncServer 惰性建会话并原样透传上游 start() 回显的地址', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    const sync = await manager.startSyncServer()
    expect(sync.running).toBe(true)
    expect(sync.host).toBe('127.0.0.1')
    expect(sync.port).toBe(38137)
    expect(sync.secure).toBe(true)
    expect(sync.serverId).toBe('server_fake_1')
    expect(sync.tlsFingerprintSha256).toHaveLength(64)
    expect(sync.serverCertificatePem).toContain('BEGIN CERTIFICATE')
    expect(sync.pairedDeviceCount).toBe(1)
    expect(calls.scannerStart).toBe(1)
    expect(calls.logs.some((item) => item.message.includes('sync server listening on'))).toBe(true)
    // runtime-status 一并带出 sync，UI 只轮询一个通道
    expect(manager.status().sync?.running).toBe(true)
  })

  it('重复 startSyncServer 不重建会话（幂等依赖上游，本层不额外发明状态判断）', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    const first = await manager.startSyncServer()
    const second = await manager.startSyncServer()
    expect(second.port).toBe(first.port)
    expect(calls.createSession).toHaveLength(1)
    // 上游 start() 自带 `if (this.server) return this.address` ⇒ 第二次调用不会二次 listen
    expect(calls.serverStart).toBe(2)
  })

  it('端口占用：归类 PORT_IN_USE、不上抛、会话与只读查询面仍可用', async () => {
    const { deps, calls } = createDependencies({}, { serverStartError: 'eaddrinuse' })
    const manager = createRuntimeManager(deps)
    const sync = await manager.startSyncServer()
    expect(sync.running).toBe(false)
    expect(sync.error).toBe('PORT_IN_USE')
    // 未监听时端口回落成配置值，UI 才知道该改哪一个
    expect(sync.port).toBe(28080)
    await expect(manager.listAssets({ limit: 5 })).resolves.toBeDefined()
    expect(
      calls.logs.some((item) => item.level === 'warn' && item.message.includes('start failed'))
    ).toBe(true)
  })

  it('非端口类失败保留上游原始串（不吞、不改写文案）', async () => {
    const { deps } = createDependencies({}, { serverStartError: 'other' })
    const manager = createRuntimeManager(deps)
    const sync = await manager.startSyncServer()
    expect(sync.running).toBe(false)
    expect(sync.error).toContain('EACCES')
  })

  it('端口 / mdns 变更走会话重建（上游配置冻结在构造期）', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.startSyncServer()
    expect(calls.syncPorts).toEqual(['28080/false'])
    const changed = await manager.startSyncServer({ port: 39139, mdnsEnabled: true })
    expect(changed.running).toBe(true)
    // 旧会话先被完整 teardown（含 server.stop），再以新 LAN 配置重建
    expect(calls.createSession).toHaveLength(2)
    expect(calls.syncPorts).toEqual(['28080/false', '39139/true'])
    expect(calls.serverStop).toBe(1)
    expect(calls.dispose).toBe(1)
    // 同端口同 mdns 重复请求不再重建
    await manager.startSyncServer({ port: 39139, mdnsEnabled: true })
    expect(calls.createSession).toHaveLength(2)
  })

  it('stopSyncServer 停止上游服务并把状态复位', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.startSyncServer()
    const sync = await manager.stopSyncServer()
    expect(sync.running).toBe(false)
    expect(calls.serverStop).toBe(1)
    // 会话仍在（只停服务），库还能查
    await expect(manager.listAssets({ limit: 5 })).resolves.toBeDefined()
    // 幂等
    await manager.stopSyncServer()
    expect(calls.serverStop).toBe(2)
  })

  it('teardown 顺序：server.stop → scanner.stop → dispose（端口先释放再关库）', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.startSyncServer()
    await manager.stop()
    expect(calls.order).toEqual(['server.stop', 'scanner.stop', 'dispose'])
    expect(manager.syncStatus().running).toBe(false)
  })

  it('pairingCode：host 来自注入的解析器，NS1 串被解析成结构化字段', async () => {
    const { deps } = createDependencies({ resolvePairingHost: () => '192.168.1.50' })
    const manager = createRuntimeManager(deps)
    await manager.startSyncServer()
    const code = await manager.pairingCode()
    expect(code.host).toBe('192.168.1.50')
    expect(code.port).toBe(38137)
    expect(code.serverId).toBe('server_fake_1')
    expect(code.tlsFingerprintSha256).toBe('a'.repeat(64))
    expect(code.content.startsWith('NS1|server_fake_1|192.168.1.50|38137|')).toBe(true)
    expect(Date.parse(code.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('pairingCode：未注入解析器时如实回落回环地址（不假装是局域网 IP）', async () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.startSyncServer()
    const code = await manager.pairingCode()
    expect(code.host).toBe('127.0.0.1')
  })

  it('pairingCode：上游原生抛错（服务未启动）原样上抛，供 handler 映射前置条件失败', async () => {
    const { deps } = createDependencies({}, { pairingUriThrows: true })
    const manager = createRuntimeManager(deps)
    await manager.startSyncServer()
    await expect(manager.pairingCode()).rejects.toThrow(/Server must be started/)
  })

  it('设备面：未就绪拒绝；撤销返回 false 时上抛 not found', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    await expect(manager.listPairedDevices()).rejects.toThrow(/not ready/)
    await expect(manager.revokeDevice('x')).rejects.toThrow(/not ready/)

    await manager.startSyncServer()
    await expect(manager.listPairedDevices()).resolves.toEqual([
      expect.objectContaining({ deviceId: 'phone_1', platform: 'android' })
    ])
    await expect(manager.revokeDevice('phone_1')).resolves.toBeDefined()
    expect(calls.revoke).toEqual(['phone_1'])

    const { deps: refused } = createDependencies({}, { revokeResult: false })
    const stopped = createRuntimeManager(refused)
    await stopped.startSyncServer()
    await expect(stopped.revokeDevice('ghost')).rejects.toThrow(/not found/)
  })
})
