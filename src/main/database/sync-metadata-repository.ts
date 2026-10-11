import crypto from 'crypto'
import type Database from 'better-sqlite3'
import { CHANGE_TYPES, type ChangeRecord, type ChangeType } from '../../shared/sync/protocol'
import type { MotionLinkRow } from './sync-row-mappers'
import { mapChangeRow } from './sync-row-mappers'

/**
 * 同步元数据仓储 — sync_* 四表的 SQL 访问（复用宿主 Repository 范式）。
 *
 * - 职责：变更日志（append-only）+ 库级 revision 分配、设备配对、服务身份、
 *   动态照片配对链接（sync_motion_links）的全量重建
 * - 写路径采用同步直写 + 事务：revision 分配（MAX+1 → 镜像更新）等语句在单个
 *   db.transaction 内原子执行。
 *   （备注：宿主 media-repository 的写路径走 database-worker 卸载，本仓储暂用
 *   同步直写——安全扫描工具将 bridge.execute / 变量 prepare 调用误报为 SQL 注入
 *   并阻断；与 resonance-repository 同款先例。构造函数保留 workerBridge/dbPath
 *   参数，待规则修正后可无缝切回 worker 桥接，方法签名保持 async 不变。）
 * - revision 单调递增：change_journal 为 append-only，本仓储不提供任何
 *   改写/删除日志的 API；单事务批内完成"播种服务状态行 → 追加日志（MAX+1）→
 *   镜像更新 library_revision"
 * - SQL 一律为调用点完整静态字面量（零拼接/插值/展开），全部参数绑定
 * - 时间戳由代码生成 ISO 字符串后经参数绑定写入（DDL 不设默认值）
 * - 测试接缝：可用内存数据库实例化；DDL 常量导出供迁移与测试共用
 */

// ============================================================================
// DDL — 由 connection.ts 的 applyMigrations 幂等执行（纯新增表，无数据回填，
// 不占用迁移版本号，与 favorites / resonance_* 同款先例）
// ============================================================================

export const SYNC_METADATA_DDL_STATEMENTS: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS sync_paired_devices (device_id TEXT PRIMARY KEY, device_name TEXT NOT NULL, platform TEXT NOT NULL CHECK (platform IN ('ios','android')), public_key TEXT NOT NULL, credential_hash TEXT NOT NULL, app_version TEXT, paired_at TEXT NOT NULL, last_seen_at TEXT, last_ack_revision INTEGER NOT NULL DEFAULT 0, revoked_at TEXT)",
  "CREATE TABLE IF NOT EXISTS sync_change_journal (revision INTEGER PRIMARY KEY CHECK (revision > 0), event_type TEXT NOT NULL CHECK (event_type IN ('asset.created','asset.updated','asset.deleted')), asset_id TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT)",
  'CREATE TABLE IF NOT EXISTS sync_service_state (id INTEGER PRIMARY KEY CHECK (id = 1), library_revision INTEGER NOT NULL DEFAULT 0 CHECK (library_revision >= 0), server_id TEXT, server_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  "CREATE TABLE IF NOT EXISTS sync_motion_links (still_media_id INTEGER PRIMARY KEY, motion_media_id INTEGER NOT NULL UNIQUE, method TEXT NOT NULL CHECK (method IN ('embedded_id','filename','timestamp','heuristic','manual')), confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1), presentation_timestamp_us INTEGER, created_at TEXT NOT NULL)",
  'CREATE INDEX IF NOT EXISTS idx_sync_change_journal_asset ON sync_change_journal(asset_id, revision)',
  'CREATE INDEX IF NOT EXISTS idx_sync_paired_devices_revoked ON sync_paired_devices(revoked_at)',
  'CREATE INDEX IF NOT EXISTS idx_sync_motion_links_motion ON sync_motion_links(motion_media_id)'
]

// ============================================================================
// SQL 模板（完整静态字面量；与 sync-metadata-repository.test.ts 的 mock 一一对应）
// ============================================================================

const SQL_SERVICE_STATE_SEED =
  'INSERT OR IGNORE INTO sync_service_state (id, library_revision, server_id, server_name, created_at, updated_at) VALUES (1, 0, NULL, NULL, ?, ?)'
const SQL_JOURNAL_INSERT =
  'INSERT INTO sync_change_journal (revision, event_type, asset_id, occurred_at, payload_json) VALUES ((SELECT COALESCE(MAX(revision), 0) + 1 FROM sync_change_journal), ?, ?, ?, ?)'
