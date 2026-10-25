import { describe, expect, it } from 'vitest'

import {
  LOOPBACK_FALLBACK_HOST,
  PORT_IN_USE_MARKER,
  SYNC_JOURNAL_POLL_MS,
  SYNC_SERVER_DEFAULT_HOST,
  SYNC_SERVER_DEFAULT_MDNS,
  SYNC_SERVER_DEFAULT_NAME,
  SYNC_SERVER_DEFAULT_PORT,
  buildSyncStatusSnapshot,
  classifySyncStartError,
  embeddedServerConfig,
  isPortInUseError,
  mapPairedDeviceRow,
  normalizeJournalPollMs,
  normalizeSyncPort,
  parsePairingUri,
  resolveSyncServerConfig
} from './sync-server-view'
import type { NikkiSyncSyncServerConfig } from './runtime-types'

/**
 * 同步服务视图纯函数单测（整合阶段 3 · T-B）。
 * 不依赖 @nikkisync 链接：端口/mdns 归一化、错误归类、设备行收敛、状态快照与
 * 配对串解析都在这里闭环，集成侧只证明上游真按这些形状工作。
 */

const baseConfig: NikkiSyncSyncServerConfig = {
  host: SYNC_SERVER_DEFAULT_HOST,
  port: SYNC_SERVER_DEFAULT_PORT,
  mdns: SYNC_SERVER_DEFAULT_MDNS,
  name: SYNC_SERVER_DEFAULT_NAME
}

/** 64 位小写 hex 指纹（上游 `X509Certificate.fingerprint256` 去冒号转小写后的形态）。 */
const fingerprint = 'a'.repeat(64)

describe('normalizeSyncPort', () => {
  it('正常：整数端口原样返回，0 表示交给系统分配（合法）', () => {
    expect(normalizeSyncPort(28080)).toBe(28080)
    expect(normalizeSyncPort(1)).toBe(1)
    expect(normalizeSyncPort(65535)).toBe(65535)
    expect(normalizeSyncPort(0)).toBe(0)
  })

  it('异常：非数字 / 非整数 / NaN 一律回落默认', () => {
    expect(normalizeSyncPort(undefined)).toBe(SYNC_SERVER_DEFAULT_PORT)
    expect(normalizeSyncPort(null)).toBe(SYNC_SERVER_DEFAULT_PORT)
    expect(normalizeSyncPort(NaN)).toBe(SYNC_SERVER_DEFAULT_PORT)
    expect(normalizeSyncPort(28080.5)).toBe(SYNC_SERVER_DEFAULT_PORT)
    expect(normalizeSyncPort('abc')).toBe(SYNC_SERVER_DEFAULT_PORT)
    expect(normalizeSyncPort({})).toBe(SYNC_SERVER_DEFAULT_PORT)
  })

  it('边界：负数与超 65535 拒绝；字符串数字接受（设置项历史形态）', () => {
    expect(normalizeSyncPort(-1)).toBe(SYNC_SERVER_DEFAULT_PORT)
    expect(normalizeSyncPort(65536)).toBe(SYNC_SERVER_DEFAULT_PORT)
    expect(normalizeSyncPort('28081')).toBe(28081)
    expect(normalizeSyncPort('  28081  ')).toBe(28081)
    expect(normalizeSyncPort(80, 443)).toBe(80)
    expect(normalizeSyncPort('nope', 443)).toBe(443)
  })
})

describe('normalizeJournalPollMs', () => {
  it('只有正整数生效，其余回落上游默认 250ms', () => {
    expect(normalizeJournalPollMs(20)).toBe(20)
    expect(normalizeJournalPollMs(undefined)).toBe(SYNC_JOURNAL_POLL_MS)
    expect(normalizeJournalPollMs(0)).toBe(SYNC_JOURNAL_POLL_MS)
    expect(normalizeJournalPollMs(-1)).toBe(SYNC_JOURNAL_POLL_MS)
    expect(normalizeJournalPollMs('1000')).toBe(1000)
  })
})

