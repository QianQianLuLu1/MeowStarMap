import { ipcMain } from 'electron'
import { z } from 'zod'
import fsp from 'fs/promises'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { pickBestId } from '../../utils/duplicate-scoring'
import { generatePhashForUnprocessed } from '../../services/thumbnail-phash-service'
import { MediaRepository } from '../../database/media-repository'
import { logger } from '../../utils/logger'
import { t } from '../../i18n'

/**
 * R7：相似检测前的 stale 检测节流间隔（5 分钟）。
 * 避免每次 findSimilar 都触发 stat 扫描；5 分钟内的重复调用复用上次检测结果。
 */
const PHASH_STALE_CHECK_INTERVAL_MS = 5 * 60 * 1000
/** R7：stale 检测的采样数量，限制 stat 开销 */
const PHASH_STALE_CHECK_SAMPLE_SIZE = 20

/** R7：上次 stale 检测时间戳，模块级节流 */
let lastPhashStaleCheckAt = 0

/**
 * R7：相似检测前触发轻量 stale 检测（仅 stat，不计算 phash）。
 * 通过轻量采样（只取 file_path/phash_mtime/phash_file_size，不取 phash 本体）判定
 * 部分样本是否 stale，若发现 mtime/size 与 phash_mtime/phash_file_size 不一致，
 * fire-and-forget 触发 generatePhashForUnprocessed 让 worker 重算 stale 项。
 *
 * 不阻塞 findSimilar 响应——本次仍返回当前（可能 stale）结果，下次调用受益。
 *
 * 性能重构 v3（2026-08）：stale 检测不再依赖主进程全量载入的 pHash 行，
 * 改为接收 getRepo 闭包，内部走 getPhashStaleSample 轻量采样。
 */
async function maybeTriggerPhashStaleCheck(
  ctx: HandlerContext,
  getRepo: () => MediaRepository
): Promise<void> {
  const now = Date.now()
  if (now - lastPhashStaleCheckAt < PHASH_STALE_CHECK_INTERVAL_MS) return
  lastPhashStaleCheckAt = now

  // 轻量采样：只取 file_path/phash_mtime/phash_file_size，不取 phash
  const sample = getRepo().getPhashStaleSample(PHASH_STALE_CHECK_SAMPLE_SIZE)
  if (sample.length === 0) return

  let staleFound = false
  for (const row of sample) {
    // 缺少 mtime/size 元数据（旧库未迁移）→ 视为 stale，触发回填
    if (row.phash_mtime === null || row.phash_file_size === null) {
      staleFound = true
      break
    }
    try {
      const stat = await fsp.stat(row.file_path)
      if (Math.floor(stat.mtimeMs) !== row.phash_mtime || stat.size !== row.phash_file_size) {
        staleFound = true
        break
      }
    } catch {
      // stat 失败：文件可能被删除/移动，由 is_missing 流程处理，不算 stale
    }
  }

  if (staleFound) {
    // fire-and-forget：让 worker 在后台重算 stale 项，不阻塞本次响应
    void generatePhashForUnprocessed(ctx, 'low').catch(() => {
      // 重算失败不影响本次相似检测；下次 findSimilar 会再次触发
    })
  }
}

/**
 * 相似检测域 IPC handler
 *
 * 覆盖：pHash 汉明距离相似检测 / 手动 pHash 补算。
 *
 * 性能重构 v3（2026-08）：相似检测的 O(n²) 汉明距离两两比对已从主进程事件循环
 * 迁移到 media-worker（utilityProcess）。主进程仅负责：
 * - 解析参数（阈值透传）；
 * - 派发 SIMILAR_FIND_START 到 worker；
 * - 转发进度（task:progress，复用 manager 的 TaskRegistry/节流）；
 * - 接收候选边 + 行元数据，做 O(E·α(N)) 的 Union-Find 轻量聚合；
 * - 支持 task:cancel 取消（经 manager 的 AbortController → bridge.stopSimilarFind）。
 *
 * 对外 IPC 返回结构（success / duplicates / bestItemIds / totalGroups / totalFiles /
 * wastedBytes / scannedFiles / threshold / hashedFiles / cancelled）完全不变，
 * 渲染端零改动。
 */
