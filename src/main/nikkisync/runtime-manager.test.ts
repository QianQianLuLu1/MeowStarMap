import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createRuntimeManager,
  runWithTimeout,
  type RuntimeManagerDependencies,
  type FakeSessionPlan,
  installNotfoundMessage
} from './runtime-manager'
import type { NikkiSyncRuntimeSession, NikkiSyncSessionOptions } from './runtime-types'
import { DEFAULT_METADATA_MAX_PASSES, NUAN5_METADATA_ENDPOINT } from './metadata-resolver-driver'
import {
  clearNikkiSyncResourcePaths,
  isNikkiSyncResourcePath,
  registerNikkiSyncResourcePaths
} from './resource-allowlist'

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
  /** 阶段 6：上游元数据服务面的调用计数。 */
  metadataStop: number
  metadataRunOnce: number
  metadataDiagnostics: number
  /** 阶段 6：上游 `runtime.start()` 是否被调用过（本仓必须恒为 0）。 */
  runtimeStart: number
  /** K1：缓存解码元数据闭包被调次数。 */
  cachedMetadataRunOnce: number
  /** K2：同意开关 setEnabled 收到的参数序列。 */
  metadataConsentSet: Array<{ enabled: boolean; policyVersion?: string }>
  /** K3：会话面收到的 capturedAt 序列。 */
  resolveGameVersion: Array<string | undefined>
  /** K5：会话面 pairingUri 收到的参数序列。 */
  pairingUriArgs: Array<{ host: string; ttlMs?: number; hosts?: string[] }>
  /** K8：整理队列 decide/approveMany 收到的参数序列（验证逐字透传）。 */
  organizerDecide: Array<{ id: string; approve: boolean }>
  organizerApproveMany: string[][]
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
      if (plan.fullScanThrows) throw new Error(installNotfoundMessage)
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
  const pairingUri = (host: string, ttlMs?: number, hosts?: readonly string[]): string => {
    if (plan.pairingUriThrows) {
      throw new Error('Server must be started before creating a pairing payload')
    }
    calls.pairingUriArgs.push({ host, ttlMs, hosts: hosts ? [...hosts] : undefined })
    // K5：多 host 时上游走 nikki-sync://pair? 新格式（与 vendored buildPairingUri 同构）
    if (hosts && hosts.length > 1) {
      const query = new URLSearchParams({
        serverId: 'server_fake_1',
        host,
        port: '38137',
        token: 'tok_value',
        protocol: '1',
        expiresAt: '2026-10-25T12:05:00.000Z',
        tls: 'a'.repeat(64),
        hosts: [...new Set([host, ...hosts])].slice(0, 8).join(',')
      })
      return `nikki-sync://pair?${query}`
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
      // 阶段 6：上游 `runtime.start()` 会连带启 LAN 服务（绑 0.0.0.0），本仓必须一次都不调
      start: vi.fn(async () => {
        calls.runtimeStart += 1
        return {}
      }),
      createPairingUri: (host: string, ttlMs?: number, hosts?: readonly string[]) =>
        pairingUri(host, ttlMs, hosts)
    },
    scanner,
    server,
    tlsIdentity: () => ({
      certPem: '-----BEGIN CERTIFICATE-----fake-----END CERTIFICATE-----',
      fingerprintSha256: 'a'.repeat(64)
    }),
    pairingUri: (host: string, ttlMs?: number, hosts?: readonly string[]) =>
      pairingUri(host, ttlMs, hosts),
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
    stopMetadataResolver: () => {
      calls.metadataStop += 1
      calls.order.push('metadataResolver.stop')
      if (plan.metadataStopThrows) throw new Error('metadata resolver stop failed')
    },
    // 上游条件构造的镜像：未开启 ⇒ 该成员整个缺席，编排层据此判 0 轮
    ...(plan.metadataResolverPresent
      ? {
          metadataRunOnce: async () => {
            calls.metadataRunOnce += 1
            if (plan.metadataRunOnceThrows) throw new Error('SQLITE_BUSY: database is locked')
            if (plan.metadataRunOnceWait) await plan.metadataRunOnceWait()
            const results = plan.metadataRunOnceResults ?? [0]
            return results[Math.min(calls.metadataRunOnce - 1, results.length - 1)]
          }
        }
      : {}),
    // K1：上游 cachedMetadataRunOnce「仅存在时挂出」先例的镜像（默认缺席 ⇒ 零调用）
    ...(plan.cachedMetadataPresent
      ? {
          cachedMetadataRunOnce: () => {
            calls.cachedMetadataRunOnce += 1
            if (plan.cachedMetadataRunOnceThrows) {
              throw new Error('SQLITE_BUSY: cached metadata upgrade failed')
            }
            const results = plan.cachedMetadataRunOnceResults ?? [0]
            return results[Math.min(calls.cachedMetadataRunOnce - 1, results.length - 1)]
          }
        }
      : {}),
    // K2：上游同意面「仅解析开启时挂出」的镜像（默认缺席 ⇒ manager 读写抛 unavailable）
    ...(plan.metadataConsentPresent
      ? {
          metadataConsent: {
            state: () => ({
              enabled: false,
              policyVersion: '2026-10-13.1',
              recipients: [
                {
                  name: 'Nuan5 metadata service',
                  endpoint: 'https://nuan5.pro/api/decode-photo2',
                  fields: ['photo UID']
                }
              ]
            }),
            setEnabled: (enabled: boolean, policyVersion?: string) => {
              calls.metadataConsentSet.push({ enabled, policyVersion })
            }
          }
        }
      : {}),
    metadataDiagnostics: () => {
      calls.metadataDiagnostics += 1
      return {
        schemaVersion: 1,
        generatedAt: '2026-10-16T00:00:00.000Z',
        resolverEnabled: plan.metadataResolverPresent === true,
        ordinaryPhotos: 25,
        withNativeToken: 25,
        withCompleteEnvelope: 25,
        resolved: 0,
        failed: 0,
        pending: 25,
        withOutfit: 0,
        withCamera: 0,
        motionPhotos: 6,
        failureCategories: {}
      }
    },
    queries: {
      // 上游 b397e0e 起 `mapAssetSummary` 追加两个本机绝对路径键（sourceFolder 由 sourcePath
      // 剥尾段得来 ⇒ 二者成对出现）。夹具如实带上，用于钉住「渲染层拿不到绝对路径」这条姿态。
      listAssets: vi.fn(async () =>
        plan.assetPage
          ? (plan.assetPage as { items: unknown[]; libraryRevision: number })
          : {
              items: [
                {
                  assetId: 'asset_1',
                  revision: 3,
                  sourcePath: 'D:/game/photos/Photo_1.jpg',
                  sourceFolder: 'D:/game/photos'
                }
              ],
              libraryRevision: 7
            }
      ),
      getAssetDetail: vi.fn(async (assetId: string) => ({ asset: { assetId } })),
      getResource: vi.fn(async (_assetId: string, resourceId: string, mode: string) =>
        mode === 'path' ? '/game/photos/1.jpg' : { resourceId }
      ),
      listResourceRecords: vi.fn(async (_assetIds: string[], mode: string) =>
        mode === 'path'
          ? { byAsset: { asset_1: { res_1: 'D:/game/photos/Photo_1.jpg' } } }
          : { byAsset: { asset_1: [{ resourceId: 'res_1', role: 'source_primary' }] } }
      ),
      // 搜索面把资产行嵌在 items[].photos[].asset 里（上游 SuitSearchIndex 按引用塞入）：
      // 只浅拷一层裁不到它，故夹具刻意做成嵌套
      searchSuits: vi.fn(
        async () =>
          plan.suitPage ?? {
            items: [
              {
                suitId: 'suit_1',
                photos: [
                  {
                    asset: {
                      assetId: 'asset_1',
                      sourcePath: 'D:/game/photos/Photo_1.jpg',
                      sourceFolder: 'D:/game/photos'
                    },
                    matchedParts: ['top']
                  }
                ]
              }
            ]
          }
      ),
      // 服装索引与套装索引同构：上游 ClothingSearchIndex.js:79 把同一张照片的**同一个** asset
      // 对象按引用塞进每个命中的服装聚合 ⇒ 夹具必须给出嵌套载荷，`{ items: [] }` 会让裁剪
      // 断言空转（这正是跨聚合漏键没被抓住的原因）。字段形态取自上游 :67-92，
      // 刻意不含 matchedParts——那是套装索引独有。
      searchClothing: vi.fn(
        async () =>
          plan.clothingPage ?? {
            query: '裙',
            items: [
              {
                clothingId: 'cloth_1',
                name: '天鹅裙',
                category: 'dresses',
                suitId: 'suit_1',
                suitName: '天鹅童话',
                photoCount: 1,
                photos: [
                  {
                    asset: {
                      assetId: 'asset_1',
                      sourcePath: 'D:/game/photos/Photo_1.jpg',
                      sourceFolder: 'D:/game/photos'
                    }
                  }
                ]
              }
            ]
          }
      ),
      profileStats: vi.fn(async () => ({ libraryRevision: 7 }))
    },
    // K3：会话面的游戏版本推断（facade 接到日历深入口；默认两键缺省）
    resolveGameVersion: (capturedAt?: string) => {
      calls.resolveGameVersion.push(capturedAt)
      return plan.gameVersionResult ?? {}
    },
    // K6：额外目录面「仅文件给出时挂出」的镜像（默认缺席 ⇒ manager 五方法抛 unavailable）
    ...(plan.extraDirectoriesPresent
      ? {
          extraDirectories: {
            state: () => ({
              directories: [{ id: 'dir_1', path: 'D:/ExtraPhotos', mode: 'native' }],
              automaticRoots: ['/game/photos'],
              busy: false
            }),
            inspect: async (selected: string) => ({ id: 'p1', selected, images: 3, videos: 1 }),
            add: async (id: string) => ({ added: id }),
            remove: async (id: string) => ({ removed: id }),
            rescan: async () => ({ rescanned: true })
          }
        }
      : {}),
    // K7：扫描诊断面「仅存在时挂出」（facade 接 ScanDiagnostics 深入口）
    ...(plan.scanDiagnosticsResult
      ? { scanDiagnostics: () => ({ ...plan.scanDiagnosticsResult }) }
      : {}),
    // K8：整理队列假面（上游构造期必建；缺省不挂 ⇒ manager 三方法抛 unavailable）
    ...(plan.deletionsPlan
      ? {
          deletions: {
            list: () => plan.deletionsPlan!.rows.map((row) => ({ ...row })),
            decide: async (id: string, approve: boolean) => {
              calls.organizerDecide.push({ id, approve })
              if (plan.deletionsPlan!.decideError) throw new Error(plan.deletionsPlan!.decideError)
              return (
                plan.deletionsPlan!.decideResult ??
                plan.deletionsPlan!.rows.map((row) => ({ ...row }))
              )
            },
            approveMany: async (ids: string[]) => {
              calls.organizerApproveMany.push(ids)
              if (plan.deletionsPlan!.approveManyError) {
                throw new Error(plan.deletionsPlan!.approveManyError)
              }
              return (
                plan.deletionsPlan!.approveManyResult ?? {
                  items: plan.deletionsPlan!.rows.map((row) => ({ ...row })),
                  approved: ids.length,
                  skipped: 0
                }
              )
            },
            activity: () =>
              plan.deletionsPlan!.activity ?? { catalogPasses: 0, queued: 0, active: 0 }
          }
        }
      : {}),
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
    revoke: [],
    metadataStop: 0,
    metadataRunOnce: 0,
    metadataDiagnostics: 0,
    runtimeStart: 0,
    cachedMetadataRunOnce: 0,
    metadataConsentSet: [],
    resolveGameVersion: [],
    organizerDecide: [],
    organizerApproveMany: [],
    pairingUriArgs: []
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

  it('会话拆除即收回 media:// 资产路径授权（阶段4）', async () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    clearNikkiSyncResourcePaths()
    registerNikkiSyncResourcePaths(1, ['/mock/nikki/a.png'])
    expect(isNikkiSyncResourcePath('/mock/nikki/a.png')).toBe(true)

    await manager.stop()
    // 库已关闭还允许显示旧路径，等于给不存在的文件开长期口子
    expect(isNikkiSyncResourcePath('/mock/nikki/a.png')).toBe(false)
  })

  it('换根重建同样收回授权，不把上一个库的路径带进新会话', async () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    clearNikkiSyncResourcePaths()
    registerNikkiSyncResourcePaths(1, ['/mock/old-root/a.png'])

    await manager.scan({ gameRoot: '/mock/other-root' })
    expect(isNikkiSyncResourcePath('/mock/old-root/a.png')).toBe(false)
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
  it('除资产行的本机绝对路径两键外原样返回，不做字段包装', async () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await expect(manager.listAssets({ limit: 10 })).resolves.toEqual({
      items: [{ assetId: 'asset_1', revision: 3 }],
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

describe('createRuntimeManager 资产路径键裁剪（上游 b397e0e 同步）', () => {
  it('正常：资产行的 sourcePath/sourceFolder 不透给渲染层，其余键原样保留', async () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    const page = await manager.listAssets({ limit: 10 })
    expect(JSON.stringify(page)).not.toContain('sourcePath')
    expect(JSON.stringify(page)).not.toContain('sourceFolder')
    expect((page as { items: unknown[] }).items).toHaveLength(1)
    expect((page as { libraryRevision: number }).libraryRevision).toBe(7)
  })

  it('正常：搜索面嵌套 items[].photos[].asset 里的两键同样不透出（浅拷一层不够）', async () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    const suits = await manager.searchSuits('dress')
    expect(JSON.stringify(suits)).not.toContain('sourcePath')
    expect(JSON.stringify(suits)).not.toContain('sourceFolder')
    // 结构本身不被改写：suitId / matchedParts 仍在原位
    const first = (suits as { items: Array<{ photos: Array<{ matchedParts: string[] }> }> })
      .items[0]
    expect(first?.photos[0]?.matchedParts).toEqual(['top'])
  })

  it('边界：path 模式资源通道按设计保留绝对路径原值（裁了 media:// 当场失效）', async () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await expect(manager.getResource('a', 'r', 'path')).resolves.toBe('/game/photos/1.jpg')
    const records = (await manager.listResourceRecords(['asset_1'], 'path')) as {
      byAsset: Record<string, Record<string, string>>
    }
    expect(records.byAsset.asset_1?.res_1).toBe('D:/game/photos/Photo_1.jpg')
  })

  it('边界：裁剪走副本，不写回上游查询面的对象身份（searchSource 按 revision 缓存，就地删键会污染缓存与统计面）', async () => {
    const rawPage = {
      items: [
        {
          assetId: 'asset_1',
          sourcePath: 'D:/game/photos/Photo_1.jpg',
          sourceFolder: 'D:/game/photos'
        }
      ],
      libraryRevision: 9
    }
    const rawSuits = {
      items: [
        {
          suitId: 'suit_1',
          photos: [
            {
              asset: {
                assetId: 'asset_1',
                sourcePath: 'D:/game/photos/Photo_1.jpg',
                sourceFolder: 'D:/game/photos'
              },
              matchedParts: ['top']
            }
          ]
        }
      ]
    }
    const { deps } = createDependencies({}, { assetPage: rawPage, suitPage: rawSuits })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.listAssets({ limit: 10 })
    await manager.searchSuits('dress')
    // 原件两键仍在 ⇒ 委托层返回的是副本；若实现改成 delete 原对象，这两条断言立刻红
    expect(rawPage.items[0]).toHaveProperty('sourcePath')
    expect(rawSuits.items[0]?.photos[0]?.asset).toHaveProperty('sourceFolder')
  })

  it('回归：searchClothing 的嵌套 items[].photos[].asset 同样不透两键，且结构不被改写', async () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    const clothing = await manager.searchClothing('裙')
    expect(JSON.stringify(clothing)).not.toContain('sourcePath')
    expect(JSON.stringify(clothing)).not.toContain('sourceFolder')
    // 结构原样：服装面的键（clothingId/photoCount/photos[].asset）不被改写，无 matchedParts
    const typed = clothing as {
      query: string
      items: Array<{
        clothingId: string
        photoCount: number
        photos: Array<{ asset: { assetId: string }; matchedParts?: unknown }>
      }>
    }
    expect(typed.query).toBe('裙')
    expect(typed.items[0]?.clothingId).toBe('cloth_1')
    expect(typed.items[0]?.photoCount).toBe(1)
    expect(typed.items[0]?.photos[0]?.asset.assetId).toBe('asset_1')
    expect(typed.items[0]?.photos[0]?.matchedParts).toBeUndefined()
  })

  it('缺陷：同一 asset 身份被两个套装聚合共享时两处都必须是已裁键副本（上游按引用塞入 ⇒ 第二处曾退回原件）', async () => {
    const sharedAsset = {
      assetId: 'asset_1',
      sourcePath: 'D:/game/photos/Photo_1.jpg',
      sourceFolder: 'D:/game/photos'
    }
    // 一张照片同时命中两套「天鹅」开头的服装 ⇒ 上游 SuitSearchIndex.js:145 把**同一个** asset
    // 对象塞进两个聚合；委托层若按「已访问」跳过第二处，拿回去的就是带绝对路径的原件。
    const rawSuits = {
      items: [
        {
          suitId: 'suit_1',
          suitName: '天鹅童话',
          photos: [{ asset: sharedAsset, matchedParts: ['top'] }]
        },
        {
          suitId: 'suit_2',
          suitName: '天鹅童话·晨曦',
          photos: [{ asset: sharedAsset, matchedParts: ['dress'] }]
        }
      ]
    }
    const { deps } = createDependencies({}, { suitPage: rawSuits })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    const suits = (await manager.searchSuits('天鹅')) as {
      items: Array<{ photos: Array<{ asset: unknown }> }>
    }
    expect(suits.items).toHaveLength(2)
    for (const item of suits.items) {
      for (const photo of item.photos) {
        expect(photo.asset).not.toBe(sharedAsset)
        expect(photo.asset).not.toHaveProperty('sourcePath')
        expect(photo.asset).not.toHaveProperty('sourceFolder')
      }
    }
    expect(JSON.stringify(suits)).not.toContain('sourcePath')
    expect(JSON.stringify(suits)).not.toContain('sourceFolder')
    // 副本而非就地删键：原件两键必须原样在（searchSource 缓存与统计面共享它）
    expect(sharedAsset).toHaveProperty('sourcePath')
    expect(sharedAsset).toHaveProperty('sourceFolder')
  })

  it('缺陷：searchClothing 的同一 asset 跨服装聚合共享 ⇒ 两处都裁键（一张照片命中 N 件服装即 N 份引用）', async () => {
    const sharedAsset = {
      assetId: 'asset_1',
      sourcePath: 'D:/game/photos/Photo_1.jpg',
      sourceFolder: 'D:/game/photos'
    }
    // 上游 ClothingSearchIndex.js:79 在逐服装循环里 push 同一个 searchable.asset
    const rawClothing = {
      query: '天鹅',
      items: [
        {
          clothingId: 'cloth_1',
          name: '天鹅裙',
          category: 'dresses',
          photoCount: 1,
          photos: [{ asset: sharedAsset }]
        },
        {
          clothingId: 'cloth_2',
          name: '天鹅披肩',
          category: 'accessories',
          photoCount: 1,
          photos: [{ asset: sharedAsset }]
        }
      ]
    }
    const { deps } = createDependencies({}, { clothingPage: rawClothing })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    const clothing = (await manager.searchClothing('天鹅')) as {
      items: Array<{ photos: Array<{ asset: unknown }> }>
    }
    expect(clothing.items).toHaveLength(2)
    for (const item of clothing.items) {
      for (const photo of item.photos) {
        expect(photo.asset).not.toBe(sharedAsset)
        expect(photo.asset).not.toHaveProperty('sourcePath')
        expect(photo.asset).not.toHaveProperty('sourceFolder')
      }
    }
    expect(JSON.stringify(clothing)).not.toContain('sourcePath')
    expect(sharedAsset).toHaveProperty('sourcePath')
  })

  it('缺陷：深层嵌套（>8 层）对象的 sourcePath/sourceFolder 也必须裁掉（旧 MAX_STRIP_DEPTH=8 提前 return 致 fail-open）', async () => {
    // 旧实现在 depth>=8 的对象上 `return copy` 停下钻，其子树仍是原引用 → 两键残留。
    // 含两键对象落在 depth12（root=0 → items 数组=1 → items[0]=2 → 10 层 nested=12）；
    // 只要真实 payload 未来在 asset 外多包几层即泄漏，破的是函数自述「按形状递归、宁少不漏」。
    let deep: Record<string, unknown> = {
      sourcePath: 'D:/game/photos/leak.jpg',
      sourceFolder: 'D:/game/photos'
    }
    for (let i = 0; i < 10; i++) deep = { nested: deep }
    const rawPage = { items: [deep], libraryRevision: 1 }

    const { deps } = createDependencies({}, { assetPage: rawPage })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    const page = await manager.listAssets({ limit: 10 })

    expect(JSON.stringify(page)).not.toContain('sourcePath')
    expect(JSON.stringify(page)).not.toContain('sourceFolder')
    // 防恒绿：结构其余键与 libraryRevision 原样保留，证明拿到的是裁剪后的副本而非空对象
    expect((page as { libraryRevision: number }).libraryRevision).toBe(1)
  })

  it('缺陷：Date/Map/Set 作为载荷值不得被浅拷展开成空对象（DEBT-042 的静默丢数据）', async () => {
    const capturedAt = new Date('2026-10-30T00:00:00.000Z')
    const tags = new Map([['theme', 12]])
    const buckets = new Set(['Photo_1.jpg'])
    const rawPage = {
      items: [
        { assetId: 'a1', capturedAt, tags, buckets },
        // 同一个身份在一页里再出现一次 ⇒ 告警必须按身份去重，否则热路径会刷屏
        { assetId: 'a2', capturedAt, tags, buckets }
      ],
      libraryRevision: 9
    }
    const warnSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    try {
      const { deps } = createDependencies({}, { assetPage: rawPage })
      const manager = createRuntimeManager(deps)
      await manager.start(DEFAULTS)
      const page = (await manager.listAssets({ limit: 10 })) as {
        items: Array<Record<string, unknown>>
      }
      expect(page.items).toHaveLength(2)
      for (const item of page.items) {
        // 旧实现走 `{...value}`：Date/Map/Set 的可枚举自有属性为空 ⇒ 三者全变 `{}`，数据静默消失
        expect(item.capturedAt).toBe(capturedAt)
        expect(item.tags).toBe(tags)
        expect(item.buckets).toBe(buckets)
      }
      // 透传不许是静默的：三个身份各告警一次，出现两次不翻倍
      expect(warnSpy).toHaveBeenCalledTimes(3)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('缺陷：类实例自带两键时必须剔键，但不得连带丢掉其它自有属性与实例身份', async () => {
    class AssetRow {
      assetId = 'asset_1'
      note = 'keep me'
      sourcePath = 'D:/game/photos/Photo_1.jpg'
      sourceFolder = 'D:/game/photos'
    }
    const row = new AssetRow()
    const rawPage = { items: [row], libraryRevision: 9 }
    const warnSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    try {
      const { deps } = createDependencies({}, { assetPage: rawPage })
      const manager = createRuntimeManager(deps)
      await manager.start(DEFAULTS)
      const page = (await manager.listAssets({ limit: 10 })) as {
        items: Array<Record<string, unknown>>
      }
      const item = page.items[0]!
      expect(item).not.toHaveProperty('sourcePath')
      expect(item).not.toHaveProperty('sourceFolder')
      // 旧实现的 `{...row}` 把原型抹平 ⇒ 这两条同时钉住「裁键不以丢类型为代价」
      expect(item).toBeInstanceOf(AssetRow)
      expect(item.note).toBe('keep me')
      expect(item.assetId).toBe('asset_1')
      // 副本语义不因分支改变：原件一律不动
      expect(row).toHaveProperty('sourcePath')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('缺陷：Symbol 键承载的子对象也必须下钻裁键（旧实现只走 Object.keys）', async () => {
    const extra = Symbol('nikkisync.extra')
    const nested = {
      sourcePath: 'D:/game/photos/Photo_7.jpg',
      sourceFolder: 'D:/game/photos'
    }
    const rawPage = { items: [{ assetId: 'a1', [extra]: nested }], libraryRevision: 9 }
    const { deps } = createDependencies({}, { assetPage: rawPage })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    const page = (await manager.listAssets({ limit: 10 })) as {
      items: Array<Record<PropertyKey, unknown>>
    }
    // 既有断言一律用 JSON.stringify，而它对 Symbol 键不可见 ⇒ 这里改用 Reflect 探针
    const carried = Reflect.get(page.items[0]!, extra) as Record<string, unknown>
    expect(carried).not.toHaveProperty('sourcePath')
    expect(carried).not.toHaveProperty('sourceFolder')
    expect(nested).toHaveProperty('sourcePath') // 副本语义：原件仍带两键
  })

  it('边界：访问器返回的子树同样要裁——求值是 IPC 序列化本来就会做的事，不裁才是 fail-open', async () => {
    // 刻意钉住「不求值访问器」这条修法**不采纳**的理由：出 IPC 时结构化克隆自己会求值自有可枚举
    // 访问器并把返回值送出去，若本层为了避开求值而原样带过访问器，未裁键的子树就会照样漏给渲染层。
    let calls = 0
    const nested = {
      sourcePath: 'D:/game/photos/Photo_8.jpg',
      sourceFolder: 'D:/game/photos'
    }
    const rawPage = {
      items: [
        {
          assetId: 'a1',
          get derived(): unknown {
            calls += 1
            return nested
          }
        }
      ],
      libraryRevision: 9
    }
    const { deps } = createDependencies({}, { assetPage: rawPage })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    const page = (await manager.listAssets({ limit: 10 })) as {
      items: Array<Record<string, unknown>>
    }
    expect(JSON.stringify(page)).not.toContain('sourcePath')
    expect(page.items[0]?.derived).not.toHaveProperty('sourcePath')
    expect(page.items[0]?.derived).not.toHaveProperty('sourceFolder')
    expect(calls).toBeGreaterThan(0)
    expect(nested).toHaveProperty('sourcePath')
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

  it('teardown 顺序：metadataResolver.stop → server.stop → scanner.stop → dispose（阶段 6 前置生产者）', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.startSyncServer()
    await manager.stop()
    // 阶段 6：先停元数据生产者（它会在库上写 updateMetadata），再停传输，再停扫描，最后关库
    expect(calls.order).toEqual(['metadataResolver.stop', 'server.stop', 'scanner.stop', 'dispose'])
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

describe('createRuntimeManager 停止/重建竞态（阶段 4 审查修复）', () => {
  it('stop() 落在启动在途时不被吞：等在途启动落地后完成拆除', async () => {
    const { deps, calls } = createDependencies()
    let release: ((session: NikkiSyncRuntimeSession) => void) | undefined
    const session = createFakeSession(calls)
    // 让 createSession 挂起：start() 停在「会话未落地」的在途态
    deps.createSession = () =>
      new Promise<NikkiSyncRuntimeSession>((resolve) => {
        release = resolve
      })
    const manager = createRuntimeManager(deps)

    const starting = manager.start(DEFAULTS)
    // 在途启动期间停止：stop 必须等在途启动落地后再拆（而不是只把状态置 idle
    // 就返回——那会被在途 start 的收尾覆盖回 running，停止被静默吞掉）
    const stopping = manager.stop()
    release?.(session)
    await starting
    await stopping

    expect(manager.status().state).toBe('idle')
    expect(calls.dispose).toBe(1)
    expect(calls.order).toEqual(['metadataResolver.stop', 'server.stop', 'scanner.stop', 'dispose'])
  })

  it('换端口重建保留当前会话的游戏根（不丢回 auto-discovery）', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    // 用户经 scan 选过根：会话的 activeRoot 必须被后续重建沿用
    await manager.scan({ gameRoot: 'D:\\Games\\InfinityNikki' })
    expect(calls.createSession).toEqual(['<auto>', 'D:\\Games\\InfinityNikki'])

    await manager.startSyncServer({ port: 38138 })
    expect(calls.createSession).toEqual([
      '<auto>',
      'D:\\Games\\InfinityNikki',
      'D:\\Games\\InfinityNikki'
    ])
    // 新端口确实进了重建会话的构造期配置
    expect(calls.syncPorts[calls.syncPorts.length - 1]).toContain('38138')
    expect(manager.status().state).toBe('running')
  })
})

describe('阶段 6：元数据解析编排（拆除前置、有界驱动、故障隔离）', () => {
  it('C-10 全程不调上游 runtime.start()，并在关库之前停元数据服务', async () => {
    const { deps, calls } = createDependencies({}, { metadataResolverPresent: true })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.scan({})
    await manager.stop()
    // 上游 runtime.start() 把 scanner.start() 当硬前置并随后无条件启 LAN 服务（绑 0.0.0.0）；
    // 本仓的 LAN 服务是显式 opt-in 的，因此这条必须恒为 0（把「巧合」焊成契约）。
    expect(calls.runtimeStart).toBe(0)
    expect(calls.metadataStop).toBe(1)
    expect(calls.order.indexOf('metadataResolver.stop')).toBeLessThan(
      calls.order.indexOf('dispose')
    )
  })

  it('C-11 stopMetadataResolver 抛错时 scanner.stop 与 dispose 照常执行', async () => {
    const { deps, calls } = createDependencies(
      {},
      { metadataResolverPresent: true, metadataStopThrows: true }
    )
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.stop()
    expect(calls.metadataStop).toBe(1)
    expect(calls.scannerStop).toBe(1)
    expect(calls.dispose).toBe(1)
    // 失败只落 warn，且停止链本身照常收尾到 idle
    expect(
      calls.logs.some((entry) => entry.level === 'warn' && /metadata/i.test(entry.message))
    ).toBe(true)
    expect(manager.status().state).toBe('idle')
  })

  it('C-12 扫描成功后按 maxPasses 上界有界驱动（候选不收敛也不会无限轮询）', async () => {
    const { deps, calls } = createDependencies(
      {},
      { metadataResolverPresent: true, metadataRunOnceResults: [4] }
    )
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.scan({})
    // 驱动是后台任务：扫描返回不等于解析返回，故以后落盘的 lastDrive 作为收敛信号
    await expect.poll(() => manager.status().metadata?.lastDrive, { timeout: 2000 }).toBeTruthy()
    expect(calls.metadataRunOnce).toBe(DEFAULT_METADATA_MAX_PASSES)
    expect(manager.status().metadata?.lastDrive).toEqual({
      passes: DEFAULT_METADATA_MAX_PASSES,
      resolved: DEFAULT_METADATA_MAX_PASSES * 4,
      aborted: false,
      failed: false
    })
  })

  it('C-13 上游收敛（runOnce 返回 0）时只发起一轮', async () => {
    const { deps, calls } = createDependencies({}, { metadataResolverPresent: true })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.scan({})
    await expect.poll(() => manager.status().metadata?.lastDrive, { timeout: 2000 }).toBeTruthy()
    expect(calls.metadataRunOnce).toBe(1)
    expect(manager.status().metadata?.lastDrive?.resolved).toBe(0)
  })

  it('C-17 驱动不挂扫描返回路径，且拆除后不再发起下一轮（代次契约）', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let waited = false
    const { deps, calls } = createDependencies(
      {},
      {
        metadataResolverPresent: true,
        metadataRunOnceResults: [4],
        metadataRunOnceWait: async () => {
          if (waited) return
          waited = true
          await gate
        }
      }
    )
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.scan({})
    // 扫描已返回，但第一轮还卡在在途请求上：解析不得成为扫描的尾巴
    expect(calls.metadataRunOnce).toBe(1)
    expect(manager.status().metadata?.lastDrive).toBeUndefined()

    await manager.stop()
    release?.()
    // 放行后驱动发现代次已变 ⇒ 只收尾这一轮，绝不发起第二轮。
    // 收敛信号取日志而非 status：会话拆除后 status 不再带 metadata 段（没有会话就没有快照），
    // 这一档恰好也是期望行为——不能拿一个已关闭的库的计数继续对外称「当前状态」。
    await expect
      .poll(() => calls.logs.some((entry) => /metadata resolution:.*aborted/.test(entry.message)), {
        timeout: 2000
      })
      .toBe(true)
    expect(calls.metadataRunOnce).toBe(1)
  })

  it('C-12b 扫描失败 ⇒ 一轮都不发起（失败态不得产生出站请求）', async () => {
    const { deps, calls } = createDependencies(
      {},
      { metadataResolverPresent: true, fullScanThrows: true }
    )
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await expect(manager.scan({})).rejects.toThrow(installNotfoundMessage)
    expect(calls.metadataRunOnce).toBe(0)
    expect(calls.fullScan).toBe(1)
    // 扫描失败的状态迁移不受阶段 6 改动影响（degraded 判定仍按上游原文）
    expect(manager.status().state).toBe('degraded')
    expect(manager.status().metadata?.lastDrive).toBeUndefined()
  })

  it('C-14 未开启解析 ⇒ 会话没有驱动面，一轮都不发起', async () => {
    const { deps, calls } = createDependencies({}, { metadataResolverPresent: false })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.scan({})
    expect(calls.metadataRunOnce).toBe(0)
    expect(manager.status().metadata?.enabled).toBe(false)
    expect(manager.status().metadata?.lastDrive).toBeUndefined()
  })

  it('C-15 故障隔离：runOnce 抛错不外抛，扫描结果与状态原样给出', async () => {
    const { deps, calls } = createDependencies(
      {},
      { metadataResolverPresent: true, metadataRunOnceThrows: true }
    )
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    const result = (await manager.scan({})) as { scanId: string }
    // 扫描成功的返回值不得被解析故障改写（handler 逐字透传，已有断言锁定）
    expect(result.scanId).toBe('scan_full')
    expect(manager.status().state).toBe('running')
    await expect.poll(() => manager.status().metadata?.lastDrive, { timeout: 2000 }).toBeTruthy()
    expect(calls.metadataRunOnce).toBe(1)
    expect(manager.status().metadata?.lastDrive?.failed).toBe(true)
  })

  it('C-16 状态快照带端点与上游聚合计数，未开启时同样如实给计数', async () => {
    const { deps, calls } = createDependencies({}, { metadataResolverPresent: false })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    const snapshot = manager.status()
    expect(snapshot.metadata?.enabled).toBe(false)
    expect(snapshot.metadata?.endpoint).toBe(NUAN5_METADATA_ENDPOINT)
    expect(snapshot.metadata?.counters).toMatchObject({
      ordinaryPhotos: 25,
      withCompleteEnvelope: 25,
      resolved: 0,
      withCamera: 0
    })
    // 计数在建会话时取一次即可：不得每次 status() 都跑一遍聚合 SQL
    const before = calls.metadataDiagnostics
    manager.status()
    manager.status()
    expect(calls.metadataDiagnostics).toBe(before)
  })
})

describe('K1：启动阶段观测与缓存解码元数据接线', () => {
  it('K1-1 正常启动只记录真实发生的阶段：[scanner, runtime-ready, cached-metadata]', async () => {
    const { deps, calls } = createDependencies(
      {},
      { cachedMetadataPresent: true, cachedMetadataRunOnceResults: [3] }
    )
    const manager = createRuntimeManager(deps)
    const status = await manager.start(DEFAULTS)
    expect(status.state).toBe('running')
    expect(status.startupStages?.map((item) => item.stage)).toEqual([
      'scanner',
      'runtime-ready',
      'cached-metadata'
    ])
    // 有闭包 ⇒ 启动触发点恰好驱动一次
    expect(calls.cachedMetadataRunOnce).toBe(1)
    expect(calls.logs.some((item) => item.message.includes('cached metadata'))).toBe(true)
  })

  it('K1-2 lan-listen 仅在 server.start 成功后追加，重复 startSyncServer 不重复记', async () => {
    const { deps } = createDependencies({}, { cachedMetadataPresent: true })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.startSyncServer()
    await manager.startSyncServer()
    const stages = manager.status().startupStages?.map((item) => item.stage)
    expect(stages).toContain('lan-listen')
    expect(stages?.filter((stage) => stage === 'lan-listen')).toHaveLength(1)
  })

  it('K1-3 未发生的阶段永不出现：degraded（无游戏目录）启动后阶段为空', async () => {
    const { deps } = createDependencies({}, { startError: 'notfound' })
    const manager = createRuntimeManager(deps)
    const status = await manager.start(DEFAULTS)
    expect(status.state).toBe('degraded')
    expect(status.startupStages).toBeUndefined()
  })

  it('K1-4 启动中断时已发生阶段保留：cachedMetadataRunOnce 抛错 ⇒ warn 日志、scanner/runtime-ready 保留', async () => {
    const { deps, calls } = createDependencies(
      {},
      { cachedMetadataPresent: true, cachedMetadataRunOnceThrows: true }
    )
    const manager = createRuntimeManager(deps)
    const status = await manager.start(DEFAULTS)
    // 故障不外抛、不改判启动结果；「runOnce 完成」才记阶段 ⇒ cached-metadata 不出现
    expect(status.state).toBe('running')
    expect(status.startupStages?.map((item) => item.stage)).toEqual(['scanner', 'runtime-ready'])
    expect(
      calls.logs.some((item) => item.level === 'warn' && item.message.includes('SQLITE_BUSY'))
    ).toBe(true)
  })

  it('K1-5 无闭包零调用：深入口缺席（老会话）时不驱动、不记阶段', async () => {
    const { deps, calls } = createDependencies({}, { cachedMetadataPresent: false })
    const manager = createRuntimeManager(deps)
    const status = await manager.start(DEFAULTS)
    await manager.scan({})
    expect(calls.cachedMetadataRunOnce).toBe(0)
    expect(status.startupStages?.map((item) => item.stage)).toEqual(['scanner', 'runtime-ready'])
  })

  it('K1-6 扫描成功后各驱动一次（启动+扫描共两次）；扫描失败不驱动', async () => {
    const { deps, calls } = createDependencies(
      {},
      { cachedMetadataPresent: true, cachedMetadataRunOnceResults: [1, 2, 0] }
    )
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    expect(calls.cachedMetadataRunOnce).toBe(1)
    await manager.scan({})
    expect(calls.cachedMetadataRunOnce).toBe(2)

    const failed = createDependencies({}, { cachedMetadataPresent: true, fullScanThrows: true })
    const failedManager = createRuntimeManager(failed.deps)
    await failedManager.start(DEFAULTS)
    const before = failed.calls.cachedMetadataRunOnce
    await expect(failedManager.scan({})).rejects.toThrow(installNotfoundMessage)
    expect(failed.calls.cachedMetadataRunOnce).toBe(before)
  })

  it('K1-7 teardown 清空阶段记录：stop() 后 startupStages 缺省', async () => {
    const { deps } = createDependencies({}, { cachedMetadataPresent: true })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    expect(manager.status().startupStages).toBeTruthy()
    await manager.stop()
    expect(manager.status().startupStages).toBeUndefined()
  })
})

describe('K2：元数据在线同意读写', () => {
  it('K2-m1 会话无同意面（解析关闭）⇒ 读写都抛 unavailable（handler 映射 PRECONDITION_FAILED）', async () => {
    const { deps } = createDependencies({}, { metadataConsentPresent: false })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    expect(() => manager.metadataConsentState()).toThrow(/unavailable/)
    expect(() => manager.setMetadataConsent(true, '2026-10-13.1')).toThrow(/unavailable/)
  })

  it('K2-m2 有同意面：state 原样透传；setEnabled 下传 (enabled, policyVersion)', async () => {
    const { deps, calls } = createDependencies({}, { metadataConsentPresent: true })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    const state = manager.metadataConsentState()
    expect(state).toMatchObject({
      enabled: false,
      policyVersion: '2026-10-13.1',
      recipients: [
        {
          name: 'Nuan5 metadata service',
          endpoint: 'https://nuan5.pro/api/decode-photo2'
        }
      ]
    })
    manager.setMetadataConsent(true, '2026-10-13.1')
    expect(calls.metadataConsentSet).toEqual([{ enabled: true, policyVersion: '2026-10-13.1' }])
  })
})

describe('K3：游戏版本推断', () => {
  it('K3-m1 未启动即查询拒绝（不把空结果伪装成正常）', async () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    await expect(manager.resolveGameVersion('2025-04-01T00:00:00.000Z')).rejects.toThrow(
      /not ready/
    )
  })

  it('K3-m2 会话在位：capturedAt 原样下传、结果逐字透传；缺省入参同样放行', async () => {
    const { deps, calls } = createDependencies(
      {},
      { gameVersionResult: { version: '1.4', effectiveAt: '2025-03-26T03:00:00.000Z' } }
    )
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await expect(manager.resolveGameVersion('2025-04-01T00:00:00.000Z')).resolves.toEqual({
      version: '1.4',
      effectiveAt: '2025-03-26T03:00:00.000Z'
    })
    // 缺省 capturedAt = 交给上游判「无法推断」，不在本层拦截
    await manager.resolveGameVersion(undefined)
    expect(calls.resolveGameVersion).toEqual(['2025-04-01T00:00:00.000Z', undefined])
  })
})

describe('K4：连接诊断段（观测面，纯聚合既有状态）', () => {
  it('K4-m1 运行中：syncStatus 附带 diagnostics（指纹尾 8 位、设备数、监听地址）', async () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.startSyncServer()
    const diagnostics = manager.syncStatus().diagnostics as {
      running: boolean
      host: string
      port: number
      secure?: boolean
      pairedDeviceCount?: number
      tlsFingerprintTail8?: string
      updatedAt: string
    }
    expect(diagnostics.running).toBe(true)
    expect(diagnostics.secure).toBe(true)
    expect(diagnostics.pairedDeviceCount).toBe(1)
    // 假会话指纹为 'a'.repeat(64) ⇒ 尾 8 位摘要 'aaaaaaaa'
    expect(diagnostics.tlsFingerprintTail8).toBe('a'.repeat(8))
    expect(Number.isFinite(Date.parse(diagnostics.updatedAt))).toBe(true)
  })

  it('K4-m2 无会话：diagnostics 同样给出（running=false、回落配置默认端口，不虚构字段）', () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    const diagnostics = manager.syncStatus().diagnostics as {
      running: boolean
      port: number
      secure?: boolean
      tlsFingerprintTail8?: string
    }
    expect(diagnostics.running).toBe(false)
    expect(diagnostics.port).toBe(28080)
    expect(diagnostics.secure).toBeUndefined()
    expect(diagnostics.tlsFingerprintTail8).toBeUndefined()
  })
})

describe('K5：多 host 配对', () => {
  it('K5-m1 默认态（未注入 resolvePairingHosts）：pairingUri 单参调用，NS1 逐字节不变', async () => {
    const { deps, calls } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.startSyncServer()
    const code = await manager.pairingCode()
    expect(code.content.startsWith('NS1|')).toBe(true)
    expect(code.content.split('|')).toHaveLength(7)
    expect(code.hosts).toBeUndefined()
    // 单参形态：hosts 键不下传（与关闭前的行为逐字节一致——第三方旧客户端回归锚）
    expect(calls.pairingUriArgs).toEqual([
      { host: '127.0.0.1', ttlMs: undefined, hosts: undefined }
    ])
  })

  it('K5-m2 开启态（注入 resolvePairingHosts）：三参调用且 hosts 回填进配对码', async () => {
    const { deps, calls } = createDependencies()
    deps.resolvePairingHosts = () => ['192.168.1.10', '192.168.1.11']
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.startSyncServer()
    const code = await manager.pairingCode()
    expect(code.content.startsWith('nikki-sync://pair?')).toBe(true)
    expect(code.hosts).toEqual(['127.0.0.1', '192.168.1.10', '192.168.1.11'])
    expect(calls.pairingUriArgs[0].hosts).toEqual(['192.168.1.10', '192.168.1.11'])
  })

  it('K5-m3 开启态但解析结果为空（无网卡）：回落单参 NS1，不产出空 hosts 新格式', async () => {
    const { deps } = createDependencies()
    deps.resolvePairingHosts = () => []
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.startSyncServer()
    const code = await manager.pairingCode()
    expect(code.content.startsWith('NS1|')).toBe(true)
    expect(code.hosts).toBeUndefined()
  })
})

describe('K6：额外照片目录五方法', () => {
  it('K6-m1 会话无该面（未给文件/老链接）⇒ 五方法都抛 unavailable（handler 映射 PRECONDITION）', async () => {
    const { deps } = createDependencies({}, { extraDirectoriesPresent: false })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    expect(() => manager.extraDirectoriesState()).toThrow(/unavailable/)
    await expect(manager.inspectExtraDirectory('D:/X')).rejects.toThrow(/unavailable/)
    await expect(manager.addExtraDirectory('p1')).rejects.toThrow(/unavailable/)
    await expect(manager.removeExtraDirectory('dir_1')).rejects.toThrow(/unavailable/)
    await expect(manager.rescanExtraDirectories()).rejects.toThrow(/unavailable/)
  })

  it('K6-m2 有该面：五个调用逐字透传（state/inspect(path)/add(id)/remove(id)/rescan）', async () => {
    const { deps } = createDependencies({}, { extraDirectoriesPresent: true })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    expect(manager.extraDirectoriesState()).toMatchObject({
      directories: [{ id: 'dir_1', path: 'D:/ExtraPhotos', mode: 'native' }]
    })
    await expect(manager.inspectExtraDirectory('D:/ExtraPhotos')).resolves.toMatchObject({
      id: 'p1',
      selected: 'D:/ExtraPhotos'
    })
    await expect(manager.addExtraDirectory('p1')).resolves.toEqual({ added: 'p1' })
    await expect(manager.removeExtraDirectory('dir_1')).resolves.toEqual({ removed: 'dir_1' })
    await expect(manager.rescanExtraDirectories()).resolves.toEqual({ rescanned: true })
  })
})

describe('K7：扫描诊断观测面（纯计数，无路径/UID/错误原文）', () => {
  it('K7-m1 扫描完成后 status 带 scanDiagnostics 段（计数快照逐字透传）；未扫描时缺省', async () => {
    const { deps } = createDependencies(
      {},
      {
        scanDiagnosticsResult: {
          lastScan: { filesObserved: 31, resourcesAccepted: 25, errorCount: 1 },
          timestamp: '2026-10-25T09:00:00.000Z',
          status: 'running',
          installationFound: true,
          scanRootCount: 2,
          automaticRootCount: 1,
          extraRootCount: 1
        }
      }
    )
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    // 未扫描：即使会话在位，诊断段也缺省（不拿旧值伪装当前状态）
    expect(manager.status().scanDiagnostics).toBeUndefined()
    await manager.scan({})
    const diagnostics = manager.status().scanDiagnostics as { scanRootCount: number }
    expect(diagnostics.scanRootCount).toBe(2)
    expect(manager.status().scanDiagnostics).toMatchObject({
      lastScan: { filesObserved: 31, errorCount: 1 }
    })
  })

  it('K7-m2 会话未挂诊断面（老链接）⇒ 扫描成功也不带段、不抛', async () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.scan({})
    expect(manager.status().scanDiagnostics).toBeUndefined()
  })
})

describe('K8-c：整理队列（批量删除）三方法——透传、中文剔除、错误上抛', () => {
  const QUEUE_ROWS = [
    {
      id: 'del_1aaaaaaaaaaaaaaa',
      assetId: 'asset_1',
      state: 'pending',
      message: '等待电脑确认',
      online: true,
      files: [{ name: 'a.jpg', size: 123, folder: 'photos' }],
      count: 1
    },
    {
      id: 'del_2aaaaaaaaaaaaaaa',
      assetId: 'asset_2',
      state: 'recycled',
      message: '已移入电脑回收站，可从回收站恢复',
      online: false,
      files: [{ name: 'b.jpg', size: 456, folder: 'photos' }],
      count: 1
    }
  ]

  function deletionsPlan(): FakeSessionPlan['deletionsPlan'] {
    return {
      rows: QUEUE_ROWS.map((row) => ({ ...row })),
      activity: {
        catalogPasses: 1,
        catalogImages: 3,
        prepared: 2,
        recycled: 1,
        queued: 0,
        active: 0
      }
    }
  }

  it('K8-c-1 organizerStatus：list() 行剔除中文 message 后透传 + activity() 计数', async () => {
    const { deps } = createDependencies({}, { deletionsPlan: deletionsPlan() })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    expect(manager.organizerStatus()).toEqual({
      items: [
        {
          id: 'del_1aaaaaaaaaaaaaaa',
          assetId: 'asset_1',
          state: 'pending',
          online: true,
          files: [{ name: 'a.jpg', size: 123, folder: 'photos' }],
          count: 1
        },
        {
          id: 'del_2aaaaaaaaaaaaaaa',
          assetId: 'asset_2',
          state: 'recycled',
          online: false,
          files: [{ name: 'b.jpg', size: 456, folder: 'photos' }],
          count: 1
        }
      ],
      activity: {
        catalogPasses: 1,
        catalogImages: 3,
        prepared: 2,
        recycled: 1,
        queued: 0,
        active: 0
      }
    })
  })

  it('K8-c-2 organizerDecide：参数逐字透传，返回列表同样剔除 message（批准与拒绝两支）', async () => {
    const { deps, calls } = createDependencies({}, { deletionsPlan: deletionsPlan() })
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await manager.organizerDecide('del_1aaaaaaaaaaaaaaa', true)
    await manager.organizerDecide('del_2aaaaaaaaaaaaaaa', false)
    expect(calls.organizerDecide).toEqual([
      { id: 'del_1aaaaaaaaaaaaaaa', approve: true },
      { id: 'del_2aaaaaaaaaaaaaaa', approve: false }
    ])
    const list = (await manager.organizerDecide('del_1aaaaaaaaaaaaaaa', true)) as Array<
      Record<string, unknown>
    >
    expect(list).toHaveLength(2)
    for (const row of list) expect(row).not.toHaveProperty('message')
  })

  it('K8-c-3 organizerApproveMany：ids 逐字透传，返回 {items 剔除, approved, skipped}', async () => {
    const { deps, calls } = createDependencies(
      {},
      {
        deletionsPlan: {
          ...deletionsPlan(),
          approveManyResult: {
            items: QUEUE_ROWS.map((row) => ({ ...row })),
            approved: 1,
            skipped: 1
          }
        }
      }
    )
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    const ids = ['del_1aaaaaaaaaaaaaaa', 'del_2aaaaaaaaaaaaaaa']
    const result = (await manager.organizerApproveMany(ids)) as {
      items: Array<Record<string, unknown>>
      approved: number
      skipped: number
    }
    expect(calls.organizerApproveMany).toEqual([ids])
    expect(result.approved).toBe(1)
    expect(result.skipped).toBe(1)
    for (const row of result.items) expect(row).not.toHaveProperty('message')
  })

  it('K8-c-4 上游错误原样上抛（not_pending / stopping），manager 不吞不改写', async () => {
    const { deps } = createDependencies(
      {},
      {
        deletionsPlan: {
          ...deletionsPlan(),
          decideError: 'not_pending',
          approveManyError: 'stopping'
        }
      }
    )
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    await expect(manager.organizerDecide('del_1aaaaaaaaaaaaaaa', true)).rejects.toThrow(
      'not_pending'
    )
    await expect(manager.organizerApproveMany(['del_1aaaaaaaaaaaaaaa'])).rejects.toThrow('stopping')
  })

  it('K8-c-5 会话未挂队列面 ⇒ unavailable 语义错误（handler 映射 PRECONDITION_FAILED）', async () => {
    const { deps } = createDependencies()
    const manager = createRuntimeManager(deps)
    await manager.start(DEFAULTS)
    expect(() => manager.organizerStatus()).toThrow(/unavailable/)
    await expect(manager.organizerDecide('del_1aaaaaaaaaaaaaaa', true)).rejects.toThrow(
      /unavailable/
    )
    await expect(manager.organizerApproveMany(['del_1aaaaaaaaaaaaaaa'])).rejects.toThrow(
      /unavailable/
    )
  })
})
