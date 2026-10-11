import { describe, it, expect } from 'vitest'
import type Database from 'better-sqlite3'

/**
 * SyncPairingRepository 单元测试
 *
 * 策略沿用宿主 FakeDb 约定（见 ../database/AGENTS.md §4.2）：SQL 匹配桩只覆盖
 * 仓储实际发出的静态字面量语句，未匹配的 SQL 抛错快速暴露遗漏；不加载原生
 * better-sqlite3。编号对应 docs/sync-integration/03-auth-pairing-plan.md §10（T1）。
 */

import {
  SYNC_PAIRING_DDL_STATEMENTS,
  SyncPairingRepository,
  type ConsumeSessionResult
} from './sync-pairing-repository'

// ============================================================================
// FakeDb：内存行存储（仅覆盖 sync-pairing-repository 的 3 条语句）
// ============================================================================

interface SessionRow {
  pairing_token_hash: string
  server_id: string
  expires_at: string
  used_at: string | null
  created_at: string
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

class PairingSessionsFakeDb {
  rows: SessionRow[] = []

  prepare(sql: string): {
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint }
    get: (...params: unknown[]) => SessionRow | undefined
    all: (...params: unknown[]) => SessionRow[]
  } {
    const normalized = normalizeSql(sql)
    return {
      run: (...params: unknown[]) => this.runStatement(normalized, params),
      get: (...params: unknown[]) => this.getStatement(normalized, params),
      all: (...params: unknown[]) => this.allStatement(normalized, params)
    }
  }

  transaction<R>(fn: () => R): () => R {
    // 同步直写先例：fn 抛错时异常向上传播（等价回滚——中间态对外不可见）
    return () => fn()
  }

  private runStatement(
    normalized: string,
    params: unknown[]
  ): { changes: number; lastInsertRowid: number | bigint } {
    if (normalized.startsWith('INSERT INTO sync_pairing_sessions')) {
      this.rows.push({
        pairing_token_hash: params[0] as string,
        server_id: params[1] as string,
        expires_at: params[2] as string,
        used_at: null,
        created_at: params[3] as string
      })
      return { changes: 1, lastInsertRowid: 1 }
    }
    if (normalized.startsWith('UPDATE sync_pairing_sessions SET used_at')) {
      const usedAt = params[0] as string
      const hash = params[1] as string
      const row = this.rows.find((r) => r.pairing_token_hash === hash)
      if (row && row.used_at === null) {
        row.used_at = usedAt
        return { changes: 1, lastInsertRowid: 1 }
      }
      return { changes: 0, lastInsertRowid: 1 }
    }
    throw new Error(`FakeDb: 未覆盖的 SQL: ${normalized}`)
  }

  private getStatement(normalized: string, params: unknown[]): SessionRow | undefined {
    if (normalized.startsWith('SELECT pairing_token_hash')) {
      const hash = params[0] as string
      const row = this.rows.find((r) => r.pairing_token_hash === hash)
      return row ? { ...row } : undefined
    }
    throw new Error(`FakeDb: 未覆盖的 SQL: ${normalized}`)
  }

  private allStatement(normalized: string): SessionRow[] {
    throw new Error(`FakeDb: 未覆盖的 SQL: ${normalized}`)
  }
}

function makeRepo(): { repo: SyncPairingRepository; db: PairingSessionsFakeDb } {
  const db = new PairingSessionsFakeDb()
  const repo = new SyncPairingRepository(db as unknown as Database.Database)
  return { repo, db }
}

const TOKEN_HASH = 'a'.repeat(64)
const SERVER_ID = 'wxnn-test0000000000'
const EXPIRES_AT = '2026-10-11T08:05:00.000Z'
const NOW = '2026-10-11T08:00:00.000Z'

// ============================================================================
// DDL 导出（connection.ts 幂等展开与测试共用）
// ============================================================================

