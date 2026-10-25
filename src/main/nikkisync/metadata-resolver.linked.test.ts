import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { hasNikkiSyncLink } from './runtime-loader'
import { createRuntimeSession, loadRuntimeSurface, type RuntimeSurface } from './runtime-facade'
import { DEFAULT_METADATA_BATCH_SIZE } from './metadata-resolver-driver'
import type { NikkiSyncMetadataCounters, NikkiSyncRuntimeSession } from './runtime-types'

/**
 * 阶段 6：元数据解析的链接态端到端用例。
 *
 * 与假面对象用例的分工：`metadata-resolver-driver.test.ts` 测本仓折算逻辑，
 * `runtime-facade.test.ts` 测注入形状；这里验证**真实上游**确实按那条配置键
 * 构造服务、`runOnce()` 真的能落库并推进 revision / journal / 诊断计数。
 *
 * 零出站请求：通过 `createRuntimeSession` 已有的 `preloadedSurface` 测试缝
 * 把上游 `Nuan5CompatibleResolver` 换成假解析器，其余全部走真实产物。
 * 未建链时整件 skip（`hasNikkiSyncLink` 按包内 package.json 判定，不用目录存在判定）。
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const LINKED = hasNikkiSyncLink(projectRoot)
const suite = LINKED ? describe : describe.skip

/** 与本机取证同形的两台“相机”：25 张静图带完整信封，6 张实况连 raw 都没有。 */
const PHOTO_COUNT = 25
const MOTION_COUNT = 6

let fixtureRoot = ''
let session: NikkiSyncRuntimeSession | undefined
let surface: RuntimeSurface | undefined

/** 假解析器：返回值逐字对齐 `mapDecodedPhoto` 的形状（clothes 是裸数字数组）。 */
const fixtureResolver = {
  id: 'fixture-resolver',
  version: '1',
  resolve: async () => ({
    provider: 'fixture-resolver',
    metadata: {
      camera: { focalLength: 50, apertureSection: 2.8 },
      // 上游实测：NUAN5 的 clothes 是裸 id 数组，不是带 name 的对象
      dressing: { clothes: [101, 102] }
    }
  })
}

/** 替换上游深入口导出的构造器；记下本仓下传的配置以便断言端点确实显式给了。 */
let resolverConfigSeen: Record<string, unknown> | undefined
class FakeNuan5Resolver {
  constructor(config?: Record<string, unknown>) {
    resolverConfigSeen = config
    // 构造函数返回对象即取代 this ⇒ 上游拿到的就是假解析器实例
    return fixtureResolver as unknown as FakeNuan5Resolver
  }
}

function envelopeJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    identity: { uid: '10001' },
    capture: {},
    camera: {},
    raw: {
      nativeParamToken: 'dG9rZW4tdG9rZW4tdG9rZW4tdG9rZW4tMTIzNDU=',
      nativeParamPayload: 'cGF5bG9hZC1ieXRlcy1mb3ItdGhlLWVudmVsb3Bl',
      nativeParamNuan5Md5: '0'.repeat(32)
    }
  })
}

/**
 * 直接对 NikkiSync 自有库播种（**不** import 上游仓储：`@nikkisync/*` 不是声明依赖，
 * 静态导入会被 eslint 双层护栏拦下，且这里只需要 INSERT 三列）。
 */
function seedAssets(database: NikkiSyncRuntimeSession['runtime']['database']): void {
  const insert = database.connection.prepare(
    'INSERT INTO assets (asset_id, asset_type, asset_state, uid, captured_at, discovered_at, ' +
      'metadata_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'
  )
  for (let index = 0; index < PHOTO_COUNT; index += 1) {
    const stamp = `2026-10-${String(1 + (index % 28)).padStart(2, '0')}T00:00:00.000Z`
    insert.run(
      `photo/${index}`,
      'photo',
      'ready',
      '10001',
      stamp,
      stamp,
      envelopeJson(),
      stamp,
      stamp
    )
  }
  for (let index = 0; index < MOTION_COUNT; index += 1) {
    const stamp = `2026-10-0${1 + (index % 9)}T12:00:00.000Z`
    insert.run(
      `motion/${index}`,
      'motion_photo',
      'ready',
      '10001',
      stamp,
      stamp,
      '{}',
      stamp,
      stamp
    )
  }
}

beforeAll(async () => {
  if (!LINKED) return
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nikkisync-metadata-'))
  const databaseFile = path.join(fixtureRoot, 'nikkisync.db')
  // 用真实装载面，只把 Nuan5 那个深入口换成假解析器 ⇒ 组装链其余部分仍是真产物
  const realSurface = await loadRuntimeSurface(projectRoot)
  surface = {
    ...realSurface,
    nuan5Resolver: {
      Nuan5CompatibleResolver: FakeNuan5Resolver
    } as unknown as RuntimeSurface['nuan5Resolver']
  }
  session = await createRuntimeSession(
    {
      databaseFile,
      watcher: false,
      projectRoot,
      metadataResolverEnabled: true
    },
    surface
  )
  seedAssets(session.runtime.database)
})