const SQL_REVISION_MIRROR =
  'UPDATE sync_service_state SET library_revision = (SELECT MAX(revision) FROM sync_change_journal), updated_at = ? WHERE id = 1'
const SQL_DEVICE_UPSERT =
  'INSERT OR REPLACE INTO sync_paired_devices (device_id, device_name, platform, public_key, credential_hash, app_version, paired_at, last_seen_at, last_ack_revision, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)'
const SQL_DEVICE_TOUCH = 'UPDATE sync_paired_devices SET last_seen_at = ? WHERE device_id = ?'
const SQL_DEVICE_ACK =
  'UPDATE sync_paired_devices SET last_ack_revision = ? WHERE device_id = ? AND last_ack_revision < ?'
const SQL_DEVICE_REVOKE =
  'UPDATE sync_paired_devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL'
const SQL_SERVER_IDENTITY_UPDATE =
  "UPDATE sync_service_state SET server_id = ?, server_name = ?, updated_at = ? WHERE id = 1 AND (server_id IS NULL OR server_id = '')"
const SQL_MOTION_LINKS_DELETE = 'DELETE FROM sync_motion_links'
const SQL_MOTION_LINK_INSERT =
  "INSERT INTO sync_motion_links (still_media_id, motion_media_id, method, confidence, presentation_timestamp_us, created_at) VALUES (?, ?, 'filename', 1, NULL, ?)"

const SQL_CURRENT_REVISION = 'SELECT library_revision FROM sync_service_state WHERE id = 1'
const SQL_MAX_JOURNAL_REVISION = 'SELECT MAX(revision) AS revision FROM sync_change_journal'
const SQL_MIN_JOURNAL_REVISION = 'SELECT MIN(revision) AS min_revision FROM sync_change_journal'
const SQL_CHANGES_AFTER =
  'SELECT revision, event_type, asset_id, occurred_at, payload_json FROM sync_change_journal WHERE revision > ? ORDER BY revision ASC LIMIT ?'
const SQL_SERVER_IDENTITY = 'SELECT server_id, server_name FROM sync_service_state WHERE id = 1'
const SQL_DEVICE_BY_ID =
  'SELECT device_id, device_name, platform, public_key, credential_hash, app_version, paired_at, last_seen_at, last_ack_revision, revoked_at FROM sync_paired_devices WHERE device_id = ?'
const SQL_DEVICE_ALL =
  'SELECT device_id, device_name, platform, public_key, credential_hash, app_version, paired_at, last_seen_at, last_ack_revision, revoked_at FROM sync_paired_devices ORDER BY paired_at DESC'
// 阶段5：活跃设备（未撤销）——设备列表 UI 与 pairedDeviceCount 的口径
const SQL_DEVICE_ALL_ACTIVE =
  'SELECT device_id, device_name, platform, public_key, credential_hash, app_version, paired_at, last_seen_at, last_ack_revision, revoked_at FROM sync_paired_devices WHERE revoked_at IS NULL ORDER BY paired_at DESC'
const SQL_MOTION_LINK_ALL =
  'SELECT still_media_id, motion_media_id, method, confidence, presentation_timestamp_us FROM sync_motion_links'
const SQL_MOTION_LINK_BY_STILL =
  'SELECT still_media_id, motion_media_id, method, confidence, presentation_timestamp_us FROM sync_motion_links WHERE still_media_id = ?'
const SQL_PAIRING_CANDIDATES =
  "SELECT id, file_path, file_name, file_ext, file_type FROM media_files WHERE is_deleted = 0 AND file_type IN ('image', 'video')"

export const DEFAULT_SERVER_NAME = 'WXNN XiangCe'

// ============================================================================
// Row Types
// ============================================================================

export interface SyncPairedDeviceRow {
  device_id: string
  device_name: string
  platform: string
  public_key: string
  credential_hash: string
  app_version: string | null
  paired_at: string
  last_seen_at: string | null
  last_ack_revision: number
  revoked_at: string | null
}

export interface RecordAssetChangeInput {
  eventType: ChangeType
  assetId: string
  occurredAt?: string
  payload?: Record<string, unknown>
}

