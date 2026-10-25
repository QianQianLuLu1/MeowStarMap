/**
 * 同步服务视图纯函数（整合阶段 3）。
 *
 * 职责边界（与 `runtime-manager.ts` 的关系同 `runtime-cli-report.ts` 之于入口壳）：
 * 这里只做**结构与分类**——把本仓的配置意图折算成上游 `LocalSyncServerConfig` 的形状、
 * 把上游错误串归类、把 `paired_devices` 行折算成管理视图、把状态字段拼成 IPC 响应体。
 * **不含**任何监听、SQL、加密或上游对象引用；服务器本体全部由 NikkiSync 提供。
 *
 * 默认值口径（禁假设，全部指向上游源码）：
 * - `28080` = `apps/pc-companion/src/windows-app.ts:128` 的 `NIKKISYNC_PORT ?? 28080`
 *   （上游 `LocalSyncServer` 自身默认是 `0` 临时端口，嵌入态不用它：配对二维码需要稳定端口）
 * - `0.0.0.0` = 同文件 `:127` 的 `NIKKISYNC_BIND` 默认
 * - mDNS：**本仓默认关**，与上游 `windows-app.ts:129`（`NIKKISYNC_MDNS !== '0'` 即开）刻意不同，
 *   原因是上游 `MdnsAdvertiser` 存在组播自激回环（详见下方 `SYNC_SERVER_DEFAULT_MDNS` 的实测记录）
 * - `journalPollMs 250` = `LocalSyncServer.ts:166`
 * - `PORT_IN_USE` 分类判据 = `desktop/StartupFailure.ts:8`（`includes('EADDRINUSE')`）
 *
 * 字符串字面量保持英文（src/** 的中文硬编码护栏为 error）。
 */

import type {
  NikkiSyncPairedDeviceView,
  NikkiSyncPairingCode,
  NikkiSyncSyncServerAddress,
  NikkiSyncSyncServerConfig,
  NikkiSyncSyncServerStatus
} from './runtime-types'

/** 上游桌面版默认端口（`windows-app.ts:128`）。 */
export const SYNC_SERVER_DEFAULT_PORT = 28080
/** 上游桌面版默认绑定（`windows-app.ts:127`）。 */
export const SYNC_SERVER_DEFAULT_HOST = '0.0.0.0'
/** mDNS 实例名与 `PairResponse.serverName`：上游 `MdnsAdvertiser.ts:52` 的清洗只去非 ASCII（空格与 `_ -` 放行），故取英文品牌形，中文名会被洗掉。 */
export const SYNC_SERVER_DEFAULT_NAME = 'Meow Star Map'
/**
 * mDNS 默认**关闭**——这是对上游缺陷的集成侧兜底，不是随手改的默认值。
 *
 * 实测（2026-10-14，本机 `NikkiSync@d4ca7d7`，A/B 各一次，见 docs/sync-integration/03-sync-server-plan.md §15）：
 * `MdnsAdvertiser` 用同一个 socket 既发公告又把「任何含 `_nikkisync` + `_tcp` 的来包」当作查询立即重发
 * （`MdnsAdvertiser.ts:69-71`），而它自己的公告会经组播回环送回自己（`:72-77`，loopback 默认开，
 * 不判 QR 位、无速率限制）⇒ 正反馈自激：`mdns:true` 时 45s 内被动收到 **1,568,807** 条带本次 serverId
 * 的公告包（≈3.5 万/秒，TTL 255 会打到整个局域网段）；`mdns:false` 时同口径 15s 收到 **0** 条。
 * 手机侧不依赖它：配对二维码已经直接携带 `host:port`（`NS1|` 第 3、4 段）。
 * 因此本仓默认关，并保留 `nikkisync.syncMdnsEnabled` 供用户知情开启；上游修复前不得默认打开。
 */
export const SYNC_SERVER_DEFAULT_MDNS = false
/** 上游 `journalPollMs` 默认（`LocalSyncServer.ts:166`）。 */
export const SYNC_JOURNAL_POLL_MS = 250
/** 端口占用归类标记（与上游 `StartupFailure.ts` 的 `PORT_IN_USE` 同字面）。 */
export const PORT_IN_USE_MARKER = 'PORT_IN_USE'
/** 配对码解析不到局域网地址时的兜底 host（如实展示，不假装是局域网 IP）。 */
export const LOOPBACK_FALLBACK_HOST = '127.0.0.1'

/**
 * 端口归一化：允许 `0`（交给系统分配，测试与「不参与冲突协商」的场景用），
 * 拒绝负数、非整数、>65535 与非数字；字符串数字接受（设置项历史形态可能是字符串）。
 */
export function normalizeSyncPort(
  value: unknown,
  fallback: number = SYNC_SERVER_DEFAULT_PORT
): number {
  const numeric = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof numeric !== 'number' || !Number.isInteger(numeric)) return fallback
  if (numeric < 0 || numeric > 65535) return fallback
  return numeric
}