afterAll(async () => {
  if (session) {
    // 拆除顺序与生产链一致：先停解析、再停扫描、最后关库（关库后 WAL 需 checkpoint）
    session.stopMetadataResolver()
    await session.scanner.stop().catch(() => undefined)
    session.dispose()
    session = undefined
  }
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

suite('阶段 6 元数据解析链接态', () => {
  it('注入缝：给了 metadataResolver 配置键，上游确实构造了解析服务', () => {
    const runtime = session?.runtime as unknown as { metadataResolver?: unknown }
    expect(runtime?.metadataResolver).toBeDefined()
    expect(typeof session?.metadataRunOnce).toBe('function')
    expect(session?.metadataDiagnostics).toBeTypeOf('function')
    // 端点由本仓显式下传（不吃上游默认值），设置页披露与实际出口才可能同源
    expect(resolverConfigSeen).toEqual({ endpoint: 'https://nuan5.pro/api/decode-photo2' })
  })

  it('未开启时上游不构造服务，本仓的 stop 退化为 no-op', async () => {
    const offSession = await createRuntimeSession(
      {
        databaseFile: path.join(fixtureRoot, 'off.db'),
        watcher: false,
        projectRoot,
        metadataResolverEnabled: false
      },
      surface
    )
    try {
      const runtime = offSession.runtime as unknown as { metadataResolver?: unknown }
      expect(runtime.metadataResolver).toBeUndefined()
      expect(offSession.metadataRunOnce).toBeUndefined()
      expect(() => offSession.stopMetadataResolver()).not.toThrow()
    } finally {
      offSession.stopMetadataResolver()
      await offSession.scanner.stop().catch(() => undefined)
      offSession.dispose()
    }
  })

  it('runOnce 逐批解析：只有带原生信封的静图入队，实况资产始终不被写', async () => {
    const runOnce = session?.metadataRunOnce
    expect(runOnce).toBeTypeOf('function')
    const counters = (): NikkiSyncMetadataCounters =>
      session?.metadataDiagnostics() as NikkiSyncMetadataCounters

    // 播种后的起点：全部未解析
    expect(counters().withCompleteEnvelope).toBe(PHOTO_COUNT)
    expect(counters().resolved).toBe(0)
    expect(counters().withCamera).toBe(0)

    let total = 0
    let rounds = 0
    // 上游每轮上限 = batchSize（本仓下传 4），因此 25 条需要多轮；
    // 这里的轮次上界只用于防失控，不代表生产编排的 maxPasses
    while (total < PHOTO_COUNT && rounds < 40) {
      const resolved = await runOnce?.()
      if (!resolved) break
      total += resolved
      rounds += 1
    }
    expect(total).toBe(PHOTO_COUNT)
    expect(rounds).toBe(Math.ceil(PHOTO_COUNT / DEFAULT_METADATA_BATCH_SIZE))

    const after = counters()
    expect(after.resolved).toBe(PHOTO_COUNT)
    expect(after.withCamera).toBe(PHOTO_COUNT)
    expect(after.failed).toBe(0)
    expect(after.motionPhotos).toBe(MOTION_COUNT)
    expect(after.pending).toBe(0)

    // 实况资产逐字未动：候选 SQL 要求 $.raw.nativeParamToken 非空，它们根本不入队
    const motion = session?.runtime.database.connection
      .prepare(
        "SELECT asset_id, metadata_json, revision FROM assets WHERE asset_type = 'motion_photo' ORDER BY asset_id"
      )
      .all() as Array<{ asset_id: string; metadata_json: string; revision: number }>
    expect(motion).toHaveLength(MOTION_COUNT)
    for (const row of motion) {
      expect(JSON.parse(row.metadata_json)).toEqual({})
      expect(row.revision).toBe(0)
    }
  })

  it('每解析一条就是一条 asset.updated，revision 与 library_revision 同步推进', () => {
    const database = session?.runtime.database
    const journal = database?.connection
      .prepare("SELECT COUNT(*) AS c FROM change_journal WHERE event_type = 'asset.updated'")
      .get() as { c: number }
    expect(journal.c).toBe(PHOTO_COUNT)
    const library = database?.connection
      .prepare('SELECT library_revision FROM library_state WHERE id = 1')
      .get() as { library_revision: number }
    // 播种时 0，逐条 updateMetadata 各推进 1
    expect(library.library_revision).toBe(PHOTO_COUNT)
    const bumped = database?.connection
      .prepare('SELECT COUNT(*) AS c FROM assets WHERE asset_type = ? AND revision > 0')
      .get('photo') as { c: number }
    expect(bumped.c).toBe(PHOTO_COUNT)
  })

  it('解析结果经上游行映射可见：详情面给出 camera 值，但 clothes 仍是裸 id（阶段 6b 才可用）', async () => {
    const detail = (await session?.queries.getAssetDetail('photo/0')) as {
      asset?: { metadata?: { camera?: Record<string, unknown>; dressing?: unknown } }
      metadata?: { camera?: Record<string, unknown>; dressing?: unknown }
    }
    const metadata = detail.asset?.metadata ?? detail.metadata
    expect(metadata?.camera).toMatchObject({ focalLength: 50 })
    // 校正 2 的实链证据：dressing.clothes 保持数组原样，元素是数字而非带 name 的对象
    expect(JSON.parse(JSON.stringify(metadata?.dressing ?? {}))).toEqual({ clothes: [101, 102] })

    const clothing = (await session?.queries.searchClothing('101')) as {
      query?: string
      items?: unknown[]
    }
    const suits = (await session?.queries.searchSuits('101')) as {
      query?: string
      items?: unknown[]
    }
    // 先要求形状本身在：上游返回 `{ query, items }`，形状漂移必须让本用例红，
    // 而不是被 `?? []` 兜成一个静默通过的弱断言
    expect(clothing.query).toBe('101')
    expect(suits.query).toBe('101')
    // 上游两个索引都以 `objectOf(clothing)` 起判，裸数字被直接丢弃 ⇒ 搜索仍为空。
    // 这条断言把「resolver 单独接上并不能让搜索可用」钉成回归，防止后来者误判已完成。
    expect(clothing.items).toEqual([])
    expect(suits.items).toEqual([])
  })

  it('stopMetadataResolver 幂等：重复调用不抛（上游对 undefined timer 安全）', () => {
    expect(() => session?.stopMetadataResolver()).not.toThrow()
    expect(() => session?.stopMetadataResolver()).not.toThrow()
  })

  // ---------------------------------------------------------------- K2：在线解析同意

  it('K2 真实同意门：未同意 ⇒ runOnce 零出站、失败归入 failureCategories；同意文件持久化后新会话可解析', async () => {
    expect(session).toBeDefined()
    // 独立假解析器：resolve 被调一次就能观测「是否真的出站」
    let fakeResolveCalls = 0
    const countingFixture = {
      id: 'counting-fixture-resolver',
      version: '1',
      resolve: async () => {
        fakeResolveCalls += 1
        return {
          provider: 'counting-fixture-resolver',
          metadata: { camera: { focalLength: 50 }, dressing: { clothes: [101] } }
        }
      }
    }
    class CountingResolverCtor {
      constructor() {
        return countingFixture as unknown as CountingResolverCtor
      }
    }
    const consentSurface = {
      ...surface,
      nuan5Resolver: {
        Nuan5CompatibleResolver: CountingResolverCtor
      } as unknown as RuntimeSurface['nuan5Resolver']
    }
    const consentFile = path.join(fixtureRoot, 'metadata-online-consent.json')

    // ① 未同意（initiallyDisabled + 无同意文件）：runOnce 零出站，失败计数归入诊断
    const denied = await createRuntimeSession(
      {
        databaseFile: path.join(fixtureRoot, 'consent-denied.db'),
        watcher: false,
        projectRoot,
        metadataResolverEnabled: true,
        consentFile
      },
      consentSurface
    )
    try {
      expect(denied.metadataConsent).toBeDefined()
      expect(denied.metadataConsent?.state().enabled).toBe(false)
      seedAssets(denied.runtime.database)
      const beforeCalls = fakeResolveCalls
      const resolved = await denied.metadataRunOnce?.()
      expect(resolved).toBe(0)
      expect(fakeResolveCalls).toBe(beforeCalls)
      const counters = denied.metadataDiagnostics() as NikkiSyncMetadataCounters
      expect(counters.failed).toBeGreaterThan(0)
      expect(counters.resolved).toBe(0)
      expect(Object.keys(counters.failureCategories).length).toBeGreaterThan(0)

      // ② 同意写入磁盘（policyVersion 取自 state，与 UI「携带页面展示版本提交」同口径）
      denied.metadataConsent?.setEnabled(true, denied.metadataConsent?.state().policyVersion)
      expect(denied.metadataConsent?.state().enabled).toBe(true)
      expect(fs.existsSync(consentFile)).toBe(true)
    } finally {
      denied.stopMetadataResolver()
      await denied.scanner.stop().catch(() => undefined)
      denied.dispose()
    }

    // ③ 同意文件跨会话生效：新会话（新库、同一 consentFile）读回已同意 ⇒ 可解析
    const granted = await createRuntimeSession(
      {
        databaseFile: path.join(fixtureRoot, 'consent-granted.db'),
        watcher: false,
        projectRoot,
        metadataResolverEnabled: true,
        consentFile
      },
      consentSurface
    )
    try {
      expect(granted.metadataConsent?.state().enabled).toBe(true)
      seedAssets(granted.runtime.database)
      const beforeCalls = fakeResolveCalls
      let total = 0
      for (let round = 0; round < 40 && total < PHOTO_COUNT; round += 1) {
        const resolved = await granted.metadataRunOnce?.()
        if (!resolved) break
        total += resolved
      }
      expect(total).toBe(PHOTO_COUNT)
      expect(fakeResolveCalls).toBeGreaterThan(beforeCalls)
      const counters = granted.metadataDiagnostics() as NikkiSyncMetadataCounters
      expect(counters.resolved).toBe(PHOTO_COUNT)
    } finally {
      granted.stopMetadataResolver()
      await granted.scanner.stop().catch(() => undefined)
      granted.dispose()
    }
  })
})