export interface UpsertPairDeviceInput {
  deviceId: string
  deviceName: string
  platform: 'ios' | 'android'
  publicKey: string
  credentialHash: string
  appVersion?: string
  pairedAt?: string
}

export interface ServerIdentity {
  serverId: string
  serverName: string
}

/** rebuildMotionLinks 的 media_files 候选行 */
export interface MotionPairingCandidateRow {
  id: number
  file_path: string
  file_name: string
  file_ext: string
  file_type: string
}

export interface MotionLinkPair {
  still_media_id: number
  motion_media_id: number
}

// ============================================================================
// 同名配对（纯函数，供 rebuildMotionLinks 与测试直接调用）
// ============================================================================

/** 目录键：截掉文件名得到目录前缀，统一正斜杠并小写（Windows 大小写不敏感） */
function directoryKeyOf(row: MotionPairingCandidateRow): string {
  const dir = row.file_path.slice(0, Math.max(0, row.file_path.length - row.file_name.length))
  return dir.replace(/\\/g, '/').toLowerCase()
}

/** basename 键：去扩展名后小写（与 SQL substr 公式等价，防止越界） */
function baseNameKeyOf(row: MotionPairingCandidateRow): string {
  const end = row.file_name.length - row.file_ext.length - 1
  if (end <= 0) return ''
  return row.file_name.slice(0, end).toLowerCase()
}

/**
 * 同名约定配对：同目录 + 同 basename 的静图/视频一一对应才建链；
 * 一对多/多对一歧义保守跳过（对齐项目 Live Photo 导入识别约定，
 * 见 livephoto-service.ts 的配对说明与上游 resolver 的 'filename' method）。
 */
export function computeMotionLinks(rows: MotionPairingCandidateRow[]): MotionLinkPair[] {
  const stills = new Map<string, MotionPairingCandidateRow[]>()
  const videos = new Map<string, MotionPairingCandidateRow[]>()
  for (const row of rows) {
    const key = `${directoryKeyOf(row)}\u0000${baseNameKeyOf(row)}`
    const bucket = row.file_type === 'image' ? stills : videos
    const list = bucket.get(key)
    if (list) list.push(row)
    else bucket.set(key, [row])
  }
  const links: MotionLinkPair[] = []
  for (const [key, stillRows] of stills) {
    const videoRows = videos.get(key)
    if (!videoRows || stillRows.length !== 1 || videoRows.length !== 1) continue
    links.push({ still_media_id: stillRows[0]!.id, motion_media_id: videoRows[0]!.id })
  }
  return links
}

// ============================================================================
// Repository
// ============================================================================

function nowIso(): string {
  return new Date().toISOString()
}

function assertIsoDateTime(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`invalid ${label}: not an ISO datetime string`)
  }
}

/** 变更记录入参校验（单条与批量共用；批量任一条非法整体回滚） */
function assertChangeInput(input: RecordAssetChangeInput): void {
  if (!(CHANGE_TYPES as readonly string[]).includes(input.eventType)) {
    throw new Error(`invalid eventType: ${String(input.eventType)}`)
  }
  if (typeof input.assetId !== 'string' || input.assetId === '') {
    throw new Error('invalid assetId: must be a non-empty string')
  }
  if (input.occurredAt !== undefined) {
    assertIsoDateTime(input.occurredAt, 'occurredAt')
  }
}

export class SyncMetadataRepository {
  /** 保留形参（下划线前缀=刻意未读）：写路径切回 worker 桥接时无需改动调用方 */
  constructor(
    private readonly db: Database.Database,
    _workerBridge: unknown = null,
    _dbPath: string = ''
  ) {}

  // ============ 写（async 签名；当前为同步直写，见文件头备注） ============

  /**
   * 记录一条资产变更并分配下一个库级 revision。
   * 三个语句在同一事务内原子执行：服务状态行兜底播种 → 日志追加（MAX+1）→
   * revision 镜像更新。revision 严格单调（日志 append-only，无删除 API）。
   */
  async recordAssetChange(input: RecordAssetChangeInput): Promise<{ revision: number }> {
    assertChangeInput(input)
    const occurredAt = input.occurredAt ?? nowIso()
    const payloadJson = input.payload === undefined ? null : JSON.stringify(input.payload)
    const now = nowIso()
    const allocate = this.db.transaction(() => {
      this.db.prepare(SQL_SERVICE_STATE_SEED).run(now, now)
      this.db
        .prepare(SQL_JOURNAL_INSERT)
        .run(input.eventType, input.assetId, occurredAt, payloadJson)
      this.db.prepare(SQL_REVISION_MIRROR).run(now)
    })
    allocate()
    const row = this.db.prepare(SQL_MAX_JOURNAL_REVISION).get() as
      { revision: number | null } | undefined
    return { revision: row?.revision ?? 0 }
  }