describe('SYNC_PAIRING_DDL_STATEMENTS', () => {
  it('包含 sync_pairing_sessions 建表与过期索引语句', () => {
    const joined = SYNC_PAIRING_DDL_STATEMENTS.join('\n')
    expect(SYNC_PAIRING_DDL_STATEMENTS.length).toBeGreaterThanOrEqual(2)
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS sync_pairing_sessions')
    expect(joined).toContain('pairing_token_hash TEXT PRIMARY KEY')
    expect(joined).toContain('used_at TEXT')
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_sync_pairing_sessions_expires_at')
  })
})

// ============================================================================
// createSession
// ============================================================================

describe('SyncPairingRepository.createSession', () => {
  it('写入 token_hash（非原 token 由调用方保证）、server_id 与过期时间', async () => {
    const { repo, db } = makeRepo()
    await repo.createSession({ tokenHash: TOKEN_HASH, serverId: SERVER_ID, expiresAt: EXPIRES_AT })
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({
      pairing_token_hash: TOKEN_HASH,
      server_id: SERVER_ID,
      expires_at: EXPIRES_AT,
      used_at: null
    })
    expect(db.rows[0]!.created_at).toBeTruthy()
  })

  it('拒绝空 tokenHash / 非 ISO 过期时间', async () => {
    const { repo } = makeRepo()
    await expect(
      repo.createSession({ tokenHash: '', serverId: SERVER_ID, expiresAt: EXPIRES_AT })
    ).rejects.toThrow()
    await expect(
      repo.createSession({ tokenHash: TOKEN_HASH, serverId: SERVER_ID, expiresAt: 'not-iso' })
    ).rejects.toThrow()
  })
})

// ============================================================================
// consumeSession 四态
// ============================================================================

describe('SyncPairingRepository.consumeSession', () => {
  it('ok：未用未过期令牌消费成功并置位 used_at', async () => {
    const { repo, db } = makeRepo()
    await repo.createSession({ tokenHash: TOKEN_HASH, serverId: SERVER_ID, expiresAt: EXPIRES_AT })
    const result: ConsumeSessionResult = await repo.consumeSession(TOKEN_HASH, NOW)
    expect(result).toBe('ok')
    expect(db.rows[0]!.used_at).toBe(NOW)
  })

  it('missing：不存在的令牌哈希返回 missing', async () => {
    const { repo } = makeRepo()
    expect(await repo.consumeSession('b'.repeat(64), NOW)).toBe('missing')
  })

  it('used：已使用（used_at 非空）返回 used', async () => {
    const { repo, db } = makeRepo()
    await repo.createSession({ tokenHash: TOKEN_HASH, serverId: SERVER_ID, expiresAt: EXPIRES_AT })
    expect(await repo.consumeSession(TOKEN_HASH, NOW)).toBe('ok')
    db.rows[0]!.used_at = NOW // 直改内存行模拟已消费
    expect(await repo.consumeSession(TOKEN_HASH, '2026-10-11T08:01:00.000Z')).toBe('used')
  })

  it('expired：expires_at <= now（ISO 串比较）返回 expired', async () => {
    const { repo } = makeRepo()
    await repo.createSession({ tokenHash: TOKEN_HASH, serverId: SERVER_ID, expiresAt: EXPIRES_AT })
    expect(await repo.consumeSession(TOKEN_HASH, EXPIRES_AT)).toBe('expired')
    expect(await repo.consumeSession(TOKEN_HASH, '2026-10-11T08:05:00.001Z')).toBe('expired')
  })

  it('一次性守卫：同一哈希二次消费返回 used 且 used_at 不被改写', async () => {
    const { repo, db } = makeRepo()
    await repo.createSession({ tokenHash: TOKEN_HASH, serverId: SERVER_ID, expiresAt: EXPIRES_AT })
    expect(await repo.consumeSession(TOKEN_HASH, NOW)).toBe('ok')
    expect(await repo.consumeSession(TOKEN_HASH, '2026-10-11T08:02:00.000Z')).toBe('used')
    expect(db.rows[0]!.used_at).toBe(NOW)
  })

  it('拒绝非 ISO nowIso / 空 tokenHash', async () => {
    const { repo } = makeRepo()
    await expect(repo.consumeSession(TOKEN_HASH, 'not-iso')).rejects.toThrow()
    await expect(repo.consumeSession('', NOW)).rejects.toThrow()
  })
})