describe('resolveSyncServerConfig / embeddedServerConfig', () => {
  it('默认值：端口/绑定对齐上游桌面版，mDNS 刻意默认关（上游自激回环缺陷，见常量注释）', () => {
    const config = resolveSyncServerConfig()
    expect(config).toEqual({
      name: 'Meow Star Map',
      host: '0.0.0.0',
      port: 28080,
      mdns: false,
      journalPollMs: 250
    })
  })

  it('mDNS 可被显式开启（保留知情开关，不改上游）', () => {
    expect(resolveSyncServerConfig({ mdns: true }).mdns).toBe(true)
    expect(embeddedServerConfig({ mdns: true }).mdns).toBe(true)
  })

  it('折算成上游 LocalSyncServerConfig 的字段名（name/host/port/mdns/journalPollMs）', () => {
    expect(Object.keys(embeddedServerConfig()).sort()).toEqual([
      'host',
      'journalPollMs',
      'mdns',
      'name',
      'port'
    ])
  })

  it('绝不产出 tls 字段：自签身份由上游 PcCompanionRuntime 补齐（runtime.ts:87-88）', () => {
    expect('tls' in embeddedServerConfig()).toBe(false)
    expect('remoteBridge' in embeddedServerConfig()).toBe(false)
  })

  it('兼容层 C5：connectionHosts 函数引用逐字透传（K5 将经 /v1/server 下发备选地址）', () => {
    const connectionHosts = (): string[] => ['192.168.1.5', '192.168.1.6']
    const resolved = resolveSyncServerConfig({ connectionHosts })
    expect(resolved.connectionHosts).toBe(connectionHosts)
    const embedded = embeddedServerConfig({ connectionHosts }) as Record<string, unknown>
    expect(embedded.connectionHosts).toBe(connectionHosts)
  })

  it('兼容层 C5：connectionHosts 缺省时连键都不下发（默认态 server config 形状不变）', () => {
    expect('connectionHosts' in resolveSyncServerConfig()).toBe(false)
    expect('connectionHosts' in embeddedServerConfig()).toBe(false)
  })

  it('边界：空白 name 回落默认，异常 name 原样保留（清洗由上游 mDNS 侧负责）', () => {
    expect(resolveSyncServerConfig({ name: '   ' }).name).toBe(SYNC_SERVER_DEFAULT_NAME)
    expect(resolveSyncServerConfig({ name: '  自定义名字  ' }).name).toBe('自定义名字')
  })

  it('异常输入被归一化而非原样透传', () => {
    const config = resolveSyncServerConfig({ port: 99999, mdns: false, host: '127.0.0.1' })
    expect(config.port).toBe(SYNC_SERVER_DEFAULT_PORT)
    expect(config.mdns).toBe(false)
    expect(config.host).toBe('127.0.0.1')
  })
})

describe('isPortInUseError / classifySyncStartError', () => {
  it('正常：上游 listen 失败原串包含 EADDRINUSE ⇒ 归类 PORT_IN_USE', () => {
    const error = new Error('listen EADDRINUSE: address already in use 0.0.0.0:28080')
    expect(isPortInUseError(error)).toBe(true)
    expect(classifySyncStartError(error)).toBe(PORT_IN_USE_MARKER)
  })

  it('异常：其它错误保留上游原始英文串（不吞、不改写）', () => {
    expect(isPortInUseError(new Error('listen EACCES: permission denied'))).toBe(false)
    expect(classifySyncStartError(new Error('listen EACCES: permission denied'))).toBe(
      'listen EACCES: permission denied'
    )
  })

  it('边界：非 Error 输入也能归类（字符串 / undefined）', () => {
    expect(classifySyncStartError('listen EADDRINUSE boom')).toBe(PORT_IN_USE_MARKER)
    expect(classifySyncStartError(undefined)).toBe('undefined')
  })
})

describe('mapPairedDeviceRow', () => {
  const row = {
    device_id: 'phone_1',
    device_name: 'Pixel 8',
    platform: 'android',
    app_version: '0.2.17',
    paired_at: '2026-10-14T00:00:00.000Z',
    last_seen_at: '2026-10-14T01:00:00.000Z',
    revoked_at: null
  }

  it('正常：snake_case 行收敛成管理视图，敏感列不参与映射', () => {
    expect(mapPairedDeviceRow({ ...row, public_key: 'PEM', credential_hash: 'deadbeef' })).toEqual({
      deviceId: 'phone_1',
      deviceName: 'Pixel 8',
      platform: 'android',
      appVersion: '0.2.17',
      pairedAt: '2026-10-14T00:00:00.000Z',
      lastSeenAt: '2026-10-14T01:00:00.000Z'
    })
  })

  it('正常：platform 只承认 ios，其余一律按 android 展示', () => {
    expect(mapPairedDeviceRow({ ...row, platform: 'ios' })?.platform).toBe('ios')
    expect(mapPairedDeviceRow({ ...row, platform: 'harmony' })?.platform).toBe('android')
  })

  it('异常：已撤销行与非对象输入降级为 null', () => {
    expect(mapPairedDeviceRow({ ...row, revoked_at: '2026-10-14T02:00:00.000Z' })).toBeNull()
    expect(mapPairedDeviceRow(null)).toBeNull()
    expect(mapPairedDeviceRow(undefined)).toBeNull()
    expect(mapPairedDeviceRow('phone_1')).toBeNull()
    expect(mapPairedDeviceRow(42)).toBeNull()
  })

  it('边界：缺 device_id 视为无效行；缺 app_version 时键整个不出现', () => {
    expect(mapPairedDeviceRow({ ...row, device_id: '' })).toBeNull()
    expect(mapPairedDeviceRow({ ...row, device_id: 123 })).toBeNull()
    expect('appVersion' in mapPairedDeviceRow({ ...row, app_version: null })!).toBe(false)
    // device_name 缺失时退回 deviceId 显示，UI 不会拿到空串
    expect(mapPairedDeviceRow({ ...row, device_name: null })?.deviceName).toBe('phone_1')
    expect(mapPairedDeviceRow({ ...row, last_seen_at: null })?.lastSeenAt).toBeNull()
  })
})