  /**
   * 批量记录资产变更：单事务内逐条追加（每行 MAX+1），镜像更新一次。
   * 任一条非法整体回滚。返回写入条数。
   * 使用场景：扫描完成后的批量接线——万级文件不能逐条开事务（每条一个事务
   * 含 3 语句，顺序执行会阻塞 runPostScanActions 数十秒）；广播策略由调用方
   * （事件汇）负责，本方法只管 journal 落库。
   */
  async recordAssetChanges(inputs: ReadonlyArray<RecordAssetChangeInput>): Promise<number> {
    if (inputs.length === 0) return 0
    for (const input of inputs) assertChangeInput(input)
    const now = nowIso()
    const allocateAll = this.db.transaction(() => {
      const seed = this.db.prepare(SQL_SERVICE_STATE_SEED)
      const insert = this.db.prepare(SQL_JOURNAL_INSERT)
      const mirror = this.db.prepare(SQL_REVISION_MIRROR)
      seed.run(now, now)
      for (const input of inputs) {
        const occurredAt = input.occurredAt ?? now
        const payloadJson = input.payload === undefined ? null : JSON.stringify(input.payload)
        insert.run(input.eventType, input.assetId, occurredAt, payloadJson)
      }
      mirror.run(now)
    })
    allocateAll()
    return inputs.length
  }

  /** 记录设备配对（重复配对视为重新配对：重置 ack 进度与撤销态） */
  async upsertPairDevice(input: UpsertPairDeviceInput): Promise<void> {
    if (typeof input.deviceId !== 'string' || input.deviceId === '') {
      throw new Error('invalid deviceId: must be a non-empty string')
    }
    if (typeof input.deviceName !== 'string' || input.deviceName === '') {
      throw new Error('invalid deviceName: must be a non-empty string')
    }
    if (input.platform !== 'ios' && input.platform !== 'android') {
      throw new Error(`invalid platform: ${String(input.platform)}`)
    }
    if (typeof input.publicKey !== 'string' || input.publicKey === '') {
      throw new Error('invalid publicKey: must be a non-empty string')
    }
    if (typeof input.credentialHash !== 'string' || input.credentialHash === '') {
      throw new Error('invalid credentialHash: must be a non-empty string')
    }
    if (input.pairedAt !== undefined) assertIsoDateTime(input.pairedAt, 'pairedAt')
    const pairedAt = input.pairedAt ?? nowIso()
    this.db
      .prepare(SQL_DEVICE_UPSERT)
      .run(
        input.deviceId,
        input.deviceName,
        input.platform,
        input.publicKey,
        input.credentialHash,
        input.appVersion ?? null,
        pairedAt,
        pairedAt
      )
  }

  async touchDevice(deviceId: string, seenAt?: string): Promise<void> {
    if (seenAt !== undefined) assertIsoDateTime(seenAt, 'seenAt')
    this.db.prepare(SQL_DEVICE_TOUCH).run(seenAt ?? nowIso(), deviceId)
  }

  /** 确认进度只增不减（SQL 守卫 last_ack_revision < ?）；未知设备为 no-op */
  async acknowledgeRevision(deviceId: string, revision: number): Promise<void> {
    if (!Number.isInteger(revision) || revision < 0) {
      throw new Error(`invalid revision: ${String(revision)}`)
    }
    this.db.prepare(SQL_DEVICE_ACK).run(revision, deviceId, revision)
  }

  async revokeDevice(deviceId: string, revokedAt?: string): Promise<void> {
    if (revokedAt !== undefined) assertIsoDateTime(revokedAt, 'revokedAt')
    this.db.prepare(SQL_DEVICE_REVOKE).run(revokedAt ?? nowIso(), deviceId)
  }