/** journal 轮询间隔归一化：非正整数回落上游默认。 */
export function normalizeJournalPollMs(
  value: unknown,
  fallback: number = SYNC_JOURNAL_POLL_MS
): number {
  const numeric = typeof value === 'string' ? Number(value.trim()) : value
  return typeof numeric === 'number' && Number.isInteger(numeric) && numeric > 0
    ? numeric
    : fallback
}

/**
 * 把（可能不完整或形态错误的）输入折算成类型化的同步服务配置。
 * 单一真相源：默认值取自上方常量，端口/mdns 一律经归一化，不留 `undefined`。
 */
export function resolveSyncServerConfig(
  input?: Partial<NikkiSyncSyncServerConfig>
): NikkiSyncSyncServerConfig {
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  return {
    name: name || SYNC_SERVER_DEFAULT_NAME,
    host: input?.host ?? SYNC_SERVER_DEFAULT_HOST,
    port: normalizeSyncPort(input?.port),
    mdns: input?.mdns ?? SYNC_SERVER_DEFAULT_MDNS,
    journalPollMs: normalizeJournalPollMs(input?.journalPollMs),
    // 兼容层（b422193）：函数引用原样保留（上游构造期调用取值）；缺省时键不存在
    ...(input?.connectionHosts ? { connectionHosts: input.connectionHosts } : {})
  }
}

/**
 * 折算成上游 `LocalSyncServerConfig`（`LocalSyncServer.ts:39-55`）的字段形状。
 * 刻意**不传 `tls`**：上游 `PcCompanionRuntime` 会在缺省时用
 * `LocalTlsIdentityService.getOrCreate()` 自动补齐自签身份（`runtime.ts:87-88`），
 * 本仓因此不需要也不应该自己管证书文件。
 */
export function embeddedServerConfig(
  input?: Partial<NikkiSyncSyncServerConfig>
): Record<string, unknown> {
  const config = resolveSyncServerConfig(input)
  return {
    name: config.name,
    host: config.host,
    port: config.port,
    mdns: config.mdns,
    journalPollMs: config.journalPollMs,
    // 兼容层（b422193）：备选地址回调透传（缺省时连键都不下发，与上游可选语义一致）
    ...(config.connectionHosts ? { connectionHosts: config.connectionHosts } : {})
  }
}

/**
 * 解析上游 `buildPairingUri()` 的紧凑配对串（`packages/protocol/src/index.ts:326-329`）：
 * `NS1|serverId|host|port|token|expiresEpochSeconds|tlsFingerprintSha256`（恰 7 段）。
 * 注意它**不是 URL scheme**（`docs/M2_0` 里的 `nikki-sync://pair?...` 是过时文档），
 * 且 `PairingQrPayload.scheme: 'nikki-sync'` 不出现在串里。字段不全即返回 null。
 */
export function parsePairingUri(content: string): NikkiSyncPairingCode | null {
  const parts = content.split('|')
  if (parts.length !== 7 || parts[0] !== 'NS1') return null
  const [, serverId, host, port, , expiresAtSeconds, tlsFingerprintSha256] = parts
  const portValue = Number(port)
  const expiresValue = Number(expiresAtSeconds)
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) return null
  if (!Number.isFinite(expiresValue)) return null
  // 与手机侧 `PairingUri.parseCompact` 同口径：指纹必须是 64 位小写 hex，
  // 形态不对就是串被截断/拼错了，不能把坏二维码交给 UI。
  if (!/^[0-9a-f]{64}$/.test(String(tlsFingerprintSha256))) return null
  return {
    content,
    expiresAt: new Date(expiresValue * 1000).toISOString(),
    serverId: String(serverId),
    host: String(host),
    port: portValue,
    tlsFingerprintSha256: String(tlsFingerprintSha256)
  }
}

/** 上游 `listen` 失败原样抛 `EADDRINUSE`（`start()` 无重试、无回退）。 */
export function isPortInUseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('EADDRINUSE')
}

/** 启停失败归类：端口占用给短标记，其余保留上游原始英文串便于排查。 */
export function classifySyncStartError(error: unknown): string {
  if (isPortInUseError(error)) return PORT_IN_USE_MARKER
  return error instanceof Error ? error.message : String(error)
}

/**
 * `paired_devices` 行 → 管理视图。
 * 上游 `PairingRepository` 没有任何 list 方法（只有 `getDevice` / `countActiveDevices` /
 * `revoke`），因此列表由本仓做只读 SELECT；这里负责把 snake_case 行收敛成视图，
 * 并且**只字面量透传非敏感列**（公钥与凭据哈希绝不出库）。
 * 已撤销行、缺 device_id、非对象输入一律降级为 null（调用侧过滤）。
 */
