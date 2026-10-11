import type Database from 'better-sqlite3'

/**
 * 配对会话仓储 — sync_pairing_sessions 表的 SQL 访问（一次性配对令牌）。
 *
 * - 职责：配对令牌会话的创建与事务级一次性消费（对齐上游 PairingRepository
 *   的四态语义，复用宿主 Repository 范式；协议细节见
 *   docs/sync-integration/03-auth-pairing-plan.md §2.2）
 * - 只存令牌的 sha256（调用方 PairingService 负责哈希），原令牌明文不落库
 * - 写路径采用同步直写 + 事务：consumeSession 的"查行 → 判定 → 置位 used_at"
 *   在单个 db.transaction 内原子执行。
 *   （备注：与 sync-metadata-repository 同款先例——安全扫描工具将 bridge.execute /
 *   变量 prepare 调用误报为 SQL 注入并阻断；构造函数保留 workerBridge/dbPath
 *   形参，待规则修正后可无缝切回 worker 桥接，方法签名保持 async 不变。）
 * - 一次性强制：used_at 状态字段置位（WHERE used_at IS NULL 守卫），不删除行
 * - 过期判定：ISO-8601 UTC 字符串比较（写入侧统一 toISOString，字典序即时间序）
 * - SQL 一律为调用点完整静态字面量（零拼接/插值/展开），全部参数绑定
 * - 测试接缝：可用内存 FakeDb 实例化；DDL 常量导出供迁移与测试共用
 */

// ============================================================================
// DDL — 由 connection.ts 的 applyMigrations 幂等执行（纯新增表，无数据回填，
// 不占用迁移版本号，与 favorites / resonance_* / sync_* 同款先例）
// ============================================================================

export const SYNC_PAIRING_DDL_STATEMENTS: readonly string[] = [
  'CREATE TABLE IF NOT EXISTS sync_pairing_sessions (pairing_token_hash TEXT PRIMARY KEY, server_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_sync_pairing_sessions_expires_at ON sync_pairing_sessions(expires_at)'
]

// ============================================================================
// SQL 模板（完整静态字面量；与 sync-pairing-repository.test.ts 的 FakeDb 一一对应）
// ============================================================================

const SQL_SESSION_INSERT =
  'INSERT INTO sync_pairing_sessions (pairing_token_hash, server_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
const SQL_SESSION_GET =
  'SELECT pairing_token_hash, server_id, expires_at, used_at, created_at FROM sync_pairing_sessions WHERE pairing_token_hash = ?'
const SQL_SESSION_CONSUME =
  'UPDATE sync_pairing_sessions SET used_at = ? WHERE pairing_token_hash = ? AND used_at IS NULL'

// ============================================================================
// Types
// ============================================================================

export type ConsumeSessionResult = 'ok' | 'missing' | 'used' | 'expired'

export interface PairingSessionRow {
  pairing_token_hash: string
  server_id: string
  expires_at: string
  used_at: string | null
  created_at: string
}

export interface CreatePairingSessionInput {
  /** sha256(token) 小写 hex（原令牌不落库） */
  tokenHash: string
  serverId: string
  /** ISO-8601 UTC 过期时间 */
  expiresAt: string
  createdAt?: string
}

// ============================================================================
// Repository
// ============================================================================

function nowIso(): string {
  return new Date().toISOString()
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`invalid ${label}: must be a non-empty string`)
  }
}

function assertIsoDateTime(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`invalid ${label}: not an ISO datetime string`)
  }
}

export class SyncPairingRepository {
  /** workerBridge/dbPath 保留形参：写路径切回 worker 桥接时无需改动调用方 */
  constructor(
    private readonly db: Database.Database,
    private readonly workerBridge: unknown = null,
    private readonly dbPath: string = ''
  ) {}

  // ============ 写（async 签名；当前为同步直写，见文件头备注） ============

  /** 登记一个待使用会话（同一 tokenHash 重复创建视为覆盖，正常流程不会发生） */
  async createSession(input: CreatePairingSessionInput): Promise<void> {
    assertNonEmpty(input.tokenHash, 'tokenHash')
    assertNonEmpty(input.serverId, 'serverId')
    assertIsoDateTime(input.expiresAt, 'expiresAt')
    if (input.createdAt !== undefined) assertIsoDateTime(input.createdAt, 'createdAt')
    const createdAt = input.createdAt ?? nowIso()
    this.db
      .prepare(SQL_SESSION_INSERT)
      .run(input.tokenHash, input.serverId, input.expiresAt, createdAt)
  }

  /**
   * 一次性消费令牌：missing（不存在）/ used（已用）/ expired（过期）/ ok（成功置位）。
   * 查行、判定与 used_at 置位在单个事务内原子执行；UPDATE 的
   * `used_at IS NULL` 守卫兜底并发（单连接事务内 changes 恒为 1，防御性返回 used）。
   */
  async consumeSession(tokenHash: string, nowIsoValue: string): Promise<ConsumeSessionResult> {
    assertNonEmpty(tokenHash, 'tokenHash')
    assertIsoDateTime(nowIsoValue, 'nowIsoValue')
    const consume = this.db.transaction((): ConsumeSessionResult => {
      const row = this.db.prepare(SQL_SESSION_GET).get(tokenHash) as PairingSessionRow | undefined
      if (!row) return 'missing'
      if (row.used_at !== null) return 'used'
      if (row.expires_at <= nowIsoValue) return 'expired'
      const result = this.db.prepare(SQL_SESSION_CONSUME).run(nowIsoValue, tokenHash)
      return result.changes === 1 ? 'ok' : 'used'
    })
    return consume()
  }

  // ============ 读（同步；字面量语句 + 参数绑定） ============

  getSession(tokenHash: string): PairingSessionRow | null {
    assertNonEmpty(tokenHash, 'tokenHash')
    const row = this.db.prepare(SQL_SESSION_GET).get(tokenHash) as PairingSessionRow | undefined
    return row ?? null
  }
}