  /** 首次调用生成并持久化服务器身份（serverId: wxnn-<16hex>），此后稳定不变 */
  async ensureServerIdentity(): Promise<ServerIdentity> {
    const now = nowIso()
    this.db.prepare(SQL_SERVICE_STATE_SEED).run(now, now)
    const existing = this.db.prepare(SQL_SERVER_IDENTITY).get() as
      { server_id: string | null; server_name: string | null } | undefined
    if (existing?.server_id) {
      return {
        serverId: existing.server_id,
        serverName: existing.server_name || DEFAULT_SERVER_NAME
      }
    }
    const serverId = `wxnn-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
    this.db.prepare(SQL_SERVER_IDENTITY_UPDATE).run(serverId, DEFAULT_SERVER_NAME, nowIso())
    const updated = this.db.prepare(SQL_SERVER_IDENTITY).get() as
      { server_id: string | null; server_name: string | null } | undefined
    return {
      serverId: updated?.server_id ?? serverId,
      serverName: updated?.server_name || DEFAULT_SERVER_NAME
    }
  }

  /**
   * 全量重建动态照片配对链接（同名约定，见 computeMotionLinks）。
   * 单事务：DELETE 全表 + INSERT 新集合，幂等可重复执行。
   */
  async rebuildMotionLinks(options: { rebuiltAt?: string } = {}): Promise<{ paired: number }> {
    if (options.rebuiltAt !== undefined) assertIsoDateTime(options.rebuiltAt, 'rebuiltAt')
    const candidates = this.db
      .prepare(SQL_PAIRING_CANDIDATES)
      .all() as unknown as MotionPairingCandidateRow[]
    const links = computeMotionLinks(candidates)
    const rebuiltAt = options.rebuiltAt ?? nowIso()
    const rebuild = this.db.transaction(() => {
      this.db.prepare(SQL_MOTION_LINKS_DELETE).run()
      for (const link of links) {
        this.db
          .prepare(SQL_MOTION_LINK_INSERT)
          .run(link.still_media_id, link.motion_media_id, rebuiltAt)
      }
    })
    rebuild()
    return { paired: links.length }
  }

  // ============ 读（同步；字面量语句 + 参数绑定） ============

  /** 库级当前 revision；服务状态行不存在（未发生任何写入）时为 0 */
  getCurrentRevision(): number {
    const row = this.db.prepare(SQL_CURRENT_REVISION).get() as
      { library_revision: number | null } | undefined
    return row?.library_revision ?? 0
  }

  listChangesAfter(afterRevision: number, limit = 1000): ChangeRecord[] {
    if (!Number.isInteger(afterRevision) || afterRevision < 0) {
      throw new Error(`invalid afterRevision: ${String(afterRevision)}`)
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`invalid limit: ${String(limit)}`)
    }
    const rows = this.db.prepare(SQL_CHANGES_AFTER).all(afterRevision, limit) as unknown as Array<{
      revision: number
      event_type: string
      asset_id: string
      occurred_at: string
      payload_json: string | null
    }>
    return rows.map(mapChangeRow)
  }

  /** 日志中现存最小 revision（null = 空日志）；支撑 fullResyncRequired 判定 */
  getMinimumJournalRevision(): number | null {
    const row = this.db.prepare(SQL_MIN_JOURNAL_REVISION).get() as
      { min_revision: number | null } | undefined
    return row?.min_revision ?? null
  }

  getPairedDevice(deviceId: string): SyncPairedDeviceRow | null {
    const row = this.db.prepare(SQL_DEVICE_BY_ID).get(deviceId) as SyncPairedDeviceRow | undefined
    return row ?? null
  }

  listPairedDevices(): SyncPairedDeviceRow[] {
    return this.db.prepare(SQL_DEVICE_ALL).all() as unknown as SyncPairedDeviceRow[]
  }

  /** 活跃（未撤销）设备，按 paired_at DESC——设备列表 UI 与 pairedDeviceCount 口径（阶段5） */
  listActivePairedDevices(): SyncPairedDeviceRow[] {
    return this.db.prepare(SQL_DEVICE_ALL_ACTIVE).all() as unknown as SyncPairedDeviceRow[]
  }

  listMotionLinks(): MotionLinkRow[] {
    return this.db.prepare(SQL_MOTION_LINK_ALL).all() as unknown as MotionLinkRow[]
  }

  getMotionLinkByStill(stillMediaId: number): MotionLinkRow | null {
    const row = this.db.prepare(SQL_MOTION_LINK_BY_STILL).get(stillMediaId) as
      MotionLinkRow | undefined
    return row ?? null
  }
}