export function mapPairedDeviceRow(row: unknown): NikkiSyncPairedDeviceView | null {
  if (typeof row !== 'object' || row === null) return null
  const record = row as Record<string, unknown>
  if (record.revoked_at) return null
  const deviceId = record.device_id
  if (typeof deviceId !== 'string' || deviceId.length === 0) return null
  return {
    deviceId,
    deviceName:
      typeof record.device_name === 'string' && record.device_name ? record.device_name : deviceId,
    platform: record.platform === 'ios' ? 'ios' : 'android',
    ...(record.app_version === null || record.app_version === undefined
      ? {}
      : { appVersion: String(record.app_version) }),
    pairedAt: typeof record.paired_at === 'string' ? record.paired_at : '',
    lastSeenAt:
      record.last_seen_at === null || record.last_seen_at === undefined
        ? null
        : String(record.last_seen_at)
  }
}

/**
 * 状态快照：运行中用上游 `start()` 回显的真实地址，未运行时回落配置值
 * （UI 需要在端口冲突时仍能把「配置端口 + PORT_IN_USE」显示出来）。
 */
export function buildSyncStatusSnapshot(input: {
  running: boolean
  configured: NikkiSyncSyncServerConfig
  address?: NikkiSyncSyncServerAddress
  serverId?: string
  tls?: { certPem: string; fingerprintSha256: string }
  pairedDeviceCount?: number
  /** 配对二维码会写出的局域网地址（解析不到时为回环，UI 据此如实提示）。 */
  lanHost?: string
  error?: string
  /** K5：`/v1/server` 同款备选地址（≤8；来源为 listLanIpv4，未接线时缺省）。 */
  connectionHosts?: string[]
}): NikkiSyncSyncServerStatus {
  const { configured, address } = input
  return {
    running: input.running,
    host: address?.host ?? configured.host,
    port: address?.port ?? configured.port,
    // 只有真的在监听才声称 secure：未运行时不下这个判断
    ...(address ? { secure: address.secure } : {}),
    ...(input.serverId ? { serverId: input.serverId } : {}),
    mdnsEnabled: configured.mdns,
    ...(input.tls
      ? {
          tlsFingerprintSha256: input.tls.fingerprintSha256,
          serverCertificatePem: input.tls.certPem
        }
      : {}),
    ...(input.lanHost ? { lanHost: input.lanHost } : {}),
    ...(input.pairedDeviceCount === undefined
      ? {}
      : { pairedDeviceCount: input.pairedDeviceCount }),
    ...(input.connectionHosts ? { connectionHosts: input.connectionHosts } : {}),
    ...(input.error ? { error: input.error } : {})
  }
}

/**
 * K4：连接诊断快照（`nikkisync:server-status` 响应的 `diagnostics` 可选段）。
 *
 * 上游 1.0.22 的连接诊断主体在其 C# windows-shell（`ConnectionDiagnosticsCollector`），
 * **不可复用**；本函数是本仓自建观测面——只聚合既有状态快照，**不做任何主动网络
 * 探测**（不 ping、不扫端口、不扫子网）。指纹只给尾 8 位摘要（完整指纹已在状态卡）。
 */
export interface NikkiSyncDiagnosticsSnapshot {
  running: boolean
  host: string
  port: number
  secure?: boolean
  mdnsEnabled: boolean
  pairedDeviceCount?: number
  /** 完整指纹的尾 8 位摘要（展示用；完整值见状态卡 tlsFingerprintSha256）。 */
  tlsFingerprintTail8?: string
  /** 备选连接地址（K5 接线后给出；≤8）。 */
  connectionHosts?: string[]
  /** 最近一次启停失败原因（端口占用归一化为 PORT_IN_USE）。 */
  lastError?: string
  /** 快照采集时刻（ISO 8601；UI 据此判断数据新鲜度）。 */
  updatedAt: string
}

/** 由状态快照聚合诊断段（纯函数；缺省字段如实缺省，不虚构）。 */
export function buildSyncDiagnosticsSnapshot(
  status: NikkiSyncSyncServerStatus,
  now: Date = new Date()
): NikkiSyncDiagnosticsSnapshot {
  return {
    running: status.running,
    host: status.host,
    port: status.port,
    ...(status.secure === undefined ? {} : { secure: status.secure }),
    mdnsEnabled: status.mdnsEnabled,
    ...(status.pairedDeviceCount === undefined
      ? {}
      : { pairedDeviceCount: status.pairedDeviceCount }),
    ...(status.tlsFingerprintSha256
      ? { tlsFingerprintTail8: status.tlsFingerprintSha256.slice(-8) }
      : {}),
    ...(status.connectionHosts ? { connectionHosts: status.connectionHosts } : {}),
    ...(status.error ? { lastError: status.error } : {}),
    updatedAt: now.toISOString()
  }
}
