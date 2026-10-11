/**
 * @layer L3
 * @module src/main/scanner/scan-journal
 * @coverage 扫描变更日志辅助：水位线捕获 + 批量落账（sync-integration 阶段5 自 scanner-handler 抽取）
 * @dependencies SyncMetadataRepository / SyncEventSink
 *
 * sync-integration 阶段5：扫描器集成补全——启动自动扫描（startup-tasks）与 IPC 扫描
 * （scanner-handler）共用同一份水位线/journal 实现。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { captureScanWatermark, recordScanChanges, type ScanJournalDeps } from './scan-journal'
import type { SyncEventSink } from '../sync/server/types'

const { syncMetadataRepoMock } = vi.hoisted(() => ({
  syncMetadataRepoMock: { rebuildMotionLinks: vi.fn(async () => ({ paired: 0 })) }
}))

vi.mock('../database/sync-metadata-repository', () => ({
  // vitest 5：生产代码以 new SyncMetadataRepository(...) 使用桩，需 function 表达式可构造
  SyncMetadataRepository: vi.fn(function createSyncMetadataRepositoryMock() {
    return syncMetadataRepoMock
  })
}))

function makeWatermarkDb(maxId: number): { prepare: ReturnType<typeof vi.fn> } {
  return {
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ max_id: maxId })),
      all: vi.fn(() => []),
      run: vi.fn()
    }))
  }
}

/** 形如 SCAN_CHANGED_ROWS_SQL 查询结果的 db：按 SQL 前缀区分水位线/变更行查询 */
function makeChangedRowsDb(rows: Array<{ id: number; created_at: string }>): {
  prepare: ReturnType<typeof vi.fn>
} {
  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('COALESCE(MAX(id), 0) AS max_id')) {
        return { get: vi.fn(() => ({ max_id: 5 })), all: vi.fn(() => []), run: vi.fn() }
      }
      return { get: vi.fn(() => undefined), all: vi.fn(() => rows), run: vi.fn() }
    })
  }
}

function makeDeps(overrides: Partial<ScanJournalDeps> = {}): ScanJournalDeps {
  return {
    db: makeChangedRowsDb([]) as unknown as ScanJournalDeps['db'],
    workerBridge: null,
    dbPath: '/mock/db/test.db',
    syncEvents: {
      recordAssetChange: vi.fn(async () => undefined),
      recordAssetChanges: vi.fn(async () => 0),
      broadcastRescanStarted: vi.fn(async () => undefined),
      broadcastRescanCompleted: vi.fn(async () => undefined)
    } as SyncEventSink,
    ...overrides
  }
}

beforeEach(() => {
  syncMetadataRepoMock.rebuildMotionLinks.mockClear()
})

describe('captureScanWatermark', () => {
  it('返回 media_files MAX(id) 水位线', () => {
    const db = makeWatermarkDb(42)
    expect(captureScanWatermark(db as never)).toBe(42)
  })

  it('db 为 null → 0', () => {
    expect(captureScanWatermark(null)).toBe(0)
  })

  it('prepare 抛错 → 0（不阻塞扫描）', () => {
    const db = {
      prepare: vi.fn(() => {
        throw new Error('no table')
      })
    }
    expect(captureScanWatermark(db as never)).toBe(0)
  })
})

describe('recordScanChanges', () => {
  it('id 越线 → asset.created，时间窗命中 → asset.updated；返回行数', async () => {
    const deps = makeDeps({
      db: makeChangedRowsDb([
        { id: 7, created_at: '2026-10-11T01:00:00.000Z' },
        { id: 3, created_at: '2026-10-10T01:00:00.000Z' }
      ]) as unknown as ScanJournalDeps['db']
    })
    const changed = await recordScanChanges(deps, {
      scanStartedAt: '2026-10-11T00:00:00.000Z',
      preScanMaxId: 5
    })
    expect(changed).toBe(2)
    expect(deps.syncEvents!.recordAssetChanges).toHaveBeenCalledWith([
      { eventType: 'asset.created', assetId: '7' },
      { eventType: 'asset.updated', assetId: '3' }
    ])
  })

  it('无变更行 → 返回 0 且不写 journal', async () => {
    const deps = makeDeps()
    const changed = await recordScanChanges(deps, {
      scanStartedAt: '2026-10-11T00:00:00.000Z',
      preScanMaxId: 5
    })
    expect(changed).toBe(0)
    expect(deps.syncEvents!.recordAssetChanges).not.toHaveBeenCalled()
  })

  it('落账前先重建动态照片同名配对（rebuildMotionLinks）', async () => {
    const deps = makeDeps({
      db: makeChangedRowsDb([{ id: 7, created_at: '2026-10-11T01:00:00.000Z' }]) as never
    })
    await recordScanChanges(deps, { scanStartedAt: '2026-10-11T00:00:00.000Z', preScanMaxId: 5 })
    expect(syncMetadataRepoMock.rebuildMotionLinks).toHaveBeenCalledTimes(1)
  })

  it('db 为 null → 0；syncEvents 缺失 → 0（journal 永远写由装配层保证，此处为防御）', async () => {
    expect(
      await recordScanChanges({ ...makeDeps(), db: null }, { scanStartedAt: '', preScanMaxId: 0 })
    ).toBe(0)
    const noEvents = makeDeps()
    delete (noEvents as Partial<ScanJournalDeps>).syncEvents
    expect(
      await recordScanChanges(noEvents, { scanStartedAt: '', preScanMaxId: 0 })
    ).toBe(0)
  })

  it('内部异常（查询/落账失败）→ 吞错返回 0，不阻塞扫描主流程', async () => {
    const deps = makeDeps()
    ;(deps.db!.prepare as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('boom')
    })
    const changed = await recordScanChanges(deps, {
      scanStartedAt: '2026-10-11T00:00:00.000Z',
      preScanMaxId: 5
    })
    expect(changed).toBe(0)
  })
})