describe('parsePairingUri', () => {
  const expires = Math.floor(Date.now() / 1000) + 300

  it('正常：NS1 七段被解析成结构化字段，content 原样保留供二维码使用', () => {
    const content = `NS1|server_abc|192.168.1.50|28080|tok123|${expires}|${fingerprint}`
    expect(parsePairingUri(content)).toEqual({
      content,
      expiresAt: new Date(expires * 1000).toISOString(),
      serverId: 'server_abc',
      host: '192.168.1.50',
      port: 28080,
      tlsFingerprintSha256: fingerprint
    })
  })

  it('异常：段数不足 / 前缀不是 NS1 / 端口非法 / 指纹形态非法 ⇒ null（不把坏串交给 UI）', () => {
    // 段数不足（只有 6 段）
    expect(parsePairingUri(`NS1|a|b|28080|t|${expires}`)).toBeNull()
    // 旧文档里的 nikki-sync:// scheme 形态（上游 docs/M2_0 已过时，Android 侧两种都收，
    // 但本仓产出的是 NS1 紧凑串，解析器只认这一种）
    expect(
      parsePairingUri(`nikki-sync|server|127.0.0.1|28080|t|${expires}|${fingerprint}`)
    ).toBeNull()
    expect(parsePairingUri(`nikki-sync://pair?serverId=x`)).toBeNull()
    // 端口越界 / 非数字
    expect(parsePairingUri(`NS1|s|h|0|t|${expires}|${fingerprint}`)).toBeNull()
    expect(parsePairingUri(`NS1|s|h|70000|t|${expires}|${fingerprint}`)).toBeNull()
    expect(parsePairingUri(`NS1|s|h|abc|t|${expires}|${fingerprint}`)).toBeNull()
    // 指纹不是 64 位小写 hex（与手机侧 parseCompact 同口径）
    expect(parsePairingUri(`NS1|s|h|28080|t|${expires}|f`)).toBeNull()
    expect(parsePairingUri(`NS1|s|h|28080|t|${expires}|${'A'.repeat(64)}`)).toBeNull()
    expect(parsePairingUri('')).toBeNull()
  })
})

describe('buildSyncStatusSnapshot', () => {
  it('运行中：用上游回显的真实地址，并带出 secure / 指纹 / 证书', () => {
    const snapshot = buildSyncStatusSnapshot({
      running: true,
      configured: baseConfig,
      address: { host: '127.0.0.1', port: 38137, secure: true },
      serverId: 'server_1',
      tls: { certPem: 'CERT', fingerprintSha256: fingerprint },
      pairedDeviceCount: 2
    })
    expect(snapshot).toEqual({
      running: true,
      host: '127.0.0.1',
      port: 38137,
      secure: true,
      serverId: 'server_1',
      // 取 baseConfig 而非字面量：mDNS 默认值本阶段被翻转过一次，不能留两套真相
      mdnsEnabled: baseConfig.mdns,
      tlsFingerprintSha256: fingerprint,
      serverCertificatePem: 'CERT',
      pairedDeviceCount: 2
    })
  })

  it('未运行：host/port 回落配置值（端口冲突时 UI 才知道该改哪一个），且不下 secure 判断', () => {
    const snapshot = buildSyncStatusSnapshot({
      running: false,
      configured: { ...baseConfig, port: 39000 },
      error: PORT_IN_USE_MARKER
    })
    expect(snapshot.running).toBe(false)
    expect(snapshot.port).toBe(39000)
    expect(snapshot.host).toBe(SYNC_SERVER_DEFAULT_HOST)
    expect(snapshot.secure).toBeUndefined()
    expect(snapshot.error).toBe(PORT_IN_USE_MARKER)
    // 无会话时不虚构计数
    expect('pairedDeviceCount' in snapshot).toBe(false)
    expect('tlsFingerprintSha256' in snapshot).toBe(false)
  })

  it('边界：error 为空串时不出现该键（避免 UI 显示空错误）', () => {
    const snapshot = buildSyncStatusSnapshot({ running: false, configured: baseConfig, error: '' })
    expect('error' in snapshot).toBe(false)
  })
})

describe('回落 host 常量', () => {
  it('配对 host 解析不到局域网地址时用回环，而不是空串或 0.0.0.0', () => {
    expect(LOOPBACK_FALLBACK_HOST).toBe('127.0.0.1')
  })
})