export function registerSimilarHandlers(ctx: HandlerContext): void {
  // 每次调用动态获取 Repository（db 可能在初始化/重连时变化）
  // 数据库写操作进程拆分：传入 workerBridge 与 dbPath，写方法走独立 utilityProcess
  const getRepo = (): MediaRepository => {
    const db = ctx.dbManager.getDatabase()
    if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
    return new MediaRepository(db, ctx.dbManager.getWorkerBridge(), ctx.dbManager.getDbPath())
  }

  // T05：基于 pHash 汉明距离的相似图片查找（聚类在 media-worker 完成）
  ipcMain.handle(
    'media:findSimilar',
    wrapHandler(
      ctx,
      z.tuple([z.object({ threshold: z.number().int().min(0).max(64).optional() }).optional()]),
      async ([options]) => {
        const threshold = options?.threshold ?? 5
        const repo = getRepo()

        // 快速路径：空库直接返回（避免起 worker）
        const count = repo.getPhashCount()
        if (count < 2) {
          return {
            success: true,
            duplicates: [],
            bestItemIds: [],
            totalGroups: 0,
            totalFiles: 0,
            wastedBytes: 0,
            scannedFiles: count,
            threshold,
            hashedFiles: count
          }
        }

        // R7：相似检测前触发 stale 检测（fire-and-forget，走轻量采样，不阻塞响应）
        void maybeTriggerPhashStaleCheck(ctx, getRepo).catch(() => {
          // stale 检测自身失败不影响相似检测主流程
        })

        // 派发到 worker，主进程只做轻量 Union-Find 聚合
        const res = await ctx.mediaWorkerManager.startSimilarFind({ threshold })

        if (!res.success) {
          return {
            success: false,
            message: res.message,
            duplicates: [],
            bestItemIds: [],
            totalGroups: 0,
            totalFiles: 0,
            wastedBytes: 0,
            scannedFiles: count,
            threshold,
            hashedFiles: count
          }
        }

        // 取消：返回空结果（终态 cancelled 已由 manager 推送）
        if (res.cancelled) {
          return {
            success: true,
            duplicates: [],
            bestItemIds: [],
            totalGroups: 0,
            totalFiles: 0,
            wastedBytes: 0,
            scannedFiles: res.rows.length,
            threshold,
            hashedFiles: res.rows.length,
            cancelled: true
          }
        }

        // —— 轻量聚合：O(E·α(N)) Union-Find（E = 候选边数，远低于 n²）——
        const rows = res.rows
        const idToIndex = new Map<number, number>()
        rows.forEach((r, i) => idToIndex.set(r.id, i))

        const parent = new Int32Array(rows.length)
        for (let i = 0; i < rows.length; i++) parent[i] = i
        const find = (x: number): number => {
          while (parent[x] !== x) {
            parent[x] = parent[parent[x]]
            x = parent[x]
          }
          return x
        }
        const union = (a: number, b: number): void => {
          const ra = find(a)
          const rb = find(b)
          if (ra !== rb) parent[ra] = rb
        }
        for (const { a, b } of res.candidates) {
          const ia = idToIndex.get(a)
          const ib = idToIndex.get(b)
          if (ia === undefined || ib === undefined) continue
          union(ia, ib)
        }

        // 分组 + 排序（数据源由 rows 替代 getPhashRows 结果，字段集一致）
        const groupMap = new Map<number, number[]>()
        for (let i = 0; i < rows.length; i++) {
          const root = find(i)
          if (!groupMap.has(root)) groupMap.set(root, [])
          groupMap.get(root)!.push(i)
        }

        const similarGroups: Array<typeof rows> = []
        let totalFiles = 0
        let wastedBytes = 0
        for (const indices of groupMap.values()) {
          if (indices.length < 2) continue
          const groupRows = indices.map((i) => rows[i])
          groupRows.sort(
            (a, b) => new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime()
          )
          similarGroups.push(groupRows)
          totalFiles += groupRows.length
          const minSize = Math.min(...groupRows.map((r) => r.file_size))
          wastedBytes += minSize * (groupRows.length - 1)
        }

        similarGroups.sort((a, b) => {
          const wa = Math.min(...a.map((r) => r.file_size)) * (a.length - 1)
          const wb = Math.min(...b.map((r) => r.file_size)) * (b.length - 1)
          return wb - wa
        })

        const result = similarGroups.map((group) => {
          const items = group.map((r) => ({
            id: r.id,
            file_path: r.file_path,
            file_name: r.file_name,
            file_type: r.file_type,
            file_size: r.file_size,
            modified_at: r.modified_at,
            width: r.width,
            height: r.height,
            is_favorite: Boolean(r.is_favorite),
            rating: r.rating,
            thumbnail: r.thumbnail ?? null
          }))
          const bestId = pickBestId(items)
          return { items, bestItemId: bestId }
        })

        logger.info(
          `[pHash] 相似检测：扫描 ${rows.length} 张，聚合 ${res.candidates.length} 条候选边，分 ${similarGroups.length} 组`
        )

        return {
          success: true,
          duplicates: result.map((g) => g.items),
          bestItemIds: result.map((g) => g.bestItemId),
          totalGroups: similarGroups.length,
          totalFiles,
          wastedBytes,
          scannedFiles: rows.length,
          threshold,
          hashedFiles: rows.length
        }
      }
    )
  )

  // T05：手动触发 pHash 补算
  ipcMain.handle(
    'media:generatePhash',
    wrapHandlerNoArgs(ctx, async () => {
      const { processed, total } = await generatePhashForUnprocessed(ctx)
      return { success: true, message: t('main.similar.message.phashDone'), processed, total }
    })
  )
}
